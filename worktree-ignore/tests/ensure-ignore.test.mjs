import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  BEGIN,
  END,
  GITIGNORE_BODY,
  IGNORE_BODY,
  ensureIgnore,
  upsertBlock,
} from "../ensure-ignore.mjs";

const SCRIPT = fileURLToPath(new URL("../ensure-ignore.mjs", import.meta.url));
const created = [];

function cleanEnv() {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  return env;
}

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wi-"));
  created.push(dir);
  return dir;
}

function git(args, cwd) {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: cleanEnv(),
  });
  if (res.error || res.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${res.status ?? "no status"}): ${res.stderr || res.error}`,
    );
  }
  return res;
}

function makeRepo() {
  const dir = tmpDir();
  git(["init", "-q"], dir);
  git(
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    ],
    dir,
  );
  return dir;
}

function addLane(dir, name = "t") {
  git(["worktree", "add", "-q", `.slim/worktrees/${name}`, "-b", `omos/${name}`, "HEAD"], dir);
  return path.join(fs.realpathSync(dir), ".slim/worktrees", name);
}

const root = (dir) => fs.realpathSync(dir);
const canon = (body) => `${[BEGIN, ...body, END].join("\n")}\n`;

after(() => {
  for (const dir of created) {
    try {
      fs.chmodSync(dir, 0o755);
    } catch {
      // Directory may have been removed or chmod may not apply.
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup of temp fixtures.
    }
  }
});

test("T1 fresh repo creates both files with canonical content", () => {
  const dir = makeRepo();
  const res = ensureIgnore({ dir });

  assert.equal(res.status, "updated");
  assert.equal(typeof res.toplevel, "string");
  assert.deepEqual(res.changed, [
    path.join(res.toplevel, ".gitignore"),
    path.join(res.toplevel, ".ignore"),
  ]);
  for (const file of res.changed) assert.ok(path.isAbsolute(file));

  assert.equal(
    fs.readFileSync(path.join(res.toplevel, ".gitignore"), "utf8"),
    canon(GITIGNORE_BODY),
  );
  assert.equal(
    fs.readFileSync(path.join(res.toplevel, ".ignore"), "utf8"),
    canon(IGNORE_BODY),
  );
});

test("T2 correct blocks are left alone (no write, mtime preserved)", () => {
  const dir = makeRepo();
  const first = ensureIgnore({ dir });
  assert.equal(first.status, "updated");

  const old = new Date(Math.floor(Date.now() / 1000) * 1000 - 3_600_000);
  const files = [path.join(first.toplevel, ".gitignore"), path.join(first.toplevel, ".ignore")];
  const contents = files.map((file) => fs.readFileSync(file));

  for (const file of files) fs.utimesSync(file, old, old);

  const res = ensureIgnore({ dir });
  assert.equal(res.status, "unchanged");
  assert.deepEqual(res.changed, []);

  files.forEach((file, index) => {
    assert.deepEqual(fs.readFileSync(file), contents[index]);
    assert.equal(Math.trunc(fs.statSync(file).mtimeMs), old.getTime());
  });
});

test("T3 stale block is replaced in place; surrounding rules untouched", () => {
  const dir = makeRepo();
  const file = path.join(root(dir), ".gitignore");
  const original = `${[
    "# user top",
    "dist/",
    BEGIN,
    ".slim/worktrees-legacy/",
    ".slim/other",
    END,
    "!keep",
  ].join("\n")}\n`;
  fs.writeFileSync(file, original);

  const res = ensureIgnore({ dir });
  assert.equal(res.status, "updated");

  const expected = `${[
    "# user top",
    "dist/",
    BEGIN,
    ...GITIGNORE_BODY,
    END,
    "!keep",
  ].join("\n")}\n`;
  assert.equal(fs.readFileSync(file, "utf8"), expected);
  assert.ok(!fs.readFileSync(file, "utf8").includes("worktrees-legacy"));
});

test("T4 CRLF file without trailing newline keeps bytes, uses CRLF, adds no newline", () => {
  const dir = makeRepo();
  const file = path.join(root(dir), ".gitignore");
  fs.writeFileSync(file, "node_modules/\r\nfoo.txt");

  const res = ensureIgnore({ dir });
  assert.equal(res.status, "updated");

  assert.equal(
    fs.readFileSync(file, "utf8"),
    `node_modules/\r\nfoo.txt\r\n\r\n${[BEGIN, ...GITIGNORE_BODY, END].join("\r\n")}`,
  );
  assert.equal(ensureIgnore({ dir }).status, "unchanged");
});

test("T5 non-git directory is skipped and nothing is created", () => {
  const dir = tmpDir();
  const res = ensureIgnore({ dir });

  assert.equal(res.status, "skipped");
  assert.equal(res.reason, "not a git repository or git unavailable");
  assert.deepEqual(res.changed, []);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("T6 directory inside a lane is skipped and left untouched", () => {
  const dir = makeRepo();
  const lane = addLane(dir);
  const laneIgnore = path.join(lane, ".gitignore");
  fs.writeFileSync(laneIgnore, "# lane rules\nlane.tmp\n");
  const before = fs.readFileSync(laneIgnore);

  const res = ensureIgnore({ dir: lane });
  assert.equal(res.status, "skipped");
  assert.equal(res.reason, "inside a lane");
  assert.deepEqual(fs.readFileSync(laneIgnore), before);
  assert.ok(!fs.existsSync(path.join(root(dir), ".gitignore")));
  assert.ok(!fs.existsSync(path.join(root(dir), ".ignore")));
});

test("T7 a second run after an update reports unchanged", () => {
  const dir = makeRepo();
  assert.equal(ensureIgnore({ dir }).status, "updated");

  const res = ensureIgnore({ dir });
  assert.equal(res.status, "unchanged");
  assert.deepEqual(res.changed, []);
});

test("T8 duplicate blocks collapse to one at the first position", () => {
  const dir = makeRepo();
  const file = path.join(root(dir), ".gitignore");
  const original = `${[
    "a",
    BEGIN,
    ".old-one",
    END,
    "b",
    BEGIN,
    ".old-two",
    END,
    "c",
  ].join("\n")}\n`;
  fs.writeFileSync(file, original);

  const res = ensureIgnore({ dir });
  assert.equal(res.status, "updated");

  const expected = `${["a", BEGIN, ...GITIGNORE_BODY, END, "b", "c"].join("\n")}\n`;
  assert.equal(fs.readFileSync(file, "utf8"), expected);
});

test("T9 unpaired markers reject and leave the file byte-identical", () => {
  const dir = makeRepo();
  const file = path.join(root(dir), ".gitignore");

  const beginOnly = `${BEGIN}\n.slim/worktrees/\n`;
  fs.writeFileSync(file, beginOnly);
  assert.throws(
    () => ensureIgnore({ dir }),
    (err) => /unpaired/.test(err.message) && err.message.includes(".gitignore"),
  );
  assert.equal(fs.readFileSync(file, "utf8"), beginOnly);
  assert.ok(!fs.existsSync(path.join(root(dir), ".ignore")));

  const endOnly = `dist/\n${END}\n`;
  fs.writeFileSync(file, endOnly);
  assert.throws(
    () => ensureIgnore({ dir }),
    (err) => /unpaired/.test(err.message) && err.message.includes(".gitignore"),
  );
  assert.equal(fs.readFileSync(file, "utf8"), endOnly);
  assert.ok(!fs.existsSync(path.join(root(dir), ".ignore")));
});

test("T10 symlinked .gitignore updates the target and stays a symlink", () => {
  const dir = makeRepo();
  const target = path.join(root(dir), "real-ignore.txt");
  const link = path.join(root(dir), ".gitignore");
  fs.writeFileSync(target, "dist/\n");
  fs.symlinkSync("real-ignore.txt", link);

  const res = ensureIgnore({ dir });
  assert.equal(res.status, "updated");

  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(
    fs.readFileSync(target, "utf8"),
    `${["dist/", "", BEGIN, ...GITIGNORE_BODY, END].join("\n")}\n`,
  );
});

test(
  "T11 unwritable repo root throws instead of silently succeeding",
  { skip: process.getuid?.() === 0 },
  () => {
    const dir = makeRepo();
    fs.chmodSync(dir, 0o555);
    try {
      assert.throws(() => ensureIgnore({ dir }), /EACCES/);
      assert.ok(!fs.existsSync(path.join(root(dir), ".gitignore")));
    } finally {
      fs.chmodSync(dir, 0o755);
    }
  },
);

const hasRg = spawnSync("rg", ["--version"], { encoding: "utf8" }).status === 0;

test("T12 .ignore whitelist makes lane files visible to rg and git stays clean", { skip: !hasRg }, () => {
  const dir = makeRepo();
  assert.equal(ensureIgnore({ dir }).status, "updated");

  const lane = addLane(dir);
  fs.writeFileSync(path.join(lane, "probe.txt"), "probe\n");

  const rg = spawnSync("rg", ["--files", "--no-messages", "."], {
    cwd: dir,
    encoding: "utf8",
    env: cleanEnv(),
  });
  assert.equal(rg.status, 0, rg.stderr);
  assert.ok(
    rg.stdout.split("\n").includes("./.slim/worktrees/t/probe.txt"),
    rg.stdout,
  );

  const status = git(["status", "--porcelain"], dir).stdout;
  assert.deepEqual(
    status.split("\n").filter((line) => line.includes(".slim")),
    [],
    status,
  );
});

test("T13 CLI contract: skipped, usage error, updated", () => {
  const nonGit = tmpDir();
  const skipped = spawnSync(process.execPath, [SCRIPT, "--dir", nonGit], {
    encoding: "utf8",
    env: cleanEnv(),
  });
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.equal(skipped.stderr, "");
  assert.ok(skipped.stdout.startsWith("skipped:"), skipped.stdout);
  assert.equal(skipped.stdout.trimEnd().split("\n").length, 1);

  const bogus = spawnSync(process.execPath, [SCRIPT, "--bogus"], {
    encoding: "utf8",
    env: cleanEnv(),
  });
  assert.equal(bogus.status, 1);
  assert.match(bogus.stderr, /usage:/);

  const repo = makeRepo();
  const updated = spawnSync(process.execPath, [SCRIPT, "--dir", repo], {
    encoding: "utf8",
    env: cleanEnv(),
  });
  assert.equal(updated.status, 0, updated.stderr);
  assert.ok(updated.stdout.startsWith("updated:"), updated.stdout);
  assert.equal(updated.stdout.trimEnd().split("\n").length, 1);
  assert.ok(updated.stdout.includes(path.join(root(repo), ".gitignore")));

  const again = spawnSync(process.execPath, [SCRIPT, "--dir", repo], {
    encoding: "utf8",
    env: cleanEnv(),
  });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout, "unchanged\n");
});

test("upsertBlock is pure and throws on unpaired markers", () => {
  assert.equal(ensureIgnore({ dir: tmpDir() }).status, "skipped");

  const fresh = upsertBlock(null, GITIGNORE_BODY);
  assert.equal(fresh, canon(GITIGNORE_BODY));

  const empty = upsertBlock("", GITIGNORE_BODY);
  assert.equal(empty, canon(GITIGNORE_BODY));

  const noTrailing = upsertBlock("a", ["x"]);
  assert.equal(noTrailing, `a\n\n${[BEGIN, "x", END].join("\n")}`);
  assert.ok(!noTrailing.endsWith("\n"));

  assert.throws(() => upsertBlock(`${BEGIN}\n`, []), /^Error: unpaired managed block markers$/);
  assert.throws(() => upsertBlock(`${END}\n`, []), /^Error: unpaired managed block markers$/);
});
