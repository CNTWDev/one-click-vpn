import { NextResponse } from "next/server";
import { currentUser } from "../../../../../server/auth";
import { jsonError } from "../../../../../server/http";
import { runNodeAction } from "../../../../../server/bootstrap";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return jsonError("Authentication required", 401);
  const { id } = await context.params;
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const action = body.action === "restart-agent" || body.action === "status-agent" ? body.action : null;
  if (!action) return jsonError("Unsupported node action");
  try {
    const output = await runNodeAction(id, action, user.id);
    return NextResponse.json({ ok: true, output });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Node action failed", 502);
  }
}
