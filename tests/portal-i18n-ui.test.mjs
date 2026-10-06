import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("Portal i18n: system language, persistence, auth, both connection modes and mobile", { skip: !process.env.NORTHSTAR_TEST_PLAYWRIGHT }, async () => {
  const { chromium } = await import(process.env.NORTHSTAR_TEST_PLAYWRIGHT);
  const port = 3394, base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["frontend-server.mjs"], { env: { ...process.env, STATIC_DIR: path.resolve("dist/portal-web"), PORT: String(port) }, stdio: "ignore" });
  let browser;
  try {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (await fetch(`${base}/health`).then((r) => r.ok).catch(() => false)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    browser = await chromium.launch({ headless: true, ...(process.env.NORTHSTAR_TEST_BROWSER ? { executablePath: process.env.NORTHSTAR_TEST_BROWSER } : {}) });
    const context = await browser.newContext({ locale: "ru-RU", viewport: { width: 1440, height: 1000 } });
    context.setDefaultTimeout(10000);
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    let signedIn = false, badLogin = true, firstRun = false, created, profileCreated;
    const now = new Date().toISOString();
    const user = { id: "user", displayName: "Test User", email: "test@example.com", status: "active", role: "user" };
    const credential = { id: "sub-credential", name: "Personal", protocol: "wireguard", subscriptionId: "sub", status: "active", state: "online", userDisabled: false, adminDisabled: false, accountStatus: "active", online: true, connectionCount: 1, syncStatus: "applied", totalBytes: 2048, uploadBytes: 1024, downloadBytes: 1024, createdAt: now, expiresAt: "2027-10-06T12:00:00Z", lastActivityAt: now };
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url()), pathname = url.pathname, method = route.request().method();
      let status = 200, body = {};
      if (pathname === "/api/v1/auth/me") { if (signedIn) body = { user }; else { status = 401; body = { error: "Authentication required" }; } }
      else if (pathname === "/api/v1/auth/web-login") { if (badLogin) { status = 401; body = { error: "Invalid email or password" }; } else { signedIn = true; body = { user }; } }
      else if (pathname === "/api/v1/auth/register") { status = 202; body = { status: "received" }; }
      else if (pathname === "/api/v1/availability") body = { regions: [{ id: "sg", name: "Singapore", code: "SG", country: "Singapore", protocols: ["wireguard", "vless", "openvpn"], status: "available" }], nodes: [{ id: "node", name: "Node 1", regionId: "sg", regionName: "Singapore", protocols: ["wireguard", "vless", "openvpn"] }] };
      else if (pathname === "/api/v1/credentials") body = method === "POST" ? { credential: { ...credential, id: "new" } } : { credentials: firstRun ? [] : [...(created ? [{ ...credential, id: "new-sub", subscriptionId: "new-subscription", name: created.name }] : []), credential, { ...credential, id: "single", name: "Office", subscriptionId: null }] };
      else if (pathname === "/api/v1/profiles") {
        if (method === "POST") profileCreated = route.request().postDataJSON();
        const profile = { id: "profile", credentialId: "single", protocol: "wireguard", status: "active", regionCode: "SG", regionName: "Singapore", nodeName: "Node 1", issuedAt: now, expiresAt: credential.expiresAt };
        body = method === "POST" ? { profile } : { profiles: [profile] };
      }
      else if (pathname.endsWith("/activate")) body = { profile: { id: "profile", protocol: "wireguard", status: "active" } };
      else if (pathname.endsWith("/download")) { await route.fulfill({ contentType: "text/plain", body: "# Test configuration" }); return; }
      else if (pathname === "/api/v1/usage/summary") body = { totals: { totalBytes: 4096, uploadBytes: 2048, downloadBytes: 2048 }, daily: [] };
      else if (pathname === "/api/v1/subscriptions") {
        if (method === "POST") { created = route.request().postDataJSON(); body = { token: "test-token", credentialId: "new-sub" }; }
        else if (method === "PATCH") { status = 403; body = { error: "登录密码不正确" }; }
        else body = { subscriptions: [] };
      }
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    });
    const picker = () => page.locator(".portal-language-picker select");
    const noChinese = async () => assert.doesNotMatch(await page.locator("main").innerText(), /[\u3400-\u9fff]/u);
    const noOverflow = async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.goto(base);
    await page.getByRole("heading", { name: "Вход в Northstar" }).waitFor();
    assert.equal(await picker().inputValue(), "system");
    assert.equal(await page.locator("html").getAttribute("lang"), "ru-RU");
    await noChinese();
    await page.getByLabel("Электронная почта").fill("test@example.com");
    await page.getByLabel("Пароль", { exact: true }).fill("test-password-123");
    await page.getByRole("button", { name: "Войти", exact: true }).click();
    await page.getByText("Неверная почта или пароль", { exact: true }).waitFor();
    await picker().selectOption("en");
    await page.getByText("Invalid email or password", { exact: true }).waitFor();
    await page.reload();
    await page.getByRole("heading", { name: "Sign in to Northstar" }).waitFor();
    assert.equal(await picker().inputValue(), "en");
    await page.getByRole("button", { name: "New here? Request access" }).click();
    await page.getByLabel("Name", { exact: true }).fill("Test User");
    await page.getByLabel("Email", { exact: true }).fill("test@example.com");
    await page.getByLabel("Password", { exact: true }).fill("test-password-123");
    await page.getByRole("button", { name: "Submit request" }).click();
    await page.getByRole("heading", { name: "Awaiting approval" }).waitFor();
    await noChinese();
    await picker().selectOption("zh");
    await page.getByRole("heading", { name: "等待管理员审核" }).waitFor();
    await picker().selectOption("system");
    await page.getByRole("heading", { name: "Ожидание одобрения" }).waitFor();
    await page.getByRole("button", { name: "Назад", exact: true }).click();
    badLogin = false;
    await page.getByLabel("Электронная почта").fill("test@example.com");
    await page.getByLabel("Пароль", { exact: true }).fill("test-password-123");
    await page.getByRole("button", { name: "Войти", exact: true }).click();
    await page.getByRole("heading", { name: "Мои подключения", level: 2 }).waitFor();
    await page.getByRole("button", { name: /Копировать ссылку/ }).click();
    await page.getByLabel("Пароль аккаунта").fill("incorrect");
    await page.getByRole("button", { name: "Подтвердить и продолжить" }).click();
    await page.getByText("Неверный пароль аккаунта", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Отмена", exact: true }).click();
    await page.getByRole("button", { name: "Новое подключение", exact: true }).click();
    await page.getByRole("heading", { name: "Новое подключение" }).waitFor();
    await noChinese();
    await page.setViewportSize({ width: 390, height: 844 });
    await noOverflow();
    await page.getByLabel("Название подписки").fill("My custom subscription");
    await picker().selectOption("en");
    assert.equal(await page.getByLabel("Subscription name").inputValue(), "My custom subscription");
    await page.getByRole("button", { name: "Create subscription", exact: true }).click();
    await page.getByLabel("Subscription link", { exact: true }).waitFor();
    assert.equal(created.name, "My custom subscription");
    await noChinese();
    await page.getByRole("button", { name: "New connection", exact: true }).click();
    await page.locator('.mode-switch button').nth(1).click();
    const downloadResponse = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/download"));
    await page.getByRole("button", { name: "Create and download" }).click();
    await downloadResponse;
    assert.equal(profileCreated.nodeId, "node");
    await noChinese();
    await picker().selectOption("ru");
    await noOverflow();
    await page.locator(".list-item").filter({ hasText: "Office" }).click();
    await page.getByRole("button", { name: "Управление подключением", exact: true }).click();
    await page.getByRole("menuitem", { name: "Переименовать", exact: true }).click();
    await page.getByRole("dialog").getByRole("heading", { name: "Переименовать подключение" }).waitFor();
    await page.getByRole("dialog").getByRole("button", { name: "Отмена", exact: true }).click();
    await page.getByText("Конфигурации и сертификаты", { exact: true }).click();
    await page.locator("summary").filter({ hasText: "Карта доступных регионов" }).click();
    await noChinese();
    await noOverflow();
    await page.setViewportSize({ width: 320, height: 844 });
    await noOverflow();
    await page.setViewportSize({ width: 390, height: 844 });
    const directory = await mkdtemp(path.join(tmpdir(), "northstar-i18n-ui-"));
    await page.screenshot({ path: path.join(directory, "ru-mobile.png"), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await picker().selectOption("en");
    await page.screenshot({ path: path.join(directory, "en-desktop.png"), fullPage: true });
    await page.evaluate(() => {
      Object.defineProperty(navigator, "languages", { configurable: true, value: ["zh-CN"] });
      window.dispatchEvent(new Event("languagechange"));
    });
    assert.equal(await page.locator("html").getAttribute("lang"), "en-US", "manual preference wins over system changes");
    await picker().selectOption("system");
    await page.getByRole("heading", { name: "我的连接", level: 2 }).waitFor();
    // A second same-origin tab updates the stored preference; the first tab follows.
    const secondPage = await context.newPage();
    await secondPage.goto(`${base}/health`);
    await secondPage.evaluate(() => localStorage.setItem("northstar.portal.language", "ru"));
    await page.getByRole("heading", { name: "Мои подключения", level: 2 }).waitFor();
    await secondPage.close();
    await picker().selectOption("en");
    await page.getByText("Download NORTHSTAR", { exact: true }).click();
    assert.equal(await page.getByText("Not released yet", { exact: true }).count(), 4);
    let catalogUnavailable = true;
    await page.route("**/api/v1/client-releases", (route) => route.fulfill({
      status: catalogUnavailable ? 503 : 200, contentType: "application/json",
      body: JSON.stringify(catalogUnavailable ? { code: "CLIENT_RELEASES_UNAVAILABLE" } : { releases: [{ platform: "windows", arch: "x64", version: "1.0.0", distribution: "direct", url: "https://downloads.example.com/northstar.exe", sha256: "a".repeat(64), minOs: "Windows 10" }] }),
    }));
    await page.reload();
    await page.getByText("Download NORTHSTAR", { exact: true }).click();
    await page.getByText("Could not load client releases. Please try again later.", { exact: true }).waitFor();
    catalogUnavailable = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await page.getByRole("link", { name: "Download installer", exact: true }).waitFor();
    assert.equal(await page.getByRole("link", { name: "Download installer", exact: true }).getAttribute("href"), "https://downloads.example.com/northstar.exe");
    await page.setViewportSize({ width: 390, height: 844 });
    await noOverflow();
    await picker().selectOption("ru");
    await page.getByRole("link", { name: "Скачать установочный файл", exact: true }).waitFor();
    await noChinese();
    await page.locator(".client-downloads").screenshot({ path: path.join(directory, "downloads-ru-mobile.png") });
    firstRun = true;
    await page.reload();
    await page.getByRole("heading", { name: "Три шага для начала" }).waitFor();
    await noChinese();
    await noOverflow();
    await picker().selectOption("en");
    await page.getByRole("heading", { name: "Get started in three steps" }).waitFor();
    await noChinese();
    assert.deepEqual(errors, []);
    console.log(`Portal i18n screenshots: ${directory}`);
    const blocked = await browser.newContext({ locale: "fr-FR" });
    const blockedPage = await blocked.newPage();
    await blockedPage.addInitScript(() => { Object.defineProperty(window, "localStorage", { get() { throw new Error("Storage blocked"); } }); });
    await blockedPage.route("**/api/**", (route) => route.fulfill({ status: 401, contentType: "application/json", body: "{}" }));
    await blockedPage.goto(base);
    await blockedPage.getByRole("heading", { name: "Sign in to Northstar" }).waitFor();
    await blockedPage.getByLabel("Language", { exact: true }).selectOption("ru");
    await blockedPage.getByRole("heading", { name: "Вход в Northstar" }).waitFor();
  } finally { await browser?.close(); child.kill("SIGTERM"); }
});
