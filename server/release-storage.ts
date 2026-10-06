import { createHash, createHmac } from "node:crypto";

/**
 * Installer storage. The Controller never receives installer bytes: it signs a short-lived upload URL
 * for S3-compatible storage (Cloudflare R2, AWS S3, MinIO, ...) and later downloads the public object
 * once to record its real SHA-256 and size. With no storage configured, operators upload elsewhere and
 * register the public HTTPS URL; verification is the same.
 */
export type ReleaseStorage =
  | { mode: "external" }
  | { mode: "s3"; endpoint: string; bucket: string; region: string; accessKeyId: string; secretAccessKey: string; publicBaseUrl: string };

export function releaseStorage(env: Record<string, string | undefined> = process.env): ReleaseStorage {
  const mode = env.NORTHSTAR_RELEASE_STORAGE?.trim() || "external";
  if (mode === "external") return { mode };
  if (mode !== "s3") throw new Error("NORTHSTAR_RELEASE_STORAGE must be external or s3");
  const value = (name: string) => {
    const text = env[name]?.trim();
    if (!text) throw new Error(`${name} is required for S3 release storage`);
    return text;
  };
  const endpoint = new URL(value("NORTHSTAR_RELEASE_S3_ENDPOINT"));
  const publicBaseUrl = new URL(value("NORTHSTAR_RELEASE_PUBLIC_BASE_URL"));
  if (endpoint.protocol !== "https:" || publicBaseUrl.protocol !== "https:") throw new Error("Release storage URLs must use HTTPS");
  return {
    mode, endpoint: endpoint.origin, bucket: value("NORTHSTAR_RELEASE_S3_BUCKET"), region: env.NORTHSTAR_RELEASE_S3_REGION?.trim() || "auto",
    accessKeyId: value("NORTHSTAR_RELEASE_S3_ACCESS_KEY_ID"), secretAccessKey: value("NORTHSTAR_RELEASE_S3_SECRET_ACCESS_KEY"),
    publicBaseUrl: publicBaseUrl.href.replace(/\/+$/, ""),
  };
}

/** Immutable object key: a build is never overwritten, so CDN caches and recorded digests stay valid. */
export function releaseObjectKey(input: { platform: string; arch: string; version: string; build: number; fileName: string }): string {
  const name = input.fileName.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "").slice(0, 120);
  if (!/\.(apk|aab|zip|dmg|pkg|msix|msixbundle|exe|msi)$/i.test(name)) throw new Error("Unsupported installer file type");
  return `clients/${input.platform}/${input.arch}/${input.version}+${input.build}/${name}`;
}

const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");
const hmac = (key: Buffer | string, value: string) => createHmac("sha256", key).update(value).digest();

/** AWS Signature Version 4 query-string presigning (path-style). */
export function presignS3Url(input: {
  method: "GET" | "PUT"; endpoint: string; bucket: string; key: string; region: string;
  accessKeyId: string; secretAccessKey: string; expiresSeconds: number; now?: Date; virtualHost?: boolean;
}): string {
  const now = input.now || new Date();
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = stamp.slice(0, 8);
  const endpoint = new URL(input.endpoint);
  const host = input.virtualHost ? `${input.bucket}.${endpoint.host}` : endpoint.host;
  const path = `${input.virtualHost ? "" : `/${encode(input.bucket)}`}/${input.key.split("/").map(encode).join("/")}`;
  const scope = `${day}/${input.region}/s3/aws4_request`;
  const query: Array<[string, string]> = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"], ["X-Amz-Credential", `${input.accessKeyId}/${scope}`], ["X-Amz-Date", stamp],
    ["X-Amz-Expires", String(input.expiresSeconds)], ["X-Amz-SignedHeaders", "host"],
  ];
  const canonicalQuery = query.map(([k, v]) => [encode(k), encode(v)]).sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => `${k}=${v}`).join("&");
  const canonical = [input.method, path, canonicalQuery, `host:${host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256Hex(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), "s3"), "aws4_request");
  return `${endpoint.protocol}//${host}${path}?${canonicalQuery}&X-Amz-Signature=${createHmac("sha256", key).update(toSign).digest("hex")}`;
}

export function presignReleaseUpload(storage: Extract<ReleaseStorage, { mode: "s3" }>, key: string, now = new Date()) {
  const uploadUrl = presignS3Url({ method: "PUT", endpoint: storage.endpoint, bucket: storage.bucket, key, region: storage.region,
    accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey, expiresSeconds: 900, now });
  return { uploadUrl, method: "PUT" as const, expiresAt: new Date(now.getTime() + 900_000).toISOString(), publicUrl: `${storage.publicBaseUrl}/${key.split("/").map(encode).join("/")}` };
}

export const maxInstallerBytes = 1024 * 1024 * 1024;

/** Downloads the published object once and returns what users will actually receive. */
export async function inspectArtifact(url: string, fetcher: typeof fetch = fetch, timeoutMs = 180_000): Promise<{ sha256: string; sizeBytes: number }> {
  const response = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(timeoutMs), headers: { "Cache-Control": "no-cache" } });
  if (!response.ok || !response.body) throw new Error(`Installer download failed (HTTP ${response.status})`);
  const hash = createHash("sha256");
  let size = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxInstallerBytes) { await reader.cancel(); throw new Error("Installer is too large"); }
    hash.update(value);
  }
  if (!size) throw new Error("Installer is empty");
  return { sha256: hash.digest("hex"), sizeBytes: size };
}
