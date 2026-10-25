import { createHash, createHmac } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, mkdir, rm, stat } from "node:fs/promises";
import { request as requestHttps } from "node:https";
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
  const mode = env.VEILBIRD_RELEASE_STORAGE?.trim() || "local";
  if (mode === "local" || mode === "external") return { mode: "local", dir: path.resolve(env.VEILBIRD_RELEASE_LOCAL_DIR?.trim() || path.join(process.cwd(), "data", "client-releases")) };
  if (mode !== "s3") throw new Error("VEILBIRD_RELEASE_STORAGE must be local or s3");
  const value = (name: string) => {
    const text = env[name]?.trim();
    if (!text) throw new Error(`${name} is required for S3 release storage`);
    return text;
  };
  const endpoint = new URL(value("VEILBIRD_RELEASE_S3_ENDPOINT"));
  const publicBaseUrl = new URL(value("VEILBIRD_RELEASE_PUBLIC_BASE_URL"));
  if (endpoint.protocol !== "https:" || publicBaseUrl.protocol !== "https:") throw new Error("Release storage URLs must use HTTPS");
  return {
    mode, endpoint: endpoint.origin, bucket: value("VEILBIRD_RELEASE_S3_BUCKET"), region: env.VEILBIRD_RELEASE_S3_REGION?.trim() || "auto",
    accessKeyId: value("VEILBIRD_RELEASE_S3_ACCESS_KEY_ID"), secretAccessKey: value("VEILBIRD_RELEASE_S3_SECRET_ACCESS_KEY"),
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
  method: "GET" | "PUT" | "DELETE"; endpoint: string; bucket: string; key: string; region: string;
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

/**
 * Optional download mirror for locally stored installers: an S3-compatible bucket behind a CDN (Aliyun OSS + CDN,
 * Cloudflare R2, ...). The Controller copies each uploaded build there and the apps try the CDN first; the
 * Controller's own copy stays the fallback, and the apps check the published SHA-256 whichever one served it.
 */
export type ReleaseMirror = { endpoint: string; bucket: string; region: string; accessKeyId: string; secretAccessKey: string; publicBaseUrl: string; virtualHost: boolean };

export function releaseMirror(env: Record<string, string | undefined> = process.env): ReleaseMirror | null {
  const value = (name: string) => env[`VEILBIRD_RELEASE_MIRROR_${name}`]?.trim() || "";
  if (!value("ENDPOINT")) return null;
  for (const name of ["BUCKET", "ACCESS_KEY_ID", "SECRET_ACCESS_KEY", "PUBLIC_BASE_URL"]) {
    if (!value(name)) throw new Error(`VEILBIRD_RELEASE_MIRROR_${name} is required for the download mirror`);
  }
  // The message names the variable: the Console shows it to the operator (never a value, so no secret leaks).
  const https = (name: string) => {
    let url: URL | null = null;
    try { url = new URL(value(name)); } catch { /* reported below */ }
    if (url?.protocol !== "https:") throw new Error(`VEILBIRD_RELEASE_MIRROR_${name} must be a full https:// URL`);
    return url;
  };
  const endpoint = https("ENDPOINT"), publicBaseUrl = https("PUBLIC_BASE_URL");
  // Aliyun OSS accepts only virtual-hosted requests (bucket.endpoint); MinIO and most others accept both.
  const style = value("ADDRESSING") || (endpoint.hostname.endsWith(".aliyuncs.com") ? "virtual" : "path");
  if (style !== "virtual" && style !== "path") throw new Error("VEILBIRD_RELEASE_MIRROR_ADDRESSING must be virtual or path");
  return { endpoint: endpoint.origin, bucket: value("BUCKET"), region: value("REGION") || "auto", accessKeyId: value("ACCESS_KEY_ID"),
    secretAccessKey: value("SECRET_ACCESS_KEY"), publicBaseUrl: publicBaseUrl.href.replace(/\/+$/, ""), virtualHost: style === "virtual" };
}

type BucketTarget = { endpoint: string; bucket: string; region: string; accessKeyId: string; secretAccessKey: string; virtualHost?: boolean };

/**
 * What an object store or CDN answered, kept so a failure can be looked up later (the request id is what the
 * provider's support asks for). Never holds a signature, key or secret.
 */
export type StoreAnswer = { stage: string; host: string; status?: number; code?: string; message?: string; requestId?: string; ms: number };

/** A failed object store or CDN request; `answer` goes to the operational logs and the Console. */
export class StoreError extends Error {
  answer: StoreAnswer;
  constructor(message: string, answer: StoreAnswer) { super(message); this.answer = answer; }
}

const requestIdOf = (headers: Headers | Record<string, string | string[] | undefined>) => {
  const get = (name: string) => headers instanceof Headers ? headers.get(name) : [headers[name]].flat()[0];
  // Aliyun OSS, AWS S3 / MinIO / R2, Aliyun CDN, Cloudflare.
  return get("x-oss-request-id") || get("x-amz-request-id") || get("eagleid") || get("cf-ray") || undefined;
};
const xmlField = (text: string, name: string) => text.match(new RegExp(`<${name}>([^<]{1,300})</${name}>`))?.[1];
/** The useful part of a network error: ENOTFOUND, ECONNREFUSED, CERT_HAS_EXPIRED, a timeout ... */
export const networkReason = (error: unknown) => {
  const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
  return String(cause?.code || cause?.message || (error as Error)?.message || error).slice(0, 200);
};
const failure = (stage: string, what: string, answer: Omit<StoreAnswer, "stage">) =>
  new StoreError(`${what} failed (${[answer.status ? `HTTP ${answer.status}` : "", answer.code, answer.message, answer.requestId ? `request ${answer.requestId}` : ""].filter(Boolean).join(", ")})`, { stage, ...answer });

/** One signed request to an S3-compatible bucket over node:https (presigned URLs need a Content-Length, not chunks). */
function bucketRequest(target: BucketTarget, stage: string, method: "GET" | "PUT" | "DELETE", key: string,
  body?: { size: number; open: () => NodeJS.ReadableStream; headers?: Record<string, string> }): Promise<{ status: number; text: string; answer: StoreAnswer }> {
  const url = new URL(presignS3Url({ method, endpoint: target.endpoint, bucket: target.bucket, key, region: target.region,
    accessKeyId: target.accessKeyId, secretAccessKey: target.secretAccessKey, expiresSeconds: 3600, virtualHost: target.virtualHost }));
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const request = requestHttps(url, { method, timeout: 120_000, headers: body ? { "Content-Length": String(body.size), "Content-Type": "application/octet-stream", ...body.headers } : {} }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { if (text.length < 4000) text += chunk; });
      response.on("error", (error) => reject(new StoreError(`${stage}: ${networkReason(error)}`, { stage, host: url.host, message: networkReason(error), ms: Date.now() - started })));
      response.on("end", () => {
        const status = response.statusCode || 0;
        resolve({ status, text, answer: { stage, host: url.host, status, code: xmlField(text, "Code"), message: xmlField(text, "Message"),
          requestId: requestIdOf(response.headers) || xmlField(text, "RequestId"), ms: Date.now() - started } });
      });
    });
    request.on("timeout", () => request.destroy(new Error("timed out after 120 s without data")));
    request.on("error", (error) => reject(new StoreError(`${stage}: ${networkReason(error)}`, { stage, host: url.host, message: networkReason(error), ms: Date.now() - started })));
    if (body) body.open().on("error", (error) => request.destroy(error)).pipe(request);
    else request.end();
  });
}

