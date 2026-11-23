import { writeOperationalLog } from "./operational-logs";
import { notify } from "./telegram";

/**
 * Results of the real-device regression run (.github/workflows/device-regression.yml), sent by CI with the
 * release token. Every case goes to Loki; a failure is posted to Telegram (event "releases") with the run link.
 */
type Case = { platform: string; case: string; ok: boolean; detail: string };
const PLATFORM_NAMES: Record<string, string> = { android: "Android", macos: "Mac", windows: "Windows", subscription: "Clash 订阅" };

export async function recordRegression(body: Record<string, unknown>): Promise<{ cases: number; failed: number }> {
  const cases = (Array.isArray(body.cases) ? body.cases : []).slice(0, 200).flatMap((item: unknown) => {
    const row = item as Partial<Case> | null;
    if (!row || typeof row.case !== "string" || typeof row.platform !== "string" || typeof row.ok !== "boolean") return [];
    return [{ platform: row.platform.slice(0, 20), case: row.case.slice(0, 60), ok: row.ok, detail: typeof row.detail === "string" ? row.detail.slice(0, 300) : "" }];
  });
  const version = typeof body.version === "string" ? body.version.slice(0, 40) : "";
  const runUrl = typeof body.runUrl === "string" && /^https:\/\/github\.com\//.test(body.runUrl) ? body.runUrl : "";
  const trigger = typeof body.trigger === "string" ? body.trigger.slice(0, 40) : "";
  for (const row of cases) {
    await writeOperationalLog({ component: "controller", level: row.ok ? "info" : "warning", source: "system", action: "client.regression",
      message: `Device regression ${row.platform} ${row.case}: ${row.ok ? "passed" : "failed"}${row.detail ? ` (${row.detail})` : ""}`,
      fields: { event: "client.regression", platform: row.platform, case: row.case, ok: row.ok, version, trigger, runUrl } }).catch(() => undefined);
  }
  const failed = cases.filter((row) => !row.ok);
  const skipped = Array.isArray(body.skipped) ? body.skipped.filter((item): item is string => typeof item === "string").slice(0, 5) : [];
  if (failed.length) {
    await notify("releases", { tone: "alert", title: `真机回归失败：${failed.length}/${cases.length} 项${version ? ` · ${version}` : ""}`,
      lines: [...failed.slice(0, 10).map((row) => `✗ ${PLATFORM_NAMES[row.platform] || row.platform} · ${row.case}${row.detail ? `：${row.detail}` : ""}`),
        ...(skipped.length ? [`未运行：${skipped.join("、")}`] : [])],
      ...(runUrl ? { link: { label: "查看运行记录 →", url: runUrl } } : {}) });
  }
  return { cases: cases.length, failed: failed.length };
}
