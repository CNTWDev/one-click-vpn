import { NextResponse } from "next/server";
import { requestUser } from "../../../../server/request-auth";
import { findRegion, findRegionByLabel, insertNode, addAudit } from "../../../../server/db";
import { encryptSecret } from "../../../../server/crypto";
import { listControlNodes, listNodeProtocols, updateNodeControlMetadata } from "../../../../server/control-db";
import { ensureDefaultNodeProtocols } from "../../../../server/control-plane";
import { queueNodeBootstrap } from "../../../../server/bootstrap";
import { cleanText, isValidIp, isValidPort, jsonError, readJson } from "../../../../server/http";
import { initializeVpnServices, type DeploymentTemplate } from "../../../../server/vpn-services";
import { STANDARD_POLICY_VERSION } from "../../../../server/deployment-policy";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = await requestUser(request);
  if (!user) return jsonError("Authentication required", 401);
  const nodes = [];
  for (const node of await listControlNodes()) {
    await ensureDefaultNodeProtocols(node.id);
    nodes.push({
      id: node.id,
      name: node.name,
      place: node.place,
      provider: node.provider,
      region: node.region || node.place,
      endpoint: node.public_endpoint || node.ip,
      status: node.status,
      latency: node.latency,
      version: node.version,
      lastSeen: node.last_seen,
      capabilities: await listNodeProtocols(node.id),
    });
  }
  return NextResponse.json({ nodes });
}

export async function POST(request: Request) {
  const user = await requestUser(request);
  if (!user) return jsonError("Authentication required", 401);
  try {
    const body = await readJson(request);
    const name = cleanText(body.name, 120);
    const ip = cleanText(body.ip, 64);
    const requestedPlace = cleanText(body.place || body.region, 120);
    const region = (cleanText(body.regionId, 80) && await findRegion(cleanText(body.regionId, 80))) || (requestedPlace && await findRegionByLabel(requestedPlace));
    const place = region ? `${region.name} · ${region.country}` : requestedPlace || "Unassigned";
    const sshUser = cleanText(body.sshUser || body.user, 64) || "root";
    const secret = typeof body.secret === "string" ? body.secret : "";
    const credentialType = body.credentialType === "private_key" ? "private_key" : "password";
    const hostFingerprint = cleanText(body.hostFingerprint, 256) || null;
    const deploymentTemplate = cleanText(body.deploymentTemplate, 32) as DeploymentTemplate || "standard";
    if (!["standard", "wireguard", "openvpn", "agent-only"].includes(deploymentTemplate)) return jsonError("Invalid deployment template");
    if (!name || !isValidIp(ip) || !secret) return jsonError("Name, IPv4 address, and SSH credential are required");
    if (!region) return jsonError("A valid region is required");
    if (credentialType === "private_key" && !secret.includes("BEGIN")) return jsonError("Private key is not valid PEM text");
    const encrypted = encryptSecret(secret);
    const node = await insertNode({
      name, place, region_id: region.id, ip, ssh_user: sshUser, ssh_port: isValidPort(body.sshPort), status: "provisioning",
      latency: "checking", users: 0, traffic: "—", version: "bootstrap queued", last_seen: "just added",
      credential_type: credentialType, credential_ciphertext: encrypted.ciphertext, credential_iv: encrypted.iv,
      credential_tag: encrypted.tag, host_fingerprint: hostFingerprint, agent_token_hash: null,
      deployment_policy: deploymentTemplate === "standard" ? "standard" : deploymentTemplate === "agent-only" ? "agent-only" : "custom",
      policy_version: deploymentTemplate === "standard" ? STANDARD_POLICY_VERSION : 0,
    });
    await updateNodeControlMetadata(node.id, {
      provider: cleanText(body.provider, 64) || "unknown",
      region: cleanText(body.region || body.place, 120) || "Unassigned",
      publicEndpoint: cleanText(body.publicEndpoint, 256) || ip,
    });
    await ensureDefaultNodeProtocols(node.id);
    await initializeVpnServices(node.id, deploymentTemplate);
    await addAudit({ actorUserId: user.id, action: "node.created", targetType: "node", targetId: node.id, metadata: { credentialType } });
    const actionId = await queueNodeBootstrap(node.id, user.id);
    return NextResponse.json({ node: { id: node.id, name: node.name, place: node.place, ip: node.ip, status: node.status, version: node.version }, actionId }, { status: 201 });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to create node");
  }
}
