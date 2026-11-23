import { statfs } from "node:fs/promises";
import { dbExec, dbQuery, getControllerSettings } from "./db";
import { mailConfigured, sendMail } from "./mail";
import { agentRelease } from "./agent-self-upgrade";
import { listSites, siteBrand } from "./sites";
import { PRODUCT_NAME } from "../shared/brand-name";
import { writeOperationalLog } from "./operational-logs";
import { heldNodes } from "./node-health";

// Email alerts to the addresses in Console → Controller → 告警通知, through the mail settings there.
// Every minute each rule lists what is wrong right now. A problem is mailed once it has lasted the rule's
// delay, and once more when it is gone; nothing repeats while it lasts. State lives in alert_states, so a
// Controller restart neither repeats an alert nor forgets one.

// kind + subject let Console show the problem in its own language; title and detail are the (Chinese) email text.
type Problem = { key: string; kind: "node-offline" | "service" | "agent-outdated" | "disk" | "transport-blocked" | "node-drained" | "node-drain-held"; subject: string; title: string; detail: string; delayMinutes: number };
type Row = { key: string; firing_since: Date; notified_at: Date | null; detail: string };

const startedAt = Date.now();
const MINUTE = 60_000;

export function alertRecipients(value: string): string[] {
  return [...new Set(value.split(/[\s,;，；]+/).map((item) => item.trim().toLowerCase()).filter(Boolean))];
}

export function validateAlertRecipients(value: unknown): string {
  const list = alertRecipients(String(value ?? ""));
  if (list.length > 10) throw new Error("At most 10 alert recipients");
  for (const address of list) if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new Error(`${address} is not a valid email address`);
  return list.join(", ");
}

async function nodeProblems(): Promise<Problem[]> {
  const problems: Problem[] = [];
  // Right after a Controller start every node looks silent: give heartbeats three minutes to arrive.
  if (Date.now() - startedAt > 3 * MINUTE) {
    const silent = await dbQuery<{ id: string; name: string; last_heartbeat_at: string }>(`SELECT id, name, last_heartbeat_at FROM nodes
      WHERE agent_token_hash IS NOT NULL AND last_heartbeat_at IS NOT NULL AND last_heartbeat_at::timestamptz < now() - interval '3 minutes'`);
    for (const node of silent) problems.push({ key: `node-offline:${node.id}`, kind: "node-offline", subject: node.name, title: `节点离线：${node.name}`, detail: `最后心跳 ${node.last_heartbeat_at}`, delayMinutes: 0 });
  }
  const failing = await dbQuery<{ node_id: string; name: string; protocol: string; last_error: string }>(`SELECT s.node_id, n.name, s.protocol, s.last_error
    FROM vpn_services s JOIN nodes n ON n.id = s.node_id WHERE s.enabled = 1 AND s.status = 'attention'`);
  for (const service of failing) problems.push({ key: `service:${service.node_id}:${service.protocol}`, kind: "service", subject: `${service.name} ${service.protocol}`, title: `协议同步失败：${service.name} ${service.protocol}`,
    detail: service.last_error.slice(0, 300) || "状态为 attention", delayMinutes: 10 });
  // Removed automatically (node-health.ts): reported at once, and as recovered when it is back in service.
  const drained = await dbQuery<{ id: string; name: string; drained_at: string; drain_locked: number }>("SELECT id, name, drained_at, drain_locked FROM nodes WHERE drained_at IS NOT NULL");
  for (const node of drained) problems.push({ key: `node-drained:${node.id}`, kind: "node-drained", subject: node.name, title: `节点已自动摘除：${node.name}`,
    detail: `控制面从外部连续 3 分钟连不上它的任何线路，15 分钟内也没有用户连上过。已停止给新连接下发，现有连接不受影响。${node.drain_locked ? "6 小时内已摘除 3 次，需要在 Console 手动恢复。" : "连续正常 10 分钟后自动放回。"}`, delayMinutes: 0 });
  const names = new Map((await dbQuery<{ id: string; name: string }>("SELECT id, name FROM nodes")).map((row) => [row.id, row.name]));
  for (const [id, why] of heldNodes) problems.push({ key: `node-drain-held:${id}`, kind: "node-drain-held", subject: names.get(id) || id, title: `节点连不上，但没有自动摘除：${names.get(id) || id}`,
    detail: why === "fleet" ? "摘除它会超过节点总数的一半，更可能是控制面自己的网络出了问题。" : "它是所在地区最后一个可用节点。", delayMinutes: 0 });
  const release = agentRelease().version;
  const behind = await dbQuery<{ name: string; version: string }>(`SELECT name, version FROM nodes
    WHERE agent_token_hash IS NOT NULL AND status = 'online' AND version LIKE 'agent %' AND version <> $1 ORDER BY name`, [release]);
  if (behind.length) problems.push({ key: "agent-outdated", kind: "agent-outdated", subject: behind.slice(0, 10).map((node) => node.name).join(", "), title: `${behind.length} 个节点的 Agent 不是最新版 ${release}`,
    detail: `${behind.slice(0, 10).map((node) => `${node.name}（${node.version}）`).join("、")}。在 Console 节点页点「升级 Agent」。`, delayMinutes: 24 * 60 });
  return problems;
}

