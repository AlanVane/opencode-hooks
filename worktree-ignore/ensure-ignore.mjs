#!/usr/bin/env node
// Upsert the managed worktree-ignore blocks into a repository root.
// Spec: docs/worktree-ignore-plan.md (component 1).
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BEGIN = "# BEGIN oh-my-opencode-slim worktrees";
export const END = "# END oh-my-opencode-slim worktrees";

export const GITIGNORE_BODY = [".slim/worktrees/", ".slim/worktrees.json"];
export const IGNORE_BODY = [
  "!.slim/",
  "!.slim/worktrees.json",
  "!.slim/worktrees/",
  "!.slim/worktrees/**",
];

const UNPAIRED = "unpaired managed block markers";
const SKIP_NOT_REPO = "not a git repository or git unavailable";
const SKIP_IN_LANE = "inside a lane";
const USAGE = "usage: ensure-ignore.mjs [--dir <path>] [--dry-run]";
const MAX_GIT_OUTPUT = 1024 * 1024;

/** Split a source string into a line model. A trailing "\n" becomes a flag. */
function splitSource(src) {
  if (src === null || src === "") {
    return { lines: [], trailing: true };
  }
  const parts = src.split("\n");
  let trailing = false;
  if (parts[parts.length - 1] === "") {
    parts.pop();
    trailing = true;
  }
  return { lines: parts, trailing };
}

/** Classify a line, comparing after stripping a trailing "\r" and trailing whitespace. */
function markerOf(line) {
  const trimmed = line.replace(/\s+$/, "");
  if (trimmed === BEGIN) return "begin";
  if (trimmed === END) return "end";
  return null;
}

function isBlank(line) {
  return line.trim() === "";
}

/** Locate complete managed blocks in order; throws when a marker is unpaired. */
function findBlocks(lines) {
  const blocks = [];
  let open = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const marker = markerOf(lines[i]);
    if (marker === "begin") {
      if (open !== -1) throw new Error(UNPAIRED);
      open = i;
    } else if (marker === "end") {
      if (open === -1) throw new Error(UNPAIRED);
      blocks.push({ start: open, end: i });
      open = -1;
    }
  }
  if (open !== -1) throw new Error(UNPAIRED);
  return blocks;
}

/**
 * Pure upsert. `src` is the current file content, or null when the file is
 * missing. Replaces the first complete managed block in place, drops any
 * duplicate blocks, or appends the canonical block.
 */
export function upsertBlock(src, bodyLines) {
  const { lines, trailing } = splitSource(src);
  const crlf = typeof src === "string" && src.includes("\r\n");
  const eol = crlf ? "\r" : "";
  const canonical = [BEGIN, ...bodyLines, END].map((line) => line + eol);
  const blocks = findBlocks(lines);
  // Lines are re-joined with "\n". An unterminated last line in a CRLF file
  // needs its "\r" now, or it would gain a bare "\n" on the next join.
  if (
    crlf &&
    !trailing &&
    lines.length > 0 &&
    !lines[lines.length - 1].endsWith("\r")
  ) {
    lines[lines.length - 1] += "\r";
  }

  let out;
  if (blocks.length === 0) {
    out = lines.slice();
    if (out.length > 0 && !isBlank(out[out.length - 1])) {
      out.push(eol);
    }
    out.push(...canonical);
  } else {
    out = [];
    let next = 0;
    for (let i = 0; i < lines.length; i += 1) {
      if (next < blocks.length && i === blocks[next].start) {
        if (next === 0) out.push(...canonical);
        i = blocks[next].end;
        next += 1;
      } else {
        out.push(lines[i]);
      }
    }
  }

  const text = out.join("\n");
  // Without a trailing newline the output must not end in a bare "\r".
  return trailing ? `${text}\n` : text.replace(/\r$/, "");
}

function errorWithPath(err, file) {
  if (err instanceof Error) {
    const wrapped = new Error(`${file}: ${err.message}`, { cause: err });
    if (err.code !== undefined) wrapped.code = err.code;
    return wrapped;
  }
  return new Error(`${file}: ${String(err)}`);
}

