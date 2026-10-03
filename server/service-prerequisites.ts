import { lookup } from "node:dns/promises";
import { dbQuery } from "./db";
import { realitySettings, configureReality } from "./reality";
import { realityDefaults } from "./reality-defaults";
import { pickRealityCandidate, type RealityProbe } from "./reality-candidates";
import { selectTarget, targetAddresses } from "./reality-target-check.mjs";

/** The target a node would get right now, or a reason it has to wait. */
export async function defaultRealityTarget(nodeId: string): Promise<{ serverName?: string; reason?: string }> {
  const defaults = await realityDefaults();
  if (defaults.mode === "custom") return defaults.serverName ? { serverName: defaults.serverName } : { reason: "请先在 VPN 服务中设置自建 REALITY 目标，或改用自动选择" };
  const node = (await dbQuery<{ agent_capabilities_json: string | null }>("SELECT agent_capabilities_json FROM nodes WHERE id=$1", [nodeId]))[0];
  let probe: RealityProbe | undefined;
  try { probe = (JSON.parse(node?.agent_capabilities_json || "{}") as { realityProbe?: RealityProbe }).realityProbe; } catch { probe = undefined; }
  const serverName = pickRealityCandidate(nodeId, probe);
  return serverName ? { serverName } : { reason: probe?.checkedAt ? "节点无法连通任何候选 REALITY 目标，请检查节点出站 443" : "等待节点上报 REALITY 目标探测结果（Agent 2.9+，约 1 分钟）" };
}

/** A management host can also be a VPN node, but never its own REALITY target on the same :443. */
export async function assertTargetNotOnNode(nodeId: string, serverName: string, listenPort: number) {
  if (listenPort !== 443) return;
  const node = (await dbQuery<{ ip: string; public_endpoint: string | null }>("SELECT ip,public_endpoint FROM nodes WHERE id=$1", [nodeId]))[0];
  if (!node) throw new Error("Node not found");
  const addresses = await targetAddresses(serverName);
  const endpoints = [...new Set([node.ip, node.public_endpoint].filter((value): value is string => typeof value === "string" && Boolean(value)))];
  const local = (await Promise.all(endpoints.map((host) => lookup(host, { all: true }).catch(() => [])))).flat().map((row) => row.address);
  if (local.some((address) => addresses.includes(address))) throw new Error("REALITY 目标与节点是同一台服务器，不能同时使用 443。请改用自动选择、独立目标，或调整该节点端口；其他协议不受影响。");
}

/** Shared by initial bootstrap, policy rollout and normal desired-state reconciliation. */
export async function ensureRealityService(nodeId: string, listenPort: number) {
  const existing = await realitySettings(nodeId);
  if (existing) return existing;
  const target = await defaultRealityTarget(nodeId);
  if (!target.serverName) throw new Error(target.reason);
  const name = selectTarget("", undefined, target.serverName);
  await assertTargetNotOnNode(nodeId, name, listenPort);
  // Never overwrite a key/target another concurrent operation has just created.
  await configureReality(nodeId, name, { onlyIfMissing: true });
  return (await realitySettings(nodeId))!;
}