const TRANSPORT_LABELS: Record<string, string> = { hysteria2: "Hysteria2", reality: "REALITY", "reality-alt": "REALITY 备用端口", xhttp: "XHTTP" };
// Console shows the subject in its own language: technical names only.
const TRANSPORT_NAMES: Record<string, string> = { hysteria2: "Hysteria2", reality: "REALITY", "reality-alt": "REALITY alt", xhttp: "XHTTP" };

/**
 * A line blocked at one node: in the last 24 hours, apps on at least 2 networks (half or more of those that
 * tried it there) could not reach this node's line while another line of the node answered, AND the same
 * line worked to another node from those same networks. The last part tells a block on this node's
 * address or port apart from a carrier that blocks the protocol everywhere (which no node change fixes).
 * Networks are the apps' one-way labels (carrier or Wi-Fi hash); nothing about users is read.
 */
export async function blockedTransports() {
  return dbQuery<{ node_id: string; name: string; transport: string; blocked: number; networks: number }>(`
    WITH recent AS (
      SELECT node_id, transport, network, ok_at, failed_at,
        failed_at > now() - interval '24 hours' AND failed_at > COALESCE(ok_at, 'epoch') AS failing
      FROM node_transport_reach
      WHERE network <> 'controller' AND transport <> 'wireguard'
        AND GREATEST(COALESCE(ok_at, 'epoch'), COALESCE(failed_at, 'epoch')) > now() - interval '24 hours')
    SELECT r.node_id, n.name, r.transport,
      COUNT(*) FILTER (WHERE r.failing AND EXISTS (SELECT 1 FROM recent o WHERE o.transport = r.transport AND o.network = r.network
        AND o.node_id <> r.node_id AND o.ok_at > now() - interval '24 hours'))::int AS blocked,
      COUNT(*)::int AS networks
    FROM recent r JOIN nodes n ON n.id = r.node_id
    GROUP BY r.node_id, n.name, r.transport`).then((rows) => rows.filter((row) => row.blocked >= 2 && row.blocked * 2 >= row.networks));
}

async function blockedProblems(): Promise<Problem[]> {
  return (await blockedTransports()).map((row) => {
    const label = TRANSPORT_LABELS[row.transport] || row.transport;
    return { key: `transport-blocked:${row.node_id}:${row.transport}`, kind: "transport-blocked", subject: `${row.name} ${TRANSPORT_NAMES[row.transport] || row.transport}`,
      title: `线路疑似被封：${row.name} ${label}`,
      detail: `近 24 小时 ${row.blocked}/${row.networks} 个网络连不上这条线路，同一网络连别的节点的同一线路正常。客户端已自动改走其他线路；如果持续，可以考虑给节点换 IP。`,
      delayMinutes: 30 };
  });
}

async function diskProblem(): Promise<Problem[]> {
  try {
    // The container's root filesystem is the host disk that also holds the database and logs.
    const stats = await statfs("/");
    const used = 1 - Number(stats.bavail) / Number(stats.blocks);
    if (used < 0.85) return [];
    return [{ key: "disk", kind: "disk", subject: `${Math.round(used * 100)}%`, title: `控制面磁盘已用 ${Math.round(used * 100)}%`, detail: `剩余 ${(Number(stats.bavail) * Number(stats.bsize) / 2 ** 30).toFixed(1)} GB。可以清理旧备份或 Docker 镜像。`, delayMinutes: 5 }];
  } catch { return []; }
}

