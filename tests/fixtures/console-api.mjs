// Realistic Console API responses for browser tests: real-looking fleets, long names and every page populated,
// so layout checks see the same density operators do (empty tables hide most layout bugs).
const now = new Date().toISOString();
const ago = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
const GB = 1073741824;

const user = { id: "owner", displayName: "Owner", email: "owner@example.com", role: "admin", status: "active", createdAt: "2026-10-01T00:00:00Z" };
const users = [
  { ...user, accessSummary: { deviceCount: 3, activeDeviceCount: 2, credentialCount: 4, activeCredentialCount: 3, profileCount: 5, activeProfileCount: 4, certificateCount: 1, activeCertificateCount: 1, uploadBytes: 3.2 * GB, downloadBytes: 41.7 * GB, totalBytes: 44.9 * GB, lastActivityAt: ago(3) } },
  { id: "u2", displayName: "Aleksandra Konstantinopolskaya", email: "aleksandra.konstantinopolskaya@very-long-company-domain.example", role: "user", status: "pending", createdAt: "2026-10-05T00:00:00Z" },
  { id: "u3", displayName: "李明", email: "liming@example.cn", role: "user", status: "active", createdAt: "2026-10-02T00:00:00Z", accessSummary: { deviceCount: 1, activeDeviceCount: 1, credentialCount: 1, activeCredentialCount: 1, profileCount: 1, activeProfileCount: 1, certificateCount: 0, activeCertificateCount: 0, uploadBytes: 120e6, downloadBytes: 2.1 * GB, totalBytes: 2.2 * GB, lastActivityAt: ago(60) } },
  { id: "u4", displayName: "Disabled User", email: "disabled@example.com", role: "user", status: "disabled", createdAt: "2026-09-02T00:00:00Z" },
];

const regions = [
  { id: "r1", name: "Cape Town", country: "South Africa", code: "ZA" },
  { id: "r2", name: "Singapore", country: "Singapore", code: "SG" },
  { id: "r3", name: "Ohio", country: "United States", code: "US" },
  { id: "r4", name: "Malaysia", country: "Malaysia", code: "MY" },
  { id: "r5", name: "São Paulo Metropolitan Area", country: "Brazil", code: "BR" },
];
const metrics = (cpu, mem, disk) => ({ collectedAt: now, cpuPercent: cpu, load1: cpu / 25, memory: { usedBytes: mem * 0.08 * GB, totalBytes: 8 * GB, percent: mem }, disk: { usedBytes: disk * 0.4 * GB, totalBytes: 40 * GB, percent: disk }, network: { rxBytes: 9e9, txBytes: 7e9, rxBytesPerSecond: 120000, txBytesPerSecond: 98000 } });
const node = (id, name, region, ip, user, port, extra = {}) => ({ id, name, place: regions.find((r) => r.id === region).name, region_id: region, ip, ssh_user: user, ssh_port: port, ssh_privilege_mode: "auto", credential_type: "private_key", status: "online", latency: "38 ms", users: 3, traffic: "12.4 GB", version: "agent 2.10.0", last_seen: "now", host_fingerprint: "SHA256:" + "x".repeat(43), host_fingerprint_source: "ssh_tofu", node_identity: "node-" + id, identity_verified_at: now, deployment_policy: "standard", policy_version: 2, metrics: metrics(2, 17, 3), ...extra });
const nodes = [
  node("n1", "13.245.35.167@Cape Town", "r1", "13.245.35.167", "root", 10022, { metrics: metrics(2, 17, 3) }),
  node("n2", "190.92.202.34@Singapore", "r2", "190.92.202.34", "root", 22, { metrics: metrics(3, 16, 18) }),
  node("n3", "3.139.105.5(US)", "r3", "3.139.105.5", "ubuntu", 22, { metrics: metrics(2, 48, 3) }),
  node("n4", "Johor-bytedance", "r4", "101.47.28.201", "root", 22, { metrics: metrics(100, 94, 71) }),
  node("n5", "sao-paulo-edge-gateway-primary-with-a-very-long-hostname", "r5", "2001:db8:85a3::8a2e:370:7334", "administrator", 65022, { status: "offline", last_seen: "2 days ago", metrics: null, deployment_policy: "custom", policy_version: 1, version: "agent 2.9.4" }),
];

