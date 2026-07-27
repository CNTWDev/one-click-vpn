import { NextResponse } from "next/server";
import { requestUser } from "../../../../server/request-auth";
import { findDevice, listConnectionProfiles, listDevices, type ConnectionProfile, type Protocol } from "../../../../server/control-db";
import { issueScheduledConnectionProfile, publicProfile, protocolForPlatform } from "../../../../server/control-plane";
import { listNodes, listRegions } from "../../../../server/db";
import { cleanText, jsonError, readJson } from "../../../../server/http";
import { listProtocolAdapters } from "../../../../server/protocols/registry";

export const runtime = "nodejs";

const protocols = new Set<Protocol>(listProtocolAdapters().filter((adapter) => adapter.capability.status === "enabled").map((adapter) => adapter.id));

async function profilesWithRegions(profiles: ConnectionProfile[], userId: string) {
  const [nodes, regions, devices] = await Promise.all([listNodes(), listRegions(), listDevices(userId)]);
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const regionsById = new Map(regions.map((region) => [region.id, region]));
  const devicesById = new Map(devices.map((device) => [device.id, device]));
  return profiles.map((profile) => {
    const regionId = nodesById.get(profile.node_id)?.region_id;
    const region = regionId ? regionsById.get(regionId) : undefined;
    return publicProfile(profile, region ? { code: region.code, name: region.name } : undefined, devicesById.get(profile.device_id));
  });
}

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
  return NextResponse.json({ profiles: await profilesWithRegions(await listConnectionProfiles({ deviceId, status, userId: user.id }), user.id) });
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
    return NextResponse.json({ profile: (await profilesWithRegions([profile], user.id))[0] }, { status: 201 });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to issue profile", 409);
  }
}
