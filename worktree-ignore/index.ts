/**
 * worktree-ignore (OpenCode V2 plugin).
 *
 * Before a git worktree is created (`git worktree add` in a shell call, or a
 * worktree_* tool), makes sure the repo root carries the managed `.gitignore`
 * and `.ignore` blocks, so the new lane stays out of git status and stays
 * searchable. Logic lives in ./gate.mjs; design in docs/worktree-ignore-plan.md.
 */
import { Plugin } from "@opencode/plugin";
import { enforceLaneIgnore } from "./gate.mjs";

export default Plugin.define({
  id: "worktree-ignore",
  async setup(ctx) {
    await ctx.tool.hook("execute.before", async (event) => {
      // Throws to refuse the tool call when the blocks cannot be confirmed.
      const summary = await enforceLaneIgnore(event, ctx.location.directory);
      if (summary) console.error(`[worktree-ignore] ${summary}`);
    });
  },
});
