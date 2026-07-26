import { randomUUID } from "node:crypto";
import { addAudit, dbExec, dbQuery } from "./db";
import {
  listControlNodes,
  listNodeProtocols,
  listVpnServices,
  updateVpnServiceState,
  upsertVpnService,
  type Protocol,
} from "./control-db";
import { rebuildDesiredState } from "./control-plane";
import { listProtocolAdapters } from "./protocols/registry";

export const STANDARD_POLICY_VERSION = 1;
export type DeploymentPolicy = "standard" | "custom" | "agent-only";

function now(): string {
  return new Date().toISOString();
}

export function standardProtocolAdapters() {
  return listProtocolAdapters().filter((adapter) => adapter.capability.status === "enabled" && adapter.service.standard);
}

export async function setNodeDeploymentPolicy(nodeId: string, policy: DeploymentPolicy, version: number): Promise<void> {
  await dbExec("UPDATE nodes SET deployment_policy = $1, policy_version = $2, updated_at = $3 WHERE id = $4", [policy, version, now(), nodeId]);
}

async function standardPolicyDrift() {
  const protocols = standardProtocolAdapters().map((adapter) => adapter.id);
  const services = await listVpnServices();
  const capabilities = await listNodeProtocols();
  return (await listControlNodes()).flatMap((node) => {
    if ((node.deployment_policy || "standard") !== "standard") return [];
    const missingProtocols = protocols.filter((protocol) => !services.some((service) => service.node_id === node.id && service.protocol === protocol && service.enabled && service.status === "healthy"));
    if (Number(node.policy_version || 0) >= STANDARD_POLICY_VERSION && !missingProtocols.length) return [];
    const heartbeatAt = node.last_heartbeat_at ? new Date(node.last_heartbeat_at).getTime() : 0;
    const fresh = node.status === "online" && heartbeatAt > 0 && Date.now() - heartbeatAt < 90_000;
    const unsupported = protocols.filter((protocol) => !capabilities.some((capability) => capability.node_id === node.id && capability.protocol === protocol && capability.status === "enabled"));
    const reason = !fresh ? "A fresh authenticated Agent heartbeat is required"
      : unsupported.length ? `Agent runtime does not advertise: ${unsupported.join(", ")}` : "Ready";
    return [{ node, missingProtocols, eligible: fresh && !unsupported.length, reason }];
  });
}

export async function deploymentPolicyOverview() {
  await refreshPolicyRollouts();
  const nodes = await listControlNodes();
  const drift = await standardPolicyDrift();
  const rollouts = await dbQuery<Record<string, unknown>>("SELECT * FROM policy_rollouts ORDER BY created_at DESC LIMIT 10");
  const standardNodes = nodes.filter((node) => (node.deployment_policy || "standard") === "standard");
  return {
    standard: {
      version: STANDARD_POLICY_VERSION,
      protocols: standardProtocolAdapters().map((adapter) => ({
        protocol: adapter.id, transport: adapter.service.defaultTransport,
        listenPort: adapter.service.defaultListenPort, configSchemaVersion: adapter.capability.configSchemaVersion,
      })),
    },
    counts: {
      totalNodes: nodes.length,
      standardNodes: standardNodes.length,
      customNodes: nodes.filter((node) => node.deployment_policy === "custom").length,
      agentOnlyNodes: nodes.filter((node) => node.deployment_policy === "agent-only").length,
      driftedNodes: drift.length,
      eligibleNodes: drift.filter((item) => item.eligible).length,
      blockedNodes: drift.filter((item) => !item.eligible).length,
    },
    driftedNodes: drift.map(({ node, missingProtocols, eligible, reason }) => ({
      id: node.id, name: node.name, currentVersion: Number(node.policy_version || 0), status: node.status,
      missingProtocols, eligible, reason,
    })),
    rollouts: rollouts.map((row) => ({
      id: String(row.id), fromVersion: Number(row.from_version), toVersion: Number(row.to_version), mode: String(row.mode),
      status: String(row.status), protocols: JSON.parse(String(row.protocols_json || "[]")) as Protocol[],
      totalTargets: Number(row.total_targets), queuedTargets: Number(row.queued_targets), succeededTargets: Number(row.succeeded_targets),
      blockedTargets: Number(row.blocked_targets), failedTargets: Number(row.failed_targets),
      createdAt: String(row.created_at), finishedAt: row.finished_at ? String(row.finished_at) : null,
    })),
  };
}

