# worktree-ignore：自动写入 `.gitignore` / `.ignore` 的方案（待审）

**状态**：待审核，未实施
**起草日期**：2026-11-15
**目标仓库**：`oh-my-opencode-slim` 的 `worktrees` 技能使用方（任意 git 项目）

## 问题

`~/.config/opencode/skills/worktrees/SKILL.md` 第 3 节 "Ignore File Setup" 要求在每个项目根维护两个受管块：

```gitignore
# BEGIN oh-my-opencode-slim worktrees
.slim/worktrees/
.slim/worktrees.json
# END oh-my-opencode-slim worktrees
```

```ignore
# BEGIN oh-my-opencode-slim worktrees
!.slim/
!.slim/worktrees.json
!.slim/worktrees/
!.slim/worktrees/**
# END oh-my-opencode-slim worktrees
```

但**没有任何代码会写它们**，实测证据：

| 检查                                                                            | 结果                                                                    |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `grep -r "BEGIN oh-my-opencode-slim worktrees"` 于 `oh-my-opencode-slim` 8.x 包 | 仅命中 `src/skills/worktrees/SKILL.md`（纯 markdown）                   |
| `grep -oh "\.slim/[a-z]*"` 于 `dist/**/*.js`                                    | 只有 `.slim/deepwork`，无 `.slim/worktrees`                             |
| `grep -rn "worktree_"` 于 `dist/`                                               | 无实现                                                                  |
| 上游 `docs/worktrees.md`                                                        | 自述 "the skill writes no `.ignore` allowlist"，与 SKILL.md 第 3 节矛盾 |

后果：技能只在 Phase 1 第 4 步"提醒"模型去写，模型跳过就静默失效。现场对照 `formzero` 仓库：`.gitignore` 无受管块、无 `.ignore`、无 `.slim/`，即从未被写入过。

两个块的职责不能混淆，缺一即故障：

| 文件         | 消费方                       | 作用                                                         |
| ------------ | ---------------------------- | ------------------------------------------------------------ |
| `.gitignore` | git                          | lane 不进 `status`/`commit`                                  |
| `.ignore`    | ripgrep（OpenCode 搜索底层） | 把刚被 git 忽略的路径重新放行，否则 agent 搜不到 lane 内代码 |

补充事实：ripgrep **默认也读 git 的全局 excludes**（`~/.config/git/ignore`），且**没有用户级 `.ignore`**。所以"把规则放全局 git 配置"只能覆盖一半：git 干净了，但 `rg --files` 在 lane 目录里返回空。仓库级 `.ignore` 的白名单优先级高于全局 excludes，可修复（已实测，见附录 A）。

## 目标与非目标

**目标**

- 任意一次 lane 创建**之前**，仓库根两个块已就位；不依赖模型自觉。
- 幂等：重复触发不改内容、不动 mtime。
- 失败不阻断工具调用（fail-open，仅记日志）。
- 不触碰受管块以外的任何规则，不改全局 git 配置。

**非目标**

- 不接管 OpenCode 的 worktree 创建/删除逻辑（见"为什么不用 `ctx.worktree.transform`"）。
- 不修改 `oh-my-opencode-slim` 上游包；本仓库只产出插件与脚本。
- 不做自动 `git worktree remove` / 分支清理（SKILL 要求人工确认，保持）。

## 为什么不用现成机制

| 候选                                   | 结论                                                                                                                                                                               |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 技能加载时自动执行                     | ❌ 机制不存在。`@opencode/plugin/dist/effect/skill.d.ts` 中 `SkillDomain` 只有 `list/get/add/update/remove/transform/reload`，**无 onLoad/onUse**。技能是 markdown，加载即文本注入 |
| `oh-my-opencode-slim.json` 自定义 hook | ❌ `disabled_hooks` 是固定枚举（phase-reminder、apply-patch、tool-loop-guard…），无注册入口                                                                                        |
| git alias / `git worktree` 包装        | ❌ 技能执行的是裸 `git worktree add`，别名不生效                                                                                                                                   |
| AGENTS.md 里写"记得加"                 | ❌ 就是现状                                                                                                                                                                        |
| 全局 `~/.config/git/ignore`            | ⚠️ 只覆盖 git 侧；`.ignore` 白名单无法全局化（ripgrep 无用户级 `.ignore`）                                                                                                         |
| 技能 sidecar 脚本                      | ⚠️ 可行但半自动（仍需模型执行），仅作为插件之外的冗余入口（见"可选：skill 侧接入"）                                                                                                |

## 方案 A（推荐）：插件 + 共享 upsert 脚本

### 目录结构

