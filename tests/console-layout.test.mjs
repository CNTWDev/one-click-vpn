import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { consoleApi } from "./fixtures/console-api.mjs";
import { auditLayout } from "./fixtures/layout-audit.mjs";

// Every Console page and the main dialogs, in every locale, at desktop / narrow desktop / tablet / phone widths,
// with a realistic fleet. Fails on sideways page scroll, text spilling out of its box, or content painting over
// other content (e.g. a translated "Memory" label running into its usage bar).
// VEILBIRD_TEST_PLAYWRIGHT=<playwright-core entry> [VEILBIRD_TEST_BROWSER=<chromium>] [VEILBIRD_LAYOUT_SHOTS=<dir>]
const catalog = JSON.parse(readFileSync(new URL("../shared/i18n-console.json", import.meta.url), "utf8"));
const locales = [["zh", "zh-CN"], ["en", "en-US"], ["ru", "ru-RU"]];
const widths = [1440, 1100, 820, 390];
const tr = (locale, source) => locale === "zh" ? source : catalog[source]?.[locale === "en" ? 0 : 1] ?? source;
const views = [
  { name: "overview", hash: "overview" },
  { name: "topology", hash: "topology" },
  { name: "users", hash: "users" },
  { name: "users-access", hash: "users", open: (page, l) => page.getByRole("button", { name: tr(l, "访问详情"), exact: true }).first().click() },
  { name: "subscriptions", hash: "subscriptions" },
  { name: "nodes", hash: "nodes" },
  { name: "nodes-detail", hash: "nodes?focus=n4" },
  { name: "nodes-add", hash: "nodes", open: (page) => page.locator(".page-actions .button.primary").click() },
  { name: "services", hash: "services" },
  { name: "services-policy", hash: "services?tab=policy" },
  { name: "services-reality", hash: "services?tab=reality" },
  { name: "regions", hash: "regions" },
  { name: "controller", hash: "controller" },
  { name: "logs", hash: "logs" },
  { name: "releases", hash: "releases" },
];

test("Console layout: no overflow, spill or overlap on any page, locale or width", { skip: !process.env.VEILBIRD_TEST_PLAYWRIGHT, timeout: 600000 }, async () => {
  const { chromium } = await import(process.env.VEILBIRD_TEST_PLAYWRIGHT);
  const shots = process.env.VEILBIRD_LAYOUT_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  const port = 3402, base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["frontend-server.mjs"], { env: { ...process.env, STATIC_DIR: path.resolve("dist/admin-web"), PORT: String(port) }, stdio: "ignore" });
  let browser;
  const failures = [], errors = [];
  try {
    for (let n = 0; n < 60; n++) { if (await fetch(`${base}/health`).then(r => r.ok).catch(() => false)) break; await new Promise(r => setTimeout(r, 100)); }
    browser = await chromium.launch({ headless: true, ...(process.env.VEILBIRD_TEST_BROWSER ? { executablePath: process.env.VEILBIRD_TEST_BROWSER } : {}) });
    for (const [locale, browserLocale] of locales) {
      const context = await browser.newContext({ locale: browserLocale, viewport: { width: widths[0], height: 900 }, reducedMotion: "reduce" });
      context.setDefaultTimeout(10000);
      const api = consoleApi();
      await context.route("**/api/**", async (route) => {
        const [status, body] = api(new URL(route.request().url()).pathname, route.request().method());
        await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      });
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(`${locale}: ${error.message}`));
      for (const width of widths) {
        await page.setViewportSize({ width, height: 900 });
        for (const view of views) {
          await page.goto(`${base}/#/${view.hash}`);
          await page.reload(); // drop any dialog left open by the previous view
          await page.locator(".content h1, .subscription-heading h2").first().waitFor();
          if (view.open) await view.open(page, locale);
          if (view.open || view.hash.includes("focus=")) await page.locator(".modal").first().waitFor();
          await page.waitForTimeout(300);
          for (const issue of await page.evaluate(`(${auditLayout})()`)) failures.push(`${locale} ${width}px ${view.name}: [${issue.kind}] ${issue.detail}`);
          if (shots) await page.screenshot({ path: path.join(shots, `${locale}-${width}-${view.name}.png`), fullPage: true });
        }
      }
      await context.close();
    }
  } finally { await browser?.close(); child.kill("SIGTERM"); }
  if (shots && failures.length) await writeFile(path.join(shots, "failures.txt"), failures.join("\n") + "\n");
  assert.deepEqual(errors, []);
  assert.equal(failures.length, 0, `${failures.length} layout problems:\n${failures.join("\n")}`);
});
