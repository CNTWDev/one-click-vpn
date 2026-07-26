import { NextResponse } from "next/server";
import { requestUser } from "../../../../../../server/request-auth";
import { findDevice } from "../../../../../../server/control-db";
import { revokeDeviceAndReconcile, publicDevice } from "../../../../../../server/control-plane";
import { jsonError } from "../../../../../../server/http";

export const runtime = "nodejs";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await requestUser(_request);
  if (!user) return jsonError("Authentication required", 401);
  const { id } = await context.params;
  const device = await findDevice(id);
  if (!device || device.user_id !== user.id) return jsonError("Device not found", 404);
  try {
    await revokeDeviceAndReconcile(id, user.id);
    return NextResponse.json({ device: publicDevice(await findDevice(id)) });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to revoke device");
  }
}
