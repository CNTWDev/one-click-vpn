#!/usr/bin/env node
// Prints the release notes of one client version from clients/CHANGELOG.md: the "### zh/en/ru" blocks under
// "## <version>". They become the release's 更新说明; the apps show the block in their own language.
//
//   node scripts/client-changelog.mjs 1.0.3            # notes of 1.0.3 (empty when the version has none)
//   node scripts/client-changelog.mjs                  # notes of clients/version.json
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);

export function changelogNotes(version) {
  const text = readFileSync(new URL("clients/CHANGELOG.md", root), "utf8");
  const lines = text.split(/\r?\n/), start = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (start < 0) return "";
  const end = lines.findIndex((line, index) => index > start && /^## /.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = process.argv[2] || JSON.parse(readFileSync(new URL("clients/version.json", root), "utf8")).version;
  process.stdout.write(changelogNotes(version) + "\n");
}
