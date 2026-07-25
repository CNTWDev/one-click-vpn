import { NextResponse } from "next/server";
import { addAudit, findRegion, findRegionByLabel, insertNode, listNodes } from "../../../server/db";
import { currentUser } from "../../../server/auth";
import { encryptSecret } from "../../../server/crypto";
import { cleanText, isValidIp, isValidPort, jsonError, readJson } from "../../../server/http";
import { queueNodeBootstrap } from "../../../server/bootstrap";

export const runtime = "nodejs";

function publicNode(node: ReturnType<typeof listNodes>[number]) {
  const hidden = new Set(["credential_ciphertext", "credential_iv", "credential_tag", "agent_token_hash"]);
  return Object.fromEntries(Object.entries(node).filter(([key]) => !hidden.has(key)));
}

export async function GET() {
  const user = await currentUser();
  if (!user) return jsonError("Authentication required", 401);
  return NextResponse.json({ nodes: listNodes().map(publicNode) });
}

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return jsonError("Authentication required", 401);
  try {
    const body = await readJson(request);
    const name = cleanText(body.name, 120);
    const ip = cleanText(body.ip, 64);
    const requestedPlace = cleanText(body.place || body.region, 120);
    const region = (cleanText(body.regionId, 80) && findRegion(cleanText(body.regionId, 80))) || (requestedPlace && findRegionByLabel(requestedPlace));
    const place = region ? `${region.name} · ${region.country}` : requestedPlace || "Unassigned";
    const sshUser = cleanText(body.sshUser || body.user, 64) || "root";
    const secret = typeof body.secret === "string" ? body.secret : "";
    const credentialType = body.credentialType === "private_key" ? "private_key" : "password";
    const hostFingerprint = cleanText(body.hostFingerprint, 256) || null;
    if (!name || !isValidIp(ip) || !secret) return jsonError("Name, IPv4 address, and SSH credential are required");
    if (!region) return jsonError("A valid region is required");
    if (credentialType === "private_key" && !secret.includes("BEGIN")) return jsonError("Private key is not valid PEM text");
    const encrypted = encryptSecret(secret);
    const node = insertNode({
      name,
      place,
      region_id: region.id,
      ip,
      ssh_user: sshUser,
      ssh_port: isValidPort(body.sshPort),
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
    });
    addAudit({ actorUserId: user.id, action: "node.created", targetType: "node", targetId: node.id, metadata: { credentialType } });
    queueNodeBootstrap(node.id, user.id);
    return NextResponse.json({ node: publicNode(node) }, { status: 201 });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to create node");
  }
}
