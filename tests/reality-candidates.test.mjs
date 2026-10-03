import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { REALITY_CANDIDATES, pickRealityCandidate } from "../server/reality-candidates.ts";

test("Agent and Controller share the same REALITY candidate pool", () => {
  const agent = readFileSync(new URL("../agent/agent.py", import.meta.url), "utf8");
  const block = agent.match(/REALITY_CANDIDATES = \(([\s\S]*?)\)\n/)[1];
  assert.deepEqual([...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]), [...REALITY_CANDIDATES]);
});

test("each node gets a target it verified itself, spread across the fast ones", () => {
  assert.equal(pickRealityCandidate("node_a", undefined), undefined);
  assert.equal(pickRealityCandidate("node_a", { checkedAt: "x", results: [{ serverName: "www.apple.com", ok: false, latencyMs: null }] }), undefined);
  // Unknown names reported by an Agent are never used.
  assert.equal(pickRealityCandidate("node_a", { results: [{ serverName: "evil.example.com", ok: true, latencyMs: 1 }] }), undefined);
  const probe = { results: [
    { serverName: "www.microsoft.com", ok: true, latencyMs: 20 }, { serverName: "www.apple.com", ok: true, latencyMs: 30 },
    { serverName: "www.amazon.com", ok: true, latencyMs: 45 }, { serverName: "www.cisco.com", ok: true, latencyMs: 300 },
  ] };
  const picks = new Set(Array.from({ length: 40 }, (_, index) => pickRealityCandidate(`node_${index}`, probe)));
  assert.ok(picks.size >= 2);
  assert.ok(!picks.has("www.cisco.com"));
  assert.equal(pickRealityCandidate("node_1", probe), pickRealityCandidate("node_1", probe));
});
