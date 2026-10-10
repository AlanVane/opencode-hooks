# claude-code-hooks → OpenCode 移植可行性报告

**报告日期**：2026-10-10
**源仓库**：`claude-code-hooks`（22 个插件，~9,100 行 hook 代码 + ~12,400 行测试，零运行时依赖，MIT）
**目标平台**：OpenCode V2（`@opencode/plugin@2.0.26`，以 V2 官方文档为唯一依据）
**结论先行**：✅ **整体可行**。22 个插件中约 14 个可高保真移植，6 个需重建数据源或机制，2 个受 OpenCode 事件模型缺失影响需降级或重设计（另有 cache-tax 视前提成立与否归入第三类）。**没有任何一个插件属于"完全不可移植"**，但 `config-watch`、`instructions-audit`、`cache-tax` 三个需要接受行为语义上的折衷。

---

## 一、两侧机制对比（核心差异）

| 维度 | Claude Code Hooks | OpenCode V2 Plugins |
|---|---|---|
| 运行形态 | **独立进程**，每次事件 spawn 一次 Node（34-38ms 启动成本），stdin JSON 进 / stdout JSON 出 | **进程内 TypeScript 模块**，`setup(ctx)` 常驻，注册回调 |
| 事件模型 | 14+ 个具名事件（PreToolUse/SessionStart/ConfigChange…），`hooks.json` 声明 matcher | 三类通道：`ctx.*.hook()` 拦截器 + `ctx.event.subscribe()` 事件流 + transform 注册 |
| 阻断语义 | stdout `permissionDecision: deny/ask` 或 exit 2 | `permission.hook("evaluate")` 改写 `effect: allow/ask/deny` + `message` |
| 上下文注入 | `additionalContext` / `systemMessage` | `session.hook("context")` 推送 system 段；`session.hook("prompt")` 添加附件 |
| 分发 | `/plugin marketplace add` 一键市场 | `opencode.json` 的 `plugins` 数组（npm 包 / 本地路径），**无 marketplace 一键命令** |
| 异步 | `"async": true` 声明 | 天然支持：回调内 fire-and-forget Promise，机制更简单 |
| matcher | 声明式正则（`Bash\|Edit`） | 回调内手动按 `event.tool` 过滤 |

**关键架构判断**：Claude Code 的 hook 是"进程外黑盒"（prompt injection 无法绕过），OpenCode 插件是"进程内代码"。移植后安全性论证需要重写——但 OpenCode 的 permission 层同样在模型决策之外运行，防护强度不降级。

---

## 二、事件模型逐项映射

| Claude Code 事件 | OpenCode V2 对应物 | 覆盖度 | 说明 |
|---|---|---|---|
| `PreToolUse` | **`permission.hook("evaluate")`**（主通道，可 deny/ask + 理由回传）+ `tool.hook("execute.before")`（读取/改写完整 input） | 🟢 高 | 见风险 R1/R2 |
| `PostToolUse` | `tool.hook("execute.after")`，`status: "completed"` | 🟢 高 | 结果在 `event.result` |
| `PostToolUseFailure` | `execute.after`，`status: "error"` | 🟢 高 | 比 Claude Code 更规整 |
| `UserPromptSubmit` | `session.hook("prompt")`：可改写文本、注入附件 | 🟡 中 | 无 typed 拒绝 API；"注入即阻止"需验证（R3） |
| `SessionStart` | `session.hook("context")` 推 system 段 / prompt 注入 | 🟡 中高 | 时机不同：OpenCode 每次模型调用都会触发，需用一次性标记模拟"会话开始只注入一次" |
| `Stop` / `SubagentStop` | 事件流 `session.idle`、`session.execution.succeeded`；子会话带 `parentID` 可区分 subagent | 🟢 高 | |
| `SessionEnd` | **无严格对应** → 组合 `session.deleted` + `location.shutdown` + idle 超时 | 🟡 中 | flush 时机需重设计（R4） |
| `PreCompact` | `session.hook("compaction")` | 🟢 高 | 还可直接短路（`event.result` 自带 summary） |
| `Notification` | 事件流 permission 相关事件 + `ctx.permission.list()` | 🟡 中 | `permission_prompt` 有对应；`idle_prompt`/`elicitation_dialog` 需用 `session.idle`/`question` 权限事件拼凑 |
| `ConfigChange` | **无事件** → 插件内自行 `fs.watch` opencode.json / `.opencode/` | 🔴 低（机制重建） | 语义可重建，但触发方从宿主变成插件自监视（R5） |
| `InstructionsLoaded` | **无事件** → `session.hook("context")` 扫描 system/instructions + `session.instructions.updated` 事件 | 🔴 低 | 检测臂可行，三臂强制结构需重设计（R5） |
| `"async": true` | 回调内不 await | 🟢 高 | 更简单 |
| exit 2 / `permissionDecision` | `effect: "deny"` / `"ask"` + `message` | 🟢 高 | OpenCode 的 deny 理由同样回传给模型 |
| `additionalContext` 注入 | `event.system.push(...)` 或 prompt 附件 | 🟢 高 | |

