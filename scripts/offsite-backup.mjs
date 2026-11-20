// Off-site database backups: encrypts a pg_dump together with .env and keeps copies in an S3-compatible bucket
// (Aliyun OSS, Cloudflare R2, AWS S3, MinIO...). The host scripts pipe this file into the Controller container,
// so no extra image or tool is needed on the server:
//   docker compose exec -T veilbird node --input-type=module -e "$(cat scripts/offsite-backup.mjs)" < input
// Input on stdin: one line of JSON (the request: command, bucket settings, passphrase), then for "upload" the
// .env bytes and the dump bytes. Commands:
//   upload  encrypt, upload veilbird-<UTC time>.vbk, verify its size, keep the newest `keep` copies
//   list    print the backups in the bucket, newest first
//   get     decrypt one backup (`name`, or the newest) and write its `part` ("dump" or "env") to stdout
//   log     only write `message` to the Console log (Loki)
// Results also go to Console → 日志 (Loki), the only place operational logs are kept.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync } from "node:crypto";

const MAGIC = Buffer.from("VBK1");
const NAME = /^veilbird-\d{8}T\d{6}Z\.vbk$/;

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function splitRequest(input) {
  const end = input.indexOf(0x0a);
  if (end < 0) throw new Error("missing request line");
  return { request: JSON.parse(input.subarray(0, end).toString("utf8")), rest: input.subarray(end + 1) };
}

// ---- encryption: AES-256-GCM with a key derived by scrypt from the passphrase (the master key by default) ----
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function seal(passphrase, header, env, dump) {
  const meta = Buffer.from(JSON.stringify({ ...header, envBytes: env.length, dumpBytes: dump.length,
    dumpSha256: createHash("sha256").update(dump).digest("hex") }));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(meta.length);
  const salt = randomBytes(16), iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", scryptSync(passphrase, salt, 32, SCRYPT), iv);
  const body = Buffer.concat([cipher.update(Buffer.concat([length, meta, env, dump])), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body]);
}

export function open(passphrase, file) {
  if (file.length < 48 || !file.subarray(0, 4).equals(MAGIC)) throw new Error("not a Veilbird backup file");
  const salt = file.subarray(4, 20), iv = file.subarray(20, 32), tag = file.subarray(32, 48);
  const decipher = createDecipheriv("aes-256-gcm", scryptSync(passphrase, salt, 32, SCRYPT), iv);
  decipher.setAuthTag(tag);
  let plain;
  try { plain = Buffer.concat([decipher.update(file.subarray(48)), decipher.final()]); }
  catch { throw Object.assign(new Error("cannot decrypt: wrong backup password (VEILBIRD_BACKUP_PASSPHRASE / VEILBIRD_MASTER_KEY of the server that made it)"), { code: "BAD_PASSPHRASE" }); }
  const metaLength = plain.readUInt32BE(0);
  const meta = JSON.parse(plain.subarray(4, 4 + metaLength).toString("utf8"));
  const env = plain.subarray(4 + metaLength, 4 + metaLength + meta.envBytes);
  const dump = plain.subarray(4 + metaLength + meta.envBytes, 4 + metaLength + meta.envBytes + meta.dumpBytes);
  if (createHash("sha256").update(dump).digest("hex") !== meta.dumpSha256) throw new Error("backup content does not match its checksum");
  return { meta, env, dump };
}

// ---- S3: presigned requests (host-only signature, unsigned payload), as the release mirror uses ----
const encode = (value) => encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const hmac = (key, value) => createHmac("sha256", key).update(value).digest();

