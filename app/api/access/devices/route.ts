import { NextResponse } from "next/server";
import { currentUser } from "../../../../server/auth";
import { addAudit } from "../../../../server/db";
import { createDevice, listDevices } from "../../../../server/control-db";
import { publicDevice } from "../../../../server/control-plane";
import { cleanText, jsonError, readJson } from "../../../../server/http";

export const runtime = "nodejs";

export async function GET() {
  const user = await currentUser();
  if (!user) return jsonError("Authentication required", 401);
  return NextResponse.json({ devices: (await listDevices(user.id)).map(publicDevice) });
}

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return jsonError("Authentication required", 401);
  try {
    const body = await readJson(request);
    const displayName = cleanText(body.displayName, 120);
    const platform = cleanText(body.platform, 20);
    const publicKey = cleanText(body.publicKey, 128);
    if (!displayName || platform !== "macos" || !publicKey) return jsonError("A display name and macOS public key are required");
    const device = await createDevice({ userId: user.id, displayName, platform, appVersion: "wireguard-import", publicKey });
    await addAudit({ actorUserId: user.id, action: "access.device.created", targetType: "device", targetId: device.id, metadata: { platform } });
    return NextResponse.json({ device: publicDevice(device) }, { status: 201 });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to create access device");
  }
}
