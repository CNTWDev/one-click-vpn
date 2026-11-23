import assert from "node:assert/strict";
import test from "node:test";
import { decide, FAIL_MINUTES, RETURN_MINUTES } from "../server/node-health-rules.ts";

const node = (id, extra = {}) => ({ id, name: id, regionId: "jp", serving: true, drained: false, locked: false, autoDrain: true, fails: 0, oks: 5, reachedByUsers: false, history: [], ...extra });

test("a node nobody reaches is removed; one some users reach is left to the apps", () => {
  const fleet = [node("a", { fails: FAIL_MINUTES, oks: 0 }), node("b"), node("c", { regionId: "sg" }), node("d", { regionId: "sg" })];
  assert.deepEqual(decide(fleet), [{ kind: "drain", id: "a", lock: false }]);
  fleet[0].reachedByUsers = true;
  assert.deepEqual(decide(fleet), []);
  fleet[0].reachedByUsers = false; fleet[0].fails = FAIL_MINUTES - 1;
  assert.deepEqual(decide(fleet), []);
});

test("never the last serving node of a region, never more than half the fleet", () => {
  assert.deepEqual(decide([node("a", { fails: 5 }), node("b", { regionId: "sg" })]), [{ kind: "held", id: "a", why: "region" }]);
  const down = ["a", "b", "c", "d"].map((id) => node(id, { fails: 5 }));
  assert.deepEqual(decide(down).map((action) => action.kind), ["drain", "drain", "held", "held"]);
  assert.equal(decide(down).find((action) => action.kind === "held").why, "fleet");
});

test("a removed node returns after enough healthy minutes unless it is flapping", () => {
  assert.deepEqual(decide([node("a", { serving: false, drained: true, oks: RETURN_MINUTES }), node("b")]), [{ kind: "restore", id: "a" }]);
  assert.deepEqual(decide([node("a", { serving: false, drained: true, oks: RETURN_MINUTES - 1 }), node("b")]), []);
  assert.deepEqual(decide([node("a", { serving: false, drained: true, locked: true, oks: 60 }), node("b")]), []);
  const now = Date.now();
  assert.deepEqual(decide([node("a", { fails: 5, history: [now - 3600_000, now - 600_000] }), node("b")], now), [{ kind: "drain", id: "a", lock: true }]);
  assert.deepEqual(decide([node("a", { fails: 5, history: [now - 7 * 3600_000, now - 600_000] }), node("b")], now), [{ kind: "drain", id: "a", lock: false }]);
});

test("paused nodes and nodes opted out are never touched", () => {
  assert.deepEqual(decide([node("a", { fails: 9, autoDrain: false }), node("b")]), []);
  assert.deepEqual(decide([node("a", { fails: 9, serving: false }), node("b")]), []);
});
