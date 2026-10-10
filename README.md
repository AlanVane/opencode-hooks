# opencode-hooks

将 [claude-code-hooks](https://github.com/karanb192/claude-code-hooks)（22 个 Claude Code hook 插件）移植到 OpenCode V2 的工作仓库。

**基线**：`claude-code-hooks` @ 2026-10-10 快照（只读，本仓库不修改上游）
**许可**：MIT — 保留原作者 Karan Bansal 的署名（见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)）

## 方案

采用**适配器优先**（可行性报告中的方案 A）：

1. `plugins/` — 上游 hook 脚本原样复制（零改动，测试原样复用）
2. `adapter/` — OpenCode 插件基座：接收 OpenCode 的 permission/tool 事件，拼装 Claude Code 格式 JSON payload，spawn 现有脚本，将 stdout 决策映射回 OpenCode 的 `effect: allow/ask/deny`

验证通过后，再逐个对 A 级插件做原生化（方案 B）。

## 目录

```
opencode-hooks/
├── adapter/                    # OpenCode 插件基座（方案 A）
├── plugins/                    # 上游脚本快照（只读复制，勿直接编辑）
│   ├── block-dangerous-commands/
│   ├── case-insensitive-guard/
│   ├── config-guard/
│   ├── git-safety/
│   ├── guard-pack/
│   ├── protect-secrets/
│   ├── protect-tests/
│   └── subagent-spawn-cap/
├── docs/
│   └── opencode-port-feasibility.md   # 完整可行性报告
├── LICENSE
└── NOTICE                      # 上游署名
```

## 使用

```bash
# 运行已复制插件的测试（验证脚本在新位置完好）
npm test

# P0 验证实验（R1-R3，见可行性报告第五章）
# TODO: 实验插件待建
```

## 文档

- [可行性报告](docs/opencode-port-feasibility.md) — 事件映射、逐插件分级、风险清单（R1-R7）、工作量估算
