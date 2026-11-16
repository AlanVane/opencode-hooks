# worktree-ignore：新建 worktree 前自动写入忽略配置

**状态**：已实施，严格模式（确认不了配置就位，就拒绝建 lane）
**最后整理**：2026-11-16
**代码位置**：`worktree-ignore/`（不改动上游 `oh-my-opencode-slim`）
**安装状态**：已软链到 `~/.config/opencode/plugins/worktree-ignore`，需重启 OpenCode 生效

## 一句话

AI 执行 `git worktree add`（新建一个 git 工作目录，下文称 lane）之前，插件先检查仓库根的 `.gitignore` 和 `.ignore` 里有没有我们约定的受管块。没有就写入，确认写好才放行；写不进去就拒绝这次命令，并把原因告诉模型。

## 1. 背景与问题

- worktrees 技能（第 3 节）要求每个项目根维护两个受管块，但没有任何代码会去写它们，只靠技能里的提醒。模型跳过，就静默失效。
- 两个文件分工不同，缺一即故障：

| 文件         | 谁读                         | 作用                                                        |
| ------------ | ---------------------------- | ----------------------------------------------------------- |
| `.gitignore` | git                          | lane 不进 `status` / `commit`                               |
| `.ignore`    | ripgrep（OpenCode 搜索底层） | 把被 git 忽略的 lane 重新放行，否则搜索搜不到 lane 里的代码 |

- 为什么不能只放全局：ripgrep 不读用户级 `.ignore`，全局 git 忽略只能管 git，搜索依然看不到 lane（见附录 A）。

## 2. 目标与非目标

**目标**

- 每次新建 lane 之前，仓库根的两个受管块已经就位，不依赖模型自觉。
- 幂等：重复执行，内容不变，文件修改时间也不变。
- 严格：确认不了就位，就拒绝执行，并把原因回传模型。
- 只改受管块，块外的规则一律不动；不改全局 git 配置。

**非目标**

- 不接管 OpenCode 自己的 worktree 创建 / 删除逻辑。
- 不修改 `oh-my-opencode-slim` 上游包。
- 不自动执行 `git worktree remove` / `prune` 或分支清理（技能要求人工确认，保持不变）。

## 3. 当前实现

### 3.1 文件结构

```
worktree-ignore/
├── index.ts            插件入口，挂在 execute.before（工具执行前）上
├── gate.mjs            判断是否在新建 lane、算出要检查的目录、调用写入脚本、决定放行或拒绝
├── ensure-ignore.mjs   唯一的写入实现（既是命令行，也是函数），幂等、原子写
├── package.json        依赖 @opencode/plugin
├── bun.lock
└── tests/
    ├── ensure-ignore.test.mjs   14 项
    └── gate.test.mjs            4 项
```

### 3.2 组件 1：`ensure-ignore.mjs`（写入）

命令行：`node ensure-ignore.mjs [--dir <路径>] [--dry-run]`，`--dir` 缺省为当前目录。

写入的两个受管块，内容固定：

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

对每个目录，按以下顺序处理：

1. 用 `git rev-parse --show-toplevel` 找仓库根（超时 3 秒）。不是 git 仓库，或 git 不可用，就跳过（输出 `skipped`，退出码 0）。
2. 仓库根路径里含 `/.slim/worktrees/`，说明本身就在 lane 里，跳过，不改 lane 自己的文件。
3. 对 `.gitignore` 和 `.ignore` 各做一次写入：
   - 已有完整的受管块：就地替换块内内容。如果有多个重复块，合并成第一个。
   - 没有受管块：追加到末尾（末尾不是空行时，先空一行）。
   - 文件不存在：创建。
   - BEGIN 或 END 标记不成对：**拒绝改写**，报错退出，文件保持原样。
   - 保留原有的换行风格（LF 或 CRLF）和末尾换行状态。
4. 写入结果与原内容逐字节相同，就不写盘，修改时间不变。
5. 确需写入时，先写同目录的临时文件，再整体替换。符号链接指向的文件会被更新，链接本身保留；原有权限也保留。
6. 输出一行：`updated: <文件列表>`、`unchanged` 或 `skipped: <原因>`。退出码：0 表示成功、无需改动或已跳过；1 表示内部错误（如没有写权限、标记不成对）。

### 3.3 组件 2：插件与闸门（`index.ts` + `gate.mjs`）

**什么时候检查**。满足下面任一条件就检查，否则直接放行，不做任何读写：

- 工具是 `shell`（或 `bash`），输入里有 `command` 字段，且命令中含 `git worktree add`。允许中间带 `-C <路径>` 或 `-c <配置>`。
- 工具名含 `worktree_create` 或 `worktree_add`（文档原有设定，尚未实测）。

**检查哪些目录**：

