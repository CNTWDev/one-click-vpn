import { NextResponse } from "next/server";
import { controllerId } from "../../../../../server/agent-domain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Lets Console confirm that an Agent domain reaches this deployment before nodes are told to use it. */
export async function GET() {
  return NextResponse.json({ controllerId: controllerId() }, { headers: { "Cache-Control": "no-store" } });
}
