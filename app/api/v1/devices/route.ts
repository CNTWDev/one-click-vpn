import { NextResponse } from "next/server";
import { requestUser } from "../../../../server/request-auth";
import { addAudit } from "../../../../server/db";
import { createDevice, listDevices, type Platform } from "../../../../server/control-db";
import { publicDevice } from "../../../../server/control-plane";
import { cleanText, jsonError, readJson } from "../../../../server/http";

export const runtime = "nodejs";

const platforms = new Set<Platform>(["macos", "ios", "android"]);

export async function GET(request: Request) {
  const user = await requestUser(request);
  if (!user) return jsonError("Authentication required", 401);
  return NextResponse.json({ devices: (await listDevices(user.id)).map(publicDevice) });
}

export async function POST(request: Request) {
  const user = await requestUser(request);
  if (!user) return jsonError("Authentication required", 401);
  try {
    const body = await readJson(request);
    const displayName = cleanText(body.displayName, 120);
    const platform = cleanText(body.platform, 20) as Platform;
    const appVersion = cleanText(body.appVersion, 64);
    const publicKey = cleanText(body.publicKey, 512);
    if (!displayName || !platforms.has(platform) || !appVersion || !publicKey) return jsonError("displayName, platform, appVersion, and publicKey are required");
    const device = await createDevice({ userId: user.id, displayName, platform, appVersion, publicKey });
    await addAudit({ actorUserId: user.id, action: "device.created", targetType: "device", targetId: device.id, metadata: { platform } });
    return NextResponse.json({ device: publicDevice(device) }, { status: 201 });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to create device");
  }
}
