import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hysteria2ShareLink, lineNames, proxyName, renderSubscription, renderV2raySubscription, routingMode, subscriptionClient, subscriptionFormat, vlessShareLink } from "../server/subscription-format.ts";
const exec = promisify(execFile);
const parseConfig = (text) => Object.fromEntries(text.trim().split("\n").map((line) => [line.slice(0,line.indexOf(":")),JSON.parse(line.slice(line.indexOf(":")+1))]));
const proxies = [
  { name: "Tokyo\n\"rules\": evil", type: "wireguard", server: "192.0.2.1", port: 51820, ip: "10.70.0.2", "private-key": Buffer.alloc(32,1).toString("base64"), "public-key": Buffer.alloc(32,2).toString("base64"), "allowed-ips": ["0.0.0.0/0"], udp: true, mtu: 1280 },
  { name: "Singapore · VL", type: "vless", server: "192.0.2.2", port: 443, uuid: "12345678-1234-4234-9234-123456789abc", network: "tcp", tls: true, flow: "xtls-rprx-vision", servername: "www.example.com", "client-fingerprint": "chrome", "reality-opts": { "public-key": Buffer.alloc(32,2).toString("base64url"), "short-id": "0123456789abcdef" } },
];
test("subscription format contains selection groups and cannot inject rules", () => {
  const config = parseConfig(renderSubscription(proxies));
  assert.equal(config.rules.at(-1),"MATCH,TrackNothing");
  assert.ok(config.rules.includes("RULE-SET,cn_ip,DIRECT"));
  assert.ok(config.rules.includes("RULE-SET,cn_domain,DIRECT"));
  // Small rule sets, fetched through the tunnel; no geo database that can block the whole profile.
  assert.equal(config["geox-url"],undefined);
  assert.equal(config["rule-providers"].cn_domain.format,"mrs");
  assert.equal(config["rule-providers"].cn_domain.proxy,"TrackNothing");
  assert.ok(config.rules.includes("IP-CIDR,192.168.0.0/16,DIRECT,no-resolve"));
  assert.equal(config.rules.filter((rule) => rule.startsWith("MATCH")).length,1);
  assert.equal(config.proxies.length,2);
  assert.equal(config["proxy-groups"][0].type,"select");
  assert.equal(config["proxy-groups"][1].type,"url-test");
  // The client's built-in Global switch must use the tunnel, not Mihomo's DIRECT default.
  assert.deepEqual(config["proxy-groups"][2].proxies.slice(0,2),["TrackNothing","自动选择"]);
  assert.equal(config["proxy-groups"][2].name,"GLOBAL");
  assert.equal(config["allow-lan"],false);
  assert.throws(() => renderSubscription([]),/尚未就绪/);
});
test("global mode proxies everything except private networks", () => {
  const config = parseConfig(renderSubscription(proxies, { mode: "global" }));
  assert.equal(config.rules.some((rule) => rule.includes("GEO") || rule.includes("RULE-SET")),false);
  assert.equal(config.rules.at(-1),"MATCH,TrackNothing");
  assert.equal(config["rule-providers"],undefined);
  assert.equal(config.dns["nameserver-policy"],undefined);
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
    // Both modes must load offline: smart routing rule sets are downloaded later and never block startup.
    for (const mode of ["global","smart"]) {
      await writeFile(file,renderSubscription(proxies,{ mode }));
      await exec(process.env.VEILBIRD_TEST_MIHOMO,["-t","-d",dir,"-f",file]);
    }
  } finally { await rm(dir,{ recursive: true, force: true }); }
});

