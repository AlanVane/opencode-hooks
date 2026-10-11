/**
 * opencode-hooks adapter (feasibility report, plan A).
 *
 * Bridges OpenCode V2 permission/tool events to the unmodified guard scripts
 * in ../plugins/, speaking the Claude Code hook JSON protocol:
 *
 *   stdin:  { hook_event_name, tool_name, tool_input, session_id, cwd, ... }
 *   stdout: { hookSpecificOutput: { permissionDecision, permissionDecisionReason } }
 *   exit 2: block (stderr carries the reason)
 *
 * Three channels, validated by the P0 experiments + e2e runs
 * (docs/p0-validation-results.md):
 *
 *   1. permission.hook("evaluate")  <- shell/read/grep/glob/subagent actions.
 *      R2-validated: fires for every call under default allow rules; the
 *      resource IS the command text (shell) or the path (read); flipping
 *      effect to deny/ask hard-blocks with `message` fed back to the model.
 *
 *   2. tool.hook("execute.before")  <- edit/write/patch actions, which carry
 *      the FULL input (old_string/new_string/content) the permission channel
 *      does not expose. R1-validated: throwing blocks the tool and the error
 *      message reaches the model. Caveat: no "ask" in this channel — an ask
 *      verdict degrades to deny (throw). Guards that need ask-on-edit keep
 *      their shell-side ask via channel 1.
 *
 *   3. tool.hook("execute.after")   <- PostToolUse recorders/effects
 *      (auto-stage, format-code), fire-and-forget like upstream "async":true.
 *
 * A startup self-check probes every script once (see probeGuards): guards fail
 * open by design, so a broken spawn must not be silent.
 *
 * Each (guard, action) pair runs on exactly one channel to avoid double
 * execution: file-mutation actions go to channel 2, everything else channel 1.
 *
 * Fail-open, matching upstream: script error / malformed output -> pass.
 */
import { Plugin } from "@opencode/plugin";
import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// OpenCode plugins run inside the Bun host, where process.execPath is the
// opencode binary itself — spawning it with a script path re-enters the
// opencode CLI and fails (ENOTDIR). Resolve a real node from PATH instead.
function nodeBin(): string {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    try {
      const candidate = join(dir, "node");
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {}
  }
  return "node"; // last resort: let spawn resolve via PATH
}

// Guard scripts live next to the adapter in this repo, not in the target project.
const PLUGINS_DIR = fileURLToPath(new URL("../plugins", import.meta.url));

// --- Claude Code tool_name mapping ------------------------------------------
// Channel 1 (permission action -> Claude Code tool name)
const ACTION_TO_TOOL: Record<string, string> = {
  shell: "Bash",
  read: "Read",
  grep: "Grep",
  glob: "Glob",
  subagent: "Task", // subagent-spawn-cap matches Agent|Task
};
// Channel 2 (OpenCode tool id -> Claude Code tool name + input reshaper)
const TOOL_CHANNEL: Record<
  string,
  { toolName: string; reshape: (input: any) => any }
> = {
  edit: {
    toolName: "Edit",
    reshape: (i) => ({
      file_path: i.path,
      old_string: i.oldString,
      new_string: i.newString,
      replace_all: i.replaceAll,
    }),
  },
  write: {
    toolName: "Write",
    reshape: (i) => ({ file_path: i.path, content: i.content }),
  },
  // patch merges several mutations; guards see it as a Write of the combined text
  patch: {
    toolName: "Write",
    reshape: (i) => ({ file_path: "(patch)", content: i.patchText }),
  },
};

interface GuardConfig {
  /** script path relative to this repo's plugins/ dir */
  script: string;
  /** channel 1: permission actions; channel 2: tool ids */
  actions: string[];
  env?: Record<string, string>;
}

