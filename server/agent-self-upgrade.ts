import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { wakeAgent } from "./agent-wake";

// Agents 2.17+ upgrade themselves: the Console's 升级 Agent hands them the target version and the source's
// SHA-256 with their next task pull, and they fetch the source over their own authenticated channel
// (app/api/v1/agent/source). No SSH and no stored credential are needed. Staging and the 90 s rollback
// timer are the same as the SSH path (server/agent-upgrade.ts).
const pending = new Map<string, { version: string; sha256: string; at: number }>();
const DELIVERY_MS = 2 * 60_000;

export function agentRelease(): { source: string; version: string; sha256: string } {
  const source = readFileSync(path.join(process.cwd(), "agent", "agent.py"), "utf8");
  const version = source.match(/"version":\s*"(agent [\d.]+)"/)?.[1];
  if (!version) throw new Error("Controller Agent release version is unavailable");
  return { source, version, sha256: createHash("sha256").update(source).digest("hex") };
}

export function supportsSelfUpgrade(capabilities: Record<string, unknown> | undefined): boolean {
  return capabilities?.selfUpgrade === 1;
}

export function requestSelfUpgrade(nodeId: string): { version: string; sha256: string } {
  const { version, sha256 } = agentRelease();
  pending.set(nodeId, { version, sha256, at: Date.now() });
  wakeAgent(nodeId);
  return { version, sha256 };
}

/** Handed out once, with the next pull of an Agent that can upgrade itself. */
export function takeSelfUpgradeFor(nodeId: string): { version: string; sha256: string } | undefined {
  const request = pending.get(nodeId);
  if (!request) return undefined;
  pending.delete(nodeId);
  if (Date.now() - request.at > DELIVERY_MS) return undefined;
  return { version: request.version, sha256: request.sha256 };
}
