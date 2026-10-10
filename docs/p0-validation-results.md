# P0 验证实验结果（R1-R3）

**日期**：2026-10-10
**环境**：OpenCode v2.0.26（`/usr/bin/opencode`），`opencode run --standalone --auto`，实验项目位于 `/tmp/opencode/p0-r{1,2,3}/`（每个含最小插件 + `opencode.json`）
**对应风险项**：可行性报告 §5 的 R1、R2、R3

---

## R1 ✅ 已验证：`tool.hook("execute.before")` 抛错可阻断工具执行

**实验**：插件在 `execute.before` 中对 `read a.txt` 抛出 `Error("P0-R1: execute.before veto")`。

**结果**：

```
✗ Read a.txt failed
Error: P0-R1: execute.before veto
（模型回复 READ-BLOCKED，未读取到文件内容）
```

**结论**：
- 抛错 = 阻断，且**错误消息原样回传给模型**（模型能看到 veto 原因，可据此自我纠正）——与 Claude Code 的 `permissionDecisionReason` 行为等价。
- hook 同时能看到完整 `event.input`（`{"path":"/tmp/opencode/p0-r1/a.txt"}`）。
- **protect-tests 等内容级守卫可以走 execute.before 通道拿到完整 input 并阻断**，无需依赖 permission 通道的内容缺口。R1 从"风险"降级为"已确认可行"。

## R2 ✅ 已验证：permission evaluate 覆盖所有工具调用，deny 翻转生效

**实验 A（覆盖面）**：只记录不修改。让模型跑 `echo hi-from-r2` + `read a.txt`，检查日志：

```json
{"action":"read","resources":["a.txt"],"effect":"allow","source":"tool"}
{"action":"shell","resources":["echo hi-from-r2"],"effect":"allow","source":"tool"}
```

- 默认 `* allow` 策略下，**每次工具调用都触发 evaluate hook**，初始 `effect: "allow"`，守卫可翻转。
- `shell` 的 resource 是**命令原文**（`echo hi-from-r2`）——Claude Code `tool_input.command` 的等价物。
- `read`/`edit` 的 resource 是**路径**（可能是相对路径 `a.txt`，适配器需按 `cwd` 归一化）。

**实验 B（deny 翻转）**：hook 对含 `evil` 的 shell 命令设 `effect: "deny"` + message：

```
The command `echo evil-payload` was blocked by the harness guard:
{"error":{"type":"permission.rejected","message":"P0-R2: shell command denied by guard"}}
（命令未执行）
```

**结论**：
- deny 翻转 = 硬阻断，`message` 作为拒绝原因回传给模型。
- **适配器主通道成立**：A 级守卫的 `permissionDecision: deny/ask` 可完整映射为 `effect: deny/ask`。
- ⚠️ 细节：复合命令是否被 scanner 拆成多个 resource 本次未测（本例为单命令），适配器应对 `resources` 数组逐个匹配（`any()` 语义），guard-pack 语义即"任一资源命中即拒"。

## R3 ⚠️ 部分验证：prompt hook 抛错可阻断提交，但错误信息粗糙

**实验**：`session.hook("prompt")` 对含 `BLOCKME` 的文本抛错。

**结果**：

| 用例 | 结果 |
|---|---|
| `"BLOCKME please say hello"` | `Error: UnexpectedStatus: 500`——prompt 未被 admit，**阻断成功**，但用户只看到 500，veto 消息（"P0-R3: prompt veto"）未透出 |
| `"say hello without any marker"` | 正常回复 Hello!（对照组通过，hook 放行不伤正常流） |

**结论**：
- **阻断语义成立**：preparation 失败 → prompt 不 admit（与文档一致）。
- ⚠️ **质量缺陷**：抛错的消息不透传，客户端只见 500。cache-tax"拒绝一次"、instructions-audit"锁会话"可以依赖此机制**阻止**，但优雅的拒绝原因展示需要替代方案：
  - 兜底：不抛错，改为把 prompt 改写为警告文本 + 注入说明（弱化但可见）；
  - 或抛错接受 500，同时把原因写入日志/通知渠道；
  - 待查：OpenCode 后续版本是否提供 typed rejection API。

---

