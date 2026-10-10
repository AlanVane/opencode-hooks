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
 * Mapping (see docs/opencode-port-feasibility.md §2):
 *   permission.hook("evaluate")  <- PreToolUse (deny/ask channel)
 *   tool.hook("execute.after")   <- PostToolUse (fire-and-forget recorders)
 *
 * P0 validation status (docs/p0-validation-results.md, 2026-10-10):
 *   R2 confirmed: permission evaluate fires for every tool call under the
 *     default allow policy; shell resources carry the raw command text;
 *     flipping effect to deny/ask hard-blocks with the message fed back.
 *   R1 confirmed: throwing in execute.before blocks the tool and the error
 *     message reaches the model — wire that channel next for content-level
 *     guards (protect-tests new_string checks etc).
 *   R3 partial: throwing in the prompt hook blocks admission, but the client
 *     only sees a 500; combine with prompt-text rewrite when a visible
 *     rejection reason matters.
 */
import { Plugin } from "@opencode/plugin"
import { spawn } from "node:child_process"
import { join } from "node:path"

// --- Claude Code tool_name mapping from OpenCode permission actions ---------
// resource semantics: shell -> command text, read/edit -> target path
const ACTION_TO_TOOL: Record<string, string> = {
  shell: "Bash",
  read: "Read",
  edit: "Edit", // covers edit/write/patch; guards treat Edit+Write the same
  grep: "Grep",
  glob: "Glob",
  subagent: "Task", // subagent-spawn-cap matches Agent|Task
}

interface GuardConfig {
  /** script path relative to the repo's plugins/ dir, e.g. "block-dangerous-commands/block-dangerous-commands.js" */
  script: string
  /** OpenCode permission actions this guard cares about */
  actions: string[]
  /** extra env for the script (HOOK_SAFETY_LEVEL, HOOK_ASK_*, ...) */
  env?: Record<string, string>
}

const DEFAULT_GUARDS: GuardConfig[] = [
  { script: "block-dangerous-commands/block-dangerous-commands.js", actions: ["shell"] },
  { script: "git-safety/git-safety.js", actions: ["shell"] },
  { script: "protect-secrets/protect-secrets.js", actions: ["shell", "read", "edit", "grep"] },
  { script: "config-guard/config-guard.js", actions: ["shell", "edit"] },
  // R1 confirmed (p0-validation-results.md): execute.before can block by
  // throwing, and sees full input — content-level checks move to the
  // execute.before channel once wired; path-level shell checks already work here.
  { script: "protect-tests/protect-tests.js", actions: ["shell", "edit"] },
  { script: "subagent-spawn-cap/subagent-spawn-cap.js", actions: ["subagent"] },
]

interface ClaudeHookResult {
  permissionDecision?: "allow" | "ask" | "deny"
  permissionDecisionReason?: string
}

/** Run one guard script with a Claude Code shaped payload; fail-open like upstream. */
function runGuard(
  scriptPath: string,
  payload: Record<string, unknown>,
  env: Record<string, string> = {},
): Promise<ClaudeHookResult | null> {
  return new Promise((resolve) => {
    let out = ""
    const child = spawn(process.execPath, [scriptPath], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    })
    child.stdout.on("data", (d) => (out += d))
    // upstream guards print the reason to stderr on exit 2; capture but the
    // stdout decision is authoritative
    child.stderr.on("data", () => {})
    child.on("error", () => resolve(null)) // fail-open, same as upstream catch
    child.on("close", (code) => {
      if (code === 2) {
        // exit-2 guards (config-watch style) block without stdout JSON
        resolve({ permissionDecision: "deny", permissionDecisionReason: `guard blocked (exit 2): ${scriptPath}` })
        return
      }
      try {
        resolve(JSON.parse(out || "{}"))
      } catch {
        resolve(null) // malformed output -> fail-open (upstream behavior)
      }
    })
    child.stdin.end(JSON.stringify(payload))
  })
}

export default Plugin.define({
  id: "claude-code-hooks.adapter",
  async setup(ctx) {
    const repoRoot = join(ctx.location.directory)
    const guards = DEFAULT_GUARDS // TODO: accept ctx.options.guards

    await ctx.permission.hook("evaluate", async (event) => {
      // R2 validation point: log every evaluation to confirm coverage
      for (const guard of guards) {
        if (!guard.actions.includes(event.action)) continue
        const toolName = ACTION_TO_TOOL[event.action]
        if (!toolName) continue

        // Build the Claude Code PreToolUse payload from the permission event.
        const payload = {
          hook_event_name: "PreToolUse",
          tool_name: toolName,
          tool_input:
            event.action === "shell"
              ? { command: event.resources[0] }
              : { file_path: event.resources[0] },
          session_id: event.sessionID,
          cwd: repoRoot,
          permission_mode: event.effect,
        }

        const result = await runGuard(join(repoRoot, "plugins", guard.script), payload, guard.env)
        const decision = result?.hookSpecificOutput?.permissionDecision
          ?? (result as ClaudeHookResult | null)?.permissionDecision
        const reason = result?.hookSpecificOutput?.permissionDecisionReason
          ?? (result as ClaudeHookResult | null)?.permissionDecisionReason

        if (decision === "deny") {
          event.effect = "deny"
          event.message = reason
          return // first blocking verdict wins (guard-pack semantics)
        }
        if (decision === "ask" && event.effect !== "deny") {
          event.effect = "ask"
          event.message = reason
          // keep scanning: a later guard may still hard-deny
        }
      }
    })

    // PostToolUse recorders (auto-stage, format-code, ...) wire in here later:
    // ctx.tool.hook("execute.after", ...) -> runGuard with PostToolUse payload,
    // fire-and-forget.
  },
})
