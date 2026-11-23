import assert from "node:assert/strict";
import test from "node:test";
import { crashSignature, parseSession } from "../server/client-session.ts";
import { hardStops, judge, queries, thresholds } from "../server/rollout-health.ts";
import { scrubDetail } from "../server/scrub-detail.ts";

const figures = (overrides = {}) => ({ users: 100, sessions: 1000, crashUsers: 0, okSessions: 950, failedSessions: 50, connectP50: 1500, connectP90: 4000,
  drops: 10, connectedSeconds: 3600 * 200, fallbackSessions: 100, ...overrides });

test("a session summary survives the scrubber and is read field by field", () => {
  const detail = "outcome=ok ms=1400 line=reality-alt fallbacks=1 drops=2 seconds=3600 net=wifi";
  assert.equal(scrubDetail(detail), detail);
  assert.deepEqual(parseSession(detail), { outcome: "ok", ms: 1400, line: "reality-alt", fallbacks: 1, drops: 2, seconds: 3600, net: "wifi" });
  assert.equal(parseSession("outcome=failed ms=-1 line=- fallbacks=0 drops=0 seconds=0 net=cell").ms, null);
  assert.equal(parseSession("outcome=failed ms=-1 line=- fallbacks=0 drops=0 seconds=0 net=cell").line, null);
  assert.equal(parseSession("outcome=weird ms=1"), null);
  assert.equal(parseSession(null), null);
  assert.equal(parseSession("outcome=ok drops=999999 seconds=99999999 net=home").drops, 1000);
  assert.equal(parseSession("outcome=ok net=home").net, "unknown");
});

test("the same crash on different builds has one signature", () => {
  assert.equal(crashSignature("1.0.21 NullPointerException: x at Main/tick < Svc/run"), crashSignature("1.0.22 NullPointerException: x at Main/tick < Svc/run"));
  assert.notEqual(crashSignature("1.0.22 IllegalStateException: x at Main/tick"), crashSignature("1.0.22 NullPointerException: x at Main/tick"));
});

test("metrics are judged against stable only with enough data on both builds", () => {
  assert.equal(judge("crash", figures(), figures()), "ok");
  assert.equal(judge("crash", figures({ users: 10 }), figures()), "insufficient");
  assert.equal(judge("crash", figures(), null), "insufficient");
  assert.equal(judge("crash", figures({ crashUsers: 2 }), figures({ crashUsers: 0 })), "bad"); // 2% is over the 1% ceiling
  assert.equal(judge("crash", figures({ crashUsers: 1 }), figures({ crashUsers: 1 })), "ok");
  assert.equal(judge("success", figures({ okSessions: 900, failedSessions: 100 }), figures()), "bad"); // 90% vs 95%
  assert.equal(judge("success", figures({ okSessions: 940, failedSessions: 60 }), figures()), "ok");
  assert.equal(judge("connectP90", figures({ connectP90: 7000 }), figures()), "bad");
  assert.equal(judge("connectP90", figures({ connectP90: 5000 }), figures()), "ok"); // ×1.25
  assert.equal(judge("connectP90", figures({ connectP90: 3000 }), figures()), "better");
  assert.equal(judge("drops", figures({ drops: 20 }), figures()), "bad"); // 0.1/h vs 0.05/h
  assert.equal(judge("drops", figures({ drops: 2 }), figures({ drops: 1 })), "ok"); // tiny figures compare against 0.02/h
});

test("hard stops do not wait for a full sample", () => {
  assert.deepEqual(hardStops(figures({ users: 5 }), { signature: "abc", users: thresholds.burstUsers }), ["crash-burst"]);
  assert.deepEqual(hardStops(figures({ okSessions: 10, failedSessions: 15 }), null), ["success-floor"]);
  assert.deepEqual(hardStops(figures({ okSessions: 1, failedSessions: 3 }), null), []); // too few sessions to tell
});

test("Loki queries filter one platform's client events", () => {
  const q = queries("android");
  assert.match(q.sessions, /event="client\.session" \| platform="android"/);
  assert.match(q.p90, /quantile_over_time\(0\.9, .* \| outcome="ok" \| unwrap ms \[24h\]\) by \(build\)/);
  assert.match(q.burst, /\[1h\]/);
});