**工具名 matcher 映射**：`Bash→shell`、`Read→read`、`Edit|MultiEdit|Write→edit|write|patch`、`Grep→grep`、`Glob→glob`、`Agent|Task→subagent`、`NotebookEdit→无对应`（相关 matcher 可安全丢弃）。

**Payload 字段映射**：

| Claude Code 字段 | OpenCode 来源 | 备注 |
|---|---|---|
| `tool_name` / `tool_input` | `execute.before` 的 `event.tool` / `event.input`；permission 的 `action` + `resources` | permission 资源对 shell 是**命令原文**、对 edit/read 是**路径**——覆盖大多数守卫 |
| `session_id` | `event.sessionID` | ✅ |
| `cwd` | `ctx.location.directory` / permission `metadata` | ✅ |
| `transcript_path`（JSONL 挖矿） | `ctx.session.context()` / `session.message.list` / `session.usage.recorded` 事件 / session log API | ⚠️ **最大改写点**，5 个插件依赖它 |
| `tool_response` | `execute.after` 的 `event.result` | ✅ |
| `permission_mode`、`cc_version` | 无 | 仅日志用途，可丢弃 |

---

## 三、逐插件可行性分级

### 🟢 A 级：直接移植（11 个）——只依赖 tool/input/permission 通道

| 插件 | 移植路径 | 备注 |
|---|---|---|
| block-dangerous-commands | permission evaluate（shell 资源 = 命令原文） | `HOOK_SAFETY_LEVEL`/`HOOK_ASK_*` 环境变量原样保留 |
| protect-secrets | permission evaluate（read/edit 路径 + shell 命令） | 外传 sink 语法分析用 `execute.before` 的完整 input |
| git-safety | permission evaluate | 分支状态仍需跑 `git` 子进程，逻辑不变 |
| case-insensitive-guard | permission evaluate（命令原文）+ execute.before | shell tokenizer 原样复用 |
| config-guard | permission evaluate | 保护路径从 `.claude/settings.json` 换成 `opencode.json(c)` / `.opencode/` / 插件清单 |
| protect-tests | permission evaluate（shell）+ execute.before（edit 内容） | ⚠️ 依赖 R1：edit 内容级拦截需要 execute.before 能阻断 |
| auto-stage / format-code | `execute.after` 回调内跑 git/ruff/prettier | 比原来更简单：无需 stdout 协议 |
| notify-permission | 事件流 permission 事件 → Slack webhook | `CCH_SLA_WEBHOOK` 不变 |
| subagent-spawn-cap | **permission evaluate，`action: "subagent"`** | OpenCode 原生 `subagent` 权限动作 + agent ID 资源，ask=20/deny=60 语义**完美对应**，可能比 Claude Code 版更干净 |

> 💡 **顺带发现**：OpenCode 自带声明式权限系统（wildcard 规则 + policies + 内置 `.env` 读取 ask 默认值）。部分简单守卫（如"禁止 push main"）用原生 `permissions` 配置一行就能实现。移植时建议：**能声明的用声明，复杂模式匹配（管道解析、cd 链解析、Unicode 走私检测）才用 hook**——hook 的不可替代性正在于此。

### 🟡 B 级：可移植但需重建数据源（6 个）——依赖 transcript 挖矿

`session-logger`、`context-hogs`、`nerf-receipts`、`standup-autopilot`、`dead-end-registry`、`pr-provenance-stamp`（另有 `bounty-board`、`dead-rules-audit` 中等依赖）。

