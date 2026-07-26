import { NextResponse } from "next/server";
import { addAudit, insertRegion, listRegions } from "../../../server/db";
import { currentUser } from "../../../server/auth";
import { cleanText, jsonError, readJson } from "../../../server/http";

export const runtime = "nodejs";

export async function GET() {
  const user = await currentUser();
  if (!user) return jsonError("Authentication required", 401);
  return NextResponse.json({ regions: await listRegions() });
}

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return jsonError("Authentication required", 401);
  try {
    const body = await readJson(request);
    const name = cleanText(body.name, 80);
    const country = cleanText(body.country, 80);
    const code = cleanText(body.code, 8).toUpperCase();
    const id = (cleanText(body.id, 80) || `${name}-${country}`).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!id || !name || !country || !code) return jsonError("Region name, country, and code are required");
    if (!/^[A-Z]{2,8}$/.test(code)) return jsonError("Region code must contain 2 to 8 letters");
    const region = await insertRegion({ id, name, country, code });
    await addAudit({ actorUserId: user.id, action: "region.created", targetType: "region", targetId: id });
    return NextResponse.json({ region }, { status: 201 });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to create region");
  }
}
