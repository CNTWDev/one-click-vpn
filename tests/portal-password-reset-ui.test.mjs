import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { auditLayout } from "./fixtures/layout-audit.mjs";

// Forgot-password and reset screens in every locale and width: flow works, and nothing overflows, spills or overlaps.
// VEILBIRD_TEST_PLAYWRIGHT=<playwright-core entry> [VEILBIRD_TEST_BROWSER=<chromium>] [VEILBIRD_LAYOUT_SHOTS=<dir>]
const copy = {
  zh: { forgot: "忘记密码？", send: "发送重置链接", sent: "如果该邮箱已注册", admin: "请联系管理员", save: "保存新密码", done: "密码已更新", bad: "重置链接无效或已过期", email: "邮箱", password: "新密码" },
  en: { forgot: "Forgot password?", send: "Send reset link", sent: "If this email has an account", admin: "Ask your administrator", save: "Save password", done: "Password updated", bad: "This reset link is invalid", email: "Email", password: "New password" },
  ru: { forgot: "Забыли пароль?", send: "Отправить ссылку", sent: "Если такой аккаунт есть", admin: "Попросите администратора", save: "Сохранить пароль", done: "Пароль обновлён", bad: "Ссылка недействительна", email: "Электронная почта", password: "Новый пароль" },
};

test("Portal password reset: forgot (email and admin), reset link, all locales and widths", { skip: !process.env.VEILBIRD_TEST_PLAYWRIGHT, timeout: 300000 }, async () => {
  const { chromium } = await import(process.env.VEILBIRD_TEST_PLAYWRIGHT);
  const shots = process.env.VEILBIRD_LAYOUT_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  const port = 3395, base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["frontend-server.mjs"], { env: { ...process.env, STATIC_DIR: path.resolve("dist/portal-web"), PORT: String(port) }, stdio: "ignore" });
  let browser;
  const failures = [], errors = [];
  try {
    for (let n = 0; n < 60; n++) { if (await fetch(`${base}/health`).then((r) => r.ok).catch(() => false)) break; await new Promise((r) => setTimeout(r, 100)); }
    browser = await chromium.launch({ headless: true, ...(process.env.VEILBIRD_TEST_BROWSER ? { executablePath: process.env.VEILBIRD_TEST_BROWSER } : {}) });
    for (const [locale, browserLocale] of [["zh", "zh-CN"], ["en", "en-US"], ["ru", "ru-RU"]]) {
      const text = copy[locale];
      for (const width of [1440, 1100, 820, 390]) {
        for (const mailEnabled of [true, false]) {
          const context = await browser.newContext({ locale: browserLocale, viewport: { width, height: 900 }, reducedMotion: "reduce" });
          context.setDefaultTimeout(10000);
          const requests = [];
          await context.route("**/api/**", async (route) => {
            const { pathname } = new URL(route.request().url());
            const body = route.request().postDataJSON?.() ?? null;
            requests.push({ pathname, method: route.request().method(), body });
            const [status, json] = pathname === "/api/v1/auth/password-reset" ? (route.request().method() === "GET" ? [200, { email: mailEnabled }] : [202, { status: "received" }])
              : pathname === "/api/v1/auth/password-reset/confirm" ? (body?.token === "good.1.sig" ? [200, { ok: true }] : [400, { error: "This reset link is invalid or has expired" }])
                : [401, { error: "Authentication required" }];
            await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(json) });
          });
          const page = await context.newPage();
          page.on("pageerror", (error) => errors.push(`${locale}: ${error.message}`));
          const audit = async (view) => {
            await page.waitForTimeout(200);
            for (const issue of await page.evaluate(`(${auditLayout})()`)) failures.push(`${locale} ${width}px ${view}: [${issue.kind}] ${issue.detail}`);
            if (shots) await page.screenshot({ path: path.join(shots, `portal-${locale}-${width}-${view}.png`), fullPage: true });
          };
          await page.goto(base);
          await page.getByRole("button", { name: text.forgot }).waitFor();
          if (mailEnabled) await audit("login");
          await page.getByRole("button", { name: text.forgot }).click();
          if (mailEnabled) {
            await page.getByRole("button", { name: text.send }).waitFor();
            await audit("forgot");
            await page.getByLabel(text.email, { exact: true }).fill("someone@example.com");
            await page.getByRole("button", { name: text.send }).click();
            await page.getByText(text.sent).waitFor();
            await audit("forgot-sent");
            assert.deepEqual(requests.find((r) => r.method === "POST")?.body, { email: "someone@example.com", language: locale });
          } else {
            await page.getByText(text.admin).waitFor();
            assert.equal(await page.getByLabel(text.email, { exact: true }).count(), 0);
            await audit("forgot-admin");
            // The reset link itself works the same whether it came by email or from an administrator.
            await page.goto(`${base}/#reset=bad.1.sig`);
            await page.getByLabel(text.password, { exact: true }).fill("new-password-123");
            await page.getByRole("button", { name: text.save }).click();
            await page.getByText(text.bad).waitFor();
            await audit("reset-error");
            await page.goto(`${base}/#reset=good.1.sig`);
            await page.reload();
            await page.getByLabel(text.password, { exact: true }).fill("new-password-123");
            await page.getByRole("button", { name: text.save }).click();
            await page.getByText(text.done).waitFor();
            assert.equal(new URL(page.url()).hash, "", "the token leaves the address bar");
            await audit("reset-done");
          }
          await context.close();
        }
      }
    }
  } finally { await browser?.close(); child.kill("SIGTERM"); }
  assert.deepEqual(errors, []);
  assert.equal(failures.length, 0, `${failures.length} layout problems:\n${failures.join("\n")}`);
});
