import { lookup } from "node:dns/promises";
import { dbQuery } from "./db";
import { realitySettings, configureReality } from "./reality";
import { realityDefaults } from "./reality-defaults";
import { selectTarget, targetAddresses } from "./reality-target-check.mjs";

/** Shared by initial bootstrap, policy rollout and normal desired-state reconciliation. */
export async function ensureRealityService(nodeId: string, listenPort: number) {
  const existing = await realitySettings(nodeId);
  if (existing) return existing;
  const name = selectTarget("", undefined, (await realityDefaults()).serverName);
  if (listenPort === 443) {
    const node = (await dbQuery<{ ip: string; public_endpoint: string | null }>("SELECT ip,public_endpoint FROM nodes WHERE id=$1", [nodeId]))[0];
    if (!node) throw new Error("Node not found");
    const addresses = await targetAddresses(name);
    const endpoints = [...new Set([node.ip, node.public_endpoint].filter((value): value is string => typeof value === "string" && Boolean(value)))];
    const local = (await Promise.all(endpoints.map((host) => lookup(host, { all: true })))).flat().map((row) => row.address);
    if (local.some((address) => addresses.includes(address))) throw new Error("REALITY 目标与节点共用 443，请使用独立节点或调整该节点监听端口；其他协议不受影响。");
  }
  // Never overwrite a key/target another concurrent operation has just created.
  await configureReality(nodeId, name, { onlyIfMissing: true });
  return (await realitySettings(nodeId))!;
}