- 默认是工具指定的 `workdir`（如果有），否则是会话所在目录。
- 如果命令里有 `cd <目录>` 或 `git -C <目录>`，就改为检查这些目录，替代默认目录。
- 只做正则匹配，不做完整的 shell 解析（见第 7 节 R2）。

**放行还是拒绝（严格模式）**：

- 所有目录都检查通过：放行，命令照常执行。
- 任一目录失败（脚本退出码为 1、超时、或启动失败）：拒绝这次工具调用，把失败的目录和原因作为错误信息回传模型。
- 开关是 `gate.mjs` 里的 `FAIL_CLOSED`，当前为 `true`（严格）。改为 `false`，即回到原文档的做法：失败只记日志，照常建 lane。
- 插件钩子会等待检查结束才放行，所以写入一定发生在 `git worktree add` 之前（见第 5 节，A 组已验证）。

## 4. 与最初方案的差异

| 项目               | 最初方案                    | 现在                                       | 原因                                                 |
| ------------------ | --------------------------- | ------------------------------------------ | ---------------------------------------------------- |
| 失败时             | 放行，只记日志（fail-open） | **拒绝建 lane（严格）**                    | 需求要求"就位再放行"；2026-11-16 确认采用严格        |
| 工具 id            | 认 `bash` 和 `shell`        | 实测为 `shell`，`bash` 也兼容              | 探针实测（OpenCode v2.3.0）                          |
| 检查目录           | 会话目录，再归一到仓库根    | `workdir`，以及 `cd` / `git -C` 指定的目录 | 会话目录可能不是命令真正执行的目录                   |
| 标记不成对         | 未定义                      | 拒绝改写，报错                             | 不能动用户自己的规则，交由人工修复                   |
| 重复块             | 未定义                      | 合并为第一个                               | 保证幂等                                             |
| CRLF 无末尾换行    | 未定义                      | 保持字节，不新增末尾换行                   | 初版实现会留下孤立的 `\r`，已修正（T4 改为精确断言） |
| `@opencode/plugin` | adapter 用 2.0.26           | 解析为 2.3.0                               | `^2.0.26` 的解析结果，与宿主版本一致                 |

## 5. 验证证据

### 5.1 自动测试

- `node --test worktree-ignore/tests/ensure-ignore.test.mjs`：14/14 通过。覆盖：全新仓库；已正确（不写盘）；过期块就地替换；CRLF 无末尾换行；非 git 目录；lane 内的目录；幂等；重复块合并；标记不成对；符号链接；无写权限；`.ignore` 白名单让 ripgrep 能看到 lane 文件，同时 git 状态干净；命令行输出与退出码。
- `node --test worktree-ignore/tests/gate.test.mjs`：4/4 通过。覆盖：触发判断；目标目录解析；拒绝路径；真实脚本的跳过 / 更新 / 拒绝结果，以及超时。
- 仓库根 `npm test`：退出码 0，1230/1230 通过（包含以上两组）。

### 5.2 真实 OpenCode 端到端（v2.3.0，隔离克隆）

做法：把本仓库克隆到临时目录。在克隆的 `.git/hooks/post-checkout` 里放一个钩子，记录 `git worktree add` 检出时仓库根两个文件的内容。检出发生在命令执行过程中，所以它反映的是"命令执行时"的状态。然后用 `opencode run --auto` 让模型执行 `git worktree add -b omos/e2e .slim/worktrees/e2e HEAD`。

| 组  | 设置                                          | 结果                                                                                                                        |
| --- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| A   | 挂载插件                                      | 检出时两个受管块已就位；`git status` 无 `.slim` 条目（仅 ` M .gitignore`、`?? .ignore`）；`rg --files` 可见 lane 文件 73 个 |
| B   | 不挂插件（对照）                              | lane 在 `git status` 中显示为 `?? .slim/`，原问题复现                                                                       |
| C   | 挂插件，且把 `.gitignore` 改成只有 BEGIN 标记 | 工具调用被拒，原因回传模型；未建 lane；`.gitignore` 原样未改；未生成 `.ignore`                                              |

原始日志位于 `/tmp/opencode/wi-e2e-real-1794810324/`，属于临时文件，可能会被系统清理。

## 6. 安装、使用与回滚

- **安装（已完成）**：`ln -s /home/alecshan/projects/ai-coding/opencode-hooks/worktree-ignore ~/.config/opencode/plugins/worktree-ignore`，然后重启 OpenCode。
- **手动运行脚本（不经插件）**：`node worktree-ignore/ensure-ignore.mjs --dir <仓库路径>`；加 `--dry-run` 则只检查、不写入。
- **回滚**：`unlink ~/.config/opencode/plugins/worktree-ignore`，然后重启。受管块可以保留（无害），也可以手工删除。
- **对仓库的影响**：仓库根的 `.gitignore` 会显示为已修改（` M`），`.ignore` 会以未跟踪文件出现（`??`）。需要提交，或按第 8 节的待决事项处理。

## 7. 风险与已知限制

