import { NextResponse } from "next/server";
import { requestUser } from "../../../../../server/request-auth";
import { usageByDevices } from "../../../../../server/traffic";
import { jsonError } from "../../../../../server/http";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = await requestUser(request);
  if (!user) return jsonError("Active user authentication required", 403);
  const url = new URL(request.url);
  return NextResponse.json(await usageByDevices(user.id, { from: url.searchParams.get("from") || undefined, to: url.searchParams.get("to") || undefined }));
}