// One subscription node with the apps' three lines: Hysteria2, REALITY, XHTTP (same UUID).
const uuid = "12345678-1234-4234-9234-123456789abc";
const realityOpts = { "public-key": Buffer.alloc(32,2).toString("base64url"), "short-id": "0123456789abcdef" };
const stealthLines = (node) => {
  const lines = [
    { name: "", type: "hysteria2", server: "192.0.2.3", port: 8443, password: uuid, obfs: "salamander", "obfs-password": "obfs-password-0123456789", sni: "www.bing.com", "skip-cert-verify": true, fingerprint: "ab".repeat(32), alpn: ["h3"], udp: true },
    { name: "", type: "vless", server: "192.0.2.3", port: 443, uuid, network: "tcp", tls: true, udp: true, flow: "xtls-rprx-vision", servername: "www.example.com", "client-fingerprint": "chrome", "reality-opts": realityOpts },
    { name: "", type: "vless", server: "192.0.2.3", port: 8443, uuid, network: "xhttp", tls: true, udp: true, servername: "www.example.com", "client-fingerprint": "chrome", "reality-opts": realityOpts, "xhttp-opts": { path: "/abcdefghijkl" } },
  ];
  return (format) => { const names = lineNames(node, lines.length, format); return lines.map((line, index) => ({ ...line, name: names[index] })); };
};
test("Clash: each node is one hidden fallback group over its lines, picked like a plain node", () => {
  const tokyo = stealthLines("🇯🇵 Tokyo")("clash"), solo = { ...proxies[1], name: "solo" };
  const config = parseConfig(renderSubscription([...tokyo, solo], { nodes: [{ name: "🇯🇵 Tokyo", proxies: tokyo.map((p) => p.name) }, { name: "solo", proxies: ["solo"] }] }));
  assert.deepEqual(tokyo.map((p) => p.name), ["🇯🇵 Tokyo · 线路 1", "🇯🇵 Tokyo · 线路 2", "🇯🇵 Tokyo · 线路 3"]);
  const groups = Object.fromEntries(config["proxy-groups"].map((group) => [group.name, group]));
  assert.deepEqual(groups.TrackNothing.proxies, ["自动选择", "🇯🇵 Tokyo", "solo"]);
  assert.deepEqual(groups["自动选择"].proxies, ["🇯🇵 Tokyo", "solo"]);
  assert.deepEqual(groups.GLOBAL.proxies, ["TrackNothing", "自动选择", "🇯🇵 Tokyo", "solo"]);
  assert.equal(groups["🇯🇵 Tokyo"].type, "fallback");
  assert.equal(groups["🇯🇵 Tokyo"].hidden, true);
  assert.deepEqual(groups["🇯🇵 Tokyo"].proxies, tokyo.map((p) => p.name));
  assert.equal(groups.solo, undefined, "a node with one line needs no group");
});
test("share links: Hysteria2 pinned, XHTTP without flow, backups named after the node", () => {
  const lines = stealthLines("Tokyo")("v2ray");
  assert.deepEqual(lines.map((p) => p.name), ["Tokyo", "Tokyo · 备用 1", "Tokyo · 备用 2"]);
  const links = Buffer.from(renderV2raySubscription(lines), "base64").toString().trim().split("\n").map((link) => new URL(link));
  assert.equal(links.length, 3);
  assert.equal(links[0].protocol, "hysteria2:");
  assert.equal(links[0].username, uuid);
  assert.equal(links[0].port, "8443");
  assert.equal(links[0].searchParams.get("obfs"), "salamander");
  assert.equal(links[0].searchParams.get("obfs-password"), "obfs-password-0123456789");
  assert.equal(links[0].searchParams.get("pinSHA256"), "ab".repeat(32));
  assert.equal(links[0].searchParams.get("sni"), "www.bing.com");
  assert.equal(links[1].searchParams.get("type"), "tcp");
  assert.equal(links[2].searchParams.get("type"), "xhttp");
  assert.equal(links[2].searchParams.get("path"), "/abcdefghijkl");
  assert.equal(links[2].searchParams.get("flow"), null);
  assert.equal(links[2].searchParams.get("security"), "reality");
  assert.equal(hysteria2ShareLink({ ...lines[0], server: "2001:db8::1" }).includes("@[2001:db8::1]:8443/?"), true);
  // No pin, no Hysteria2 line (user rule): never skip certificate checks without one.
  assert.equal(Buffer.from(renderV2raySubscription([{ ...lines[0], fingerprint: "" }, lines[1]]), "base64").toString().trim().split("\n").length, 1);
});
test("each client only gets the lines it can use", () => {
  assert.deepEqual(subscriptionClient("clash", "clash-verge/v2.2.3"), { hysteria2: true, xhttp: true });
  assert.deepEqual(subscriptionClient("clash", "mihomo/1.19.33"), { hysteria2: true, xhttp: true });
  assert.deepEqual(subscriptionClient("clash", "mihomo/v1.19.22"), { hysteria2: true, xhttp: true });
  assert.deepEqual(subscriptionClient("clash", "mihomo/1.19.21"), { hysteria2: true, xhttp: false });
  assert.deepEqual(subscriptionClient("clash", "mihomo/1.18.10"), { hysteria2: true, xhttp: false });
  assert.deepEqual(subscriptionClient("clash", "mihomo/2.0.0"), { hysteria2: true, xhttp: true });
  assert.deepEqual(subscriptionClient("clash", "HiddifyNext/2.5.7"), { hysteria2: false, xhttp: false });
  // Stash: no documented Hysteria2 pin, so REALITY + XHTTP only, with the REALITY server name as `sni`.
  assert.deepEqual(subscriptionClient("clash", "Stash/3.1.1 Clash/1.11.0"), { hysteria2: false, xhttp: true, sni: true });
  assert.equal(subscriptionFormat(null, "Stash/3.1.1 Clash/1.11.0"), "clash");
  assert.deepEqual(subscriptionClient("v2ray", "Shadowrocket/2070"), { hysteria2: false, xhttp: true });
  assert.deepEqual(subscriptionClient("v2ray", "v2rayNG/1.10.2"), { hysteria2: true, xhttp: true });
  assert.deepEqual(lineNames("Tokyo", 1, "clash"), ["Tokyo"]);
});
test("generated multi-line subscription validates with real Mihomo", { skip: !process.env.VEILBIRD_TEST_MIHOMO }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(),"northstar-mihomo-lines-"));
  try {
    const file = path.join(dir,"config.json"), tokyo = stealthLines("🇯🇵 Tokyo")("clash");
    await writeFile(file,renderSubscription(tokyo,{ mode: "global", nodes: [{ name: "🇯🇵 Tokyo", proxies: tokyo.map((p) => p.name) }] }));
    await exec(process.env.VEILBIRD_TEST_MIHOMO,["-t","-d",dir,"-f",file]);
  } finally { await rm(dir,{ recursive: true, force: true }); }
});
