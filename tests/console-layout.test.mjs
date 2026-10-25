import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { consoleApi } from "./fixtures/console-api.mjs";
import { auditLayout, installWideFont } from "./fixtures/layout-audit.mjs";

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
  { name: "users-grant", hash: "users", open: async (page, l) => { await page.getByRole("button", { name: tr(l, "访问详情"), exact: true }).first().click(); await page.getByRole("button", { name: tr(l, "增加权益") }).click(); await page.locator(".grant-form select").first().selectOption("custom"); await page.locator(".grant-form select").nth(2).selectOption("gb"); } },
  { name: "users-ending", hash: "users?filter=ending" },
  // The users table scrolls sideways on narrow screens, and any scroll closes an open menu: scroll first, then open it.
  { name: "users-reset", hash: "users", open: async (page, l) => { const more = page.getByRole("button", { name: tr(l, "{0} 的更多操作").replace("{0}", "liming@example.cn") }); await more.scrollIntoViewIfNeeded(); await page.waitForTimeout(150); await more.click(); await page.getByRole("menuitem", { name: tr(l, "重置密码链接") }).click(); } },
  { name: "plans", hash: "plans" },
  { name: "plans-edit", hash: "plans", open: (page, l) => page.getByRole("button", { name: tr(l, "编辑"), exact: true }).nth(2).click() },
  { name: "subscriptions", hash: "subscriptions" },
  { name: "nodes", hash: "nodes" },
  { name: "nodes-detail", hash: "nodes?focus=n4" },
  { name: "nodes-port-check", hash: "nodes?focus=n4", open: async (page, l) => { await page.locator(".modal").first().waitFor(); await page.getByRole("button", { name: tr(l, "检测端口") }).click(); await page.getByText(tr(l, "TCP 已重新检测；UDP 检测需要先升级 Agent 到 2.16。")).waitFor(); } },
  { name: "nodes-paused-detail", hash: "nodes?focus=n3" },
  { name: "nodes-pause", hash: "nodes", modal: false, open: async (page, l) => { const more = page.getByRole("button", { name: tr(l, "{0} 的更多操作").replace("{0}", "190.92.202.34@Singapore") }); await more.scrollIntoViewIfNeeded(); await page.waitForTimeout(150); await more.click(); await page.getByRole("menuitem", { name: tr(l, "暂停服务") }).click(); await page.locator(".confirm-dialog").waitFor(); } },
  { name: "nodes-add", hash: "nodes", open: (page) => page.locator(".page-actions .button.primary").click() },
  { name: "nodes-add-ssh", hash: "nodes", open: async (page, l) => { await page.locator(".page-actions .button.primary").click(); await page.getByRole("radio", { name: tr(l, "SSH 部署") }).click(); } },
  { name: "nodes-install", hash: "nodes", open: async (page, l) => { await page.locator(".page-actions .button.primary").click(); await page.locator("#node-form input").first().fill("Tokyo Edge"); await page.locator("#node-form input").nth(1).fill("203.0.113.10"); await page.getByRole("button", { name: tr(l, "生成安装命令") }).click(); await page.locator(".install-command").waitFor(); } },
  { name: "services", hash: "services" },
  { name: "services-policy", hash: "services?tab=policy" },
  { name: "services-reality", hash: "services?tab=reality" },
  { name: "regions", hash: "regions" },
  { name: "controller", hash: "controller" },
  { name: "sites", hash: "sites" },
  { name: "sites-checked", hash: "sites", open: async (page, l) => { await page.getByRole("button", { name: tr(l, "检查域名") }).nth(1).click(); await page.locator(".site-check").first().waitFor(); }, modal: false },
  { name: "sites-edit", hash: "sites", open: (page, l) => page.getByRole("button", { name: tr(l, "编辑"), exact: true }).nth(1).click(), modal: false },
  { name: "logs", hash: "logs" },
  { name: "releases", hash: "releases" },
  { name: "releases-mirror-test", hash: "releases", modal: false, open: async (page) => { await page.locator(".result-panel .panel-head button").click(); await page.locator(".result-panel .compact-list").waitFor(); } },
  // Batch import with recognised, already-existing and unknown files (no dialog to wait for).
  { name: "releases-import", hash: "releases", modal: false, open: async (page) => { await page.locator(".release-drop input").setInputFiles([
    { name: "TrackNothing-1.2.0-13.apk", mimeType: "application/vnd.android.package-archive", buffer: Buffer.alloc(2048, 1) },
    { name: "TrackNothing-1.2.0-13-win-arm64-setup.exe", mimeType: "application/octet-stream", buffer: Buffer.alloc(4096, 1) },
    { name: "TrackNothing-1.1.3-11.apk", mimeType: "application/vnd.android.package-archive", buffer: Buffer.alloc(1024, 1) },
    { name: "screenshot-from-a-very-long-folder-name-that-is-not-an-installer.png", mimeType: "image/png", buffer: Buffer.alloc(512, 1) },
  ]); await page.locator(".release-import-list").waitFor(); } },
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
      await installWideFont(context);
      const api = consoleApi();
      await context.route("**/api/**", async (route) => {
        const url = new URL(route.request().url());
        const [status, body] = api(url.pathname, route.request().method(), url.searchParams);
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
          if ((view.open && view.modal !== false) || view.hash.includes("focus=")) await page.locator(".modal").first().waitFor();
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
