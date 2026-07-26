import { NextResponse } from "next/server";
import { currentUser } from "../../../server/auth";
import { controllerInfo } from "../../../server/controller";
import { addAudit, updateControllerSettings } from "../../../server/db";
import { cleanText, jsonError, readJson } from "../../../server/http";

export const runtime = "nodejs";

function coordinate(value: unknown, minimum: number, maximum: number, name: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  return number;
}

export async function GET() {
  const user = await currentUser();
  if (!user) return jsonError("Authentication required", 401);
  return NextResponse.json(await controllerInfo());
}

export async function PUT(request: Request) {
  const user = await currentUser();
  if (!user) return jsonError("Authentication required", 401);
  try {
    const body = await readJson(request);
    const displayName = cleanText(body.displayName, 120) || "Northstar Controller";
    const locationLabel = cleanText(body.locationLabel, 160);
    const latitude = coordinate(body.latitude, -90, 90, "Latitude");
    const longitude = coordinate(body.longitude, -180, 180, "Longitude");
    if ((latitude === null) !== (longitude === null)) return jsonError("Latitude and longitude must be set together");
    const settings = await updateControllerSettings({ displayName, locationLabel, latitude, longitude });
    await addAudit({ actorUserId: user.id, action: "controller.settings.updated", targetType: "controller", targetId: "primary", metadata: { locationLabel, latitude, longitude } });
    return NextResponse.json({ ...(await controllerInfo()), settings });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to update Controller settings", 409);
  }
}
