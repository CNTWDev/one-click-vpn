import { NextResponse } from "next/server";
import { currentUser } from "../../../../../../server/auth";
import { findConnectionProfile } from "../../../../../../server/control-db";
import { activateProfile, publicProfile } from "../../../../../../server/control-plane";
import { jsonError } from "../../../../../../server/http";

export const runtime = "nodejs";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return jsonError("Authentication required", 401);
  const { id } = await context.params;
  const profile = await findConnectionProfile(id);
  if (!profile) return jsonError("Connection profile not found", 404);
  const activated = await activateProfile(id, user.id);
  return NextResponse.json({ profile: publicProfile(activated) });
}
