import assert from "node:assert/strict";
import test from "node:test";
import { approvalButtons, escapeHtml, MESSAGE_LIMIT, parseCallback, personName, renderMessage, scrubToken, validToken } from "../server/telegram-format.ts";

test("Telegram HTML: user text is escaped, never markup", () => {
  assert.equal(escapeHtml(`<b>&"x"</b>`), "&lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt;");
  const html = renderMessage({ tone: "approval", title: "新用户 <script>", fields: [{ label: "邮箱", value: "a<b>@x.com", code: true }], lines: ["1 < 2 & 3 > 2"], link: { label: "Console", url: "https://console.example.com/users?a=1&b=2" }, footer: "✅ 已通过" });
  assert.equal(html, [
    "🙋 <b>新用户 &lt;script&gt;</b>",
    "邮箱：<code>a&lt;b&gt;@x.com</code>",
    "1 &lt; 2 &amp; 3 &gt; 2",
    `<a href="https://console.example.com/users?a=1&amp;b=2">Console</a>`,
    "\n<b>✅ 已通过</b>",
  ].join("\n"));
  // Only http(s) links are kept.
  assert.doesNotMatch(renderMessage({ title: "x", link: { label: "x", url: "javascript:alert(1)" } }), /href/);
});

test("Telegram HTML: long messages stay within 4096 and every tag stays closed", () => {
  const html = renderMessage({ tone: "alert", title: "t".repeat(400), lines: Array.from({ length: 80 }, (_, i) => `${i} ${"<&>".repeat(40)}`), fields: [{ label: "x", value: "y".repeat(1000), code: true }], footer: "done" });
  assert.ok(html.length <= MESSAGE_LIMIT, `length ${html.length}`);
  assert.equal((html.match(/<b>/g) || []).length, (html.match(/<\/b>/g) || []).length);
  assert.equal((html.match(/<code>/g) || []).length, (html.match(/<\/code>/g) || []).length);
  assert.doesNotMatch(html, /&[a-z]*…/, "no entity is cut in half");
  assert.match(html, /<b>done<\/b>$/, "the footer survives a long body");
});

test("Telegram buttons: callback data fits 64 bytes and parses back", () => {
  const [[yes, no]] = approvalButtons("AbC123_-xyz", { approve: "通过", reject: "拒绝" });
  assert.deepEqual(parseCallback(yes.callback_data), { id: "AbC123_-xyz", approve: true });
  assert.deepEqual(parseCallback(no.callback_data), { id: "AbC123_-xyz", approve: false });
  assert.equal(parseCallback("ap:x:y"), null);
  assert.equal(parseCallback("ap:abcdefg:z"), null);
  assert.equal(approvalButtons("abcdefgh", { approve: "go" })[0].length, 1);
});

test("Telegram tokens: validated and scrubbed from any text", () => {
  const token = "123456789:AAF-abcdefghijklmnopqrstuvwxyz012345";
  assert.ok(validToken(token));
  assert.ok(!validToken("123:abc"));
  assert.equal(scrubToken(`fetch https://api.telegram.org/bot${token}/getMe failed (${token})`), "fetch https://api.telegram.org/bot[token]/getMe failed ([token])");
  assert.equal(personName({ first_name: "Lena", username: "lena_k" }), "Lena (@lena_k)");
  assert.equal(personName({ id: 7 }), "7");
});
