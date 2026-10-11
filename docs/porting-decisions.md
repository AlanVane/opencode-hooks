# 移植范围决策记录

**决策日期**：2026-10-10
**决策内容**：B/C 级共 9 个插件**暂不移植**，项目以 A 级 11 个插件收口。

## 最终范围

| 类别                               | 数量  | 状态                                            |
| ---------------------------------- | ----- | ----------------------------------------------- |
| A 级（tool/input/permission 通道） | 10    | ✅ 全部接入 + e2e 实证 + 上游测试回归 1034/1034 |
| B 级（需重建 transcript 数据源）   | 6     | ❌ 不移植（用户决策：A 级够用）                 |
| C 级（事件缺失需重设计）           | 3     | ❌ 不移植（同上）                               |

> 决策时（2026-10-10）A 级为 11 个、测试 1063/1063；2026-10-12 移除
> notify-permission 后为 10 个、测试 1034/1034（下同）。

## 已接入清单（A 级，现 10 个）

block-dangerous-commands、git-safety、case-insensitive-guard、protect-secrets、
config-guard、protect-tests（通道 1 permission + 通道 2 execute.before）
auto-stage、format-code（通道 3 execute.after）
subagent-spawn-cap（通道 1 subagent 动作）

> 注：原 A 级含 notify-permission（通道 4 event stream），已于 2026-10-12
> 连同适配器通道 4 一并移除（用户决策），A 级由 11 个变为 10 个。

## 附带结论：session-logger 是"伪 B 级"（分析存档，未实施）

6 个 B 级中 session-logger 经源码 + 探针分析确认**不挖 transcript**，
实际移植难度接近 A 级（约 0.5 人日）。关键映射已用实验钉死
（探针 `/tmp/opencode/slog-probe/`，2026-10-10）：

| 上游事件     | OpenCode 解法                                                                   | 证据                                          |
| ------------ | ------------------------------------------------------------------------------- | --------------------------------------------- |
| SessionStart | `ctx.session.hook("context")` 首次触发每 session 一次（Set 去重）→ spawn 原脚本 | 探针确认 context hook 带 sessionID 且按时触发 |
| PostToolUse  | 通道 3 现成，需补 `read`/`shell` 映射（shell input 为 `{"command":...}`）       | 探针确认工具 id 与 input 形状                 |
| SessionEnd   | plugin `setup` 返回 cleanup 函数，进程退出时批量 finalize                       | **探针确认 cleanup 被调用**                   |

已知折衷（若日后重启）：

- TUI 场景 `ended:` 为进程退出时间而非会话结束时间（`opencode run` 场景精确）；
  可选 idle 防抖精化（~30 行）
- 子代理工具调用在子 sessionID 下触发，需 `parentID` 归并进父笔记（~10 行）
- context hook 与首个工具调用的 40ms 竞态需 Promise 链排序（~8 行）
- TUI 多工作区下 `ctx.location.directory` 可能与 session 实际目录不符（已知边界）

脚本本体与 442 行测试可零改动复用（测试只依赖 stdin/stdout 协议）。

## 其余未移植插件的一句话备注

- **context-hogs**：文件粒度上下文成本排行；数据源是 tool result 字节（通道 3 有），第二便宜的候选
- **nerf-receipts**：按模型版本记录失败率/edit churn/tokens-per-task，换模型时检测质量漂移；token 数据源在 OpenCode（`session.usage.*` 事件）反而比原版解析 JSONL 更直接
- **standup-autopilot**：从会话记录生成每日站会；transcript 挖矿重写量大
- **dead-end-registry**：记住试过并回退的方案防止重蹈覆辙；B 级最贵，且 edit 通道 ask 会降级为 deny（语义折衷）
- **pr-provenance-stamp**：`gh pr create` 时往 PR body 盖出处收据；需验证 execute.before 改写 shell 命令的可行性（R1 只验证过 throw 阻断）
- **bounty-board**：TODO/FIXME 游戏化悬赏（git 扫描，无 transcript 依赖）
- **dead-rules-audit**：CLAUDE.md→AGENTS.md 合规记分卡（无 transcript 依赖）
- **config-watch / instructions-audit / cache-tax**（C 级）：需机制重设计，见可行性报告
