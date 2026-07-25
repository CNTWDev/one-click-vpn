import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const templateRoot = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Northstar control plane", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Northstar Control Plane<\/title>/i);
  assert.match(html, /NORTHSTAR/);
  assert.match(html, /Operate the edge/);
  assert.match(html, /Add node/);
  assert.match(html, /Recovery, without exposure/);
  assert.doesNotMatch(html, /Your site is taking shape|Building your site/);
});

test("keeps the management surface focused on secure node operations", async () => {
  const [page, layout, css, packageJson, socialCard] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../public/og.png", import.meta.url)),
  ]);

  assert.match(page, /Add a managed node/);
  assert.match(page, /Temporary SSH password/);
  assert.match(page, /Agent tunnel/);
  assert.match(page, /Emergency SSH fallback/);
  assert.match(page, /Theme follows your operating system/);
  assert.match(css, /prefers-color-scheme:\s*dark/);
  assert.match(layout, /Northstar Control Plane/);
  assert.match(layout, /og\.png/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.ok(socialCard.byteLength > 10_000);
  await assert.rejects(readFile(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
});