- **事件侧**：✅ 全部有对应（execute.after / idle / compaction 事件）。
- **数据侧**：⚠️ 这些插件解析 `~/.claude/projects/**/*.jsonl`。OpenCode 的等价物是 `ctx.session.context()`、`session.usage.recorded` 事件、`/api/experimental/session/{id}/log`。**数据可获得，但字段结构不同，挖矿逻辑需重写**（估占移植工作量的 60%）。
- `pr-provenance-stamp` 的 `gh pr create` 拦截 + PR body 回写：✅ shell 权限资源包含命令原文，可行。
- `dead-rules-audit` 的 CLAUDE.md 解析：路径换成 `AGENTS.md` / `.opencode/` 指令文件即可，规则提取逻辑可复用。

### 🔴 C 级：受事件缺失影响，需降级或重设计（3 个）

| 插件 | 缺失的 Claude Code 事件 | OpenCode 替代方案 | 降级程度 |
|---|---|---|---|
| config-watch | `ConfigChange` | 插件 setup 里 `fs.watch` 配置文件自行比对 mtime/hash；阻断模式（exit 2）改为 permission deny edit 配置路径 | ⚠️ 从"宿主保证"降为"插件自监视"，仍能抓住带外写入（CHAINDROP 场景核心价值保留），但阻断路径不同 |
| instructions-audit | `InstructionsLoaded` | 检测臂：`session.hook("context")` 扫描 system 段 + 指令条目 API；强制臂：permission deny 按会话锁文件拦截 | ⚠️ 三臂结构保留，但"加载即检测"变为"下次模型调用时检测"，存在一个窗口 |
| cache-tax | SessionStart 的 cache 元数据 + statusline | `session.usage.recorded` 事件可拿到 usage；statusline 段改用 CLI/TUI 插件 | ⚠️ Claude Code 特有的"1 小时 cache 过期/80x 计价"语义部分依赖 Claude Code 的 cache 策略，OpenCode 下需按 provider 重新验证前提是否成立 |

**另有一个横切项**：8 个插件的 `SKILL.md` 斜杠命令（`/context-hogs:leaderboard` 等）→ OpenCode `ctx.command.transform` 注册命令，`--render` CLI 模式可直接复用。可行，但要逐个改写清单。

---

## 四、推荐移植方案：两阶段策略

### 方案 A：适配器层（Adapter）——先跑起来 ✅ 推荐首选

写一个薄的 OpenCode 插件基座：
1. 在 `permission.hook("evaluate")` / `tool.hook("execute.after")` 里接收事件；
2. **拼装 Claude Code 格式的 JSON payload**（`tool_name`/`tool_input`/`session_id`/`cwd`…）；
3. `child_process.spawn` 现有脚本，喂 stdin，解析 stdout 的 `permissionDecision`，映射为 `effect`。

**优势**：
- 22 个脚本**一行不改**，~12,400 行测试**全部原样复用**（测试本来就是 spawn 子进程喂 JSON 的）；
- 守卫逻辑的正确性零回归风险；
- `guard-pack` 的"七合一单进程"优化天然保留。

**代价**：保留每次 34-38ms 的 spawn 成本（OpenCode 进程内 hook 本可做到 ~0ms）。

### 方案 B：原生重写（Native）——逐步替换

把 A 级 11 个插件的判定逻辑改写为进程内 TS 函数：消除 spawn 延迟、获得完整 input、与 permission 消息通道原生集成。B 级 6 个在重写数据源的同时一并原生化。测试需从"spawn 脚本"改为"调用导出函数"（各脚本已有 `module.exports` 双模式导出，改造成本可控）。

**建议节奏**：A 先行验证事件映射假设 → 逐个迁移到 B → 最后处理 C 级 3 个。

---

## 五、关键风险与待验证项（P0，实施前必须逐条跑通）