async function refreshPolicyRollouts(): Promise<void> {
  const rollouts = await dbQuery<{ id: string; protocols_json: string }>("SELECT id, protocols_json FROM policy_rollouts WHERE status IN ('reconciling', 'reconciling_with_errors')");
  if (!rollouts.length) return;
  const services = await listVpnServices();
  const nodes = await listControlNodes();
  for (const rollout of rollouts) {
    const protocols = JSON.parse(rollout.protocols_json || "[]") as Protocol[];
    const targets = await dbQuery<{ node_id: string; status: string }>("SELECT node_id, status FROM policy_rollout_targets WHERE rollout_id = $1", [rollout.id]);
    let succeeded = 0;
    let blocked = 0;
    let failed = 0;
    let queued = 0;
    for (const target of targets) {
      if (target.status === "failed") { failed += 1; continue; }
      const node = nodes.find((item) => item.id === target.node_id);
      const heartbeatAt = node?.last_heartbeat_at ? new Date(node.last_heartbeat_at).getTime() : 0;
      if (!node || node.status !== "online" || !heartbeatAt || Date.now() - heartbeatAt >= 90_000) {
        blocked += 1;
        if (target.status !== "blocked") await dbExec("UPDATE policy_rollout_targets SET status = 'blocked', error = $1, updated_at = $2 WHERE rollout_id = $3 AND node_id = $4", ["Agent heartbeat expired during rollout", now(), rollout.id, target.node_id]);
        continue;
      }
      const targetServices = protocols.map((protocol) => services.find((service) => service.node_id === target.node_id && service.protocol === protocol));
      const status = targetServices.every((service) => service?.enabled && service.status === "healthy") ? "succeeded"
        : targetServices.some((service) => service?.status === "attention" || service?.status === "unsupported") ? "blocked" : "queued";
      if (status === "succeeded") succeeded += 1;
      else if (status === "blocked") blocked += 1;
      else queued += 1;
      if (target.status !== status) await dbExec("UPDATE policy_rollout_targets SET status = $1, updated_at = $2 WHERE rollout_id = $3 AND node_id = $4", [status, now(), rollout.id, target.node_id]);
    }
    const finished = queued === 0;
    const status = finished ? blocked || failed ? "completed_with_errors" : "completed" : failed ? "reconciling_with_errors" : "reconciling";
    await dbExec(`UPDATE policy_rollouts SET status = $1, queued_targets = $2, succeeded_targets = $3,
      blocked_targets = $4, failed_targets = $5, finished_at = $6 WHERE id = $7`, [status, queued, succeeded, blocked, failed, finished ? now() : null, rollout.id]);
  }
}

export async function rolloutStandardPolicy(input: { actorUserId: string; mode: "canary" | "batch"; limit?: number; nodeIds?: string[] }) {
  const active = (await dbQuery<{ id: string }>("SELECT id FROM policy_rollouts WHERE status IN ('running', 'reconciling', 'reconciling_with_errors') LIMIT 1"))[0];
  if (active) throw new Error("Another Standard policy rollout is still reconciling");
  const drift = await standardPolicyDrift();
  const requested = input.nodeIds?.length ? new Set(input.nodeIds) : null;
  const maximum = input.mode === "canary" ? 1 : Math.min(Math.max(input.limit || 25, 1), 100);
  const targets = drift.filter((item) => item.eligible && (!requested || requested.has(item.node.id))).map((item) => item.node).slice(0, maximum);
  const rolloutId = `rollout_${randomUUID()}`;
  const timestamp = now();
  const adapters = standardProtocolAdapters();
  const fromVersion = targets.length ? Math.min(...targets.map((node) => Number(node.policy_version || 0))) : STANDARD_POLICY_VERSION;
  await dbExec(`INSERT INTO policy_rollouts
    (id, from_version, to_version, mode, status, protocols_json, total_targets, queued_targets, failed_targets, created_by, created_at, started_at)
    VALUES ($1, $2, $3, $4, 'running', $5, $6, 0, 0, $7, $8, $8)`, [
    rolloutId, fromVersion, STANDARD_POLICY_VERSION, input.mode, JSON.stringify(adapters.map((adapter) => adapter.id)), targets.length, input.actorUserId, timestamp,
  ]);

  let queued = 0;
  let failed = 0;
  for (const node of targets) {
    await dbExec("INSERT INTO policy_rollout_targets (rollout_id, node_id, status, updated_at) VALUES ($1, $2, 'running', $3)", [rolloutId, node.id, now()]);
    try {
      const capabilities = await listNodeProtocols(node.id);
      for (const adapter of adapters) {
        const existing = (await listVpnServices(node.id)).find((service) => service.protocol === adapter.id);
        const needsApply = !existing?.enabled || existing.status !== "healthy";
        await upsertVpnService({
          nodeId: node.id, protocol: adapter.id, enabled: true,
          transport: existing?.transport || adapter.service.defaultTransport,
          listenPort: existing?.listen_port || adapter.service.defaultListenPort,
          subnet: existing?.subnet || adapter.service.defaultSubnet,
          dns: existing?.dns || adapter.service.defaultDns,
          status: needsApply ? "pending" : "healthy",
        });
        if (!needsApply) continue;
        const capability = capabilities.find((item) => item.protocol === adapter.id);
        if (!capability || capability.status !== "enabled") {
          await updateVpnServiceState(node.id, adapter.id, { status: "unsupported", lastError: "Upgrade or repair the Agent before retrying this policy rollout" });
          continue;
        }
        await updateVpnServiceState(node.id, adapter.id, { status: "deploying" });
        await rebuildDesiredState(node.id, adapter.id, { force: true });
      }
      await setNodeDeploymentPolicy(node.id, "standard", STANDARD_POLICY_VERSION);
      await dbExec("UPDATE policy_rollout_targets SET status = 'queued', updated_at = $1 WHERE rollout_id = $2 AND node_id = $3", [now(), rolloutId, node.id]);
      queued += 1;
    } catch (error) {
      failed += 1;
      await dbExec("UPDATE policy_rollout_targets SET status = 'failed', error = $1, updated_at = $2 WHERE rollout_id = $3 AND node_id = $4", [error instanceof Error ? error.message.slice(-2000) : String(error).slice(-2000), now(), rolloutId, node.id]);
    }
  }
  const status = queued ? failed ? "reconciling_with_errors" : "reconciling" : failed ? "failed" : "completed";
  await dbExec("UPDATE policy_rollouts SET status = $1, queued_targets = $2, failed_targets = $3, finished_at = $4 WHERE id = $5", [status, queued, failed, queued ? null : now(), rolloutId]);
  await addAudit({ actorUserId: input.actorUserId, action: "deployment_policy.rollout", targetType: "policy_rollout", targetId: rolloutId, metadata: { mode: input.mode, targets: targets.length, queued, failed, version: STANDARD_POLICY_VERSION } });
  return { id: rolloutId, status, totalTargets: targets.length, queuedTargets: queued, failedTargets: failed };
}
