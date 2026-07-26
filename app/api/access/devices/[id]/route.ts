import { NextResponse } from "next/server";
import { currentUser } from "../../../../../server/auth";
import { findDevice } from "../../../../../server/control-db";
import { publicDevice, revokeDeviceAndReconcile } from "../../../../../server/control-plane";
import { jsonError } from "../../../../../server/http";

export const runtime = "nodejs";

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return jsonError("Authentication required", 401);
  const { id } = await context.params;
  const device = await findDevice(id);
  if (!device || device.user_id !== user.id) return jsonError("Access device not found", 404);
  try {
    await revokeDeviceAndReconcile(id, user.id);
    return NextResponse.json({ device: publicDevice(await findDevice(id)) });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to revoke access device", 409);
  }
}
