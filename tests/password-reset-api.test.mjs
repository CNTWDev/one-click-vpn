import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";
import pg from "pg";
import test from "node:test";

// Minimal SMTP sink: accepts any message and keeps its raw text.
function smtpSink() {
  const messages = [];
  const server = net.createServer((socket) => {
    let data = false, buffer = "", body = "";
    socket.write("220 sink\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index;
      while ((index = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 2);
        if (data) {
          if (line === ".") { data = false; messages.push(body); body = ""; socket.write("250 ok\r\n"); } else body += line + "\n";
        } else if (/^(EHLO|HELO)/i.test(line)) socket.write("250-sink\r\n250 AUTH PLAIN\r\n");
        else if (/^AUTH/i.test(line)) socket.write("235 ok\r\n");
        else if (/^DATA/i.test(line)) { data = true; socket.write("354 go\r\n"); }
        else if (/^QUIT/i.test(line)) { socket.write("221 bye\r\n"); socket.end(); }
        else socket.write("250 ok\r\n");
      }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, messages, port: server.address().port })));
}

test("Password reset: admin link and email link set a new password once and sign the account out", { skip: !process.env.VEILBIRD_TEST_DATABASE_URL }, async () => {
  const databaseUrl = process.env.VEILBIRD_TEST_DATABASE_URL;
  const base = "http://127.0.0.1:3197";
  const sink = await smtpSink();
  const env = { ...process.env, NODE_ENV: "production", VEILBIRD_DATABASE_URL: databaseUrl, VEILBIRD_MASTER_KEY: Buffer.alloc(32, 9).toString("base64"), VEILBIRD_ADMIN_EMAIL: "owner@example.com", VEILBIRD_ADMIN_PASSWORD: "test-password-123", VEILBIRD_PUBLIC_ORIGIN: base };
  await promisify(execFile)(process.execPath, ["scripts/migrate.mjs"], { env });
  const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3197"], { env, stdio: "ignore" });
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const json = { "Content-Type": "application/json" };
  const post = (path, body, headers = json) => fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
  const email = `reset-${Date.now()}@example.com`;
  try {
    for (let attempt = 0; attempt < 100 && !await fetch(base + "/api/health").then((r) => r.ok).catch(() => false); attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await post("/api/v1/auth/register", { email, displayName: "Reset", password: "first-password-1" })).status, 202);
    const { id } = (await pool.query("SELECT id FROM users WHERE email=$1", [email])).rows[0];
    await pool.query("UPDATE users SET status='active' WHERE id=$1", [id]);
    const login = (password) => post("/api/v1/auth/web-login", { email, password });
    const session = (await login("first-password-1")).headers.get("set-cookie").split(";")[0];
    assert.deepEqual(await (await fetch(base + "/api/v1/auth/password-reset")).json(), { email: false });
    assert.equal((await post("/api/v1/auth/password-reset", { email })).status, 503);

    // Administrator link: needs an admin, refuses the owner, never returns a password.
    assert.equal((await post(`/api/v1/admin/users/${id}/password-reset`, {})).status, 403);
    const admin = { ...json, Cookie: (await post("/api/auth/login", { email: "owner@example.com", password: "test-password-123" })).headers.get("set-cookie").split(";")[0] };
    const owner = (await pool.query("SELECT id FROM users WHERE email='owner@example.com'")).rows[0].id;
    assert.equal((await post(`/api/v1/admin/users/${owner}/password-reset`, {}, admin)).status, 400);
    const link = await (await post(`/api/v1/admin/users/${id}/password-reset`, {}, admin)).json();
    assert.match(link.url, new RegExp(`^${base}/#reset=`));
    const token = link.url.split("#reset=")[1];
    assert.equal((await post("/api/v1/auth/password-reset/confirm", { token, password: "short" })).status, 400);
    assert.equal((await post("/api/v1/auth/password-reset/confirm", { token: token.slice(0, -2) + "xx", password: "second-password-2" })).status, 400);
    assert.equal((await post("/api/v1/auth/password-reset/confirm", { token, password: "second-password-2" })).status, 200);
    assert.equal((await post("/api/v1/auth/password-reset/confirm", { token, password: "third-password-3" })).status, 400, "a link works once");
    assert.equal((await fetch(base + "/api/v1/auth/me", { headers: { Cookie: session } })).status, 401, "old sessions are signed out");
    assert.equal((await login("first-password-1")).status, 401);
    assert.equal((await login("second-password-2")).status, 200);

    // Mail settings live in Console; the password is write-only.
    assert.equal((await fetch(base + "/api/v1/admin/mail-settings", { method: "PUT", headers: json, body: "{}" })).status, 403);
    const mailSettings = { provider: "smtp", host: "127.0.0.1", port: sink.port, username: "no-reply@example.com", fromName: "TrackNothing", password: "smtp-secret" };
    const saved = await (await fetch(base + "/api/v1/admin/mail-settings", { method: "PUT", headers: admin, body: JSON.stringify(mailSettings) })).json();
    assert.equal(saved.settings.passwordSet, true);
    assert.doesNotMatch(JSON.stringify(saved), /smtp-secret/);
    assert.doesNotMatch(JSON.stringify((await pool.query("SELECT * FROM mail_settings")).rows), /smtp-secret/);
    assert.equal((await fetch(base + "/api/v1/admin/mail-settings", { method: "PUT", headers: admin, body: JSON.stringify({ ...mailSettings, password: "" }) })).status, 200, "blank password keeps the stored one");
    assert.deepEqual(await (await fetch(base + "/api/v1/auth/password-reset")).json(), { email: true });
    assert.equal((await post("/api/v1/admin/mail-settings/test", {}, admin)).status, 200);
    assert.equal(sink.messages.length, 1);
    assert.match(sink.messages.shift(), /From: TrackNothing <no-reply@example\.com>/);

    // Email link: same reply for unknown addresses, the mail carries a working link in the chosen language.
    assert.equal((await post("/api/v1/auth/password-reset", { email: "nobody@example.com", language: "ru" })).status, 202);
    assert.equal((await post("/api/v1/auth/password-reset", { email, language: "ru" })).status, 202);
    for (let attempt = 0; attempt < 50 && !sink.messages.length; attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(sink.messages.length, 1);
    const mail = sink.messages[0].replace(/=\r?\n/g, "");
    assert.match(mail, new RegExp(`To: ${email}`));
    const encoded = /\r?\n\r?\n([\s\S]+)$/.exec(mail)[1];
    const text = /Content-Transfer-Encoding: base64/i.test(mail) ? Buffer.from(encoded, "base64").toString("utf8") : encoded.replace(/=3D/g, "=");
    assert.match(text, /1 час/);
    const mailed = /#reset=([\w.-]+)/.exec(text)[1];
    assert.equal((await post("/api/v1/auth/password-reset/confirm", { token: mailed, password: "third-password-3" })).status, 200);
    assert.equal((await login("third-password-3")).status, 200);
    assert.equal((await (await post("/api/v1/auth/password-reset/confirm", { token: mailed, password: "fourth-password-4" })).json()).error, "This reset link is invalid or has expired");
  } finally {
    server.kill(); await pool.end(); sink.server.close();
  }
});
