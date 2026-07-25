import { timingSafeEqual } from "node:crypto";
import { findNode, updateNode } from "./db";
import { hashToken } from "./crypto";
import { updateNodeControlMetadata } from "./control-db";

function tokenMatches(provided: string, expectedHash: string | null): boolean {
  if (!expectedHash) return false;
  const actual = Buffer.from(hashToken(provided), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function authenticateAgent(nodeId: string, token: string) {
  const node = findNode(nodeId);
  if (!node || !tokenMatches(token, node.agent_token_hash)) return null;
  return node;
}

export function recordAgentHeartbeat(input: {
  nodeId: string;
  version?: string;
  hostname?: string;
  publicEndpoint?: string;
  serverPublicKey?: string;
  capabilities?: Record<string, unknown>;
}): void {
  updateNode(input.nodeId, {
    status: "online",
    last_seen: "now",
    latency: "connected",
    version: input.version || "unknown",
  });
  updateNodeControlMetadata(input.nodeId, {
    publicEndpoint: input.publicEndpoint,
    serverPublicKey: input.serverPublicKey,
    capabilities: {
      hostname: input.hostname || "",
      ...(input.capabilities || {}),
    },
  });
}
