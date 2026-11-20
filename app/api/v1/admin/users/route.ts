import { NextResponse } from "next/server";
import { requestAdmin } from "../../../../../server/request-auth";
import { jsonError } from "../../../../../server/http";
import { countUsersByFilter, listAdminUsers, parseUserListQuery } from "../../../../../server/admin-user-list";

export const runtime = "nodejs";

/**
 * One page of accounts with their access and accessSummary.
 * Query: filter (all|pending|active|suspended|rejected|ending|ended), q, sort (created|name|until|traffic|activity), offset, limit (≤ 200).
 */
export async function GET(request: Request) {
  const admin = await requestAdmin(request);
  if (!admin) return jsonError("Administrator authentication required", 403);
  const query = parseUserListQuery(new URL(request.url).searchParams);
  const [page, counts] = await Promise.all([listAdminUsers(query), countUsersByFilter()]);
  return NextResponse.json({ counts, total: page.total, offset: query.offset, limit: query.limit, users: page.users });
}