## 对可行性报告的修订

| 风险项 | 原判定 | 新判定 |
|---|---|---|
| R1 execute.before 能否阻断 | ❓ 未实测 | ✅ **可阻断**，错误消息回传模型；内容级守卫路径完全打通 |
| R2 permission evaluate 覆盖面 | ❓ 未实测 | ✅ **默认 allow 下每次调用都触发**，deny/ask 翻转均生效；shell 资源=命令原文 |
| R3 prompt hook 拒绝 | ❓ 未实测 | ⚠️ **可阻断但报错粗糙**（500），拒绝原因不透传，需要改写文本兜底 |

**连锁影响**：
- A 级 11 个插件的通道假设全部成立，protect-tests 不再需要降级（R1 解除了内容级拦截的疑虑）。
- 适配器骨架（`adapter/index.ts`）的 permission 主通道设计正确；后续补充 execute.before 通道用于需要完整 input 的守卫。
- cache-tax / instructions-audit 的"拒绝提交"能力可用但体验打折，设计时按 R3 兜底方案处理。

## 实验可复现性

实验项目为一次性验证（位于 `/tmp/opencode/`，不入 git）。复现方法：

1. 建目录含 `opencode.json`（`{"plugins": ["./plugin"]}`）和 `plugin/index.ts`（默认导出 `{ id, setup }`）
2. `cd <dir> && opencode run --standalone --auto -m <model> "<触发工具的提示>"`
3. hook 内用 `node:fs` 追加日志到文件，事后检查

---

## 附：适配器端到端实测（2026-10-10，双通道）

在上述 P0 基础上，用**真实守卫脚本**经适配器（`adapter/index.ts` 双通道版）做了两轮端到端测试，沙盒 `/tmp/opencode/e2e-guard/`：

### 通道 1（permission evaluate）：git-safety 拦截 force push ✅

- 提示：`Run this exact shell command: git push --force origin main`
- 脚本判定（直接验证）：`permissionDecision: "deny"`，理由 `⛔ [push-main] Pushing to main is not allowed`
- 模型实录：**"A permission hook rejected the command, so no output from git itself exists to show you. I won't try to work around that guard."**
- 命令未执行，deny 理由完整回传，模型明确拒绝绕过守卫

### 通道 2（tool execute.before）：config-guard 拦截写 hooks.json ✅

- 提示：`Create a file named hooks.json in this directory`
- 结果：写入被 throw 阻断，**文件未创建**（`ls` 确认 ENOENT）
- 模型实录：准确报告"guard behaved correctly — blocked once, refused silent circumvention, surfaced the block"，甚至引用了 `CONFIG_GUARD_ALLOW=true` 逃生舱语义（脚本 README 里的行为）

### 排障记录：`process.execPath` 陷阱（Bun 宿主）

首次 e2e 全部静默失败（守卫 fail-open，命令照常执行）。日志证据链：

```
cli starting args=["/path/to/block-dangerous-commands.js"] role=cli
cli process failed: ENOTDIR chdir '/tmp/...' -> '/path/to/block-dangerous-commands.js'
```

**根因**：OpenCode 插件跑在 Bun 宿主内，`process.execPath` 指向 **opencode 二进制自身**（非 node）。`spawn(process.execPath, [script])` 实际执行的是 `opencode <script>`，opencode CLI 把脚本路径当目录 chdir → ENOTDIR → spawn error → 适配器 fail-open 放行。

**修复**：`nodeBin()` 从 PATH 解析真实 node 后再 spawn（见 `adapter/index.ts`）。**教训**：宿主进程内 spawn 绝不能假设 `process.execPath` 是 node——这是移植方案 A 的通用陷阱，任何 spawn 上游脚本的适配器都要处理。

### e2e 结论

- 方案 A 适配器双通道**全部打通**：deny/ask 判定 → 回传 → 模型可见 → 命令/文件实际未被操作
- fail-open 语义与上游一致（守卫崩溃不挡道）——但代价是**静默失效**，与上游 README 的警告一致（"failing hook command is a non-blocking error"）。生产化时建议加一个启动自检（spawn 每个脚本喂 `{}` 确认 exit 0），防止再出现本次这种静默降级
