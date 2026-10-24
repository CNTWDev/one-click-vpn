import { NextResponse } from "next/server";
import { requestUser } from "../../../../../../server/request-auth";
import { jsonError } from "../../../../../../server/http";
import { NativeError } from "../../../../../../server/native-proof";
import { signOutDevice } from "../../../../../../server/portal-account";

export const runtime = "nodejs";

/** Signs the account's app out on one device. */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await requestUser(request);
  if (!user) return jsonError("Authentication required", 401);
  try {
    return NextResponse.json(await signOutDevice(user.id, (await context.params).id));
  } catch (error) {
    if (error instanceof NativeError) return jsonError("Device not found", error.status);
    throw error;
  }
}
