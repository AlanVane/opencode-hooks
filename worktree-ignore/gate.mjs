// Lane-creation gate for the worktree-ignore OpenCode plugin.
// Decides whether a tool call creates a git worktree and, if it does, makes
// sure the managed ignore blocks are in place before the call may run.
// index.ts wires enforceLaneIgnore into the execute.before hook.
import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ENSURE_SCRIPT = fileURLToPath(
  new URL("./ensure-ignore.mjs", import.meta.url),
);

// The request gates the worktree on the blocks being in place, so a failed
// check refuses the tool call. docs/worktree-ignore-plan.md originally said
// fail-open; set this to false to log and continue instead.
export const FAIL_CLOSED = true;

const ENSURE_TIMEOUT_MS = 15_000;
const SHELL_TOOLS = new Set(["shell", "bash"]);
const LANE_TOOL = /worktree_(?:create|add)/;
// `git [-C <dir>] [-c k=v] worktree add`, matched anywhere in the command text.
const WORKTREE_ADD = /\bgit(?:\s+-[Cc]\s+\S+)*\s+worktree\s+add\b/;
const CD_TARGET = /(?:^|[\s;&|(])cd\s+("[^"]*"|'[^']*'|[^\s;&|()]+)/g;
const GIT_C_TARGET = /\bgit\s+-C\s+("[^"]*"|'[^']*'|[^\s;&|()]+)/g;

const unquote = (token) => token.replace(/^(["'])(.*)\1$/, "$2");
const expandHome = (p) =>
  p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
const resolveFrom = (base, token) =>
  resolve(base, expandHome(unquote(token)));
const isNonEmptyString = (value) =>
  typeof value === "string" && value.trim() !== "";

/** True when the call creates a worktree: `git worktree add` in a shell call, or a worktree_* tool. */
export function isLaneCreation(tool, input) {
  if (typeof tool !== "string") return false;
  if (LANE_TOOL.test(tool)) return true;
  const base = tool.slice(tool.lastIndexOf(".") + 1);
  return (
    SHELL_TOOLS.has(base) &&
    typeof input?.command === "string" &&
    WORKTREE_ADD.test(input.command)
  );
}

/**
 * Directories whose repository the call may create a worktree in. Defaults to
 * the tool's workdir (or the session directory). Explicit `cd <dir>` or
 * `git -C <dir>` targets in the command replace that default.
 */
export function laneTargetDirs(input, sessionDir) {
  const workdir = isNonEmptyString(input?.workdir)
    ? resolveFrom(sessionDir, input.workdir.trim())
    : sessionDir;
  const command = typeof input?.command === "string" ? input.command : "";
  const explicit = [
    ...command.matchAll(CD_TARGET),
    ...command.matchAll(GIT_C_TARGET),
  ].map((match) => resolveFrom(workdir, match[1]));
  return explicit.length > 0 ? [...new Set(explicit)] : [workdir];
}

// OpenCode runs plugins under Bun, where process.execPath is the opencode
// binary itself, so resolve a real node from PATH.
function nodeBin() {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, "node");
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // not in this PATH entry, keep looking
    }
  }
  return "node";
}

/** Run ensure-ignore.mjs for one directory. Always resolves, never rejects. */
export function runEnsure(dir, timeoutMs = ENSURE_TIMEOUT_MS) {
  return new Promise((done) => {
    let stdout = "";
    let stderr = "";
    let timer;
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(result);
    };
    const child = spawn(nodeBin(), [ENSURE_SCRIPT, "--dir", dir], {
      cwd: homedir(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle({ ok: false, output: `timed out after ${timeoutMs} ms` });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (err) =>
      settle({ ok: false, output: `could not start ensure-ignore: ${err.message}` }),
    );
    child.on("close", (code) =>
      settle(
        code === 0
          ? { ok: true, output: stdout.trim() }
          : { ok: false, output: stderr.trim() || stdout.trim() || `exit ${code}` },
      ),
    );
  });
}

/**
 * Gate for one tool call. Returns null when the call does not create a
 * worktree. Otherwise checks every target repository and returns a log
 * summary. Throws when a check fails and FAIL_CLOSED is set, which refuses
 * the call.
 */
export async function enforceLaneIgnore(event, sessionDir, run = runEnsure) {
  if (!isLaneCreation(event?.tool, event?.input)) return null;
  const summaries = [];
  for (const dir of laneTargetDirs(event.input, sessionDir)) {
    const result = await run(dir);
    if (result.ok) {
      summaries.push(`${dir}: ${result.output}`);
    } else if (FAIL_CLOSED) {
      throw new Error(
        `worktree-ignore: could not put the managed ignore blocks in place for ${dir}, so the worktree was not created (${result.output}). Fix the problem and retry.`,
      );
    } else {
      summaries.push(`${dir}: ${result.output} (fail-open: continuing)`);
    }
  }
  return summaries.join(" | ");
}
