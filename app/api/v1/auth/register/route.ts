import { NextResponse } from "next/server";
import { createPendingUser, findUserByEmail, addAudit } from "../../../../../server/db";
import { hashPasswordAsync } from "../../../../../server/password";
import { cleanText, jsonError, readJson } from "../../../../../server/http";
import { allowRegistration } from "../../../../../server/rate-limit";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    if (!allowRegistration(request)) return jsonError("Too many registration attempts", 429);
    const body = await readJson(request);
    const email = cleanText(body.email, 320).toLowerCase();
    const displayName = cleanText(body.displayName, 120);
    const password = typeof body.password === "string" ? body.password : "";
    if (!/^\S+@\S+\.\S+$/.test(email)) return jsonError("A valid email is required");
    if (displayName.length < 2) return jsonError("A display name is required");
    if (password.length < 12) return jsonError("Password must be at least 12 characters");
    // Hash first and answer identically either way, so the endpoint cannot be used to probe which emails exist.
    const passwordHash = await hashPasswordAsync(password);
    const existing = await findUserByEmail(email);
    if (existing) {
      await addAudit({ actorUserId: existing.id, action: "auth.register.duplicate", targetType: "user", targetId: existing.id });
    } else {
      const user = await createPendingUser({ email, displayName, passwordHash });
      await addAudit({ actorUserId: user.id, action: "auth.registered", targetType: "user", targetId: user.id });
    }
    return NextResponse.json({ status: "received", email, message: "Registration received. An administrator must approve the account before VPN access is available." }, { status: 202 });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to register");
  }
}