// Guards whose file-mutation checks run with full input (channel 2):
const TOOL_CHANNEL_GUARDS: GuardConfig[] = [
  {
    script: "config-guard/config-guard.js",
    actions: ["edit", "write", "patch"],
  },
  {
    script: "protect-tests/protect-tests.js",
    actions: ["edit", "write", "patch"],
  },
  {
    script: "protect-secrets/protect-secrets.js",
    actions: ["edit", "write", "patch"],
  },
];
// Everything else sees command text / paths (channel 1):
const PERMISSION_GUARDS: GuardConfig[] = [
  {
    script: "block-dangerous-commands/block-dangerous-commands.js",
    actions: ["shell"],
  },
  { script: "git-safety/git-safety.js", actions: ["shell"] },
  {
    script: "case-insensitive-guard/case-insensitive-guard.js",
    actions: ["shell"],
  },
  {
    script: "protect-secrets/protect-secrets.js",
    actions: ["shell", "read", "grep"],
  },
  { script: "config-guard/config-guard.js", actions: ["shell"] },
  { script: "protect-tests/protect-tests.js", actions: ["shell"] },
  { script: "subagent-spawn-cap/subagent-spawn-cap.js", actions: ["subagent"] },
];
// Channel 3: PostToolUse recorders/effects — fire-and-forget, no verdict.
// Only file_path is needed by both scripts today (upstream payloads for
// Bash/Read variants can be added when other recorders are ported).
const POST_TOOL_GUARDS: GuardConfig[] = [
  { script: "auto-stage/auto-stage.js", actions: ["edit", "write"] },
  { script: "format-code/format-code.js", actions: ["edit", "write"] },
];

// Every script the adapter may spawn — used by the startup self-check.
const ALL_SCRIPTS = [
  ...new Set(
    [...TOOL_CHANNEL_GUARDS, ...PERMISSION_GUARDS, ...POST_TOOL_GUARDS].map(
      (g) => g.script,
    ),
  ),
];

interface ClaudeHookResult {
  hookSpecificOutput?: {
    permissionDecision?: "allow" | "ask" | "deny";
    permissionDecisionReason?: string;
  };
  // legacy/inline shapes some upstream scripts emit
  permissionDecision?: "allow" | "ask" | "deny";
  permissionDecisionReason?: string;
}

interface Verdict {
  decision: "deny" | "ask" | null;
  reason?: string;
}

