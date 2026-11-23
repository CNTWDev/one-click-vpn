import assert from "node:assert/strict";
import test from "node:test";
import { ASK_AFTER_MS, decideRollout, nextStage, STAGE_MS } from "../server/rollout-rules.ts";

const now = Date.UTC(2026, 10, 23, 12);
const state = (extra = {}) => ({ percent: 10, since: now - STAGE_MS - 1, frozen: false, override: false, askedAt: null, verdict: "ok", reasons: [], ...extra });

test("stages go 10 → 30 → 60 → 100", () => {
  assert.deepEqual([1, 10, 30, 60, 99].map(nextStage), [10, 30, 60, 100, 100]);
});

test("a healthy stage widens only after 24 hours", () => {
  assert.deepEqual(decideRollout(state(), now), { kind: "widen", to: 30 });
  assert.deepEqual(decideRollout(state({ verdict: "better", percent: 60 }), now), { kind: "widen", to: 100 });
  assert.equal(decideRollout(state({ since: now - 3600_000 }), now), null);
});

test("a red metric or hard stop freezes at once; a person's go-ahead overrides it", () => {
  assert.deepEqual(decideRollout(state({ since: now, verdict: "bad", reasons: ["crash-burst"] }), now), { kind: "freeze", reasons: ["crash-burst"] });
  assert.equal(decideRollout(state({ since: now, verdict: "bad", override: true }), now), null);
  assert.deepEqual(decideRollout(state({ verdict: "bad", override: true }), now), { kind: "widen", to: 30 });
});

test("frozen, finished or unknown health does nothing", () => {
  assert.equal(decideRollout(state({ frozen: true, verdict: "bad" }), now), null);
  assert.equal(decideRollout(state({ percent: 100 }), now), null);
  assert.equal(decideRollout(state({ verdict: null }), now), null);
});

test("too little data: ask after 48 hours, then once a day", () => {
  assert.equal(decideRollout(state({ verdict: "insufficient" }), now), null);
  const long = state({ verdict: "insufficient", since: now - ASK_AFTER_MS });
  assert.deepEqual(decideRollout(long, now), { kind: "ask" });
  assert.equal(decideRollout({ ...long, askedAt: now - 3600_000 }, now), null);
  assert.deepEqual(decideRollout({ ...long, askedAt: now - STAGE_MS }, now), { kind: "ask" });
});
