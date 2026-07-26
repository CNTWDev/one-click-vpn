import { NextResponse } from "next/server";
import { addAudit, countRunningNodeActions, deleteNode, findNode, findRegion, listNodeActionEvents, listNodeActions, publicNode, updateNode, updateNodeConfig } from "../../../../server/db";
import { currentUser } from "../../../../server/auth";
import { cleanText, isValidIp, isValidPort, jsonError, readJson } from "../../../../server/http";
import { queueNodeBootstrap } from "../../../../server/bootstrap";
import { getNodeReconcileStatus } from "../../../../server/control-db";
import { encryptSecret } from "../../../../server/crypto";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return jsonError("Authentication required", 401);
  const { id } = await context.params;
  const node = await findNode(id);
  if (!node) return jsonError("Node not found", 404);
  return NextResponse.json({ node: publicNode(node), actions: await listNodeActions(id), actionEvents: await listNodeActionEvents(id), reconcile: await getNodeReconcileStatus(id) });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return jsonError("Authentication required", 401);
  const { id } = await context.params;
  const node = await findNode(id);
  if (!node) return jsonError("Node not found", 404);
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const action = typeof body.action === "string" ? body.action : "";
  if (action !== "bootstrap") return jsonError("Only bootstrap is available from this endpoint");
  if (await countRunningNodeActions(id) > 0) return jsonError("This node already has a queued or running action. Wait for it to finish.", 409);
  await updateNode(id, { status: "provisioning", version: "bootstrap queued" });
  await addAudit({ actorUserId: user.id, action: "node.bootstrap.queued", targetType: "node", targetId: id });
  const actionId = await queueNodeBootstrap(id, user.id);
  return NextResponse.json({ ok: true, actionId, status: "queued" }, { status: 202 });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return jsonError("Authentication required", 401);
  const { id } = await context.params;
  const node = await findNode(id);
  if (!node) return jsonError("Node not found", 404);
  try {
    const body = await readJson(request);
    const name = cleanText(body.name, 120);
    const ip = cleanText(body.ip, 64);
    const sshUser = cleanText(body.sshUser || body.user, 64) || node.ssh_user;
    const hostFingerprint = cleanText(body.hostFingerprint, 256) || null;
    const regionId = cleanText(body.regionId, 80);
    const region = await findRegion(regionId);
    const secret = typeof body.secret === "string" ? body.secret : "";
    if (!name) return jsonError("Node name is required");
    if (!isValidIp(ip)) return jsonError("Public IP must be a valid IPv4 address, for example 203.0.113.10");
    if (!region) return jsonError("A valid region is required");
    const encrypted = secret ? encryptSecret(secret) : undefined;
    const updated = await updateNodeConfig(id, {
      name,
      place: `${region.name} · ${region.country}`,
      regionId: region.id,
      ip,
      sshUser,
      sshPort: isValidPort(body.sshPort || node.ssh_port),
      hostFingerprint,
      ...(encrypted ? { credential: { type: body.credentialType === "private_key" ? "private_key" : "password", ...encrypted } } : {}),
    });
    await addAudit({ actorUserId: user.id, action: "node.updated", targetType: "node", targetId: id, metadata: { credentialChanged: Boolean(encrypted) } });
    return NextResponse.json({ node: publicNode(updated!) });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to update node");
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return jsonError("Authentication required", 401);
  const { id } = await context.params;
  const node = await findNode(id);
  if (!node) return jsonError("Node not found", 404);
  if (await countRunningNodeActions(id) > 0) return jsonError("Node has a queued or running action. Wait for it to finish before deleting.", 409);
  if (!(await deleteNode(id))) return jsonError("Node could not be deleted", 409);
  await addAudit({ actorUserId: user.id, action: "node.deleted", targetType: "node", targetId: id, metadata: { name: node.name, ip: node.ip } });
  return NextResponse.json({ ok: true });
}