/**
 * Deletes one object from an S3-compatible bucket (the release bucket or the download mirror).
 * A missing object counts as deleted, so a retry after a partial failure succeeds.
 */
export async function deleteStoredObject(target: BucketTarget, key: string): Promise<StoreAnswer> {
  const { status, answer } = await bucketRequest(target, "delete", "DELETE", key);
  if ((status < 200 || status >= 300) && status !== 404) throw failure("delete", "Delete", answer);
  return answer;
}

export const mirrorUrl = (mirror: ReleaseMirror, key: string) => `${mirror.publicBaseUrl}/${key.split("/").map(encode).join("/")}`;

/** Reads the public (CDN) URL: HEAD for the size, or a Range GET. Times out after 30 s. */
async function cdnRequest(stage: string, url: string, init: RequestInit = {}) {
  const started = Date.now(), host = new URL(url).host;
  try {
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000), ...init, headers: { "Cache-Control": "no-cache", ...init.headers } });
    const body = init.method === "HEAD" ? new Uint8Array() : new Uint8Array(await response.arrayBuffer());
    const text = response.ok ? "" : new TextDecoder().decode(body.subarray(0, 4000));
    return { response, body, answer: { stage, host, status: response.status, code: xmlField(text, "Code"), message: xmlField(text, "Message"),
      requestId: requestIdOf(response.headers) || xmlField(text, "RequestId"), ms: Date.now() - started } as StoreAnswer };
  } catch (error) {
    throw new StoreError(`${stage}: ${networkReason(error)}`, { stage, host, message: networkReason(error), ms: Date.now() - started });
  }
}