const services = nodes.slice(0, 4).flatMap((n) => [
  { node_id: n.id, protocol: "wireguard", enabled: true, transport: "udp", listen_port: 51820, subnet: "10.66.0.0/24", dns: ["1.1.1.1", "8.8.8.8"], status: "running", last_error: "", updated_at: now },
  { node_id: n.id, protocol: "vless", enabled: true, transport: "tcp", listen_port: 443, subnet: "", dns: [], status: n.id === "n4" ? "error" : "running", last_error: n.id === "n4" ? "xray: failed to bind 0.0.0.0:443: address already in use by another long-running process (nginx)" : "", updated_at: now },
  { node_id: n.id, protocol: "openvpn", enabled: n.id !== "n2", transport: "udp", listen_port: 1194, subnet: "10.8.0.0/24", dns: ["1.1.1.1"], status: n.id !== "n2" ? "running" : "stopped", last_error: "", updated_at: now },
]);

const credential = (id, name, protocol, extra = {}) => ({ subscriptionId: null, expiringSoon: false, daysRemaining: 28, userDisabled: false, adminDisabled: false, accountStatus: "active", syncStatus: "synced", id, name, protocol, status: "active", state: "active", identitySuffix: id.slice(-6), online: true, connectionCount: 2, lastActivityAt: ago(2), lastObservedAt: now, profileCount: 2, activeProfileCount: 2, expiresAt: "2026-11-04T00:00:00Z", revokedAt: null, createdAt: "2026-10-01T00:00:00Z", updatedAt: now, uploadBytes: 1.2 * GB, downloadBytes: 18.4 * GB, totalBytes: 19.6 * GB, ...extra });
const access = {
  from: ago(43200), to: now, updatedAt: now, totals: { uploadBytes: 3.2 * GB, downloadBytes: 41.7 * GB, totalBytes: 44.9 * GB },
  summary: { deviceCount: 3, activeDeviceCount: 2, credentialCount: 3, activeCredentialCount: 2, profileCount: 4, activeProfileCount: 3, certificateCount: 1, activeCertificateCount: 1 },
  credentials: [credential("cred_aaaaaa111111", "iPhone 16 Pro Max · Shadowrocket", "vless", { subscriptionId: "sub_1" }), credential("cred_bbbbbb222222", "MacBook", "wireguard"), credential("cred_cccccc333333", "Old laptop", "openvpn", { status: "revoked", state: "revoked", online: false, revokedAt: ago(9000), connectionCount: 0 })],
  devices: [{ deviceId: "dev_1", displayName: "Pixel 9 Pro", platform: "android", appVersion: "1.2.0 (12)", publicKey: "k".repeat(44), status: "active", createdAt: now, updatedAt: now, lastSeenAt: ago(1), lastActivityAt: ago(1), uploadBytes: 1e9, downloadBytes: 9e9, totalBytes: 1e10 }],
  profiles: [{ profileId: "prof_1", deviceId: "dev_1", credentialId: "cred_bbbbbb222222", protocol: "wireguard", nodeId: "n2", nodeName: "190.92.202.34@Singapore", regionName: "Singapore", regionCode: "SG", transport: "udp", revision: 3, status: "active", clientAddress: "10.66.0.12", issuedAt: now, expiresAt: "2026-11-04T00:00:00Z", updatedAt: now, credentialIdentity: "wg-bbbbbb222222", lastActivityAt: ago(1), trafficAttribution: "exact", uploadBytes: 1e9, downloadBytes: 9e9, totalBytes: 1e10 }],
  certificates: [{ certificateId: "cert_1", authorityId: "ca_1", deviceId: "dev_1", credentialId: "cred_cccccc333333", serial: "4F:2A:91:0C:7B:33:12:EE", subject: "CN=owner-old-laptop", certificatePem: "", fingerprint: "SHA256:" + "f".repeat(43), status: "active", notBefore: "2026-10-01T00:00:00Z", notAfter: "2027-10-01T00:00:00Z", revokedAt: null, createdAt: now, updatedAt: now, authorityRealm: "veilbird", authorityStatus: "active", lastActivityAt: ago(500), trafficAttribution: "estimated", uploadBytes: 2e8, downloadBytes: 1e9, totalBytes: 1.2e9 }],
};

