import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { agentUpgradeCommand, agentUpgradeFinalizeCommand, agentRollbackCommand } from "../server/agent-upgrade.ts";
const exec = promisify(execFile);

test("Agent upgrade preserves identity, backs up source and restores on service failure", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "northstar-upgrade-test-"));
  try {
    await mkdir(path.join(dir,"bin"));
    await writeFile(path.join(dir,"bin/systemctl"), '#!/bin/sh\n[ "$1" != "restart" ] || [ "$FAIL_SERVICE" != "1" ]\n', { mode: 0o700 });
    await writeFile(path.join(dir,"bin/systemd-run"), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    await writeFile(path.join(dir,"bin/flock"), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const old = "print('old')\n", updated = "print('new')\n", identity = "TOKEN=unchanged\n";
    await writeFile(path.join(dir,"agent.py"),old);
    await writeFile(path.join(dir,"config.env"),identity);
    const command = agentUpgradeCommand(updated).replaceAll("/opt/northstar-agent",dir);
    const env = { ...process.env, PATH: `${dir}/bin:${process.env.PATH}`, FAIL_SERVICE: "0" };
    await exec("sh",["-c",command],{env});
    assert.equal(await readFile(path.join(dir,"agent.py"),"utf8"),updated);
    assert.equal(await readFile(path.join(dir,"agent.py.rollback"),"utf8"),old);
    await exec("sh",["-c",agentUpgradeFinalizeCommand().replaceAll("/opt/northstar-agent",dir)],{env});
    assert.equal(await readFile(path.join(dir,"agent.py.previous"),"utf8"),old);
    const runtimeFailure = agentUpgradeCommand("raise RuntimeError('runtime failure')\n").replaceAll("/opt/northstar-agent",dir);
    await exec("sh",["-c",runtimeFailure],{env});
    await exec("sh",["-c",agentRollbackCommand().replaceAll("/opt/northstar-agent",dir)],{env});
    assert.equal(await readFile(path.join(dir,"agent.py"),"utf8"),updated);
    // A delayed runtime failure retains the previous confirmed backup.
    assert.equal(await readFile(path.join(dir,"agent.py.previous"),"utf8"),old);
    assert.equal(await readFile(path.join(dir,"config.env"),"utf8"),identity);
    await writeFile(path.join(dir,"agent.py"),old);
    await assert.rejects(exec("sh",["-c",command],{env:{...env,FAIL_SERVICE:"1"}}),/previous source restored/);
    assert.equal(await readFile(path.join(dir,"agent.py"),"utf8"),old);
    const invalid = agentUpgradeCommand("not valid python !").replaceAll("/opt/northstar-agent",dir);
    await assert.rejects(exec("sh",["-c",invalid],{env}));
    assert.equal(await readFile(path.join(dir,"agent.py"),"utf8"),old);
    // The Agent confirms itself after its first heartbeat; the SSH finalize is then a no-op, while a
    // rolled-back upgrade is still reported as failed.
    await writeFile(path.join(dir,"agent.py"),old);
    await exec("sh",["-c",command],{env});
    await rm(path.join(dir,"upgrade.pending"));
    await writeFile(path.join(dir,"upgrade.confirmed"),"self\n");
    const finalized = await exec("sh",["-c",agentUpgradeFinalizeCommand().replaceAll("/opt/northstar-agent",dir)],{env});
    assert.match(finalized.stdout,/confirmed by the Agent/);
    await exec("sh",["-c",command],{env});
    await exec("sh",["-c",agentRollbackCommand().replaceAll("/opt/northstar-agent",dir)],{env});
    await assert.rejects(exec("sh",["-c",agentUpgradeFinalizeCommand().replaceAll("/opt/northstar-agent",dir)],{env}),/already rolled back/);
    await rm(path.join(dir,"config.env"));
    await assert.rejects(exec("sh",["-c",command],{env}),/not installed/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
