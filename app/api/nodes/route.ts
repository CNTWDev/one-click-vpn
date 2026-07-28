import { NextResponse } from "next/server";
import { addAudit, findRegion, findRegionByLabel, insertNode, listNodes, publicNode } from "../../../server/db";
import { currentUser } from "../../../server/auth";
import { encryptSecret } from "../../../server/crypto";
import { cleanText, isValidIp, isValidPort, jsonError, readJson } from "../../../server/http";
import { queueNodeBootstrap } from "../../../server/bootstrap";
import { initializeVpnServices, type DeploymentTemplate } from "../../../server/vpn-services";
import { STANDARD_POLICY_VERSION } from "../../../server/deployment-policy";
import { credentialType as resolveCredentialType, privilegeMode, validateSshCredential } from "../../../server/remote-ssh";

export const runtime = "nodejs";

export async function GET() {
  const user = await currentUser();
  if (!user) return jsonError("Authentication required", 401);
  return NextResponse.json({ nodes: (await listNodes()).map(publicNode) });
}

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return jsonError("Authentication required", 401);
  try {
    const body = await readJson(request);
    const name = cleanText(body.name, 120);
    const ip = cleanText(body.ip, 64);
    const requestedPlace = cleanText(body.place || body.region, 120);
    const region = (cleanText(body.regionId, 80) && await findRegion(cleanText(body.regionId, 80))) || (requestedPlace && await findRegionByLabel(requestedPlace));
    const place = region ? `${region.name} · ${region.country}` : requestedPlace || "Unassigned";
    const sshUser = cleanText(body.sshUser || body.user, 64) || "root";
    const rawSecret = typeof body.secret === "string" ? body.secret : "";
    const credentialType = resolveCredentialType(body.credentialType, rawSecret);
    const sshPrivilegeMode = privilegeMode(body.sshPrivilegeMode, sshUser);
    const hostFingerprint = cleanText(body.hostFingerprint, 256) || null;
    const deploymentTemplate = cleanText(body.deploymentTemplate, 32) as DeploymentTemplate || "standard";
    if (!["standard", "wireguard", "openvpn", "agent-only"].includes(deploymentTemplate)) return jsonError("Invalid deployment template");
    if (!name) return jsonError("Node name is required");
    if (!isValidIp(ip)) return jsonError("Public IP must be a valid IPv4 address, for example 203.0.113.10");
    if (!rawSecret) return jsonError("SSH password or private key is required");
    if (!region) return jsonError("A valid region is required");
    const secret = validateSshCredential(credentialType, rawSecret);
    const encrypted = encryptSecret(secret);
    const node = await insertNode({
      name,
      place,
      region_id: region.id,
      ip,
      ssh_user: sshUser,
      ssh_port: isValidPort(body.sshPort),
      ssh_privilege_mode: sshPrivilegeMode,
      status: "provisioning",
      latency: "checking",
      users: 0,
      traffic: "—",
      version: "bootstrap queued",
      last_seen: "just added",
      credential_type: credentialType,
      credential_ciphertext: encrypted.ciphertext,
      credential_iv: encrypted.iv,
      credential_tag: encrypted.tag,
      host_fingerprint: hostFingerprint,
      agent_token_hash: null,
      deployment_policy: deploymentTemplate === "standard" ? "standard" : deploymentTemplate === "agent-only" ? "agent-only" : "custom",
      policy_version: deploymentTemplate === "standard" ? STANDARD_POLICY_VERSION : 0,
    });
    await addAudit({ actorUserId: user.id, action: "node.created", targetType: "node", targetId: node.id, metadata: { credentialType, sshPrivilegeMode } });
    await initializeVpnServices(node.id, deploymentTemplate);
    const actionId = await queueNodeBootstrap(node.id, user.id);
    return NextResponse.json({ node: publicNode(node), actionId }, { status: 201 });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to create node");
  }
}
