import { NextResponse } from "next/server";
import { currentUser } from "../../../../../server/auth";
import { findNode } from "../../../../../server/db";
import { jsonError } from "../../../../../server/http";
import { agentSupportsSpeedTest, currentSpeedTest, listSpeedTests, requestSpeedTest } from "../../../../../server/speed-test";

export const runtime = "nodejs";

function view(pending: ReturnType<typeof currentSpeedTest>) {
  return pending ? { id: pending.id, kind: pending.kind, status: pending.status } : null;
}

/** The node's recent speed tests, newest first, and the one waiting or running. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  if (!(await currentUser())) return jsonError("Authentication required", 401);
  const { id } = await context.params;
  return NextResponse.json({ pending: view(currentSpeedTest(id)), tests: await listSpeedTests(id) });
}

/** 重新测速: the Agent runs it with its next task pull (about 20 s). */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  if (!(await currentUser())) return jsonError("Authentication required", 401);
  const { id } = await context.params;
  const node = await findNode(id);
  if (!node) return jsonError("Node not found", 404);
  if (!agentSupportsSpeedTest(node.version)) return NextResponse.json({ pending: null, agent: "outdated" });
  return NextResponse.json({ pending: view(requestSpeedTest(id)) });
}
