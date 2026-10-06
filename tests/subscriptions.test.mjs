import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { proxyName, renderSubscription, renderV2raySubscription, routingMode, subscriptionFormat, vlessShareLink } from "../server/subscription-format.ts";
const exec = promisify(execFile);
const parseConfig = (text) => Object.fromEntries(text.trim().split("\n").map((line) => [line.slice(0,line.indexOf(":")),JSON.parse(line.slice(line.indexOf(":")+1))]));
const proxies = [
  { name: "Tokyo\n\"rules\": evil", type: "wireguard", server: "192.0.2.1", port: 51820, ip: "10.70.0.2", "private-key": Buffer.alloc(32,1).toString("base64"), "public-key": Buffer.alloc(32,2).toString("base64"), "allowed-ips": ["0.0.0.0/0"], udp: true, mtu: 1280 },
  { name: "Singapore · VL", type: "vless", server: "192.0.2.2", port: 443, uuid: "12345678-1234-4234-9234-123456789abc", network: "tcp", tls: true, flow: "xtls-rprx-vision", servername: "www.example.com", "client-fingerprint": "chrome", "reality-opts": { "public-key": Buffer.alloc(32,2).toString("base64url"), "short-id": "0123456789abcdef" } },
];
test("subscription format contains selection groups and cannot inject rules", () => {
  const config = parseConfig(renderSubscription(proxies));
  assert.equal(config.rules.at(-1),"MATCH,Veilbird");
  assert.ok(config.rules.includes("GEOIP,CN,DIRECT"));
  assert.ok(config.rules.includes("IP-CIDR,192.168.0.0/16,DIRECT,no-resolve"));
  assert.equal(config.rules.filter((rule) => rule.startsWith("MATCH")).length,1);
  assert.equal(config.proxies.length,2);
  assert.equal(config["proxy-groups"][0].type,"select");
  assert.equal(config["proxy-groups"][1].type,"url-test");
  assert.equal(config["allow-lan"],false);
  assert.throws(() => renderSubscription([]),/尚未就绪/);
});
test("global mode proxies everything except private networks", () => {
  const config = parseConfig(renderSubscription(proxies, { mode: "global" }));
  assert.equal(config.rules.some((rule) => rule.includes("GEO")),false);
  assert.equal(config.rules.at(-1),"MATCH,Veilbird");
  assert.equal(config["geox-url"],undefined);
});
test("v2ray format lists standard vless:// share links", () => {
  const decoded = Buffer.from(renderV2raySubscription(proxies),"base64").toString().trim().split("\n");
  assert.equal(decoded.length,1);
  const link = new URL(decoded[0]);
  assert.equal(link.protocol,"vless:");
  assert.equal(link.username,"12345678-1234-4234-9234-123456789abc");
  assert.equal(link.searchParams.get("security"),"reality");
  assert.equal(link.searchParams.get("sni"),"www.example.com");
  assert.equal(link.searchParams.get("flow"),"xtls-rprx-vision");
  assert.equal(link.searchParams.get("sid"),"0123456789abcdef");
  assert.equal(decodeURIComponent(link.hash.slice(1)),"Singapore · VL");
  assert.match(vlessShareLink({ ...proxies[1], server: "2001:db8::1" }),/@\[2001:db8::1\]:443\?/);
  assert.throws(() => renderV2raySubscription([proxies[0]]),/Clash/);
});
test("format and mode selection", () => {
  assert.equal(subscriptionFormat(null,"Shadowrocket/2070"),"v2ray");
  assert.equal(subscriptionFormat(null,"clash-verge/v2.0 mihomo"),"clash");
  assert.equal(subscriptionFormat(null,null),"clash");
  assert.equal(subscriptionFormat("v2ray","clash"),"v2ray");
  assert.equal(routingMode("global"),"global");
  assert.equal(routingMode("anything"),"smart");
});
test("node names are readable, flagged and unique", () => {
  const used = new Set();
  assert.equal(proxyName({ countryCode: "jp", region: "Tokyo", nodeName: "edge-01", nodeId: "node_aaaa1111" }, used),"🇯🇵 Tokyo · edge-01");
  assert.equal(proxyName({ countryCode: "JP", region: "Tokyo", nodeName: "edge-01", nodeId: "node_bbbb2222" }, used),"🇯🇵 Tokyo · edge-01 · 2222");
  assert.equal(proxyName({ countryCode: null, region: null, nodeName: "solo", nodeId: "n" }, used),"solo");
});
test("VLESS Agent validation and telemetry tests", async () => {
  await exec("python3",["tests/test_vless_agent.py"], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
});
test("generated subscription validates with real Mihomo", { skip: !process.env.VEILBIRD_TEST_MIHOMO }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(),"northstar-mihomo-config-"));
  try {
    const file = path.join(dir,"config.json");
    await writeFile(file,renderSubscription(proxies,{ mode: "global" }));
    await exec(process.env.VEILBIRD_TEST_MIHOMO,["-t","-d",dir,"-f",file]);
    // Smart routing needs geodata; point VEILBIRD_TEST_MIHOMO_GEODATA at a directory with GeoSite.dat/GeoIP.dat.
    if (process.env.VEILBIRD_TEST_MIHOMO_GEODATA) {
      for (const name of ["GeoSite.dat","GeoIP.dat"]) await copyFile(path.join(process.env.VEILBIRD_TEST_MIHOMO_GEODATA,name),path.join(dir,name));
      await writeFile(file,renderSubscription(proxies));
      await exec(process.env.VEILBIRD_TEST_MIHOMO,["-t","-d",dir,"-f",file]);
    }
  } finally { await rm(dir,{ recursive: true, force: true }); }
});
