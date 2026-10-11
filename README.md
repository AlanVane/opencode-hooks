# opencode-hooks

将 [claude-code-hooks](https://github.com/karanb192/claude-code-hooks)（22 个 Claude Code hook 插件）移植到 OpenCode V2 的工作仓库。

**基线**：`claude-code-hooks` @ 2026-10-10 快照（只读，本仓库不修改上游）
**许可**：MIT — 保留原作者 Karan Bansal 的署名（见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)）

**范围**：移植 A 级插件（10 个，✅ 已完成；原 A 级 11 个中的 notify-permission 已于 2026-10-12 移除）。B/C 级 9 个不移植——决策记录与候选分析见 [docs/porting-decisions.md](docs/porting-decisions.md)。

## 方案

采用**适配器优先**（可行性报告中的方案 A）：

1. `plugins/` — 上游 hook 脚本原样复制（零改动，测试原样复用）
2. `adapter/` — OpenCode 插件基座：接收 OpenCode 的 permission/tool 事件，拼装 Claude Code 格式 JSON payload，spawn 现有脚本，将 stdout 决策映射回 OpenCode 的 `effect: allow/ask/deny`

验证通过后，再逐个对 A 级插件做原生化（方案 B）。

## 目录

```
opencode-hooks/
├── adapter/                    # OpenCode 插件基座（方案 A，三通道）
├── plugins/                    # 上游脚本快照（只读复制，勿直接编辑）
│   ├── auto-stage/             # 通道 3：写后自动 git add
│   ├── block-dangerous-commands/
│   ├── case-insensitive-guard/
│   ├── config-guard/
│   ├── format-code/            # 通道 3：写后自动 ruff/prettier
│   ├── git-safety/
│   ├── guard-pack/
│   ├── protect-secrets/
│   ├── protect-tests/
│   └── subagent-spawn-cap/
├── docs/
│   ├── opencode-port-feasibility.md   # 完整可行性报告
│   ├── p0-validation-results.md       # P0 实验 + 三通道 e2e 证据（含历史通道 4 实录）
│   └── porting-decisions.md           # 范围决策（B/C 不移植）+ session-logger 分析存档
├── LICENSE
└── NOTICE                      # 上游署名
```

## 使用

```bash
# 运行已复制插件的测试（验证脚本在新位置完好）
npm test
```

## 进度

- [x] 可行性报告（docs/opencode-port-feasibility.md）
- [x] 守卫脚本快照（8 个插件，992 测试通过）
- [x] 适配器骨架（adapter/，permission 主通道）
- [x] P0 验证实验（docs/p0-validation-results.md：R1 ✅ R2 ✅ R3 ⚠️）
- [x] 适配器三通道（permission evaluate + execute.before + execute.after）
- [x] 端到端实测（三通道全通过：force-push 拦截、hooks.json 拦截、auto-stage/format-code 生效、subagent-cap 拦截）
- [x] 启动自检 probeGuards（防 fail-open 静默失效）
- [x] A 级插件全部接入（10 个；notify-permission 已移除）
- [x] A 级上游测试在新仓库回归（1034/1034 通过；原 1063 含 notify-permission 的 29 个，随该插件移除）
- [x] 范围收口：B/C 级 9 个不移植（docs/porting-decisions.md，含 session-logger 分析存档）——**项目完成**

## 安装到日常项目

```jsonc
// <项目>/opencode.json
{
  "plugins": ["/home/alecshan/projects/ai-coding/opencode-hooks/adapter"]
}
```

可选环境变量（守卫脚本原生支持，随进程环境透传）：

| 变量                                 | 作用                                                             |
| ------------------------------------ | ---------------------------------------------------------------- |
| `HOOK_SAFETY_LEVEL`                  | block-dangerous-commands 档位（critical/high/strict，默认 high） |
| `HOOK_ASK_CRITICAL/HIGH/STRICT=true` | 对应档位改 ask 而非 deny                                         |
| `SPAWN_CAP_ASK` / `SPAWN_CAP_DENY`   | subagent 配额阈值（默认 20/60）                                  |

## 文档

- [可行性报告](docs/opencode-port-feasibility.md) — 事件映射、逐插件分级、风险清单（R1-R7）、工作量估算
- [P0 实验 + e2e 证据](docs/p0-validation-results.md) — R1-R3 实验、三通道端到端实录（含已移除通道 4 的历史记录）、`process.execPath` 排障记录
- [范围决策](docs/porting-decisions.md) — B/C 不移植的决策、session-logger 可行性分析存档（若日后重启可直接用）