| # | 风险 | 验证方法 | 若不成立的兜底 |
|---|---|---|---|
| **R1** | `tool.hook("execute.before")` 文档只说"inspect or replace input"，**未明确说明抛错能否阻断工具执行**（二进制分析显示 hook 在工具执行前 yield，抛错大概率中止，但未经实测） | 写一个抛错插件，`opencode run` 实测 | protect-tests 等内容级守卫只能退到 permission 通道（edit 只给路径，内容拿不到 → 需接受降级） |
| **R2** | permission evaluate 是否**对所有工具调用**触发（文档只说 allow/ask 触发、配置 deny 不触发——守卫正是要在 allow 之上翻转成 deny，需确认默认 `* allow` 策略下每次调用都会过 hook），以及 shell 的 scanner 是否能完整还原复合命令 | 实测 + 打印 payload | 改用 `execute.before` + R1 兜底 |
| **R3** | `session.hook("prompt")` 无 typed 拒绝 API；文档提到"preparation 失败则 prompt 不被 admit"——**抛错是否等于阻断 prompt**（cache-tax 拒绝一次、instructions-audit 锁会话都依赖此） | 实测 | 降级为"改写 prompt 文本为警告"（弱化但可用） |
| **R4** | 无 `SessionEnd` 精确事件，session-logger 的落盘时机 | 组合 `session.deleted` + `location.shutdown` + idle 定时 flush | 接受"关机时可能丢最后几条" |
| **R5** | `ConfigChange` / `InstructionsLoaded` 完全缺失 | fs.watch / context 扫描原型 | 见 C 级表 |
| **R6** | 分发链路：OpenCode 无 marketplace，`/plugin install` 体验不可复制 | 以 npm 包 + `plugins` 数组发布；验证 `plugin.check/update` API 是否支撑升级体验 | 文档化手动配置流程 |
| **R7** | cache-tax 的 prompt cache 计价前提在 OpenCode（多 provider）下是否成立 | 按目标 provider 核对 cache 策略 | 限定为 Anthropic-only 功能 |

**非风险项（已确认无障碍）**：零依赖脚本、Node ≥18、`node --test` 测试、`--render` 命令模式、文件锁/JSONL ledger 状态机、ask 模式（`effect: "ask"`）、safety level 环境变量、OWASP 文档结构——全部与宿主无关，原样迁移。

---

## 六、工作量估算

| 阶段 | 内容 | 估算 |
|---|---|---|
| P0 验证 | R1-R3 三个实验 + payload 采集 | 2-3 人日 |
| 方案 A 基座 | 事件→Claude Code payload 适配器 + stdout 协议解析 + 生命周期事件桥接 | 2-3 人日 |
| A 级 11 个接入 | 每个约 0.5 人日（含测试映射） | 5-6 人日 |
| B 级 6 个数据源重写 | transcript API 改写是主要成本 | 8-12 人日 |
| C 级 3 个重设计 | config-watch 自监视、instructions-audit 检测窗、cache-tax 前提核验 | 5-8 人日 |
| 命令/技能层 | 8 个 SKILL.md → `command.transform` | 2-3 人日 |
| 文档与发布 | README/OWASP 映射改写、npm 发布 | 2-3 人日 |
| **合计** | | **约 3-5 人周**（两阶段并行可压缩到 2-3 人周出可用版本） |

---

## 七、最终结论

1. **可行性：高**。Claude Code hook 的核心价值（模型决策之外的确定性拦截）在 OpenCode 有完整对应物——`permission.hook("evaluate")` 就是 PreToolUse 的 deny/ask，且同样有理由回传机制；`tool.hook` 覆盖 post/failure；事件流覆盖生命周期。
2. **最大工程量不在守卫，而在数据**：7 个安全守卫接近平移，而 6 个"挖矿类"插件要从 `~/.claude/*.jsonl` 迁到 OpenCode 的 session API。
3. **最大结构性风险是两个事件的缺失**（ConfigChange、InstructionsLoaded），两者都有可行替代但语义打折；一个 P0 技术疑问（execute.before 能否阻断）决定 protect-tests 的完整度。
4. **建议路径**：先用适配器方案（脚本零改动、测试全复用）打通并验证全部假设，再对 A 级插件做原生化以吃到进程内 hook 的性能红利，最后攻坚 C 级三个。
5. **额外收益**：OpenCode 自带声明式权限系统，移植后可与 hook 形成"声明式规则兜底 + 复杂模式 hook 精判"的双层防御，整体安全水位高于现状；同时消除每次 34-38ms 的 spawn 开销（原生化后）。
