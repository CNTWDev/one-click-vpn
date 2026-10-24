import { NextResponse } from "next/server";
import { addAudit, findUserByEmail } from "../../../../../server/db";
import { cleanText, jsonError, readJson } from "../../../../../server/http";
import { mailConfigured, passwordResetMail, sendMail } from "../../../../../server/mail";
import { writeOperationalLog } from "../../../../../server/operational-logs";
import { createResetLink, EMAIL_LINK_TTL_SECONDS } from "../../../../../server/password-reset";
import { allowPasswordResetRequest } from "../../../../../server/rate-limit";
import { siteBrand, siteForRequest } from "../../../../../server/sites";

export const runtime = "nodejs";

/** Tells the Portal whether "forgot password" can send an email or the user must ask an administrator. */
export async function GET() {
  return NextResponse.json({ email: await mailConfigured() });
}

export async function POST(request: Request) {
  try {
    if (!(await mailConfigured())) return jsonError("Email delivery is not configured", 503);
    const body = await readJson(request);
    const email = cleanText(body.email, 320).toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) return jsonError("A valid email is required");
    if (!allowPasswordResetRequest(request, email)) return jsonError("Too many requests", 429);
    const user = await findUserByEmail(email);
    const site = await siteForRequest(request);
    if (user && (user.status === "active" || user.status === "pending")) {
      // Sent in the background and answered identically either way, so the reply never reveals whether the email exists.
      void (async () => {
        try {
          const link = await createResetLink(user.id, EMAIL_LINK_TTL_SECONDS, siteBrand(site).portalOrigin);
          if (!link) return;
          await sendMail({ to: user.email, fromName: site.mailFromName, ...passwordResetMail(body.language, link.url, site.name) });
          await addAudit({ actorUserId: user.id, action: "auth.password_reset.requested", targetType: "user", targetId: user.id });
        } catch (error) {
          await writeOperationalLog({ component: "controller", level: "error", message: `Password reset email failed: ${error instanceof Error ? error.message : String(error)}` });
        }
      })();
    }
    return NextResponse.json({ status: "received" }, { status: 202 });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Invalid request");
  }
}
