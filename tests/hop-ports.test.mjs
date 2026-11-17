import assert from "node:assert/strict";
import test from "node:test";
import { altTcpPort, hopCheckDue, hopDesired, hopSamples, HOP_FROM, HOP_TO, reportedHop, withHopping } from "../server/hop-ports.ts";

test("spare REALITY port is fixed per node and inside the range", () => {
  for (const id of ["node_a", "node_b", "n".repeat(64)]) {
    const port = altTcpPort(id);
    assert.ok(port >= HOP_FROM && port <= HOP_TO);
    assert.equal(altTcpPort(id), port);
  }
  assert.notEqual(altTcpPort("node_a"), altTcpPort("node_b"));
});

test("desired state redirects the range to stealth and the spare port to REALITY", () => {
  assert.deepEqual(hopDesired("node_a", 8443, 443), { udpFrom: 20000, udpTo: 29999, udpTarget: 8443, tcpPort: altTcpPort("node_a"), tcpTarget: 443 });
  assert.deepEqual(hopDesired("node_a", 8443, undefined), { udpFrom: 20000, udpTo: 29999, udpTarget: 8443 });
});

test("hopping keeps the main port and only applies when the range is open", () => {
  const proxy = { name: "x", type: "hysteria2", port: 8443 };
  assert.deepEqual(withHopping(proxy, null), proxy);
  assert.deepEqual(withHopping(proxy, "20000-29999"), { ...proxy, ports: "8443,20000-29999", "hop-interval": "20-40" });
});

test("agent report and check schedule", () => {
  assert.equal(reportedHop({}), null);
  assert.deepEqual(reportedHop({ connectivity: { hop: { udp: "20000-29999", tcp: 24567 } } }), { udp: "20000-29999", tcp: 24567 });
  const now = Date.now();
  assert.equal(hopCheckDue(undefined, now), true);
  assert.equal(hopCheckDue({ open: true, at: now - 3600_000 }, now), false);
  assert.equal(hopCheckDue({ open: true, at: now - 13 * 3600_000 }, now), true);
  assert.equal(hopCheckDue({ open: false, at: now - 61 * 60_000 }, now), true);
  const samples = hopSamples();
  assert.equal(new Set(samples).size, 3);
  assert.ok(samples.every((port) => port >= HOP_FROM && port <= HOP_TO));
});
