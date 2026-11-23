/** The rules of automatic node removal (node-health.ts), kept free of I/O so they are tested on their own. */

export const FAIL_MINUTES = 3;
export const RETURN_MINUTES = 10;
export const USER_EVIDENCE_MINUTES = 15;
export const FLAP_LIMIT = 3;
export const FLAP_WINDOW_MS = 6 * 3600_000;

export type HealthNode = {
  id: string; name: string; regionId: string | null;
  /** Serving apps now (online, not paused, not removed). */
  serving: boolean;
  drained: boolean; locked: boolean; autoDrain: boolean;
  /** Minutes in a row the outside check failed / passed. */
  fails: number; oks: number;
  /** An app on some network reached it within USER_EVIDENCE_MINUTES. */
  reachedByUsers: boolean;
  /** Removal times within FLAP_WINDOW_MS, oldest first. */
  history: number[];
};
export type HealthAction =
  | { kind: "drain"; id: string; lock: boolean }
  | { kind: "restore"; id: string }
  | { kind: "held"; id: string; why: "fleet" | "region" };

/** What to do this minute. Pure, so the rules are tested on their own. */
export function decide(nodes: HealthNode[], now = Date.now()): HealthAction[] {
  const actions: HealthAction[] = [];
  const eligible = nodes.filter((node) => node.serving || node.drained);
  let drained = eligible.filter((node) => node.drained).length;
  const servingByRegion = new Map<string, number>();
  for (const node of eligible.filter((item) => item.serving)) servingByRegion.set(node.regionId || "", (servingByRegion.get(node.regionId || "") || 0) + 1);
  for (const node of nodes) {
    if (node.drained) {
      if (!node.locked && node.oks >= RETURN_MINUTES) { actions.push({ kind: "restore", id: node.id }); drained--; }
      continue;
    }
    if (!node.serving || !node.autoDrain || node.fails < FAIL_MINUTES || node.reachedByUsers) continue;
    if ((drained + 1) * 2 > eligible.length) { actions.push({ kind: "held", id: node.id, why: "fleet" }); continue; }
    const region = node.regionId || "";
    if ((servingByRegion.get(region) || 0) <= 1) { actions.push({ kind: "held", id: node.id, why: "region" }); continue; }
    const recent = node.history.filter((at) => now - at < FLAP_WINDOW_MS).length;
    actions.push({ kind: "drain", id: node.id, lock: recent + 1 >= FLAP_LIMIT });
    drained++;
    servingByRegion.set(region, (servingByRegion.get(region) || 0) - 1);
  }
  return actions;
}
