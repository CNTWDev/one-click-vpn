import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const projectRoot = resolve(import.meta.dirname, "..");

async function fixture(envText) {
  const root = await mkdtemp(join(tmpdir(), "northstar-origins-"));
  const scripts = join(root, "scripts");
  await mkdir(scripts);
  await copyFile(join(projectRoot, "scripts/common.sh"), join(scripts, "common.sh"));
  await copyFile(join(projectRoot, "scripts/ensure-service-origins.sh"), join(scripts, "ensure-service-origins.sh"));
  await chmod(join(scripts, "ensure-service-origins.sh"), 0o755);
  await writeFile(join(root, ".env"), envText, { mode: 0o600 });
  return root;
}

test("legacy service origins migrate atomically without changing secrets", async () => {
  const root = await fixture([
    "NODE_ENV=production",
    "APP_DOMAIN=vpn.oiihub.com",
    "NORTHSTAR_PUBLIC_ORIGIN=https://vpn.oiihub.com",
    "NORTHSTAR_ADMIN_PASSWORD=keep-this-secret",
    "NORTHSTAR_MASTER_KEY=keep-this-master-key",
    "",
  ].join("\n"));
  const script = join(root, "scripts/ensure-service-origins.sh");
  const result = spawnSync(script, ["--portal-domain", "app.oiihub.com", "--admin-domain", "console.oiihub.com", "--api-domain", "api.oiihub.com"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const env = await readFile(join(root, ".env"), "utf8");
  assert.match(env, /^APP_DOMAIN=app\.oiihub\.com$/m);
  assert.match(env, /^NORTHSTAR_PORTAL_DOMAIN=app\.oiihub\.com$/m);
  assert.match(env, /^NORTHSTAR_ADMIN_DOMAIN=console\.oiihub\.com$/m);
  assert.match(env, /^NORTHSTAR_API_DOMAIN=api\.oiihub\.com$/m);
  assert.match(env, /^NORTHSTAR_PUBLIC_ORIGIN=https:\/\/app\.oiihub\.com$/m);
  assert.match(env, /^NORTHSTAR_API_ORIGIN=https:\/\/api\.oiihub\.com$/m);
  assert.match(env, /^NORTHSTAR_AGENT_ORIGIN=https:\/\/api\.oiihub\.com$/m);
  assert.match(env, /^NORTHSTAR_ADMIN_PASSWORD=keep-this-secret$/m);
  assert.match(env, /^NORTHSTAR_MASTER_KEY=keep-this-master-key$/m);
  assert.equal((env.match(/^NORTHSTAR_AGENT_ORIGIN=/gm) || []).length, 1);

  const firstBackups = (await readdir(root)).filter((name) => name.startsWith(".env.backup.origins."));
  assert.equal(firstBackups.length, 1);
  const second = spawnSync(script, [], { encoding: "utf8" });
  assert.equal(second.status, 0, second.stderr);
  const secondBackups = (await readdir(root)).filter((name) => name.startsWith(".env.backup.origins."));
  assert.equal(secondBackups.length, 1, "an already migrated environment must not create another backup");
});

test("non-interactive migration refuses to guess missing service domains", async () => {
  const root = await fixture("APP_DOMAIN=vpn.example.com\nNORTHSTAR_PUBLIC_ORIGIN=https://vpn.example.com\n");
  const result = spawnSync(join(root, "scripts/ensure-service-origins.sh"), [], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Legacy single-domain configuration detected/);
});
