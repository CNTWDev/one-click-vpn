import { NextResponse } from "next/server";
import { cleanText, jsonError, readJson } from "../../../../../server/http";
import { agentTokenFromRequest, authenticateAgent, recordAgentHeartbeat } from "../../../../../server/agent";
import { ensureDefaultNodeProtocols } from "../../../../../server/control-plane";
import { listNodeProtocols, upsertNodeProtocol, type Platform, type Protocol } from "../../../../../server/control-db";
import { getProtocolAdapter, listProtocolAdapters } from "../../../../../server/protocols/registry";
import { reconcileEnabledVpnServices } from "../../../../../server/vpn-services";
import { recordTrafficSnapshots, type UsageSnapshot } from "../../../../../server/traffic";

export const runtime = "nodejs";

const supportedProtocols = new Set<Protocol>(listProtocolAdapters().map((adapter) => adapter.id));
const supportedPlatforms: Platform[] = ["web", "macos", "ios", "android", "windows", "linux"];

function activeSessionCount(snapshots: UsageSnapshot[]): number {
  const cutoff = Date.now() - 180_000;
  const active = new Set<string>();
  for (const snapshot of snapshots) {
    if (!snapshot.identityKey) continue;
    if (snapshot.protocol === "openvpn") active.add(`openvpn:${snapshot.identityKey}`);
    if (snapshot.protocol === "wireguard" && snapshot.lastHandshakeAt) {
      const handshake = new Date(snapshot.lastHandshakeAt).getTime();
      if (Number.isFinite(handshake) && handshake >= cutoff) active.add(`wireguard:${snapshot.identityKey}`);
    }
  }
  return active.size;
}

export async function POST(request: Request) {
  try {
    const body = await readJson(request);
    const nodeId = cleanText(body.nodeId, 128);
    const token = agentTokenFromRequest(request, cleanText(body.token, 512));
    const node = await authenticateAgent(nodeId, token);
    if (!node) return jsonError("Invalid agent credentials", 401);
    const capabilities = body.capabilities && typeof body.capabilities === "object" && !Array.isArray(body.capabilities)
      ? body.capabilities as Record<string, unknown>
      : {};
    const usageSnapshots = Array.isArray(body.usageSnapshots) ? body.usageSnapshots.filter((value): value is UsageSnapshot => Boolean(value && typeof value === "object" && !Array.isArray(value))) : [];
    await recordAgentHeartbeat({
      nodeId,
      version: cleanText(body.version, 64),
      hostname: cleanText(body.hostname, 256),
      publicEndpoint: cleanText(body.publicEndpoint, 256),
      serverPublicKey: cleanText(body.serverPublicKey, 512),
      capabilities,
      metrics: body.metrics,
      activeUsers: activeSessionCount(usageSnapshots),
    });
    await recordTrafficSnapshots(nodeId, usageSnapshots);
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
    await reconcileEnabledVpnServices(nodeId);
    return NextResponse.json({ ok: true, nextPollSeconds: 5 });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Invalid heartbeat");
  }
}