const actions = [
  { id: "act_1", action: "upgrade-agent", status: "succeeded", output: "agent 2.10.0 installed", error: "", created_at: ago(30), started_at: ago(30), finished_at: ago(29), current_phase: "complete", progress: 100 },
  { id: "act_2", action: "repair", status: "failed", output: "", error: "Failed to stop northstar-agent-upgrade-rollback.service: Unit northstar-agent-upgrade-rollback.service not loaded.", created_at: ago(300), started_at: ago(300), finished_at: ago(298), current_phase: "verify", progress: 80 },
];
const actionEvents = [
  ["info", "complete", "Operation completed successfully"], ["info", "verify", "Waiting for authenticated version heartbeat"],
  ["warning", "output", "Failed to reset failed state of unit northstar-agent-upgrade-rollback.service: Unit northstar-agent-upgrade-rollback.service not loaded."],
  ["error", "output", "Job for northstar-agent.service failed because the control process exited with error code."],
  ["info", "upgrade", "Uploading Controller Agent release"], ["info", "connecting", "Worker accepted the operation and is connecting to the node"],
].map(([level, phase, message], i) => ({ id: `ev_${i}`, action_id: "act_1", sequence: 10 - i, level, phase, message, created_at: ago(30 + i) }));
const connectivity = { status: "degraded", agentChannel: "connected", lastAuthenticatedHeartbeat: now, firewall: { manager: "ufw", inputPolicy: "drop" },
  protocols: [{ protocol: "wireguard", state: "ready", configured: true, taskStatus: null, lastError: "", transport: "udp", port: 51820, installed: true, runtimeActive: true, listening: true, hostFirewall: "open", cloudFirewall: "unknown" },
    { protocol: "vless", state: "error", configured: true, taskStatus: "failed", lastError: "address already in use", transport: "tcp", port: 443, installed: true, runtimeActive: false, listening: false, hostFirewall: "open", cloudFirewall: "unknown" }],
  note: "Cloud firewall rules cannot be inspected from the node; confirm the provider security group allows these ports." };

const subscriptions = [
  { id: "sub_1", credential_id: "cred_aaaaaa111111", display_name: "我的订阅", email: "owner@example.com", protocol: "vless", status: "active", user_disabled: false, admin_disabled: false, account_status: "active", expires_at: "2026-11-04T00:00:00Z", last_fetched_at: ago(5), total_bytes: String(19.6 * GB), synced_nodes: 4 },
  { id: "sub_2", credential_id: "cred_dddddd444444", display_name: "Family router — living room (long name)", email: "aleksandra.konstantinopolskaya@very-long-company-domain.example", protocol: "wireguard", status: "active", user_disabled: false, admin_disabled: true, account_status: "active", expires_at: "2026-10-09T00:00:00Z", last_fetched_at: null, total_bytes: "0", synced_nodes: 0 },
];

const logs = [
  { timestamp: ago(1), labels: { node: "n1", level: "info", service: "agent" }, message: "heartbeat ok · reconcile revision 14 applied (wireguard, vless, openvpn)" },
  { timestamp: ago(3), labels: { node: "n4", level: "error", service: "xray" }, message: "failed to bind 0.0.0.0:443: address already in use; a very long log line continues here with stack details /usr/local/bin/xray run -config /etc/northstar/xray/config.json", actionId: "act_1" },
  { timestamp: ago(8), labels: { node: "n2", level: "warning", service: "agent" }, message: "disk usage above 80% on /var/lib/docker" },
];

const release = (id, platform, channel, version, build, extra = {}) => ({ id, platform, arch: "universal", channel, version, build, status: "published", distribution: "direct", url: `https://downloads.example.com/veilbird/${platform}/${version}/Veilbird-${version}-${platform}-universal-release.bin`, sha256: "a".repeat(64), sizeBytes: 48234567, minOs: platform === "android" ? "Android 8.0" : platform === "windows" ? "Windows 10 1809" : "13.0", notes: "Fixes reconnect after network change.", publishedAt: "2026-10-06T00:00:00Z", createdAt: "2026-10-06T00:00:00Z", createdBy: "release-token", rolloutPercent: channel === "beta" ? 20 : 100, ...extra });

