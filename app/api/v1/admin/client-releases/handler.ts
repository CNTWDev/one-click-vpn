import { NextResponse } from "next/server";
import { readJson } from "../../../../../server/http";
import { ReleaseError, releaseActor, type ReleaseActor } from "../../../../../server/client-releases";

/** Shared wrapper: release token or administrator, JSON body, stable error codes for the console and CI. */
export async function releaseRoute(request: Request, work: (actor: ReleaseActor, body: Record<string, unknown>) => Promise<unknown>, options: { rawBody?: boolean } = {}) {
  const headers = { "Cache-Control": "no-store" };
  try {
    const actor = await releaseActor(request);
    if (!actor) return NextResponse.json({ code: "ADMIN_REQUIRED", error: "ADMIN_REQUIRED" }, { status: 403, headers });
    const body = options.rawBody || request.method === "GET" || request.method === "DELETE" ? {} : await readJson(request);
    return NextResponse.json(await work(actor, body), { headers });
  } catch (error) {
    if (error instanceof ReleaseError) return NextResponse.json({ code: error.code.split(":")[0], error: error.code }, { status: error.status, headers });
    if (error instanceof Error && error.message.startsWith("Request body")) return NextResponse.json({ code: "INVALID_REQUEST", error: error.message }, { status: 400, headers });
    console.error("Client release operation failed", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ code: "SERVICE_UNAVAILABLE", error: "SERVICE_UNAVAILABLE" }, { status: 503, headers });
  }
}
