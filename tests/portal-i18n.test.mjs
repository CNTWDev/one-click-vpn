import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { rolldown } from "rolldown";
import { catalog } from "../shared/i18n-catalog.ts";

const bundle = await rolldown({ input: "shared/i18n-core.ts" });
const { output } = await bundle.generate({ format: "esm" });
await bundle.close();
const { createTranslator, resolveLocale, formatActivity, formatDate, isPreference, message, translateMessage } = await import(`data:text/javascript;base64,${Buffer.from(output[0].code).toString("base64")}`);

test("Portal language negotiation and safe fallback", () => {
  assert.equal(resolveLocale("system", ["ru-RU", "en"]), "ru");
  assert.equal(resolveLocale("system", ["zh-TW"]), "zh");
  assert.equal(resolveLocale("system", ["de-DE", "en-GB"]), "en");
  assert.equal(resolveLocale("system", []), "en");
  assert.equal(resolveLocale("zh", ["ru-RU"]), "zh");
  assert.equal(isPreference("system"), true);
  assert.equal(isPreference("invalid"), false);
  assert.equal(createTranslator("ru")("用户自定义节点"), "用户自定义节点");
  assert.equal(createTranslator("en")("推荐：{0}", ["My $& <server>"]), "Recommended: My $& <server>");
  const notice = message("推荐：{0}", ["My custom name"]);
  assert.equal(translateMessage(notice, createTranslator("ru")), "Рекомендуется: My custom name");
  assert.equal(translateMessage(notice, createTranslator("en")), "Recommended: My custom name");
});

test("All Portal translations exist, preserve placeholders and have nonempty EN/RU text", async () => {
  const placeholders = (value) => [...value.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort();
  for (const [key, entries] of Object.entries(catalog)) {
    assert.equal(entries.length, 2, key);
    for (const value of entries) {
      assert.ok(value.trim(), key);
      assert.deepEqual(placeholders(value), placeholders(key), key);
      assert.doesNotMatch(value, /[\u3400-\u9fff]/u, key);
    }
  }
  const files = ["main.tsx", "credential-dashboard.tsx", "action-dialog.tsx", "subscription-access.tsx", "region-map.tsx", "language.tsx", "client-downloads.tsx"].map((name) => `portal-web/src/${name}`);
  files.push("shared/subscription-panel.tsx");
  for (const file of files) {
    const source = await fs.readFile(file, "utf8");
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node) {
      if (ts.isCallExpression(node) && ["t", "message"].includes(node.expression.getText(ast)) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) assert.ok(catalog[node.arguments[0].text], `${file}: missing ${node.arguments[0].text}`);
      if (ts.isJsxText(node)) assert.doesNotMatch(node.getText(ast), /[\u3400-\u9fff]/u, `${file}: untranslated JSX`);
      ts.forEachChild(node, visit);
    }
    // Native language names in the language picker are intentionally untranslated.
    if (!file.endsWith("language.tsx")) visit(ast);
  }
});

test("Date and relative time follow the selected locale, including Russian plurals", () => {
  const now = Date.parse("2026-10-06T12:00:00Z");
  for (const count of [1, 2, 5, 21]) {
    const actual = formatActivity(new Date(now - count * 60000).toISOString(), "ru", now);
    assert.equal(actual, new Intl.RelativeTimeFormat("ru-RU", { numeric: "always" }).format(-count, "minute"));
  }
  assert.equal(formatDate("bad", "en"), "Unknown time");
  assert.equal(formatActivity(null, "ru"), "Ещё не использовалось");
  assert.match(formatDate("2026-10-06T12:00:00Z", "en"), /Oct/);
  assert.match(formatDate("2026-10-06T12:00:00Z", "ru"), /окт/);
});
