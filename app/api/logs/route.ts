import { NextResponse } from "next/server";
import { currentUser } from "../../../server/auth";
import { cleanText, jsonError } from "../../../server/http";
import { queryOperationalLogs } from "../../../server/operational-logs";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) return jsonError("Authentication required", 401);
  const url = new URL(request.url);
  const hours = Number(url.searchParams.get("hours") || 24);
  const result = await queryOperationalLogs({
    nodeId: cleanText(url.searchParams.get("nodeId"), 128) || undefined,
    level: cleanText(url.searchParams.get("level"), 16) || undefined,
    hours: Number.isFinite(hours) ? hours : 24,
    limit: Number(url.searchParams.get("limit") || 200),
  });
  return NextResponse.json(result);
}
