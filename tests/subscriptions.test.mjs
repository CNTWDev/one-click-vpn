import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderSubscription } from "../server/subscription-format.ts";
const exec = promisify(execFile);
const parseConfig = (text) => Object.fromEntries(text.trim().split("\n").map((line) => [line.slice(0,line.indexOf(":")),JSON.parse(line.slice(line.indexOf(":")+1))]));
const proxies = [
  { name: "Tokyo\n\"rules\": evil", type: "wireguard", server: "192.0.2.1", port: 51820, ip: "10.70.0.2", "private-key": Buffer.alloc(32,1).toString("base64"), "public-key": Buffer.alloc(32,2).toString("base64"), "allowed-ips": ["0.0.0.0/0"], udp: true, mtu: 1280 },
  { name: "Singapore · VL", type: "vless", server: "192.0.2.2", port: 443, uuid: "12345678-1234-4234-9234-123456789abc", network: "tcp", tls: true, flow: "xtls-rprx-vision", servername: "www.example.com", "client-fingerprint": "chrome", "reality-opts": { "public-key": Buffer.alloc(32,2).toString("base64url"), "short-id": "0123456789abcdef" } },
];
test("subscription format contains selection groups and cannot inject rules", () => {
  const config = parseConfig(renderSubscription(proxies));
  assert.deepEqual(config.rules,["MATCH,Northstar"]);
  assert.equal(config.proxies.length,2);
  assert.equal(config["proxy-groups"][0].type,"select");
  assert.equal(config["proxy-groups"][1].type,"url-test");
  assert.equal(config["allow-lan"],false);
  assert.throws(() => renderSubscription([]),/尚未就绪/);
});
test("VLESS Agent validation and telemetry tests", async () => {
  await exec("python3",["tests/test_vless_agent.py"], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
});
test("generated subscription validates with real Mihomo", { skip: !process.env.NORTHSTAR_TEST_MIHOMO }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(),"northstar-mihomo-config-"));
  try {
    const file = path.join(dir,"config.json");
    await writeFile(file,renderSubscription(proxies));
    await exec(process.env.NORTHSTAR_TEST_MIHOMO,["-t","-d",dir,"-f",file]);
  } finally { await rm(dir,{ recursive: true, force: true }); }
});
