import { createHash, createHmac } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

/**
 * Installer storage. The Controller never receives installer bytes: it signs a short-lived upload URL
 * for S3-compatible storage (Cloudflare R2, AWS S3, MinIO, ...) and later downloads the public object
 * once to record its real SHA-256 and size. Without object storage ("local", the default; "external" is the
 * older name for it) the Console uploads installers to the Controller's data volume and the Controller serves
 * published builds itself. Registering an installer already hosted at a public HTTPS URL works in every mode.
 */
export type ReleaseStorage =
  | { mode: "local"; dir: string }
  | { mode: "s3"; endpoint: string; bucket: string; region: string; accessKeyId: string; secretAccessKey: string; publicBaseUrl: string };

export function releaseStorage(env: Record<string, string | undefined> = process.env): ReleaseStorage {
  const mode = env.NORTHSTAR_RELEASE_STORAGE?.trim() || "local";
  if (mode === "local" || mode === "external") return { mode: "local", dir: path.resolve(env.NORTHSTAR_RELEASE_LOCAL_DIR?.trim() || path.join(process.cwd(), "data", "client-releases")) };
  if (mode !== "s3") throw new Error("NORTHSTAR_RELEASE_STORAGE must be local or s3");
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

/** Absolute path of a stored installer; keys come from releaseObjectKey, so they never contain "..". */
export function localArtifactPath(storage: Extract<ReleaseStorage, { mode: "local" }>, key: string): string {
  const file = path.resolve(storage.dir, key);
  if (!key.startsWith("clients/") || key.split("/").some((part) => !part || part === "." || part === "..") || !file.startsWith(storage.dir + path.sep)) throw new Error("Invalid storage key");
  return file;
}

/** Upload chunks stay below the 10 MB request limit of the default Nginx configuration. */
export const uploadChunkBytes = 8 * 1024 * 1024;

/**
 * Appends one chunk of a resumable upload (chunks must arrive in order). With `final`, the object appears
 * under its key only once complete, and an existing build is never overwritten.
 */
export async function appendLocalArtifact(storage: Extract<ReleaseStorage, { mode: "local" }>, key: string, upload: { id: string; offset: number; final: boolean },
  body: ReadableStream<Uint8Array>): Promise<{ received: number; complete: boolean }> {
  if (!/^[a-f0-9-]{36}$/.test(upload.id) || !Number.isSafeInteger(upload.offset) || upload.offset < 0) throw new Error("Invalid upload");
  const file = localArtifactPath(storage, key), partial = `${file}.${upload.id}.part`;
  await mkdir(path.dirname(file), { recursive: true });
  const existing = await stat(partial).then((info) => info.size).catch(() => 0);
  if (existing !== upload.offset) throw Object.assign(new Error("Upload offset mismatch"), { received: existing });
  let size = existing;
  const meter = new Transform({ transform(chunk: Buffer, _encoding, done) {
    size += chunk.byteLength;
    if (size > maxInstallerBytes || size - existing > uploadChunkBytes) { done(new Error("Installer is too large")); return; }
    done(null, chunk);
  } });
  try {
    await pipeline(Readable.fromWeb(body as WebReadableStream<Uint8Array>), meter, createWriteStream(partial, { flags: upload.offset ? "r+" : "wx", start: upload.offset }));
  } catch (error) { await rm(partial, { force: true }); throw error; }
  if (!upload.final) return { received: size, complete: false };
  try {
    if (!size) throw new Error("Installer is empty");
    // link() fails when the key already exists, so a build can never be replaced.
    await link(partial, file);
  } finally { await rm(partial, { force: true }); }
  return { received: size, complete: true };
}

/** Same result as inspectArtifact, read from the data volume. */
export async function inspectLocalArtifact(storage: Extract<ReleaseStorage, { mode: "local" }>, key: string): Promise<{ sha256: string; sizeBytes: number }> {
  const file = localArtifactPath(storage, key), info = await stat(file);
  if (!info.isFile() || !info.size) throw new Error("Installer is missing or empty");
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), new Transform({ transform(chunk, _encoding, done) { hash.update(chunk); done(); } }));
  return { sha256: hash.digest("hex"), sizeBytes: info.size };
}

/** Public URL of a locally stored installer, served by the Controller through the Portal's /api proxy. */
export function localArtifactUrl(origin: string, key: string): string {
  return `${origin.replace(/\/+$/, "")}/api/v1/client-releases/files/${key.split("/").map(encode).join("/")}`;
}