| 编号 | 风险                                         | 现状                                                                                 |
| ---- | -------------------------------------------- | ------------------------------------------------------------------------------------ |
| R1   | 工具名是否带命名空间                         | shell 工具已实测为 `shell`；`worktree_*` 工具尚未实测                                |
| R2   | 复合命令、换行、特殊写法                     | 只做正则匹配。`cd` / `git -C` 覆盖常见写法；变量、子 shell、多层 `cd` 等可能判断不准 |
| R3   | 会话目录与实际执行目录不一致（多工作区）     | 已优先采用 `workdir`；多工作区仍是已知边界（见 `docs/porting-decisions.md`）         |
| R4   | 在 lane 内部执行，改写了 lane 自己的忽略文件 | 已跳过（路径含 `/.slim/worktrees/`）                                                 |
| R5   | 只读仓库、权限不足、git 不可用               | 严格模式：拒绝建 lane，原因回传模型                                                  |
| R6   | 子代理在 lane 内运行                         | 同 R4，已跳过                                                                        |
| R7   | 全局 `~/.config/git/ignore` 已有同名块       | 规则重复但无害（待决 3）                                                             |
| R8   | 脚本或检查卡住                               | 15 秒超时即拒绝，原因回传模型                                                        |

## 8. 待决事项

1. **已决**：插件放在新建的 `worktree-ignore/` 目录，与 `adapter/` 平级，可以单独关闭。
2. **已决**：触发范围只认 `git worktree add`（以及 `worktree_*` 工具），不含 `remove` / `prune`。
3. **已决**：不再保留全局同名块（单一来源）。已核查：`core.excludesFile` 指向 `~/.config/git/ignore`（dotfiles 仓库的软链），其中没有同名受管块；`~/.ignore` 不存在。因此无需清理。
4. **不属本仓库**：dotfiles 仓库里该文件当前的未提交修改，是随该仓库自行提交还是回退，由该仓库决定；本方案不涉及。
5. **已决**：不接入 skill 侧。worktrees 技能位于上游 npm 包的缓存目录（版本化，升级或重装即失效），改它的副本不稳定；插件已在工具层独立兜底，skill 里原有的文字提示保留，两者不冲突。
6. **已决**：本仓库这次的改动已提交进 `main`（插件 `b7e65ac`、本仓库忽略块 `9c63f25`、README `48a4188`），后续文档修订单独提交。

## 附录 A：关键实测（2026-11-15，git 2.56.1 / ripgrep 15.2.0）

| 实验                                                  | 结果                                          |
| ----------------------------------------------------- | --------------------------------------------- |
| 仓库 `.gitignore` 含 `.slim/worktrees/`，无 `.ignore` | `rg --files` 看不到 lane 文件                 |
| 加仓库根 `.ignore` 白名单                             | lane 文件可见；`git status` 仍无 `.slim` 条目 |
| 规则改放 `$XDG_CONFIG_HOME/git/ignore`                | `git status` 干净，但 `rg --files` 返回空     |
| 白名单放 `~/.config/ripgrep/ignore` 或 `~/.ignore`    | ripgrep 不认，只有仓库根的 `.ignore` 生效     |

复现要点：用假 HOME 和临时 `XDG_CONFIG_HOME`，避免污染真实配置；用 `rg --files` 与 `git check-ignore -v` 交叉验证。

## 附录 B：为什么不用其他机制

| 候选                                   | 结论                                                                                                                         |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 技能加载时自动执行                     | ❌ 不存在该机制：`SkillDomain` 只有 `list/get/add/update/remove/transform/reload`，没有 onLoad / onUse                       |
| `oh-my-opencode-slim.json` 自定义 hook | ❌ `disabled_hooks` 是固定枚举，没有注册入口                                                                                 |
| git alias / `git worktree` 包装        | ❌ 技能执行的是裸 `git worktree add`，别名不生效                                                                             |
| AGENTS.md 里写"记得加"                 | ❌ 就是现状                                                                                                                  |
| 全局 `~/.config/git/ignore`            | ⚠️ 只覆盖 git 侧，`.ignore` 无法全局化                                                                                       |
| 技能 sidecar 脚本                      | ⚠️ 仍需模型执行，属于半自动，未采用（见待决 5）                                                                              |
| `ctx.worktree.transform`               | ❌ 不采用：需要自己实现 create / remove / list，等于接管 OpenCode 的 lane 逻辑（分支命名、路径冲突、错误语义），风险大于收益 |

## 附录 C：相关文件

- `@opencode/plugin/dist/effect/{skill,tool,worktree,session,registration}.d.ts`：可用锚点与 hook 签名
- `adapter/index.ts`：本仓库已有的 `Plugin.define` 与 `execute.before` 写法，作为参照
- `docs/porting-decisions.md`：`ctx.session.hook("context")` 与 `ctx.location.directory` 的多工作区边界
