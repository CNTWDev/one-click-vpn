import { NextResponse } from "next/server";
import { findNode, updateNode } from "../../../../server/db";
import { hashToken } from "../../../../server/crypto";
import { cleanText, jsonError, readJson } from "../../../../server/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await readJson(request);
    const nodeId = cleanText(body.nodeId, 80);
    const token = cleanText(body.token, 256);
    const node = findNode(nodeId);
    if (!node || !node.agent_token_hash || hashToken(token) !== node.agent_token_hash) return jsonError("Invalid agent credentials", 401);
    updateNode(nodeId, { status: "online", last_seen: "now", version: cleanText(body.version, 64) || node.version, latency: "connected" });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Invalid heartbeat");
  }
}