export function bucketConfig(request) {
  const missing = ["endpoint", "bucket", "accessKeyId", "secretAccessKey"].filter((key) => !request[key]);
  if (missing.length) throw new Error(`off-site backup is missing ${missing.map((key) => ({ endpoint: "VEILBIRD_BACKUP_S3_ENDPOINT", bucket: "VEILBIRD_BACKUP_S3_BUCKET", accessKeyId: "VEILBIRD_BACKUP_S3_ACCESS_KEY_ID", secretAccessKey: "VEILBIRD_BACKUP_S3_SECRET_ACCESS_KEY" })[key]).join(", ")} in .env`);
  const endpoint = new URL(/^https?:\/\//.test(request.endpoint) ? request.endpoint : `https://${request.endpoint}`);
  // Aliyun OSS accepts only virtual-hosted requests (bucket.endpoint); R2, S3 and MinIO accept path style.
  const style = request.addressing || (endpoint.hostname.endsWith(".aliyuncs.com") ? "virtual" : "path");
  if (style !== "virtual" && style !== "path") throw new Error("VEILBIRD_BACKUP_S3_ADDRESSING must be virtual or path");
  // OSS signs with the region id (cn-hangzhou), read from the endpoint when not set; R2 uses "auto".
  const region = request.region || endpoint.hostname.match(/^oss-([a-z0-9-]+?)(?:-internal)?\.aliyuncs\.com$/)?.[1] || "auto";
  let prefix = (request.prefix || "veilbird-backups/").replace(/^\/+/, "");
  if (prefix && !prefix.endsWith("/")) prefix += "/";
  return { endpoint, bucket: request.bucket, region, accessKeyId: request.accessKeyId, secretAccessKey: request.secretAccessKey, virtualHost: style === "virtual", prefix };
}

export function signedUrl(target, method, key, query = {}, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = stamp.slice(0, 8);
  const scope = `${day}/${target.region}/s3/aws4_request`;
  const host = target.virtualHost ? `${target.bucket}.${target.endpoint.host}` : target.endpoint.host;
  const base = target.endpoint.pathname.replace(/\/+$/, "");
  const path = `${base}${target.virtualHost ? "" : `/${encode(target.bucket)}`}/${key.split("/").map(encode).join("/")}`;
  const params = [...Object.entries(query), ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"], ["X-Amz-Credential", `${target.accessKeyId}/${scope}`],
    ["X-Amz-Date", stamp], ["X-Amz-Expires", "900"], ["X-Amz-SignedHeaders", "host"]];
  const canonicalQuery = params.map(([k, v]) => [encode(k), encode(v)]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("&");
  const canonical = [method, path, canonicalQuery, `host:${host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", stamp, scope, createHash("sha256").update(canonical).digest("hex")].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${target.secretAccessKey}`, day), target.region), "s3"), "aws4_request");
  return `${target.endpoint.protocol}//${host}${path}?${canonicalQuery}&X-Amz-Signature=${createHmac("sha256", signingKey).update(toSign).digest("hex")}`;
}

const xmlField = (text, name) => text.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1];

async function s3(target, method, key, { query, body, timeoutMs = 120_000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(signedUrl(target, method, key, query), { method, body, signal: AbortSignal.timeout(timeoutMs) });
      const data = method === "HEAD" ? Buffer.alloc(0) : Buffer.from(await response.arrayBuffer());
      if (response.ok) return { response, data };
      const text = data.toString("utf8");
      const error = new Error(`${method} ${key || "(list)"}: HTTP ${response.status} ${xmlField(text, "Code") || ""} ${xmlField(text, "Message") || ""}`.trim());
      // Wrong keys, a missing bucket or no permission will not fix themselves on retry.
      if (response.status < 500 && response.status !== 429) throw Object.assign(error, { final: true });
      lastError = error;
    } catch (error) {
      if (error.final) throw error;
      lastError = new Error(`${method} ${key || "(list)"}: ${error.cause?.code || error.cause?.message || error.message}`);
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 5_000));
  }
  throw lastError;
}

export async function listBackups(target) {
  const items = [];
  let token;
  do {
    const query = { "list-type": "2", prefix: target.prefix, ...(token ? { "continuation-token": token } : {}) };
    const { data } = await s3(target, "GET", "", { query });
    const text = data.toString("utf8");
    for (const [, block] of text.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = xmlField(block, "Key")?.replace(/&amp;/g, "&");
      const name = key?.slice(target.prefix.length);
      if (name && NAME.test(name)) items.push({ key, name, size: Number(xmlField(block, "Size") || 0) });
    }
    token = xmlField(text, "IsTruncated") === "true" ? xmlField(text, "NextContinuationToken") : undefined;
  } while (token);
  // The UTC timestamp in the name sorts chronologically.
  return items.sort((a, b) => (a.name < b.name ? 1 : -1));
}