/** Run one guard script with a Claude Code shaped payload; fail-open like upstream. */
function runGuard(
  scriptPath: string,
  payload: Record<string, unknown>,
  env: Record<string, string> = {},
): Promise<Verdict> {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(nodeBin(), [scriptPath], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "ignore"],
      // git-safety shells out to git, which needs a repository cwd (may not
      // exist for synthetic payloads; the script handles its own fallbacks)
      cwd: typeof payload.cwd === "string" ? payload.cwd : process.env.HOME,
    });
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => resolve({ decision: null })); // fail-open
    child.on("close", (code) => {
      if (code === 2) {
        resolve({
          decision: "deny",
          reason: `guard blocked (exit 2): ${scriptPath}`,
        });
        return;
      }
      try {
        const parsed: ClaudeHookResult = JSON.parse(out || "{}");
        const decision =
          parsed.hookSpecificOutput?.permissionDecision ??
          parsed.permissionDecision ??
          null;
        const reason =
          parsed.hookSpecificOutput?.permissionDecisionReason ??
          parsed.permissionDecisionReason;
        resolve({
          decision: decision === "deny" || decision === "ask" ? decision : null,
          reason,
        });
      } catch {
        resolve({ decision: null }); // malformed output -> fail-open (upstream behavior)
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

/** First blocking verdict wins (guard-pack semantics); ask survives until a deny. */
function applyVerdict(
  event: { effect: string; message?: string },
  verdict: Verdict,
): boolean {
  if (verdict.decision === "deny") {
    event.effect = "deny";
    event.message = verdict.reason;
    return true;
  }
  if (verdict.decision === "ask" && event.effect !== "deny") {
    event.effect = "ask";
    event.message = verdict.reason;
  }
  return false;
}

/**
 * Startup self-check: every guard script must spawn and exit 0 on `{}` input.
 * Unlike runGuard this does NOT fail open — a spawn error or non-zero exit is
 * reported loudly, because a silently-broken guard is indistinguishable from a
 * guard that never fires (the Bun process.execPath incident in
 * docs/p0-validation-results.md). Returns the list of broken scripts.
 */
function probeGuards(scripts: string[]): Promise<string[]> {
  return new Promise((resolve) => {
    const broken: string[] = [];
    let pending = scripts.length;
    if (pending === 0) return resolve(broken);
    for (const script of scripts) {
      const scriptPath = join(PLUGINS_DIR, script);
      let spawned = false;
      let settled = false;
      const settle = (reason?: string) => {
        if (settled) return;
        settled = true;
        if (reason) broken.push(`${script} (${reason})`);
        if (--pending === 0) resolve(broken);
      };
      const child = spawn(nodeBin(), [scriptPath], {
        env: process.env,
        stdio: ["pipe", "ignore", "ignore"],
        cwd: process.env.HOME,
      });
      child.on("spawn", () => (spawned = true));
      child.on("error", () => settle("spawn failed"));
      child.on("close", (code) =>
        settle(spawned && code === 0 ? undefined : `exit ${code}`),
      );
      child.stdin.end("{}");
      // guard against a hung script stalling setup forever
      setTimeout(() => {
        if (!settled) {
          child.kill();
          settle("timeout");
        }
      }, 10_000).unref?.();
    }
  });
}

export default Plugin.define({
  id: "claude-code-hooks.adapter",
  async setup(ctx) {
    const cwd = ctx.location.directory;

    // --- Channel 1: permission evaluate (shell/read/grep/glob/subagent) -----
    await ctx.permission.hook("evaluate", async (event) => {
      const toolName = ACTION_TO_TOOL[event.action];
      if (!toolName) return;
      for (const guard of PERMISSION_GUARDS) {
        if (!guard.actions.includes(event.action)) continue;
        // Resources may hold several values (scanner-split compound commands):
        // build one payload per resource, first deny wins (any() semantics).
        for (const resource of event.resources) {
          const payload = {
            hook_event_name: "PreToolUse",
            tool_name: toolName,
            tool_input:
              event.action === "shell"
                ? { command: resource }
                : event.action === "grep"
                  ? { pattern: resource }
                  : { file_path: resource },
            session_id: event.sessionID,
            cwd,
          };
          const verdict = await runGuard(
            join(PLUGINS_DIR, guard.script),
            payload,
            guard.env,
          );
          if (applyVerdict(event, verdict)) return;
        }
      }
    });

    // --- Channel 2: tool execute.before (edit/write/patch, full input) ------
    await ctx.tool.hook("execute.before", async (event) => {
      const spec = TOOL_CHANNEL[event.tool];
      if (!spec) return;
      for (const guard of TOOL_CHANNEL_GUARDS) {
        if (!guard.actions.includes(event.tool)) continue;
        const payload = {
          hook_event_name: "PreToolUse",
          tool_name: spec.toolName,
          tool_input: spec.reshape(event.input),
          session_id: event.sessionID,
          cwd,
        };
        const verdict = await runGuard(
          join(PLUGINS_DIR, guard.script),
          payload,
          guard.env,
        );
        if (verdict.decision === "deny") {
          // R1-validated: throw blocks the tool; message reaches the model.
          // "ask" is not expressible here and also degrades to a throw.
          throw new Error(verdict.reason ?? `guard blocked: ${guard.script}`);
        }
      }
    });

    // --- Channel 3: tool execute.after (PostToolUse recorders/effects) ------
    // Fire-and-forget like upstream `"async": true`: logging/formatting must
    // never block the tool call. Both scripts only read file_path today.
    await ctx.tool.hook("execute.after", (event) => {
      if (event.status !== "completed") return;
      const spec = TOOL_CHANNEL[event.tool];
      if (!spec) return;
      for (const recorder of POST_TOOL_GUARDS) {
        if (!recorder.actions.includes(event.tool)) continue;
        const payload = {
          hook_event_name: "PostToolUse",
          tool_name: spec.toolName,
          tool_input: { file_path: (event.input as { path?: string })?.path },
          tool_response: { success: true },
          session_id: event.sessionID,
          cwd,
        };
        // deliberately not awaited: async recorder semantics
        void runGuard(
          join(PLUGINS_DIR, recorder.script),
          payload,
          recorder.env,
        );
      }
    });

    // --- Startup self-check (fail-loud, not fail-silent) --------------------
    // Guard scripts fail open by design, so a broken spawn (bad path, wrong
    // node, missing dep) would silently disable protection — exactly the
    // incident from the first e2e run (Bun process.execPath trap). Probe every
    // script once with `{}` at setup; all scripts exit 0 on empty input.
    void probeGuards(ALL_SCRIPTS).then((broken) => {
      if (broken.length > 0) {
        // console.error lands in the opencode server log; guards stay active
        // for the scripts that did pass, but the breakage is no longer silent.
        console.error(
          `[claude-code-hooks] SELF-CHECK FAILED — these guards will not run: ${broken.join(", ")}`,
        );
      } else {
        console.error(
          `[claude-code-hooks] self-check ok: ${ALL_SCRIPTS.length} guard scripts spawn and exit cleanly`,
        );
      }
    });
  },
});
