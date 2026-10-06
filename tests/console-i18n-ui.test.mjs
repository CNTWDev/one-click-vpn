import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("Console locales: all routes, persisted choice, forms and mobile layout", { skip: !process.env.VEILBIRD_TEST_PLAYWRIGHT }, async () => {
  const { chromium } = await import(process.env.VEILBIRD_TEST_PLAYWRIGHT);
  const port = 3401, base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["frontend-server.mjs"], { env: { ...process.env, STATIC_DIR: path.resolve("dist/admin-web"), PORT: String(port) }, stdio: "ignore" });
  let browser;
  try {
    for (let n = 0; n < 60; n++) { if (await fetch(`${base}/health`).then(r => r.ok).catch(() => false)) break; await new Promise(r => setTimeout(r, 100)); }
    browser = await chromium.launch({ headless: true, ...(process.env.VEILBIRD_TEST_BROWSER ? { executablePath: process.env.VEILBIRD_TEST_BROWSER } : {}) });
    const context = await browser.newContext({ locale: "ru-RU", viewport: { width: 1440, height: 1000 } });
    context.setDefaultTimeout(10000);
    const page = await context.newPage(), errors = [];
    page.on("pageerror", e => errors.push(e.message));
    let signedIn = false, region;
    await context.route("**/api/**", async route => {
      const url = new URL(route.request().url()), method = route.request().method();
      let status = 200, body = {};
      const user = { id: "owner", displayName: "Owner", email: "owner@example.com", role: "admin", status: "active", createdAt: "2026-10-01T00:00:00Z" };
      if (url.pathname === "/api/auth/me") { status = signedIn ? 200 : 401; body = signedIn ? { user } : { error: "Authentication required" }; }
      else if (url.pathname === "/api/auth/login") { signedIn = true; body = { user }; }
      else if (url.pathname === "/api/v1/admin/users") body = { users: [user] };
      else if (url.pathname === "/api/nodes") body = { nodes: [] };
      else if (url.pathname === "/api/regions") { if (method === "POST") region = route.request().postDataJSON(); body = { regions: [] }; }
      else if (url.pathname === "/api/controller") body = { settings: { display_name: "NORTHSTAR", location_label: "", latitude: null, longitude: null, location_source: "unset" }, status: "healthy", publicOrigin: "https://example.com", publicHost: "example.com", publicIp: "192.0.2.1", build: "test", runtime: { uptimeSeconds: 5000, nodeVersion: "22", rssBytes: 1048576, heapUsedBytes: 524288, load1: 0.25, observedAt: new Date().toISOString() } };
      else if (url.pathname === "/api/vpn-services") body = { services: [] };
      else if (url.pathname === "/api/deployment-policy") body = { standard: { version: 2, protocols: [] }, counts: { standardNodes: 0, eligibleNodes: 0, driftedNodes: 0, blockedNodes: 0 }, driftedNodes: [], rollouts: [] };
      else if (url.pathname === "/api/reality-defaults") body = { mode: "auto", serverName: "", candidates: ["www.microsoft.com"], checkedAt: null, updatedAt: null };
      else if (url.pathname === "/api/logs") body = { logs: [], available: true };
      else if (url.pathname.endsWith("/subscriptions")) body = { subscriptions: [], nodes: [] };
      else if (url.pathname.includes("agent-release")) body = { version: "test", revision: "test" };
      else if (url.pathname === "/api/v1/admin/client-releases") body = { releases: [{ id: "rel_1", platform: "android", arch: "universal", channel: "beta", version: "1.2.0", build: 12, status: "published", distribution: "direct", url: "https://downloads.example.com/a.apk", sha256: "a".repeat(64), sizeBytes: 12345678, minOs: "Android 8.0", notes: "", publishedAt: "2026-10-06T00:00:00Z", createdAt: "2026-10-06T00:00:00Z", createdBy: "release-token", rolloutPercent: 20 }],
        policies: ["android", "ios", "macos", "windows"].map((platform) => ({ platform, minBuild: 0, announcement: "", downloadPath: `/download/${platform}` })), adoption: [{ platform: "android", version: "1.2.0", build: 12, devices: 2 }],
        diagnostics: [{ platform: "android", build: 12, code: "HANDSHAKE_TIMEOUT", events: 3, users: 2, lastAt: "2026-10-06T00:00:00Z" }], storage: { mode: "external" }, ciTokenConfigured: false };
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.goto(base);
    await page.getByLabel("Язык", { exact: true }).waitFor();
    assert.equal(await page.locator("html").getAttribute("lang"), "ru-RU");
    await page.locator('input[type="email"]').fill("owner@example.com");
    await page.locator('input[type="password"]').fill("test-password");
    await page.locator('button[type="submit"]').click();
    await page.locator(".app-shell").waitFor();
    const routes = ["overview", "topology", "users", "subscriptions", "nodes", "services", "regions", "controller", "logs", "releases"];
    for (const locale of ["en", "ru"]) {
      await page.locator(".console-language-picker select").selectOption(locale);
      for (const route of routes) {
        await page.goto(`${base}/#/${route}`);
        await page.locator(".content h1, .subscription-heading h2").first().waitFor();
        await page.waitForTimeout(400);
        const text = (await page.locator(".app-shell").innerText()).replaceAll("简体中文", "");
        assert.doesNotMatch(text, /[\u3400-\u9fff]/u, `${locale}/${route}: untranslated UI`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${locale}/${route}: desktop overflow`);
      }
    }
    await page.reload();
    await page.locator(".console-language-picker select").waitFor();
    assert.equal(await page.locator("html").getAttribute("lang"), "ru-RU");
    await page.locator(".console-language-picker select").selectOption("en");
    await page.goto(`${base}/#/regions`);
    await page.getByLabel(/^Server location/).selectOption("preset:us-ohio");
    await page.getByLabel("City / region display name").fill("我的 Ohio");
    await page.locator(".console-language-picker select").selectOption("ru");
    assert.equal(await page.locator('input[value="我的 Ohio"]').count(), 1, "language switch preserves form input");
    await page.getByRole("button", { name: "Сохранить регион", exact: true }).click();
    await page.waitForTimeout(200);
    assert.deepEqual(region, { name: "我的 Ohio", country: "United States", code: "US" });
    const directory = await mkdtemp(path.join(tmpdir(), "veilbird-console-i18n-"));
    await page.screenshot({ path: path.join(directory, "russian-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    for (const route of routes) {
      await page.goto(`${base}/#/${route}`); await page.locator(".content h1, .subscription-heading h2").first().waitFor(); await page.waitForTimeout(200);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `ru/${route}: mobile overflow`);
    }
    await page.screenshot({ path: path.join(directory, "russian-mobile.png"), fullPage: true });
    assert.deepEqual(errors, []);
    console.log(`Console i18n screenshots: ${directory}`);
  } finally { await browser?.close(); child.kill("SIGTERM"); }
});
