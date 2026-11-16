// Upgrades the node Agents to the release the running Controller carries, one node first, then the rest.
// one-click-update.sh pipes this file into the Controller container (no copy in the image is needed):
//   docker compose exec -T veilbird node --input-type=module - < scripts/agent-rollout.mjs
// It talks to app/api/internal/agent-rollout with a key derived from VEILBIRD_MASTER_KEY.
import { createHmac } from "node:crypto";

const raw = process.env.VEILBIRD_MASTER_KEY?.trim() || "";
const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
if (key.length !== 32) { console.error("Agent upgrade skipped: VEILBIRD_MASTER_KEY is not available in the Controller."); process.exit(1); }
const token = createHmac("sha256", key).update("veilbird:deploy-agent-rollout").digest("hex");
const WAIT_MS = Number(process.env.VEILBIRD_AGENT_ROLLOUT_WAIT_MS) || 6 * 60_000;

async function call(body) {
  const response = await fetch("http://127.0.0.1:3000/api/internal/agent-rollout", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 404) throw new Error("this Controller does not support automatic Agent upgrades yet");
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Queues the upgrade on the given nodes and waits for every action to finish. Returns the names that failed. */
async function upgrade(nodes) {
  const { results } = await call({ step: "upgrade", nodeIds: nodes.map((node) => node.id) });
  const failed = [];
  const name = (id) => nodes.find((node) => node.id === id)?.name || id;
  const pending = new Map();
  for (const result of results) {
    if (result.actionId) pending.set(result.actionId, result.nodeId);
    else { failed.push(name(result.nodeId)); console.log(`  ✗ ${name(result.nodeId)}: ${result.error}`); }
  }
  const deadline = Date.now() + WAIT_MS;
  while (pending.size && Date.now() < deadline) {
    await sleep(3000);
    const { actions } = await call({ step: "status", actionIds: [...pending.keys()] });
    for (const action of actions) {
      if (action.status === "succeeded") { console.log(`  ✓ ${name(action.node_id)}`); pending.delete(action.id); }
      else if (action.status === "failed") { console.log(`  ✗ ${name(action.node_id)}: ${String(action.error || "failed").split("\n")[0]}`); failed.push(name(action.node_id)); pending.delete(action.id); }
    }
  }
  for (const nodeId of pending.values()) { console.log(`  ? ${name(nodeId)}: still running; check Console → 节点`); failed.push(name(nodeId)); }
  return failed;
}

try {
  const plan = await call({ step: "plan" });
  const online = plan.nodes.filter((node) => node.online && node.upgradable !== false);
  const offline = plan.nodes.filter((node) => !node.online);
  const manual = plan.nodes.filter((node) => node.online && node.upgradable === false);
  if (!plan.nodes.length) { console.log(`All node Agents run ${plan.release}.`); process.exit(0); }
  console.log(`Upgrading node Agents to ${plan.release}: ${online.length} node(s)` + (offline.length + manual.length ? `, ${offline.length + manual.length} skipped` : "") + ".");
  if (offline.length) console.log(`  Offline, upgrade later in Console → 节点: ${offline.map((node) => node.name).join(", ")}`);
  if (manual.length) console.log(`  Too old to upgrade by itself and no SSH login saved; run the install command from Console → 节点 on: ${manual.map((node) => node.name).join(", ")}`);
  if (!online.length) process.exit(0);
  // The node with the fewest users goes first; the rest only follow if it comes back healthy.
  const [first, ...rest] = [...online].sort((a, b) => a.users - b.users);
  console.log(`First node: ${first.name} (each node's VPN services restart once; users reconnect within seconds)`);
  if ((await upgrade([first])).length) {
    console.log("The first node did not upgrade cleanly, so the other nodes were left as they are.");
    process.exit(1);
  }
  if (rest.length) {
    console.log(`Remaining ${rest.length} node(s):`);
    const failed = await upgrade(rest);
    if (failed.length) { console.log(`Not upgraded: ${failed.join(", ")}. Retry later with: sudo ./one-click-update.sh --only agent`); process.exit(1); }
  }
  console.log(`All online node Agents run ${plan.release}.`);
} catch (error) {
  console.log(`Agent upgrade skipped: ${error instanceof Error ? error.message : error}. Use Console → 节点 → 升级 Agent.`);
  process.exit(1);
}
