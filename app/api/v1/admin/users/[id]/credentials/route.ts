import { NextResponse } from "next/server";
import { findUserById } from "../../../../../../../server/db";
import { jsonError } from "../../../../../../../server/http";
import { requestAdmin } from "../../../../../../../server/request-auth";
import { usageByCredentials } from "../../../../../../../server/traffic";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const admin = await requestAdmin(request);
  if (!admin) return jsonError("Administrator authentication required", 403);
  const { id } = await context.params;
  if (!await findUserById(id)) return jsonError("User not found", 404);
  const url = new URL(request.url);
  return NextResponse.json(await usageByCredentials(id, {
    from: url.searchParams.get("from") || undefined,
    to: url.searchParams.get("to") || undefined,
  }));
}