```
opencode-hooks/
├── worktree-ignore/
│   ├── ensure-ignore.mjs   # 唯一的 upsert 实现（幂等、原子写）
│   ├── index.ts            # V2 插件：在 lane 创建前调用脚本
│   └── package.json        # 同 adapter：type=module、exports ./index.ts、dep @opencode/plugin
└── docs/worktree-ignore-plan.md
```

安装（与本仓库现有 `adapter` 一致，用软链，不写全局配置）：

```bash
ln -s /home/alecshan/projects/ai-coding/opencode-hooks/worktree-ignore \
      ~/.config/opencode/plugins/worktree-ignore
```

### 组件 1：`ensure-ignore.mjs`

CLI 契约：

```bash
node ensure-ignore.mjs [--dir <path>] [--dry-run]   # 退出码 0=成功/无需变更，1=内部错误
```

算法：

1. `git -C <dir> rev-parse --show-toplevel`（spawn，3s 超时）→ 失败即 `exit 0`（非 git 仓库，静默跳过）。
2. 若 toplevel 路径包含 `/.slim/worktrees/` → `exit 0`（**已在 lane 内部，禁止写 lane 自己的忽略文件**）。
3. 对 `.gitignore`、`.ignore` 各执行一次 upsert：
   - 命中 `# BEGIN oh-my-opencode-slim worktrees` … `# END oh-my-opencode-slim worktrees` → **就地替换**块内内容；
   - 无块 → 追加（前置一个空行）；
   - 文件不存在 → 创建；
   - 保留原换行风格（LF/CRLF）、保留文件末尾换行状态。
4. 目标内容与现状逐字节相同 → **不写盘**（保 mtime，避免 watcher/formatter 抖动）。
5. 写入走 `写临时文件 + rename`（同目录），避免半截文件。
6. 有实际写入时向 stdout 打一行 `updated <toplevel>/.gitignore,.ignore`；插件把它转成 `console.error`（进 server log，不进对话）。

### 组件 2：`index.ts`（V2 插件）

```ts
export default Plugin.define({
  id: "worktree-ignore",
  async setup(ctx) {
    await ctx.tool.hook("execute.before", async (event) => {
      /* … */
    });
  },
});
```

触发条件（`execute.before` 内先做纯正则判断，无 I/O，未命中即 return）：

| 条件                                                                                  | 说明                                                     |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `event.tool` 含 `worktree_create`/`worktree_add`                                      | 覆盖插件工具路径（名字可能带命名空间，用 contains 匹配） |
| `event.tool` 是 `bash`/`shell` 且 `event.input.command` 匹配 `git\s+worktree\s+add\b` | **技能实际走这条路**（Phase 1 第 5 步）                  |

命中后 `await` spawn `ensure-ignore.mjs --dir ctx.location.directory`；任何异常/非零退出只 `console.error`，从不 `throw`（不能因为忽略文件失败挡住建 lane）。

**不实现** `git worktree remove` / `prune` 的触发（待决事项 2）。

### 写入内容（canonical，脚本内置常量）

即本文开头两段，逐字节固定；受管块外一律不动。

### 为什么不用 `ctx.worktree.transform`

`worktree.d.ts` 里 `WorktreeDefinition` 要求自行实现 `create/remove/list`，`WorktreeEditor.add()` 会**把实现注册为默认**（"later active registrations win"）。等于接管 OpenCode 的 lane 逻辑，需要复刻分支命名、路径冲突、错误语义；收益只是把触发点从"工具调用前"提前到"工具实现内"，风险明显大于收益。故不采用。

### 可选：skill 侧接入（半自动冗余入口）

给 `~/.config/opencode/skills/worktrees/scripts/ensure-ignore.mjs` 建软链指向同一文件，并把 SKILL.md Phase 1 第 4 步改成"运行该脚本"。收益：模型不必手拼内容；代价：仍需模型执行，不满足"全自动"。与插件共用同一实现，不会分叉。注意 `~/.config/opencode/skills/` 是实体文件（非软链），改 SKILL.md 不会随上游更新覆盖，也无法同步上游修复。

## 边界与风险