/** Write via a same-directory temp file + rename, following symlinks. */
function writeAtomic(file, content) {
  let target = file;
  let mode = null;
  try {
    const st = statSync(file);
    target = realpathSync(file);
    mode = st.mode & 0o7777;
  } catch (err) {
    if (err.code !== "ENOENT") throw errorWithPath(err, file);
  }

  const dir = path.dirname(target);
  const tmp = path.join(
    dir,
    `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );

  try {
    writeFileSync(tmp, content, {
      encoding: "utf8",
      mode: mode === null ? 0o666 : mode,
    });
    if (mode !== null) chmodSync(tmp, mode);
    renameSync(tmp, target);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // Best effort cleanup; the original error is what matters.
    }
    throw errorWithPath(err, target);
  }
}

function gitEnv() {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  return env;
}

function findToplevel(dir) {
  let res;
  try {
    res = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      timeout: 3000,
      env: gitEnv(),
      maxBuffer: MAX_GIT_OUTPUT,
    });
  } catch {
    return null;
  }
  if (!res || res.error || res.status !== 0) return null;
  const toplevel = (res.stdout ?? "").trim();
  return toplevel === "" ? null : path.resolve(toplevel);
}

/**
 * Ensure the managed blocks exist in `<toplevel>/.gitignore` and
 * `<toplevel>/.ignore`.
 */
export function ensureIgnore({ dir = process.cwd(), dryRun = false } = {}) {
  const startDir = path.resolve(dir);
  const toplevel = findToplevel(startDir);
  if (toplevel === null) {
    return { status: "skipped", reason: SKIP_NOT_REPO, changed: [] };
  }

  const normalized = toplevel.split(path.sep).join("/");
  if (normalized.includes("/.slim/worktrees/")) {
    return {
      status: "skipped",
      reason: SKIP_IN_LANE,
      toplevel,
      changed: [],
    };
  }

  const targets = [
    [".gitignore", GITIGNORE_BODY],
    [".ignore", IGNORE_BODY],
  ];
  const changed = [];

  for (const [name, body] of targets) {
    const file = path.join(toplevel, name);

    let current = null;
    let exists = false;
    try {
      current = readFileSync(file, "utf8");
      exists = true;
    } catch (err) {
      if (err.code !== "ENOENT") throw errorWithPath(err, file);
    }

    let next;
    try {
      next = upsertBlock(current, body);
    } catch (err) {
      throw errorWithPath(err, file);
    }

    if (exists && next === current) continue;
    if (!dryRun) writeAtomic(file, next);
    changed.push(file);
  }

  return {
    status: changed.length > 0 ? "updated" : "unchanged",
    toplevel,
    changed,
  };
}

class UsageError extends Error {}

function parseArgs(argv) {
  let dir = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--dir") {
      const value = argv[i + 1];
      if (value === undefined) throw new UsageError("missing value for --dir");
      dir = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--dir=") && arg.length > "--dir=".length) {
      dir = arg.slice("--dir=".length);
      continue;
    }
    throw new UsageError(`unknown argument: ${arg}`);
  }
  return { dir: dir === null ? process.cwd() : dir, dryRun };
}

function report(res) {
  if (res.status === "updated") {
    process.stdout.write(`updated: ${res.changed.join(",")}\n`);
  } else if (res.status === "skipped") {
    process.stdout.write(`skipped: ${res.reason}\n`);
  } else {
    process.stdout.write("unchanged\n");
  }
}

function run(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`ensure-ignore: ${err.message}\n${USAGE}\n`);
    return 1;
  }

  try {
    report(ensureIgnore(options));
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`ensure-ignore: ${message}\n`);
    return 1;
  }
}

function invokedDirectly() {
  const arg = process.argv[1];
  if (!arg) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(arg) === realpathSync(modulePath);
  } catch {
    return arg === modulePath;
  }
}

if (invokedDirectly()) {
  process.exitCode = run(process.argv.slice(2));
}
