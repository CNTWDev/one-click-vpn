import { NextResponse } from "next/server";
import { addAudit, findNode, updateNode } from "../../../../server/db";
import { currentUser } from "../../../../server/auth";
import { jsonError } from "../../../../server/http";
import { queueNodeBootstrap } from "../../../../server/bootstrap";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return jsonError("Authentication required", 401);
  const { id } = await context.params;
  const node = findNode(id);
  if (!node) return jsonError("Node not found", 404);
  const hidden = new Set(["credential_ciphertext", "credential_iv", "credential_tag", "agent_token_hash"]);
  const safe = Object.fromEntries(Object.entries(node).filter(([key]) => !hidden.has(key)));
  return NextResponse.json({ node: safe });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return jsonError("Authentication required", 401);
  const { id } = await context.params;
  const node = findNode(id);
  if (!node) return jsonError("Node not found", 404);
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const action = typeof body.action === "string" ? body.action : "";
  if (action !== "bootstrap") return jsonError("Only bootstrap is available from this endpoint");
  updateNode(id, { status: "provisioning", version: "bootstrap queued" });
  addAudit({ actorUserId: user.id, action: "node.bootstrap.queued", targetType: "node", targetId: id });
  queueNodeBootstrap(id, user.id);
  return NextResponse.json({ ok: true });
}
