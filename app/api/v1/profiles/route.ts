import { NextResponse } from "next/server";
import { requestUser } from "../../../../server/request-auth";
import { findDevice, listConnectionProfiles, type Protocol } from "../../../../server/control-db";
import { issueScheduledConnectionProfile, publicProfile, protocolForPlatform } from "../../../../server/control-plane";
import { cleanText, jsonError, readJson } from "../../../../server/http";
import { listProtocolAdapters } from "../../../../server/protocols/registry";

export const runtime = "nodejs";

const protocols = new Set<Protocol>(listProtocolAdapters().filter((adapter) => adapter.capability.status === "enabled").map((adapter) => adapter.id));

export async function GET(request: Request) {
  const user = await requestUser(request);
  if (!user) return jsonError("Authentication required", 401);
  const url = new URL(request.url);
  const deviceId = cleanText(url.searchParams.get("deviceId"), 128) || undefined;
  const status = cleanText(url.searchParams.get("status"), 20) as "issued" | "active" | "expired" | "revoked" | undefined;
  if (deviceId) {
    const device = await findDevice(deviceId);
    if (!device || device.user_id !== user.id) return jsonError("Device not found", 404);
  }
  return NextResponse.json({ profiles: (await listConnectionProfiles({ deviceId, status, userId: user.id })).map(publicProfile) });
}

export async function POST(request: Request) {
  const user = await requestUser(request);
  if (!user) return jsonError("Authentication required", 401);
  try {
    const body = await readJson(request);
    const deviceId = cleanText(body.deviceId, 128);
    const regionId = cleanText(body.regionId, 128) || undefined;
    const protocol = cleanText(body.protocol, 32) as Protocol;
    const transport = cleanText(body.transport, 32) || undefined;
    const clientPrivateKey = cleanText(body.clientPrivateKey, 128) || undefined;
    const device = await findDevice(deviceId);
    if (!device || device.user_id !== user.id || !deviceId || !protocols.has(protocol)) return jsonError("deviceId and a supported protocol are required");
    if (!protocolForPlatform(device.platform, protocol)) return jsonError("Protocol is not supported by the device platform");
    const profile = await issueScheduledConnectionProfile({ actorUserId: user.id, deviceId, regionId, protocol, transport, clientPrivateKey });
    return NextResponse.json({ profile: publicProfile(profile) }, { status: 201 });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to issue profile", 409);
  }
}
