/**
 * When a staged rollout moves on by itself (rollout-control.ts runs this every 15 minutes).
 * Stages: beta (all beta users) → 10% → 30% → 60% → 100% of stable, at least 24 hours each. A stage widens only
 * when every metric is fine against the stable build it replaces; any red metric or hard stop freezes it. When
 * there is not enough data for 48 hours, a person is asked once a day in Telegram.
 */

export const STAGES = [10, 30, 60, 100];
export const STAGE_MS = 24 * 3600_000;
export const ASK_AFTER_MS = 48 * 3600_000;
export const ASK_EVERY_MS = 24 * 3600_000;

export type RolloutState = {
  percent: number;
  since: number;
  frozen: boolean;
  /** A person let this stage continue (Telegram or Console): its metrics no longer freeze it. */
  override: boolean;
  askedAt: number | null;
  verdict: "ok" | "better" | "bad" | "insufficient" | null;
  reasons: string[];
};
export type RolloutStep = { kind: "widen"; to: number } | { kind: "freeze"; reasons: string[] } | { kind: "ask" } | null;

export const nextStage = (percent: number) => STAGES.find((stage) => stage > percent) ?? 100;

export function decideRollout(state: RolloutState, now = Date.now()): RolloutStep {
  if (state.frozen || state.percent >= 100) return null;
  // No health (Loki down or not set up) is no evidence either way: wait.
  if (state.verdict === null) return null;
  if (state.verdict === "bad" && !state.override) return { kind: "freeze", reasons: state.reasons };
  if (now - state.since < STAGE_MS) return null;
  if (state.verdict === "ok" || state.verdict === "better" || state.override) return { kind: "widen", to: nextStage(state.percent) };
  if (state.verdict === "insufficient" && now - state.since >= ASK_AFTER_MS && (state.askedAt === null || now - state.askedAt >= ASK_EVERY_MS)) return { kind: "ask" };
  return null;
}
