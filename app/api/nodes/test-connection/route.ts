import { NextResponse } from "next/server";
import { currentUser } from "../../../../server/auth";
import { decryptSecret } from "../../../../server/crypto";
import { addAudit, findNode } from "../../../../server/db";
import { cleanText, isValidIp, isValidPort, jsonError, readJson } from "../../../../server/http";
import { credentialType as resolveCredentialType, privilegeMode, testRemoteAccess, validateSshCredential } from "../../../../server/remote-ssh";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return jsonError("Authentication required", 401);
  try {
    const body = await readJson(request);
    const nodeId = cleanText(body.nodeId, 128);
    const savedNode = nodeId ? await findNode(nodeId) : undefined;
    if (nodeId && !savedNode) return jsonError("Node not found", 404);
    const ip = cleanText(body.ip, 64) || savedNode?.ip || "";
    const sshUser = cleanText(body.sshUser, 64) || savedNode?.ssh_user || "root";
    if (!isValidIp(ip)) return jsonError("A valid public IPv4 address is required");
    const suppliedSecret = typeof body.secret === "string" ? body.secret : "";
    const storedSecret = savedNode && !suppliedSecret
      ? decryptSecret({ ciphertext: savedNode.credential_ciphertext, iv: savedNode.credential_iv, tag: savedNode.credential_tag })
      : "";
    const sshPort = isValidPort(body.sshPort || savedNode?.ssh_port);
    // A stored credential may only be sent to the host it was saved for; otherwise an edited IP
    // or a blanked fingerprint would hand the node's root credential to an arbitrary server.
    if (storedSecret && savedNode && (ip !== savedNode.ip || sshPort !== savedNode.ssh_port || sshUser !== savedNode.ssh_user)) {
      return jsonError("Re-enter the SSH credential to test a changed address, port or user", 409);
    }
    const rawSecret = suppliedSecret || storedSecret;
    const type = suppliedSecret
      ? resolveCredentialType(body.credentialType, suppliedSecret)
      : resolveCredentialType(savedNode?.credential_type, storedSecret);
    const secret = validateSshCredential(type, rawSecret);
    const requestedMode = body.sshPrivilegeMode === "root" || body.sshPrivilegeMode === "sudo"
      ? body.sshPrivilegeMode
      : savedNode?.ssh_privilege_mode;
    const mode = privilegeMode(requestedMode, sshUser);
    const hostFingerprint = storedSecret
      ? savedNode?.host_fingerprint || null
      : typeof body.hostFingerprint === "string"
        ? cleanText(body.hostFingerprint, 256) || null
        : savedNode?.host_fingerprint || null;
    const result = await testRemoteAccess({
      ip,
      ssh_port: sshPort,
      ssh_user: sshUser,
      ssh_privilege_mode: mode,
      credential_type: type,
      host_fingerprint: hostFingerprint,
    }, secret);
    await addAudit({ actorUserId: user.id, action: "node.ssh.tested", targetType: nodeId ? "node" : "node_candidate", targetId: nodeId || undefined, metadata: { ip, sshUser, credentialType: type, sshPrivilegeMode: mode, fingerprintVerified: Boolean(hostFingerprint) } });
    return NextResponse.json({ ok: true, fingerprint: result.fingerprint, sshPrivilegeMode: result.privilegeMode });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to test SSH connection", 409);
  }
}
