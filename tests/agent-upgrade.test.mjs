import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { agentUpgradeCommand } from "../server/agent-upgrade.ts";
const exec = promisify(execFile);

test("Agent upgrade preserves identity, backs up source and restores on service failure", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "northstar-upgrade-test-"));
  try {
    await mkdir(path.join(dir,"bin"));
    await writeFile(path.join(dir,"bin/systemctl"), '#!/bin/sh\n[ "$FAIL_SERVICE" != "1" ]\n', { mode: 0o700 });
    const old = "print('old')\n", updated = "print('new')\n", identity = "TOKEN=unchanged\n";
    await writeFile(path.join(dir,"agent.py"),old);
    await writeFile(path.join(dir,"config.env"),identity);
    const command = agentUpgradeCommand(updated).replaceAll("/opt/northstar-agent",dir);
    const env = { ...process.env, PATH: `${dir}/bin:${process.env.PATH}`, FAIL_SERVICE: "0" };
    await exec("sh",["-c",command],{env});
    assert.equal(await readFile(path.join(dir,"agent.py"),"utf8"),updated);
    assert.equal(await readFile(path.join(dir,"agent.py.previous"),"utf8"),old);
    assert.equal(await readFile(path.join(dir,"config.env"),"utf8"),identity);
    await writeFile(path.join(dir,"agent.py"),old);
    await assert.rejects(exec("sh",["-c",command],{env:{...env,FAIL_SERVICE:"1"}}),/previous source restored/);
    assert.equal(await readFile(path.join(dir,"agent.py"),"utf8"),old);
    const invalid = agentUpgradeCommand("not valid python !").replaceAll("/opt/northstar-agent",dir);
    await assert.rejects(exec("sh",["-c",invalid],{env}));
    assert.equal(await readFile(path.join(dir,"agent.py"),"utf8"),old);
    await rm(path.join(dir,"config.env"));
    await assert.rejects(exec("sh",["-c",command],{env}),/not installed/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
