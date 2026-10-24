// Realistic Portal API responses for browser tests: several connections with long names, every region state,
// usage history and client releases, so layout checks see what a real account sees.
const now = new Date().toISOString();
const ago = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
const GB = 1073741824;
const user = { id: "user", displayName: "Aleksandra Konstantinopolskaya", email: "aleksandra.konstantinopolskaya@very-long-company-domain.example", status: "active", role: "user" };
const credential = (id, name, protocol, extra = {}) => ({ id, name, protocol, subscriptionId: null, expiringSoon: false, daysRemaining: 211, userDisabled: false, adminDisabled: false, accountStatus: "active", syncStatus: "applied", status: "active", state: "online", identitySuffix: id.slice(-6), online: true, connectionCount: 2, lastActivityAt: ago(2), lastObservedAt: now, profileCount: 2, activeProfileCount: 2, uploadBytes: 1.2 * GB, downloadBytes: 18.4 * GB, totalBytes: 19.6 * GB, expiresAt: "2027-05-06T00:00:00Z", createdAt: ago(9000), updatedAt: now, certificate: null, ...extra });
const credentials = [
  credential("cred_sub_111111", "iPhone 16 Pro Max · Shadowrocket (family plan, living room)", "vless", { subscriptionId: "sub_1" }),
  credential("cred_wg_222222", "MacBook", "wireguard"),
  credential("cred_ov_333333", "Office router", "openvpn", { state: "idle", online: false, connectionCount: 0, expiringSoon: true, daysRemaining: 3, certificate: { id: "cert", serial: "4F:2A:91:0C:7B:33:12:EE:4F:2A:91:0C", subject: "CN=office-router-very-long-common-name", fingerprint: "SHA256:" + "f".repeat(43), notBefore: ago(9000), notAfter: "2027-05-06T00:00:00Z" } }),
  credential("cred_dis_444444", "Old laptop", "wireguard", { userDisabled: true, state: "disabled", online: false, connectionCount: 0 }),
];
const regions = [
  { id: "sg", name: "Singapore", code: "SG", country: "Singapore", protocols: ["wireguard", "vless", "openvpn"], status: "available", protocolNodeCounts: { wireguard: 2, vless: 2, openvpn: 1 } },
  { id: "us", name: "Ohio", code: "US", country: "United States", protocols: ["wireguard", "vless"], status: "available" },
  { id: "za", name: "Cape Town", code: "ZA", country: "South Africa", protocols: ["wireguard"], status: "degraded" },
  { id: "br", name: "São Paulo Metropolitan Area", code: "BR", country: "Brazil", protocols: [], status: "unavailable" },
];
const nodes = [
  { id: "n1", name: "190.92.202.34@Singapore", regionId: "sg", regionName: "Singapore", protocols: ["wireguard", "vless", "openvpn"] },
  { id: "n2", name: "sao-paulo-edge-gateway-primary-with-a-very-long-hostname", regionId: "us", regionName: "Ohio", protocols: ["wireguard", "vless"] },
];
const profiles = [
  { id: "p1", nodeId: "n1", credentialId: "cred_wg_222222", displayName: "MacBook", nodeName: nodes[0].name, regionCode: "SG", regionName: "Singapore", protocol: "wireguard", status: "active", issuedAt: ago(9000), expiresAt: "2027-05-06T00:00:00Z" },
  { id: "p2", nodeId: "n2", credentialId: "cred_ov_333333", displayName: "Office router", nodeName: nodes[1].name, regionCode: "US", regionName: "Ohio", protocol: "openvpn", status: "active", issuedAt: ago(9000), expiresAt: "2027-05-06T00:00:00Z" },
];
const daily = Array.from({ length: 30 }, (_, i) => ({ day: new Date(Date.now() - (29 - i) * 86400000).toISOString().slice(0, 10), totalBytes: (i % 7 + 1) * 0.4 * GB }));
const releases = [
  { platform: "windows", arch: "x64", version: "1.2.0", build: 12, distribution: "direct", url: "https://downloads.example.com/Veilbird-1.2.0-windows-x64.exe", sha256: "a".repeat(64), sizeBytes: 48234567, minOs: "Windows 10 1809", publishedAt: ago(2000) },
  { platform: "android", arch: "universal", version: "1.2.0", build: 12, distribution: "direct", url: "https://downloads.example.com/Veilbird-1.2.0.apk", sha256: "b".repeat(64), sizeBytes: 31234567, minOs: "Android 8.0", publishedAt: ago(2000) },
  { platform: "ios", arch: "universal", version: "1.1.3", build: 11, distribution: "app-store", url: "https://apps.apple.com/app/id1234567890", minOs: "iOS 16.0", publishedAt: ago(9000) },
];
const history = [{ platform: "windows", arch: "x64", version: "1.1.3", build: 11, distribution: "direct", url: "https://downloads.example.com/Veilbird-1.1.3-windows-x64.exe", sha256: "c".repeat(64), minOs: "Windows 10 1809", publishedAt: ago(20000) }];

export function portalApi({ signedIn = true, empty = false } = {}) {
  let session = signedIn;
  return (pathname, method) => {
    if (pathname === "/api/v1/auth/me") return session ? [200, { user }] : [401, { error: "Authentication required" }];
    if (pathname === "/api/v1/auth/web-login") { session = true; return [200, { user }]; }
    if (pathname === "/api/v1/auth/register") return [202, { status: "received" }];
    if (pathname === "/api/v1/availability") return [200, { regions, nodes }];
    if (pathname === "/api/v1/credentials") return [200, method === "POST" ? { credential: credentials[1] } : { credentials: empty ? [] : credentials }];
    if (pathname === "/api/v1/profiles") return [200, method === "POST" ? { profile: profiles[0] } : { profiles: empty ? [] : profiles }];
    if (pathname === "/api/v1/usage/summary") return [200, { totals: { totalBytes: 44.9 * GB, uploadBytes: 3.2 * GB, downloadBytes: 41.7 * GB }, daily, updatedAt: now }];
    if (pathname === "/api/v1/subscriptions") return [200, { subscriptions: [] }];
    if (pathname === "/api/v1/client-releases") return [200, { releases, history }];
    return [200, {}];
  };
}
