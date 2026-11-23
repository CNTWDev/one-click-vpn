import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import http from "node:http";
import { promisify } from "node:util";
import pg from "pg";
import test from "node:test";

const TOKEN = "123456789:AAF-fake-token-abcdefghijklmnopqrstuv";

// A fake Bot API: records every call and hands queued updates to getUpdates.
function fakeTelegram() {
  const calls = [], updates = [];
  let nextMessage = 100, nextUpdate = 1;
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", async () => {
      const match = request.url.match(/^\/bot([^/]+)\/(\w+)$/);
      const body = raw ? JSON.parse(raw) : {};
      const reply = (result, ok = true, extra = {}) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(ok ? { ok, result } : { ok, ...extra })); };
      if (!match || match[1] !== TOKEN) return reply(null, false, { error_code: 401, description: "Unauthorized" });
      const method = match[2];
      calls.push({ method, body });
      if (method === "getMe") return reply({ id: 4242, is_bot: true, first_name: "Ops", username: "ops_test_bot" });
      if (method === "getChat") return reply(body.chat_id === "-100500" ? { id: -100500, type: "supergroup", title: "运维群" } : null, body.chat_id === "-100500", { error_code: 400, description: "Bad Request: chat not found" });
      if (method === "sendMessage" || method === "editMessageText") return reply({ message_id: method === "sendMessage" ? nextMessage++ : body.message_id, chat: { id: Number(body.chat_id) } });
      if (method === "getUpdates") {
        // Long poll: wait briefly for something to hand out.
        for (let i = 0; i < 10 && !updates.length; i++) await new Promise((resolve) => setTimeout(resolve, 100));
        return reply(updates.splice(0));
      }
      return reply(true);
    });
  });
  const push = (update) => updates.push({ update_id: nextUpdate++, ...update });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, calls, push, origin: `http://127.0.0.1:${server.address().port}` })));
}

async function until(check, what) {
  for (let i = 0; i < 100; i++) { const value = await check(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 100)); }
  assert.fail(`timed out waiting for ${what}`);
}

