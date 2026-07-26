import { NextResponse } from "next/server";
import { authenticateAgent } from "../../../../../server/agent";
import { cleanText, jsonError, readJson } from "../../../../../server/http";
import { writeOperationalLog } from "../../../../../server/operational-logs";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await readJson(request);
    const nodeId = cleanText(body.nodeId, 128);
    const token = cleanText(body.token, 512);
    if (!(await authenticateAgent(nodeId, token))) return jsonError("Invalid agent credentials", 401);
    const entries = Array.isArray(body.entries) ? body.entries.slice(0, 20) : [];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const value = entry as Record<string, unknown>;
      const message = cleanText(value.message, 4_000);
      const level = cleanText(value.level, 16);
      if (message) void writeOperationalLog({ nodeId, component: "agent", level: level === "error" ? "error" : level === "warning" ? "warning" : "info", message });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to record Agent logs");
  }
}
