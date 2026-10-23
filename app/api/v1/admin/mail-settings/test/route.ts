import { NextResponse } from "next/server";
import { jsonError } from "../../../../../../server/http";
import { sendMail } from "../../../../../../server/mail";
import { requestAdmin } from "../../../../../../server/request-auth";

export const runtime = "nodejs";

/** Sends a test message to the signed-in administrator and returns the SMTP error verbatim when it fails. */
export async function POST(request: Request) {
  const admin = await requestAdmin(request);
  if (!admin) return jsonError("Administrator authentication required", 403);
  try {
    await sendMail({ to: admin.email, subject: "Veilbird test email", text: "Mail delivery works. Users can now reset a forgotten password from the Portal sign-in page." });
    return NextResponse.json({ to: admin.email });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to send email", 502);
  }
}
