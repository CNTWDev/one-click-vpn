import { NextResponse } from "next/server";
import { requestUser } from "../../../../../server/request-auth";
import { findDevice } from "../../../../../server/control-db";
import { publicDevice } from "../../../../../server/control-plane";
import { jsonError } from "../../../../../server/http";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await requestUser(_request);
  if (!user) return jsonError("Authentication required", 401);
  const { id } = await context.params;
  const device = await findDevice(id);
  if (!device) return jsonError("Device not found", 404);
  return NextResponse.json({ device: publicDevice(device) });
}
