import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("REALITY setup UI: automatic default, custom target flow, per-node override and mobile layout", { skip: !process.env.NORTHSTAR_TEST_PLAYWRIGHT }, async () => {
  const { chromium } = await import(process.env.NORTHSTAR_TEST_PLAYWRIGHT);
  const port = 3391;
  const child = spawn(process.execPath, ["frontend-server.mjs"], { env: { ...process.env, STATIC_DIR: path.resolve("dist/admin-web"), PORT: String(port) }, stdio: "ignore" });
  let browser;
  try {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false)) break;
      await new Promise((resolve) => setTimeout(resolve,100));
    }
    browser = await chromium.launch({ headless: true, ...(process.env.NORTHSTAR_TEST_BROWSER ? { executablePath: process.env.NORTHSTAR_TEST_BROWSER } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const candidates = ["www.microsoft.com", "www.apple.com"];
    let defaults = { mode: "auto", serverName: "", candidates, checkedAt: null, updatedAt: null };
    let deployment;
    let lastPut;
    let failSave = false;
    await page.route("**/api/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      let body = {};
      let status = 200;
      if (pathname === "/api/auth/me") body = { user: { id: "owner", displayName: "Owner", email: "owner@example.com" } };
      else if (pathname === "/api/nodes") body = { nodes: [{ id: "node-1", name: "Singapore", ip: "192.0.2.1", status: "online" }] };
      else if (pathname === "/api/controller") body = { settings: null };
      else if (pathname === "/api/vpn-services") body = { services: [{ node_id: "node-1", protocol: "vless", enabled: true, transport: "tcp", listen_port: 443, subnet: "", dns: [], status: "healthy", updated_at: new Date().toISOString() }] };
      else if (pathname === "/api/deployment-policy") body = { standard: { version: 2, protocols: ["wireguard","openvpn","vless"].map((protocol) => ({protocol,transport:"tcp",listenPort:443})) }, counts:{standardNodes:1,eligibleNodes:1,driftedNodes:1,blockedNodes:0},driftedNodes:[],rollouts:[] };
      else if (pathname === "/api/reality-defaults") {
        if (route.request().method() === "PUT") {
          lastPut = route.request().postDataJSON();
          if (failSave) { status = 400; body = { error: "请在站点 Nginx 中启用 HTTP/2" }; }
          else { defaults = { ...defaults, mode: lastPut.mode, serverName: lastPut.serverName || "", checkedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; body = defaults; }
        } else body = defaults;
      } else if (pathname === "/api/nodes/node-1/services") { deployment = route.request().postDataJSON(); body = { service: {} }; }
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    });
    // Deep link straight to the REALITY tab: automatic selection is the default and needs no input.
    await page.goto(`http://127.0.0.1:${port}/#/services?tab=reality`);
    assert.equal(await page.getByRole("radio", { name: /自动选择/ }).isChecked(), true);
    await page.getByText("www.microsoft.com", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("独立站点域名").count(), 0);
    // Custom (advanced) keeps the self-hosted setup-command helper.
    await page.getByText("自定义目标（高级）", { exact: true }).click();
    await page.getByLabel("独立站点域名").fill("www.example.com");
    await page.getByText("还没有目标站点？查看一键初始化步骤", { exact: true }).click();
    await page.getByLabel("证书续期联系邮箱").fill("ops@example.com");
    assert.match(await page.locator("code.command").textContent(), /--domain www.example.com --email ops@example.com/);
    failSave = true;
    await page.getByRole("button", { name: "检测并保存", exact: true }).click();
    await page.getByText("请在站点 Nginx 中启用 HTTP/2", { exact: true }).waitFor();
    failSave = false;
    await page.getByRole("button", { name: "检测并保存", exact: true }).click();
    await page.getByRole("tab", { name: /REALITY 设置\s*自定义/ }).waitFor();
    assert.deepEqual(lastPut, { mode: "custom", serverName: "www.example.com" });
    // Switching back to automatic sends only the mode.
    await page.getByRole("radio", { name: /自动选择/ }).check();
    await page.getByRole("button", { name: "切换为自动选择", exact: true }).click();
    await page.getByRole("tab", { name: /REALITY 设置\s*自动/ }).waitFor();
    assert.deepEqual(lastPut, { mode: "auto" });
    // Per-node override: protocol badge -> 高级设置; it no longer switches the node to the custom policy.
    await page.getByRole("tab", { name: /服务状态/ }).click();
    await page.locator(".proto-badge", { hasText: "VLESS" }).click();
    await page.getByRole("menuitem", { name: /高级设置/ }).click();
    await page.getByLabel("监听端口").fill("8443");
    await page.getByRole("button", { name: "保存并部署", exact: true }).click();
    const confirmDialog = page.locator("dialog[open]");
    assert.match(await confirmDialog.textContent(), /部署策略保持不变/);
    assert.match(await confirmDialog.textContent(), /旧 SNI 在过渡期内仍然有效/);
    await confirmDialog.getByRole("button", { name: "保存并部署", exact: true }).click();
    await page.getByText("单节点协议配置已提交", { exact: false }).waitFor();
    assert.equal(deployment.serverName, "");
    assert.equal(deployment.nodeId, undefined);
    assert.equal(deployment.listenPort, 8443);
    assert.equal(deployment.customize, true);
    const directory = await mkdtemp(path.join(tmpdir(), "northstar-reality-ui-"));
    await page.screenshot({ path: path.join(directory,"desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("tab", { name: /REALITY 设置/ }).click();
    await page.getByText("自定义目标（高级）", { exact: true }).click();
    await page.getByText("还没有目标站点？查看一键初始化步骤", { exact: true }).click();
    await page.getByLabel("证书续期联系邮箱").fill("ops@example.com");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.screenshot({ path: path.join(directory,"mobile.png"), fullPage: true });
    assert.deepEqual(errors, []);
    console.log(`REALITY UI screenshots: ${directory}`);
  } finally { await browser?.close(); child.kill("SIGTERM"); }
});