/** Copies one stored installer to the mirror bucket and checks the public URL serves its full size. */
export async function copyToMirror(mirror: ReleaseMirror, key: string, file: string, size: number): Promise<{ url: string; upload: StoreAnswer; cdn: StoreAnswer }> {
  const { status, answer: upload } = await bucketRequest(mirror, "upload", "PUT", key,
    { size, open: () => createReadStream(file), headers: { "Content-Disposition": `attachment; filename="${key.split("/").pop()}"` } });
  if (status < 200 || status >= 300) throw failure("upload", "Mirror upload", upload);
  const url = mirrorUrl(mirror, key);
  const { response, answer: cdn } = await cdnRequest("cdn", url, { method: "HEAD" });
  if (!response.ok) throw failure("cdn", "CDN download URL", cdn);
  if (Number(response.headers.get("content-length")) !== size) throw new StoreError(`CDN download URL serves ${response.headers.get("content-length")} bytes, expected ${size}`, cdn);
  return { url, upload, cdn };
}

export type MirrorTestStep = { name: "config" | "upload" | "bucket_read" | "cdn_head" | "cdn_range" | "delete"; ok: boolean; detail: string; answer?: StoreAnswer; hint?: "range_ignored" };

/**
 * Console "test": the same requests a real copy makes, on a small throwaway object, one step at a time:
 * the configuration, a signed upload, a signed read back from the bucket, the CDN URL (size, then a Range read,
 * which the apps need to resume) and the delete. Each step reports the HTTP status, provider error code and request id.
 */
export async function testMirror(env: Record<string, string | undefined> = process.env): Promise<{ ok: boolean; steps: MirrorTestStep[] }> {
  const steps: MirrorTestStep[] = [];
  const done = () => ({ ok: steps.every((step) => step.ok), steps });
  let mirror: ReleaseMirror | null;
  try { mirror = releaseMirror(env); } catch (error) { steps.push({ name: "config", ok: false, detail: (error as Error).message }); return done(); }
  if (!mirror) { steps.push({ name: "config", ok: false, detail: "VEILBIRD_RELEASE_MIRROR_ENDPOINT is not set" }); return done(); }
  steps.push({ name: "config", ok: true, detail: `${mirror.endpoint} · bucket ${mirror.bucket} · region ${mirror.region} · ${mirror.virtualHost ? "virtual-hosted" : "path-style"} · CDN ${mirror.publicBaseUrl}` });
  const key = `clients/.healthcheck/${new Date().toISOString().replace(/[:.]/g, "-")}-${createHash("sha256").update(String(Math.random())).digest("hex").slice(0, 8)}.txt`;
  const body = Buffer.from("TrackNothing download mirror test\n".repeat(128));
  const run = async (name: MirrorTestStep["name"], work: () => Promise<Omit<MirrorTestStep, "name">>) => {
    try { const result = await work(); steps.push({ name, ...result }); return result.ok; }
    catch (error) { steps.push({ name, ok: false, detail: (error as Error).message, answer: (error as StoreError).answer }); return false; }
  };
  const describe = (answer: StoreAnswer) => [answer.status ? `HTTP ${answer.status}` : "", answer.code, answer.message].filter(Boolean).join(" · ");
  const uploaded = await run("upload", async () => {
    const { status, answer } = await bucketRequest(mirror, "upload", "PUT", key, { size: body.length, open: () => Readable.from([body]) });
    return { ok: status >= 200 && status < 300, detail: `${describe(answer)} · ${body.length} bytes to ${key}`, answer };
  });
  if (uploaded) {
    await run("bucket_read", async () => {
      const { status, text, answer } = await bucketRequest(mirror, "bucket_read", "GET", key);
      return { ok: status === 200 && text === body.toString("utf8"), detail: status === 200 && text !== body.toString("utf8") ? "the bucket returned different content" : describe(answer), answer };
    });
    const url = mirrorUrl(mirror, key);
    const reachable = await run("cdn_head", async () => {
      const { response, answer } = await cdnRequest("cdn_head", url, { method: "HEAD" });
      const length = Number(response.headers.get("content-length"));
      const cache = response.headers.get("x-cache") || response.headers.get("via") || "";
      return { ok: response.ok && length === body.length,
        detail: response.ok && length !== body.length ? `${url} serves ${length} bytes, expected ${body.length}` : `${describe(answer)} · ${url}${cache ? ` · ${cache.slice(0, 80)}` : ""}`, answer };
    });
    if (reachable) {
      await run("cdn_range", async () => {
        const { response, body: part, answer } = await cdnRequest("cdn_range", url, { headers: { Range: "bytes=100-199" } });
        const ok = response.status === 206 && Buffer.from(part).equals(body.subarray(100, 200));
        if (response.status === 200) return { ok: false, hint: "range_ignored", detail: "the CDN ignored Range (HTTP 200): turn on Range origin fetch, or downloads cannot resume", answer };
        return { ok, detail: ok ? `${describe(answer)} · ${response.headers.get("content-range") || ""}` : describe(answer), answer };
      });
    }
    await run("delete", async () => { const answer = await deleteStoredObject(mirror, key); return { ok: true, detail: describe(answer), answer }; });
  }
  return done();
}
