import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  enforceLaneIgnore,
  isLaneCreation,
  laneTargetDirs,
  runEnsure,
} from "../gate.mjs";

const created = [];

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wi-gate-"));
  created.push(dir);
  return dir;
}

after(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

test("isLaneCreation: git worktree add in shell calls and worktree_* tools", () => {
  const lanes = [
    ["shell", { command: "git worktree add -b omos/t .slim/worktrees/t HEAD" }],
    ["shell", { command: "cd /r && git worktree add x" }],
    ["shell", { command: "git -C /r worktree add x" }],
    ["shell", { command: "git -c core.x=1 worktree add x" }],
    ["bash", { command: "git worktree add x" }],
    ["worktree_create", { name: "x" }],
    ["opencode.worktree_create", { name: "x" }],
  ];
  const others = [
    ["shell", { command: "git status" }],
    ["shell", { command: "git worktree list" }],
    ["shell", { command: "git worktree remove x" }],
    ["shell", { command: "git log --grep 'worktree add'" }],
    ["shell", {}],
    ["edit", { command: "git worktree add x" }],
  ];
  for (const [tool, input] of lanes) {
    assert.equal(isLaneCreation(tool, input), true, `${tool} ${JSON.stringify(input)}`);
  }
  for (const [tool, input] of others) {
    assert.equal(isLaneCreation(tool, input), false, `${tool} ${JSON.stringify(input)}`);
  }
});

test("laneTargetDirs: workdir by default; cd and git -C targets replace it", () => {
  const session = "/repo";
  assert.deepEqual(laneTargetDirs({ command: "git worktree add x" }, session), ["/repo"]);
  assert.deepEqual(
    laneTargetDirs({ workdir: "sub", command: "git worktree add x" }, session),
    ["/repo/sub"],
  );
  assert.deepEqual(
    laneTargetDirs({ command: "cd /other && git worktree add x" }, session),
    ["/other"],
  );
  assert.deepEqual(
    laneTargetDirs({ command: "git -C /other worktree add x" }, session),
    ["/other"],
  );
  assert.deepEqual(
    laneTargetDirs({ command: 'cd "/my repo" && git worktree add x' }, session),
    ["/my repo"],
  );
  assert.deepEqual(
    laneTargetDirs({ command: "cd ~/x && git worktree add y" }, session),
    [path.join(os.homedir(), "x")],
  );
  assert.deepEqual(laneTargetDirs({ name: "x" }, session), ["/repo"]);
});

test("enforceLaneIgnore: no-op for other calls; checks targets; refuses on failure", async () => {
  const calls = [];
  const passing = async (dir) => {
    calls.push(dir);
    return { ok: true, output: `updated: ${dir}/.gitignore` };
  };

  const other = await enforceLaneIgnore(
    { tool: "shell", input: { command: "ls" } },
    "/repo",
    passing,
  );
  assert.equal(other, null);
  assert.deepEqual(calls, []);

  const summary = await enforceLaneIgnore(
    { tool: "shell", input: { command: "git worktree add x" } },
    "/repo",
    passing,
  );
  assert.deepEqual(calls, ["/repo"]);
  assert.equal(summary, "/repo: updated: /repo/.gitignore");

  const failing = async () => ({ ok: false, output: "unpaired managed block markers" });
  await assert.rejects(
    enforceLaneIgnore(
      { tool: "shell", input: { command: "git worktree add x" } },
      "/repo",
      failing,
    ),
    /could not put the managed ignore blocks in place for \/repo.*unpaired managed block markers/,
  );
});

test("runEnsure: real script outcomes (skipped, updated, refused) and timeout", async () => {
  const plain = tmpDir();
  const skipped = await runEnsure(plain);
  assert.equal(skipped.ok, true);
  assert.match(skipped.output, /^skipped:/);

  const repo = tmpDir();
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: repo }).status, 0);
  const updated = await runEnsure(repo);
  assert.equal(updated.ok, true);
  assert.match(updated.output, /^updated: /);
  assert.equal(fs.existsSync(path.join(fs.realpathSync(repo), ".gitignore")), true);

  // An unterminated BEGIN in .ignore must refuse, and name the file.
  fs.writeFileSync(path.join(repo, ".ignore"), "# BEGIN oh-my-opencode-slim worktrees\n");
  const refused = await runEnsure(repo);
  assert.equal(refused.ok, false);
  assert.match(refused.output, /unpaired managed block markers/);
  assert.match(refused.output, /\.ignore/);

  const slow = await runEnsure(repo, 1);
  assert.equal(slow.ok, false);
  assert.match(slow.output, /timed out/);
});
