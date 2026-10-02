import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const exec = promisify(execFile);

// Reconstruct the Docker source allowlist, not the whole checkout: a local Vite
// build otherwise hides missing COPY statements for shared frontend components.
test("both frontend Docker source contexts contain all build dependencies", async () => {
  const dockerfile = await readFile(path.join(root, "Dockerfile.frontend"), "utf8");
  for (const [stage, script] of [["portal-build", "build:portal"], ["admin-build", "build:admin-web"]]) {
    const directory = await mkdtemp(path.join(tmpdir(), "northstar-frontend-context-"));
    try {
      let currentStage = "";
      for (const line of dockerfile.split("\n")) {
        const from = line.match(/^FROM .* AS (\S+)$/);
        if (from) currentStage = from[1];
        if (!["dependencies", stage].includes(currentStage) || !line.startsWith("COPY ")) continue;
        const parts = line.slice(5).trim().split(/\s+/);
        assert.ok(!parts[0].startsWith("--"), "Update the source-context test for COPY options");
        const destination = parts.pop();
        for (const source of parts) {
          const target = path.join(directory, destination, destination.endsWith("/") ? path.basename(source) : "");
          await mkdir(path.dirname(target), { recursive: true });
          await cp(path.join(root, source), target, { recursive: true });
        }
      }
      // Reuse installed packages, but never expose other checkout source files.
      await symlink(path.join(root, "node_modules"), path.join(directory, "node_modules"), "dir");
      await exec("npm", ["run", script], { cwd: directory, timeout: 120_000 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
