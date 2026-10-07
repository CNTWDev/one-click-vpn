import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { portalApi } from "./fixtures/portal-api.mjs";
import { auditLayout, installWideFont } from "./fixtures/layout-audit.mjs";

// The Portal's sign-in, request-access, onboarding and dashboard states, in every locale, at desktop / tablet / phone
// widths. Same audit as the Console: sideways scroll, text spill, overlap, clipped controls, glued words.
// VEILBIRD_TEST_PLAYWRIGHT=<playwright-core entry> [VEILBIRD_TEST_BROWSER=<chromium>] [VEILBIRD_LAYOUT_SHOTS=<dir>]
const locales = ["zh-CN", "en-US", "ru-RU"];
const widths = [1440, 1100, 820, 390, 320];
const views = [
  { name: "login", api: { signedIn: false }, ready: ".auth-panel" },
  { name: "register", api: { signedIn: false }, ready: ".auth-panel", open: (page) => page.locator(".auth-panel button.ghost.wide").click() },
  { name: "onboarding", api: { empty: true }, ready: ".dashboard" },
  { name: "dashboard", ready: ".dashboard .list-item" },
  { name: "connection-openvpn", ready: ".dashboard .list-item", open: (page) => page.locator(".dashboard .list-item").nth(2).click() },
  { name: "new-subscription", ready: ".dashboard .list-item", open: (page) => page.locator(".topbar-tools ~ * button.primary, .dashboard button.primary").first().click() },
  { name: "new-single", ready: ".dashboard .list-item", open: async (page) => { await page.locator(".dashboard button.primary").first().click(); await page.locator(".mode-switch button").nth(1).click(); } },
  { name: "details-open", ready: ".dashboard .list-item", open: async (page) => { for (const summary of await page.locator("details:not([open]) > summary").all()) await summary.click().catch(() => {}); } },
];

test("Portal layout: no overflow, spill or overlap in any state, locale or width", { skip: !process.env.VEILBIRD_TEST_PLAYWRIGHT, timeout: 600000 }, async () => {
  const { chromium } = await import(process.env.VEILBIRD_TEST_PLAYWRIGHT);
  const shots = process.env.VEILBIRD_LAYOUT_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  const port = 3403, base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["frontend-server.mjs"], { env: { ...process.env, STATIC_DIR: path.resolve("dist/portal-web"), PORT: String(port) }, stdio: "ignore" });
  let browser;
  const failures = [], errors = [];
  try {
    for (let n = 0; n < 60; n++) { if (await fetch(`${base}/health`).then(r => r.ok).catch(() => false)) break; await new Promise(r => setTimeout(r, 100)); }
    browser = await chromium.launch({ headless: true, ...(process.env.VEILBIRD_TEST_BROWSER ? { executablePath: process.env.VEILBIRD_TEST_BROWSER } : {}) });
    for (const locale of locales) for (const view of views) {
      const context = await browser.newContext({ locale, viewport: { width: widths[0], height: 900 }, reducedMotion: "reduce" });
      context.setDefaultTimeout(10000);
      await installWideFont(context);
      const api = portalApi(view.api);
      await context.route("**/api/**", async (route) => {
        const [status, body] = api(new URL(route.request().url()).pathname, route.request().method());
        await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      });
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(`${locale} ${view.name}: ${error.message}`));
      await page.goto(base);
      await page.locator(view.ready).first().waitFor();
      if (view.open) await view.open(page);
      for (const width of widths) {
        await page.setViewportSize({ width, height: 900 });
        await page.waitForTimeout(300);
        for (const issue of await page.evaluate(`(${auditLayout})()`)) failures.push(`${locale.slice(0, 2)} ${width}px ${view.name}: [${issue.kind}] ${issue.detail}`);
        if (shots) await page.screenshot({ path: path.join(shots, `${locale.slice(0, 2)}-${width}-${view.name}.png`), fullPage: true });
      }
      await context.close();
    }
  } finally { await browser?.close(); child.kill("SIGTERM"); }
  if (shots && failures.length) await writeFile(path.join(shots, "failures.txt"), failures.join("\n") + "\n");
  assert.deepEqual(errors, []);
  assert.equal(failures.length, 0, `${failures.length} layout problems:\n${failures.join("\n")}`);
});
