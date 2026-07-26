import { NextResponse } from "next/server";
import { requestUser } from "../../../../../../server/request-auth";
import { activateProfile } from "../../../../../../server/control-plane";
import { findConnectionProfile, findDevice } from "../../../../../../server/control-db";
import { jsonError } from "../../../../../../server/http";

export const runtime = "nodejs";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await requestUser(_request);
  if (!user) return jsonError("Authentication required", 401);
  const { id } = await context.params;
  try {
    const existing = await findConnectionProfile(id);
    const device = existing ? await findDevice(existing.device_id) : null;
    if (!existing || !device || device.user_id !== user.id) return jsonError("Profile not found", 404);
    const profile = await activateProfile(id, user.id);
    return NextResponse.json({ profile: {
      id: profile.id,
      deviceId: profile.device_id,
      nodeId: profile.node_id,
      revision: profile.revision,
      status: profile.status,
      protocol: profile.protocol,
      transport: profile.transport,
      endpoint: profile.endpoint,
      clientAddress: profile.client_address,
      dns: profile.dns,
      allowedIps: profile.allowed_ips,
      protocolPayload: profile.protocol_payload,
      issuedAt: profile.issued_at,
      expiresAt: profile.expires_at,
      updatedAt: profile.updated_at,
    } });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to activate profile", 409);
  }
}
