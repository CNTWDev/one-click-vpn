import { NextResponse } from "next/server";
import { createPendingUser, findUserByEmail, addAudit } from "../../../../../server/db";
import { hashPassword } from "../../../../../server/password";
import { publicUser } from "../../../../../server/device-auth";
import { cleanText, jsonError, readJson } from "../../../../../server/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await readJson(request);
    const email = cleanText(body.email, 320).toLowerCase();
    const displayName = cleanText(body.displayName, 120);
    const password = typeof body.password === "string" ? body.password : "";
    if (!/^\S+@\S+\.\S+$/.test(email)) return jsonError("A valid email is required");
    if (displayName.length < 2) return jsonError("A display name is required");
    if (password.length < 12) return jsonError("Password must be at least 12 characters");
    if (await findUserByEmail(email)) return jsonError("An account with this email already exists", 409);
    const user = await createPendingUser({ email, displayName, passwordHash: hashPassword(password) });
    await addAudit({ actorUserId: user.id, action: "auth.registered", targetType: "user", targetId: user.id });
    return NextResponse.json({ user: publicUser(user), message: "Registration received. An administrator must approve the account before VPN access is available." }, { status: 201 });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to register");
  }
}