export function consoleApi({ signedIn = true } = {}) {
  let session = signedIn;
  return (pathname, method) => {
    if (pathname === "/api/auth/me") return session ? [200, { user }] : [401, { error: "Authentication required" }];
    if (pathname === "/api/auth/login") { session = true; return [200, { user }]; }
    if (pathname === "/api/auth/logout") { session = false; return [200, {}]; }
    if (pathname === "/api/v1/admin/users") return [200, { users }];
    if (/^\/api\/v1\/admin\/users\/[^/]+\/credentials$/.test(pathname)) return [200, access];
    if (/^\/api\/v1\/admin\/users\/[^/]+\/native-access$/.test(pathname)) return [200, { enabled: true, devices: [], credentials: [] }];
    if (pathname === "/api/nodes") return [200, { nodes }];
    if (pathname === "/api/nodes/agent-release") return [200, { version: "2.10.0", revision: "test" }];
    if (/^\/api\/nodes\/[^/]+$/.test(pathname) && method === "GET") return [200, { node: nodes.find((n) => pathname.endsWith(n.id)), actions, actionEvents, reconcile: { observed: [{ protocol: "vless", appliedRevision: 14, status: "applied", lastError: "", updatedAt: now }], tasks: [{ id: "task_1", protocol: "vless", taskType: "apply", desiredRevision: 15, status: "failed", attempts: 3, lastError: "xray: failed to bind 0.0.0.0:443", createdAt: ago(20), startedAt: ago(19), finishedAt: ago(18) }] }, connectivity }];
    if (pathname === "/api/regions") return [200, { regions }];
    if (pathname === "/api/controller") return [200, { settings: { display_name: "VEILBIRD", location_label: "Frankfurt am Main, Germany", latitude: 50.11, longitude: 8.68, location_source: "manual" }, status: "healthy", publicOrigin: "https://console.very-long-subdomain.example.com", publicHost: "console.very-long-subdomain.example.com", publicIp: "192.0.2.1", build: "9089cc4", runtime: { uptimeSeconds: 450000, nodeVersion: "22.13.0", rssBytes: 183e6, heapUsedBytes: 92e6, load1: 0.25, observedAt: now } }];
    if (pathname === "/api/vpn-services") return [200, { services }];
    if (pathname === "/api/deployment-policy") return [200, { standard: { version: 2, protocols: [{ protocol: "wireguard", transport: "udp", listenPort: 51820, configSchemaVersion: 1 }, { protocol: "vless", transport: "tcp", listenPort: 443, configSchemaVersion: 2 }, { protocol: "openvpn", transport: "udp", listenPort: 1194, configSchemaVersion: 1 }] }, counts: { totalNodes: 5, standardNodes: 4, customNodes: 1, agentOnlyNodes: 0, driftedNodes: 1, eligibleNodes: 1, blockedNodes: 0 }, driftedNodes: [{ id: "n5", name: nodes[4].name, currentVersion: 1, status: "offline", missingProtocols: ["vless"], eligible: false, reason: "Node is offline" }], rollouts: [{ id: "ro_1", fromVersion: 1, toVersion: 2, mode: "auto", status: "completed", totalTargets: 4, queuedTargets: 0, succeededTargets: 4, blockedTargets: 0, failedTargets: 0, createdAt: ago(3000) }] }];
    if (pathname === "/api/reality-defaults") return [200, { mode: "auto", serverName: "www.microsoft.com", candidates: ["www.microsoft.com", "www.apple.com", "dl.google.com"], checkedAt: now, updatedAt: now }];
    if (pathname === "/api/logs") return [200, { logs, available: true }];
    if (pathname.endsWith("/subscriptions")) return [200, { subscriptions, nodes: [] }];
    if (pathname === "/api/v1/admin/client-releases") return [200, {
      releases: [release("rel_1", "android", "beta", "1.2.0", 12), release("rel_2", "android", "stable", "1.1.3", 11), release("rel_3", "windows", "stable", "1.1.3", 11, { distribution: "external" }), release("rel_4", "macos", "beta", "1.2.0-rc.1", 12, { status: "withdrawn" }), release("rel_5", "ios", "stable", "1.1.3", 11, { distribution: "app_store", url: "https://apps.apple.com/app/id1234567890" })],
      policies: ["android", "ios", "macos", "windows"].map((platform) => ({ platform, minBuild: platform === "android" ? 10 : 0, announcement: platform === "android" ? "Please update to 1.2 for faster reconnects." : "", downloadPath: `/download/${platform}` })),
      adoption: [{ platform: "android", version: "1.2.0", build: 12, devices: 2 }, { platform: "android", version: "1.1.3", build: 11, devices: 14 }, { platform: "windows", version: null, build: null, devices: 1 }],
      diagnostics: [{ platform: "android", build: 12, code: "HANDSHAKE_TIMEOUT", events: 3, users: 2, lastAt: ago(30) }, { platform: "windows", build: 11, code: "TUN_ADAPTER_CREATE_FAILED_ACCESS_DENIED", events: 41, users: 9, lastAt: ago(90) }],
      storage: { mode: "local" }, ciTokenConfigured: true }];
    return [200, {}];
  };
}
