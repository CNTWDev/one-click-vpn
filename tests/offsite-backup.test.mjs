// scripts/offsite-backup.mjs: encryption round trip, and upload / list / prune / download against a small
// in-process S3 server that checks every request is presigned.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";

process.env.VEILBIRD_OFFSITE_IMPORT = "1";
const offsite = await import("../scripts/offsite-backup.mjs");
const SCRIPT = new URL("../scripts/offsite-backup.mjs", import.meta.url).pathname;

function fakeS3() {
  const objects = new Map();
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    requests.push(`${req.method} ${url.pathname}`);
    if (!url.searchParams.get("X-Amz-Signature") || !url.searchParams.get("X-Amz-Credential")?.startsWith("AKID/")) {
      res.writeHead(403).end("<Error><Code>AccessDenied</Code></Error>");
      return;
    }
    const [, bucket, ...rest] = url.pathname.split("/");
    const key = rest.map(decodeURIComponent).join("/");
    if (bucket !== "backups") { res.writeHead(404).end("<Error><Code>NoSuchBucket</Code></Error>"); return; }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (req.method === "PUT") { objects.set(key, Buffer.concat(chunks)); res.writeHead(200).end(); return; }
      if (req.method === "DELETE") { objects.delete(key); res.writeHead(204).end(); return; }
      if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
        const prefix = url.searchParams.get("prefix") || "";
        const contents = [...objects].filter(([name]) => name.startsWith(prefix))
          .map(([name, body]) => `<Contents><Key>${name}</Key><Size>${body.length}</Size></Contents>`).join("");
        res.writeHead(200, { "content-type": "application/xml" }).end(`<ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`);
        return;
      }
      const body = objects.get(key);
      if (!body) { res.writeHead(404).end("<Error><Code>NoSuchKey</Code></Error>"); return; }
      res.writeHead(200, { "content-length": body.length }).end(req.method === "HEAD" ? undefined : body);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, objects, requests, endpoint: `http://127.0.0.1:${server.address().port}` })));
}

function run(request, data = Buffer.alloc(0)) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `import(${JSON.stringify(SCRIPT)})`], { env: { PATH: process.env.PATH } });
    const out = [], err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() }));
    child.stdin.end(Buffer.concat([Buffer.from(`${JSON.stringify(request)}\n`), data]));
  });
}

test("sealed backups open only with the same passphrase and keep env and dump apart", () => {
  const file = offsite.seal("secret", { createdAt: "2026-11-20T03:30:00Z" }, Buffer.from("A=1\n"), Buffer.from("PGDMP-data"));
  assert.equal(file.subarray(0, 4).toString(), "VBK1");
  assert.ok(!file.includes(Buffer.from("PGDMP")), "the dump is not stored in clear");
  const { meta, env, dump } = offsite.open("secret", file);
  assert.equal(env.toString(), "A=1\n");
  assert.equal(dump.toString(), "PGDMP-data");
  assert.equal(meta.createdAt, "2026-11-20T03:30:00Z");
  assert.throws(() => offsite.open("wrong", file), (error) => error.code === "BAD_PASSPHRASE");
});

test("bucket settings: OSS gets virtual-hosted requests and its region from the endpoint", () => {
  const base = { bucket: "b", accessKeyId: "k", secretAccessKey: "s" };
  const oss = offsite.bucketConfig({ ...base, endpoint: "https://oss-cn-hangzhou.aliyuncs.com" });
  assert.equal(oss.region, "cn-hangzhou");
  assert.equal(oss.virtualHost, true);
  assert.equal(oss.prefix, "veilbird-backups/");
  const r2 = offsite.bucketConfig({ ...base, endpoint: "abc.r2.cloudflarestorage.com", prefix: "/db" });
  assert.equal(r2.region, "auto");
  assert.equal(r2.virtualHost, false);
  assert.equal(r2.prefix, "db/");
  assert.throws(() => offsite.bucketConfig({ endpoint: "https://x" }), /VEILBIRD_BACKUP_S3_BUCKET/);
});

test("upload, prune to the newest copies, list and download", async (t) => {
  const s3 = await fakeS3();
  t.after(() => s3.server.close());
  const bucket = { endpoint: s3.endpoint, bucket: "backups", accessKeyId: "AKID", secretAccessKey: "SECRET", passphrase: "master-key" };
  const env = Buffer.from("VEILBIRD_MASTER_KEY=master-key\n");
  for (const [i, day] of ["17", "18", "19", "20"].entries()) {
    const dump = Buffer.from(`PGDMP dump ${i}`);
    const result = await run({ ...bucket, command: "upload", keep: 3, envBytes: env.length, createdAt: `2026-11-${day}T03:30:00Z` }, Buffer.concat([env, dump]));
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout.toString(), new RegExp(`veilbird-202611${day}T033000Z\\.vbk`));
  }
  assert.deepEqual([...s3.objects.keys()].sort(), ["18", "19", "20"].map((day) => `veilbird-backups/veilbird-202611${day}T033000Z.vbk`));
  assert.ok(s3.requests.includes("DELETE /backups/veilbird-backups/veilbird-20261117T033000Z.vbk"));

  const listed = await run({ ...bucket, command: "list" });
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout.toString(), /^veilbird-20261120T033000Z\.vbk/);

  const latest = await run({ ...bucket, command: "get", part: "dump" });
  assert.equal(latest.code, 0, latest.stderr);
  assert.equal(latest.stdout.toString(), "PGDMP dump 3");
  assert.match(latest.stderr, /^BACKUP veilbird-20261120T033000Z\.vbk age_hours=/m);
  const envPart = await run({ ...bucket, command: "get", part: "env", name: "veilbird-20261118T033000Z.vbk" });
  assert.equal(envPart.stdout.toString(), env.toString());

  const wrong = await run({ ...bucket, passphrase: "other", command: "get", part: "dump" });
  assert.equal(wrong.code, 3);
  assert.match(wrong.stderr, /wrong backup password/);
});

test("a rejected request fails at once with the bucket's error code", async (t) => {
  const s3 = await fakeS3();
  t.after(() => s3.server.close());
  const started = Date.now();
  const result = await run({ endpoint: s3.endpoint, bucket: "missing", accessKeyId: "AKID", secretAccessKey: "S", passphrase: "p",
    command: "upload", envBytes: 0, createdAt: "2026-11-20T03:30:00Z" }, Buffer.from("PGDMP"));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /HTTP 404 NoSuchBucket/);
  assert.ok(Date.now() - started < 4_000, "no retries for a 4xx answer");
});