export const backupTime = (name) => new Date(name.replace(/^veilbird-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.vbk$/, "$1-$2-$3T$4:$5:$6Z"));
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 2 : 1)} MB`;

async function log(level, action, message, fields = {}) {
  const url = process.env.VEILBIRD_LOKI_URL?.trim().replace(/\/$/, "");
  if (!url) return;
  const at = Date.now();
  const line = JSON.stringify({ ...fields, time: new Date(at).toISOString(), message, action });
  await fetch(`${url}/loki/api/v1/push`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ streams: [{ stream: { service: "northstar", component: "controller", level, node: "controller", source: "system" },
      values: [[String(at * 1_000_000), line]] }] }),
    signal: AbortSignal.timeout(3_000),
  }).catch(() => {});
}

async function upload(request, rest, target) {
  const env = rest.subarray(0, request.envBytes), dump = rest.subarray(request.envBytes);
  if (!dump.length) throw new Error("the database dump is empty");
  const name = `veilbird-${(request.createdAt || new Date().toISOString()).replace(/[-:]/g, "").replace(/\.\d{3}/, "")}.vbk`;
  if (!NAME.test(name)) throw new Error(`bad backup name ${name}`);
  const file = seal(request.passphrase, { createdAt: request.createdAt, source: request.source || "", dumpName: request.dumpName || "" }, env, dump);
  const key = `${target.prefix}${name}`;
  const started = Date.now();
  await s3(target, "PUT", key, { body: file, timeoutMs: 30 * 60_000 });
  const { response } = await s3(target, "HEAD", key);
  const stored = Number(response.headers.get("content-length"));
  if (stored !== file.length) throw new Error(`uploaded ${name} but the bucket reports ${stored} bytes instead of ${file.length}`);
  const keep = Number.isInteger(request.keep) && request.keep >= 0 ? request.keep : 30;
  const removed = [];
  if (keep > 0) {
    for (const old of (await listBackups(target)).slice(keep)) {
      await s3(target, "DELETE", old.key);
      removed.push(old.name);
    }
  }
  const message = `Off-site backup uploaded: ${name} (${mb(file.length)}) to ${target.bucket}/${target.prefix} in ${((Date.now() - started) / 1000).toFixed(1)} s` +
    (removed.length ? `; removed ${removed.length} older` : "");
  console.log(message);
  for (const old of removed) console.log(`  removed ${old}`);
  await log("info", "backup.offsite_uploaded", message, { backup: name, bytes: file.length, bucket: target.bucket });
}

async function main() {
  const { request, rest } = splitRequest(await readStdin());
  if (request.command === "log") {
    await log(request.level || "info", request.action || "backup.offsite", request.message || "");
    return;
  }
  const target = bucketConfig(request);
  try {
    if (request.command === "upload") return await upload(request, rest, target);
    if (request.command === "list") {
      const items = await listBackups(target);
      if (!items.length) console.log(`No backups in ${target.bucket}/${target.prefix}`);
      for (const item of items) console.log(`${item.name}  ${mb(item.size)}`);
      return;
    }
    if (request.command === "get") {
      const items = await listBackups(target);
      const item = request.name && request.name !== "latest" ? items.find((entry) => entry.name === request.name) : items[0];
      if (!item) throw new Error(request.name && request.name !== "latest" ? `backup ${request.name} not found` : `no backups in ${target.bucket}/${target.prefix}`);
      const { data } = await s3(target, "GET", item.key, { timeoutMs: 30 * 60_000 });
      const { meta, env, dump } = open(request.passphrase, data);
      const ageHours = (Date.now() - backupTime(item.name).getTime()) / 3_600_000;
      // Read by the host scripts (backup-drill.sh, offsite-restore.sh); the data itself goes to stdout.
      console.error(`BACKUP ${item.name} age_hours=${ageHours.toFixed(1)} dump_bytes=${meta.dumpBytes} source=${meta.source || "-"}`);
      process.stdout.write(request.part === "env" ? env : dump);
      return;
    }
    throw new Error(`unknown command ${request.command}`);
  } catch (error) {
    if (request.command === "upload") await log("error", "backup.offsite_failed", `Off-site backup failed: ${error.message}`, { bucket: target.bucket });
    throw error;
  }
}

// Imported by the tests; run when piped in with -e or started as a file.
if (!process.env.VEILBIRD_OFFSITE_IMPORT) {
  main().catch((error) => {
    console.error(`Off-site backup: ${error.message}`);
    process.exit(error.code === "BAD_PASSPHRASE" ? 3 : 1);
  });
}
