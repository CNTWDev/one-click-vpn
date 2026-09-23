import { NextResponse } from "next/server";
import { requestUser } from "../../../../server/request-auth";
import { findAccessCredential, findDevice, listAccessCredentials, listConnectionProfiles, listDevices, type ConnectionProfile, type Protocol } from "../../../../server/control-db";
import { issueRegionalConnectionProfiles, publicProfile, protocolForPlatform } from "../../../../server/control-plane";
import { listNodes, listRegions } from "../../../../server/db";
import { cleanText, jsonError, readJson } from "../../../../server/http";
import { listProtocolAdapters } from "../../../../server/protocols/registry";

export const runtime = "nodejs";

const protocols = new Set<Protocol>(listProtocolAdapters().filter((adapter) => adapter.capability.status === "enabled").map((adapter) => adapter.id));

async function profilesWithRegions(profiles: ConnectionProfile[], userId: string) {
  const [nodes, regions, devices, credentials] = await Promise.all([listNodes(), listRegions(), listDevices(userId), listAccessCredentials(userId)]);
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const regionsById = new Map(regions.map((region) => [region.id, region]));
  const devicesById = new Map(devices.map((device) => [device.id, device]));
  const credentialsById = new Map(credentials.map((credential) => [credential.id, credential]));
  return profiles.map((profile) => {
    const node = nodesById.get(profile.node_id);
    const regionId = node?.region_id;
    const region = regionId ? regionsById.get(regionId) : undefined;
    const regionalNodeCount = Array.isArray(profile.protocol_payload.regionalEndpoints) ? profile.protocol_payload.regionalEndpoints.length : 1;
    const credential = profile.credential_id ? credentialsById.get(profile.credential_id) : undefined;
    return { ...publicProfile(profile, region ? { code: region.code, name: region.name } : undefined, { display_name: credential?.display_name || devicesById.get(profile.device_id)?.display_name || "" }), nodeName: node?.name || null, regionalNodeCount };
  });
}

export async function GET(request: Request) {
  const user = await requestUser(request);
  if (!user) return jsonError("Authentication required", 401);
  const url = new URL(request.url);
  const deviceId = cleanText(url.searchParams.get("deviceId"), 128) || undefined;
  const credentialId = cleanText(url.searchParams.get("credentialId"), 128) || undefined;
  const status = cleanText(url.searchParams.get("status"), 20) as "issued" | "active" | "expired" | "revoked" | undefined;
  if (deviceId) {
    const device = await findDevice(deviceId);
    if (!device || device.user_id !== user.id) return jsonError("Device not found", 404);
  }
  if (credentialId) {
    const credential = await findAccessCredential(credentialId);
    if (!credential || credential.user_id !== user.id) return jsonError("Credential not found", 404);
  }
  return NextResponse.json({ profiles: await profilesWithRegions(await listConnectionProfiles({ deviceId, credentialId, status, userId: user.id }), user.id) });
}

export async function POST(request: Request) {
  const user = await requestUser(request);
  if (!user) return jsonError("Authentication required", 401);
  try {
    const body = await readJson(request);
    const deviceId = cleanText(body.deviceId, 128);
    const credentialId = cleanText(body.credentialId, 128);
    const regionId = cleanText(body.regionId, 128) || undefined;
    const protocol = cleanText(body.protocol, 32) as Protocol;
    const transport = cleanText(body.transport, 32) || undefined;
    const clientPrivateKey = cleanText(body.clientPrivateKey, 128) || undefined;
    const credential = credentialId ? await findAccessCredential(credentialId) : undefined;
    const device = await findDevice(credential?.device_id || deviceId);
    if (!device || device.user_id !== user.id || (!credentialId && !deviceId) || !protocols.has(protocol)) return jsonError("credentialId and a supported protocol are required");
    if (credential && (credential.user_id !== user.id || credential.status !== "active" || credential.protocol !== protocol)) return jsonError("Credential is not available", 409);
    if (!protocolForPlatform(device.platform, protocol)) return jsonError("Protocol is not supported by the device platform");
    const profiles = await issueRegionalConnectionProfiles({ actorUserId: user.id, credentialId: credential?.id, deviceId: device.id, regionId, protocol, transport, clientPrivateKey });
    const publicProfiles = await profilesWithRegions(profiles, user.id);
    return NextResponse.json({ profile: publicProfiles[0], profiles: publicProfiles }, { status: 201 });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to issue profile", 409);
  }
}