| 编号 | 风险                                                                                                            | 处置                                                                 |
| ---- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| R1   | hook 事件里工具名是否带命名空间（`worktree_create` vs `opencode.worktree_create`）未实证                        | contains 匹配 + 一条探针（打印 `event.tool`）后再定稿                |
| R2   | 复合/多段 bash 命令、命令中的换行                                                                               | 只做正则 contains，不做 shell 解析；宁可多触发（幂等无害）           |
| R3   | `ctx.location.directory` 与 session 实际目录可能不一致（TUI 多工作区，见 `docs/porting-decisions.md` 已知边界） | 以 `git rev-parse --show-toplevel` 归一；不确定时以 cwd 为准并记日志 |
| R4   | 在 lane 内部触发导致写进 lane 自己的忽略文件                                                                    | 路径含 `/.slim/worktrees/` 直接跳过（算法第 2 步）                   |
| R5   | 只读仓库 / 权限不足 / `git` 不在 PATH                                                                           | fail-open + 日志，工具调用不受影响                                   |
| R6   | `ctx.location.directory` 落在非目标仓库（subagent 在 lane 里跑）                                                | 同上，由 toplevel 归一后写入正确仓库；lane 内部则跳过                |
| R7   | 全局 `~/.config/git/ignore` 已有同名块 → 规则重复                                                               | 无害（重复规则幂等）；但若仓库缺 `.ignore`，lane 对搜索不可见        |

## 验证计划（交付前须附证据）

单测矩阵（临时仓库，参数化）：

| 场景                              | 断言                                        |
| --------------------------------- | ------------------------------------------- |
| 全新仓库（无 `.gitignore`）       | 两文件被创建，内容逐字节等于 canonical      |
| 已有正确受管块                    | 无写盘，mtime 不变                          |
| 已有残缺/过期受管块               | 就地替换，块外规则原样                      |
| 文件无末尾换行 / CRLF             | 换行风格与末尾状态保持                      |
| 非 git 目录                       | 退出码 0，未创建任何文件                    |
| 当前目录在 `.slim/worktrees/x` 内 | 退出码 0，lane 自己的 `.gitignore` 未被修改 |
| 无写权限                          | 退出码非 0，不抛异常到工具层                |

端到端：

1. 在 scratch 仓库里经 bash 工具真实执行 `git worktree add -b omos/t .slim/worktrees/t main`。
2. 断言：命令**执行前**两个块已就位；`git status --porcelain` 无 `.slim` 条目；`rg --files .` 能看到 `.slim/worktrees/t/**`。
3. 反向验证：移除插件软链后重复上述，确认两文件不再被创建（证明是插件生效，而非别的东西）。

## 安装与回滚

- 安装：建软链 → 重启 OpenCode → 在 scratch 仓库跑一次端到端。
- 回滚：删软链 + 重启。脚本只写仓库根的受管块，不写全局配置，回滚无需清理残留（受管块可手工删除或保留，均无害）。

## 待决事项

1. 插件位置：新建 `worktree-ignore/`（推荐，与 `adapter/` 平级、可独立关闭）vs 并入 `adapter/index.ts` 作第四条通道。
2. 触发面：只认 `git worktree add`，还是连 `worktree remove`/`prune` 也 upsert（能修复被误删的块，代价是多读两次文件）。
3. 全局 `~/.config/git/ignore` 里已有的受管块：保留（覆盖尚未建过 lane 的仓库）还是删除（单一来源）？
4. dotfiles 仓库中该文件当前为未提交的 `M`：随本方案一起提交，还是回退？
5. skill 侧是否接入共享脚本（见"可选：skill 侧接入"）。

## 附录 A：关键实测（2026-11-15，git 2.56.1 / ripgrep 15.2.0）

| 实验                                                                              | 结果                                                                          |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 仓库 `.gitignore` 含 `.slim/worktrees/`，无 `.ignore`                             | `rg --files` 看不到 lane 文件                                                 |
| 加仓库根 `.ignore` 白名单                                                         | lane 文件可见；`git status` 仍无 `.slim` 条目                                 |
| 规则改放 `$XDG_CONFIG_HOME/git/ignore`（`core.excludesFile` 未设 → 默认读该文件） | `git check-ignore -v` 指向全局文件，`status` 干净；但 `rg --files` **返回空** |
| 白名单改放 `~/.config/ripgrep/ignore` 或 `~/.ignore`                              | ripgrep **不认**；仓库根 `.ignore` 才生效                                     |

复现要点：假 HOME + `XDG_CONFIG_HOME` 指向临时目录，避免污染真实配置；`rg --files` 与 `git check-ignore -v` 交叉验证。

## 附录 B：相关文件与依据

- `~/.config/opencode/skills/worktrees/SKILL.md` — 第 3 节（受管块）、Phase 1 第 4 步、Phase 4 第 1 步
- `@opencode/plugin/dist/effect/{skill,tool,worktree,session,registration}.d.ts` — 可用锚点与 hook 签名
- `adapter/index.ts` — 本仓库既有的 `Plugin.define` + `ctx.tool.hook("execute.before")` 写法参照
- `docs/porting-decisions.md` — `ctx.session.hook("context")` 每 session 首触发一次（探针已证）；`ctx.location.directory` 多工作区边界