export async function currentProblems(): Promise<Problem[]> {
  return [...await nodeProblems(), ...await blockedProblems(), ...await diskProblem()];
}

async function mail(lines: string[], title: string): Promise<{ subject: string; text: string }> {
  const site = (await listSites()).find((item) => item.isDefault);
  const console = site ? siteBrand(site).consoleOrigin : "";
  return { subject: `[${PRODUCT_NAME}] ${title}`, text: `${lines.join("\n\n")}\n${console ? `\nConsole: ${console}\n` : ""}` };
}

/** One evaluation; called by the minute job. Returns what was mailed. */
export async function runAlerts(): Promise<{ fired: string[]; resolved: string[] }> {
  const problems = await currentProblems();
  const rows = new Map((await dbQuery<Row>("SELECT * FROM alert_states")).map((row) => [row.key, row]));
  const now = Date.now();
  const fire: Problem[] = [];
  for (const problem of problems) {
    const row = rows.get(problem.key);
    // The title is kept for the recovery mail, which is sent when the problem no longer shows up.
    if (!row) await dbExec("INSERT INTO alert_states (key, firing_since, detail) VALUES ($1, now(), $2) ON CONFLICT (key) DO NOTHING", [problem.key, problem.title]);
    const since = row ? new Date(row.firing_since).getTime() : now;
    if (!row?.notified_at && now - since >= problem.delayMinutes * MINUTE) fire.push(problem);
  }
  const current = new Set(problems.map((problem) => problem.key));
  const gone = [...rows.values()].filter((row) => !current.has(row.key));
  const resolved = gone.filter((row) => row.notified_at);
  if (gone.length) await dbExec("DELETE FROM alert_states WHERE key = ANY($1)", [gone.map((row) => row.key)]);

  const recipients = alertRecipients((await getControllerSettings() as { alert_emails?: string }).alert_emails || "");
  if (!recipients.length || !(await mailConfigured()) || (!fire.length && !resolved.length)) return { fired: [], resolved: [] };
  const lines = [
    ...fire.map((problem) => `● ${problem.title}\n${problem.detail}`),
    ...resolved.map((row) => `✓ 已恢复：${row.detail}`),
  ];
  const subject = fire.length ? (fire.length === 1 ? fire[0].title : `${fire.length} 个问题需要处理`) : `已恢复：${resolved.length} 个问题`;
  try {
    const message = await mail(lines, subject);
    for (const to of recipients) await sendMail({ to, ...message });
    if (fire.length) await dbExec("UPDATE alert_states SET notified_at = now() WHERE key = ANY($1)", [fire.map((problem) => problem.key)]);
    void writeOperationalLog({ component: "controller", level: "info", action: "alerts.sent", message: `Alert email sent: ${subject}`, fields: { fired: fire.length, resolved: resolved.length } });
  } catch (error) {
    // Not marked as notified: the next minute tries again.
    void writeOperationalLog({ component: "controller", level: "warning", action: "alerts.failed", message: `Alert email failed: ${error instanceof Error ? error.message : String(error)}` });
  }
  return { fired: fire.map((problem) => problem.key), resolved: resolved.map((row) => row.key) };
}

export type AlertStatus = { recipients: string; mailConfigured: boolean; firing: Array<{ key: string; kind: Problem["kind"]; subject: string; title: string; detail: string; since: string; notified: boolean }> };

export async function alertStatus(): Promise<AlertStatus> {
  const problems = new Map((await currentProblems()).map((problem) => [problem.key, problem]));
  const rows = await dbQuery<Row>("SELECT * FROM alert_states ORDER BY firing_since");
  return {
    recipients: (await getControllerSettings() as { alert_emails?: string }).alert_emails || "",
    mailConfigured: await mailConfigured(),
    firing: rows.filter((row) => problems.has(row.key)).map((row) => ({ key: row.key, kind: problems.get(row.key)!.kind, subject: problems.get(row.key)!.subject, title: problems.get(row.key)!.title, detail: problems.get(row.key)!.detail,
      since: new Date(row.firing_since).toISOString(), notified: Boolean(row.notified_at) })),
  };
}

export async function saveAlertRecipients(value: unknown): Promise<void> {
  const recipients = validateAlertRecipients(value);
  await getControllerSettings();
  await dbExec("UPDATE controller_settings SET alert_emails = $1, updated_at = $2 WHERE id = 'primary'", [recipients, new Date().toISOString()]);
}
