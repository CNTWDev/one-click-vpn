import { NextResponse } from "next/server";
import { cleanText, jsonError, readJson } from "../../../../../server/http";
import { authenticateAgent, recordAgentHeartbeat } from "../../../../../server/agent";
import { ensureDefaultNodeProtocols } from "../../../../../server/control-plane";
import { listNodeProtocols, upsertNodeProtocol, type Platform, type Protocol } from "../../../../../server/control-db";
import { getProtocolAdapter } from "../../../../../server/protocols/registry";

export const runtime = "nodejs";

const supportedProtocols = new Set<Protocol>(["wireguard", "openvpn", "ikev2"]);
const supportedPlatforms: Platform[] = ["macos", "ios", "android"];

export async function POST(request: Request) {
  try {
    const body = await readJson(request);
    const nodeId = cleanText(body.nodeId, 128);
    const token = cleanText(body.token, 512);
    const node = await authenticateAgent(nodeId, token);
    if (!node) return jsonError("Invalid agent credentials", 401);
    const capabilities = body.capabilities && typeof body.capabilities === "object" && !Array.isArray(body.capabilities)
      ? body.capabilities as Record<string, unknown>
      : {};
    await recordAgentHeartbeat({
      nodeId,
      version: cleanText(body.version, 64),
      hostname: cleanText(body.hostname, 256),
      publicEndpoint: cleanText(body.publicEndpoint, 256),
      serverPublicKey: cleanText(body.serverPublicKey, 512),
      capabilities,
    });
    const protocols = Array.isArray(capabilities.protocols) ? capabilities.protocols.filter((value): value is Protocol => typeof value === "string" && supportedProtocols.has(value as Protocol)) : [];
    if (!protocols.length) {
      const knownProtocols = await listNodeProtocols(nodeId);
      if (!knownProtocols.length) await ensureDefaultNodeProtocols(nodeId);
      for (const current of await listNodeProtocols(nodeId)) {
        await upsertNodeProtocol({
          nodeId,
          protocol: current.protocol,
          transports: current.transports,
          platforms: current.platforms,
          routing: current.routing,
          ipv6: current.ipv6,
          minClientVersion: current.min_client_version,
          configSchemaVersion: current.config_schema_version,
          status: "unavailable",
        });
      }
    } else {
      for (const protocol of supportedProtocols) {
        const adapter = getProtocolAdapter(protocol);
        const available = protocols.includes(protocol);
        await upsertNodeProtocol({
          nodeId,
          protocol,
          transports: adapter.capability.transports,
          platforms: supportedPlatforms,
          routing: adapter.capability.routing,
          ipv6: adapter.capability.ipv6,
          minClientVersion: adapter.capability.minClientVersion,
          configSchemaVersion: adapter.capability.configSchemaVersion,
          status: available ? adapter.capability.status : "unavailable",
        });
      }
    }
    return NextResponse.json({ ok: true, nextPollSeconds: 5 });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Invalid heartbeat");
  }
}