test("Telegram: connect a bot, add a chat found by /start, and approve a sign-up from a button", { skip: !process.env.VEILBIRD_TEST_DATABASE_URL }, async () => {
  const databaseUrl = process.env.VEILBIRD_TEST_DATABASE_URL;
  const base = "http://127.0.0.1:3194";
  const telegram = await fakeTelegram();
  const env = { ...process.env, NODE_ENV: "production", VEILBIRD_DATABASE_URL: databaseUrl, VEILBIRD_MASTER_KEY: Buffer.alloc(32, 9).toString("base64"), VEILBIRD_ADMIN_EMAIL: "owner@example.com", VEILBIRD_ADMIN_PASSWORD: "test-password-123", VEILBIRD_PUBLIC_ORIGIN: base, VEILBIRD_TELEGRAM_API_ORIGIN: telegram.origin };
  await promisify(execFile)(process.execPath, ["scripts/migrate.mjs"], { env });
  const pool = new pg.Pool({ connectionString: databaseUrl });
  // Start clean: the test database keeps what earlier runs saved.
  for (const table of ["telegram_settings", "telegram_chats", "telegram_seen", "telegram_approvals"]) await pool.query(`DELETE FROM ${table}`);
  const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3194"], { env, stdio: "ignore" });
  const json = { "Content-Type": "application/json" };
  try {
    await until(() => fetch(base + "/api/health").then((r) => r.ok).catch(() => false), "the Controller");
    const admin = { ...json, Cookie: (await fetch(base + "/api/auth/login", { method: "POST", headers: json, body: JSON.stringify({ email: "owner@example.com", password: "test-password-123" }) })).headers.get("set-cookie").split(";")[0] };
    const call = (path, method, body, headers = admin) => fetch(base + "/api/v1/admin/telegram" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });

    assert.equal((await call("", "GET", undefined, json)).status, 403);
    assert.equal((await call("", "PUT", { token: "not-a-token" })).status, 400);
    const connected = await (await call("", "PUT", { token: TOKEN })).json();
    assert.equal(connected.bot.username, "ops_test_bot");
    assert.ok(connected.events.some((item) => item.key === "signups" && item.approval));
    assert.doesNotMatch(JSON.stringify(connected), /fake-token/);
    assert.doesNotMatch(JSON.stringify((await pool.query("SELECT * FROM telegram_settings")).rows), /fake-token/, "the token is stored encrypted");
    assert.ok(telegram.calls.some((item) => item.method === "deleteWebhook"));

    // /start in a private chat and a message in a group: both show up for the Console, and /start is answered.
    telegram.push({ message: { message_id: 1, text: "/start", chat: { id: 111, type: "private", first_name: "Tuan" }, from: { id: 111, first_name: "Tuan", username: "tuan" } } });
    telegram.push({ message: { message_id: 2, text: "hello", chat: { id: -100500, type: "supergroup", title: "运维群" }, from: { id: 222, first_name: "Mallory" } } });
    const seen = await until(async () => { const status = await (await call("", "GET")).json(); return status.seen.length >= 2 && status; }, "seen chats");
    assert.ok(seen.receiving.ok);
    assert.deepEqual(seen.seen.map((item) => item.chatId).sort(), ["-100500", "111"]);
    const startReply = telegram.calls.find((item) => item.method === "sendMessage" && item.body.chat_id === 111);
    assert.equal(startReply.body.parse_mode, "HTML");
    assert.match(startReply.body.text, /<code>111<\/code>/);

    assert.equal((await call("/chats", "POST", { chatId: "-999" })).status, 400, "a chat the bot cannot see is refused");
    let status = await (await call("/chats", "POST", { chatId: "-100500" })).json();
    // A new chat receives every event the Controller defines (other modules add their own).
    assert.deepEqual(status.chats[0].events.sort(), status.events.map((item) => item.key).sort());
    for (const key of ["alerts", "releases", "signups"]) assert.ok(status.chats[0].events.includes(key));
    status = await (await call("/chats", "PUT", { chatId: "-100500", events: ["signups", "bogus"] })).json();
    assert.deepEqual(status.chats[0].events, ["signups"]);
    status = await (await call("/approvers", "PUT", { approvers: ["111", "999"] })).json();
    assert.deepEqual(status.approvers, [{ id: "111", name: "Tuan (@tuan)" }], "only people the bot has seen");
    assert.equal((await call("/test", "POST", { chatId: "-100500" })).status, 200);
    assert.ok(telegram.calls.some((item) => item.method === "sendMessage" && item.body.chat_id === "-100500" && /测试消息/.test(item.body.text)));

    // A sign-up is posted with escaped text and approve / reject buttons.
    const email = `tg-${Date.now()}@example.com`;
    assert.equal((await fetch(base + "/api/v1/auth/register", { method: "POST", headers: json, body: JSON.stringify({ email, displayName: "<b>Eve & co</b>", password: "first-password-1" }) })).status, 202);
    const { id: userId } = (await pool.query("SELECT id FROM users WHERE email=$1", [email])).rows[0];
    const ask = await until(() => telegram.calls.find((item) => item.method === "sendMessage" && item.body.text?.includes(email)), "the sign-up message");
    assert.equal(ask.body.chat_id, "-100500");
    assert.match(ask.body.text, /&lt;b&gt;Eve &amp; co&lt;\/b&gt;/);
    const [approve, reject] = ask.body.reply_markup.inline_keyboard[0];
    assert.match(approve.callback_data, /^ap:[\w-]+:y$/);
    assert.match(reject.callback_data, /^ap:[\w-]+:n$/);
    const press = (from, data) => telegram.push({ callback_query: { id: `cb${Math.random()}`, from, data, message: { message_id: 999, chat: { id: -100500, type: "supergroup" } } } });
    const answered = (text) => until(() => telegram.calls.find((item) => item.method === "answerCallbackQuery" && item.body.text.includes(text)), `answer "${text}"`);

    press({ id: 222, first_name: "Mallory" }, approve.callback_data);
    await answered("不在审批人名单");
    assert.equal((await pool.query("SELECT status FROM users WHERE id=$1", [userId])).rows[0].status, "pending");

    press({ id: 111, first_name: "Tuan", username: "tuan" }, approve.callback_data);
    await answered("已通过");
    assert.equal((await pool.query("SELECT status FROM users WHERE id=$1", [userId])).rows[0].status, "active");
    const edited = telegram.calls.find((item) => item.method === "editMessageText" && item.body.text.includes(email));
    assert.ok(edited, "the message is rewritten with the outcome");
    assert.match(edited.body.text, /已通过 · Tuan · \d\d:\d\d<\/b>$/);
    assert.equal(edited.body.reply_markup, undefined, "buttons are gone");

    press({ id: 111, first_name: "Tuan", username: "tuan" }, reject.callback_data);
    await answered("已经处理过了");
    assert.equal((await pool.query("SELECT status FROM users WHERE id=$1", [userId])).rows[0].status, "active");

    // Turning Telegram off clears everything.
    status = await (await call("", "DELETE")).json();
    assert.equal(status.bot, null);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM telegram_chats")).rows[0].n, 0);
  } finally {
    server.kill();
    telegram.server.close();
    await pool.end();
  }
});
