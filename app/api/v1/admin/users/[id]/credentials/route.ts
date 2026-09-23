import { NextResponse } from "next/server";
import { findUserById } from "../../../../../../../server/db";
import { cleanText, jsonError, readJson } from "../../../../../../../server/http";
import { requestAdmin } from "../../../../../../../server/request-auth";
import { adminUserAccessOverview } from "../../../../../../../server/traffic";
import { findAccessCredential, findDevice, listAccessCredentials, listDevices } from "../../../../../../../server/control-db";
import { revokeCredentialAndReconcile, revokeDeviceAndReconcile } from "../../../../../../../server/control-plane";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const admin = await requestAdmin(request);
  if (!admin) return jsonError("Administrator authentication required", 403);
  const { id } = await context.params;
  if (!await findUserById(id)) return jsonError("User not found", 404);
  const url = new URL(request.url);
  return NextResponse.json(await adminUserAccessOverview(id, {
    from: url.searchParams.get("from") || undefined,
    to: url.searchParams.get("to") || undefined,
  }));
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const admin = await requestAdmin(request);
  if (!admin) return jsonError("Administrator authentication required", 403);
  const { id } = await context.params;
  if (!await findUserById(id)) return jsonError("User not found", 404);
  try {
    const body = await readJson(request);
    const action = cleanText(body.action, 40);
    if (action === "revoke-credential") {
      const credentialId = cleanText(body.credentialId, 128);
      const credential = await findAccessCredential(credentialId);
      if (!credential || credential.user_id !== id) return jsonError("Credential not found", 404);
      if (credential.status !== "revoked") await revokeCredentialAndReconcile(credential.id, admin.id);
      return NextResponse.json({ ok: true });
    }
    if (action === "revoke-all-credentials") {
      const credentials = await listAccessCredentials(id);
      let revoked = 0;
      for (const credential of credentials) {
        if (credential.status === "revoked") continue;
        await revokeCredentialAndReconcile(credential.id, admin.id);
        revoked += 1;
      }
      return NextResponse.json({ ok: true, revoked });
    }
    if (action === "revoke-device") {
      const deviceId = cleanText(body.deviceId, 128);
      const device = await findDevice(deviceId);
      if (!device || device.user_id !== id) return jsonError("Device not found", 404);
      if (device.status !== "revoked") await revokeDeviceAndReconcile(device.id, admin.id);
      return NextResponse.json({ ok: true });
    }
    if (action === "revoke-all-devices") {
      const devices = await listDevices(id);
      let revoked = 0;
      for (const device of devices) {
        if (device.status === "revoked") continue;
        await revokeDeviceAndReconcile(device.id, admin.id);
        revoked += 1;
      }
      return NextResponse.json({ ok: true, revoked });
    }
    return jsonError("Unsupported access-management action");
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to update user access");
  }
}
