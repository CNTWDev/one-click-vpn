import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { rolldown } from "rolldown";
async function load(input) {
  const bundle = await rolldown({ input });
  const { output } = await bundle.generate({ format: "esm" });
  await bundle.close();
  return import(`data:text/javascript;base64,${Buffer.from(output[0].code).toString("base64")}`);
}
const { catalog } = await load("shared/i18n-catalog.ts");
const { createLanguageStore } = await load("shared/language-store.ts");
const han = /[\u3400-\u9fff]/u;

test("Console copy and metadata have complete locale resources", async () => {
  for (const name of await fs.readdir("admin-web/src", { recursive: true })) {
    if (!/\.tsx?$/.test(name) || ["region-catalog.ts", "country-map-points.ts"].includes(name)) continue;
    const file = `admin-web/src/${name}`, source = await fs.readFile(file, "utf8");
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, name.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    function visit(node) {
      if (ts.isJsxText(node)) assert.doesNotMatch(node.text, han, `${file}: untranslated JSX`);
      if (ts.isStringLiteral(node) && han.test(node.text)) assert.ok(catalog[node.text], `${file}: missing resource ${node.text}`);
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
});

test("Native resources cover all three platforms with matching parameters", async () => {
  const messages = JSON.parse(await fs.readFile("clients/locales/messages.json", "utf8"));
  const tokens = text => (text.match(/\{\d+\}/g) || []).sort();
  for (const [key, values] of Object.entries(messages)) {
    assert.match(key, /^[a-z][a-z0-9_]*$/);
    for (const locale of ["en", "zh", "ru"]) {
      assert.ok(values[locale]?.trim(), `${key}/${locale}`);
      assert.deepEqual(tokens(values[locale]), tokens(values.en), `${key}/${locale}`);
      if (locale !== "zh") assert.doesNotMatch(values[locale], han, `${key}/${locale}`);
    }
  }
  for (const dir of ["clients/android/app/src/main/java", "clients/apple/App", "clients/apple/Shared", "clients/apple/PacketTunnel", "clients/windows/Northstar"]) {
    for (const name of await fs.readdir(dir, { recursive: true })) {
      if (!/\.(kt|swift|cs)$/.test(name) || /(^|\/)(obj|bin)\//.test(name)) continue;
      const file = `${dir}/${name}`, source = await fs.readFile(file, "utf8");
      for (const match of source.matchAll(/(?:R\.string\.|L10n\.(?:text|Text)\(")(\w+)/g)) {
        // Variable arguments (e.g. L10n.text(model.status)) are deliberately not matched.
        assert.ok(messages[match[1]], `${file}: missing ${match[1]}`);
      }
      for (const line of source.split("\n")) {
        if (line.trim().startsWith("//") || line.includes("简体中文")) continue;
        assert.doesNotMatch(line, /"[^"\n]*[\u3400-\u9fff]/u, `${file}: UI copy outside resources`);
      }
    }
  }
  const apple = JSON.parse(await fs.readFile("clients/apple/Shared/Native.xcstrings", "utf8"));
  assert.deepEqual(Object.keys(apple.strings).sort(), Object.keys(messages).sort());
});

test("Language stores preserve independent preferences and work without browser storage", () => {
  const portal = createLanguageStore("test.portal"), console = createLanguageStore("test.console");
  let renders = 0;
  const unsubscribe = portal.subscribe(() => renders++);
  portal.select("ru");
  assert.equal(portal.locale(), "ru");
  assert.equal(portal.t("语言"), "Язык");
  assert.equal(console.preference(), "system");
  assert.equal(portal.number(1234.5), new Intl.NumberFormat("ru-RU").format(1234.5));
  portal.select("invalid");
  assert.equal(portal.preference(), "ru");
  assert.equal(renders, 1);
  unsubscribe();
  portal.select("en");
  assert.equal(renders, 1);
});
