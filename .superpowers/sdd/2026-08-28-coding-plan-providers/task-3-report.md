# Task 3 report — restricted Claude Code CLI runtime/provider

## 结果

状态：`DONE_WITH_CONCERNS`

基线：`4104925`（`feat: support Kimi and GLM coding plan transports`）。

本任务新增了一个仅限单次文本回合的 Claude Code CLI Provider。每次调用创建独立进程，使用固定的非交互安全参数，通过 stdin 发送一段 UTF-8 文本并以 EOF 结束；只解析 `stream-json` 的 assistant 文本增量和最终 `result`。Base64、MCP、禁用 restricted、非 `plan` 权限模式和非 `stream-json` 输出均在启动前拒绝。进程取消、超时、退出和插件关闭路径都会执行 best-effort kill；stderr 持续 drain、限长并脱敏，错误保留机器可读 code 和 exitCode（如有）。

## RED 证据

按 brief 执行：

```text
npx mocha --config test/tsconfig.json test/claudeCodeCliProvider.test.ts
```

该仓库现有 Mocha 配置在测试加载前失败：`test/tsconfig.json` 的 `extends` 被解析为缺失的 `/Users/alater/Documents/Codex/2026-08-28/tsconfig.json`。

使用仓库已有 esbuild 测试打包方式再次验证 RED：

```text
Could not resolve "../src/modules/llmproviders/ClaudeCodeCliProvider"
Could not resolve "../src/modules/llmproviders/claudeCodeCli/ClaudeCodeCliProcess"
```

后续补充行为时也执行了独立 RED→GREEN：

- assistant `delta` 对象测试在实现前失败（progress 为空），实现后通过；
- final result 不等待 exit 回调测试在实现前超时，实现后通过；
- malformed stream 测试在实现前被误报为 timeout，实现后返回 `claude-cli-malformed-response`。

## 改动

- `src/modules/llmproviders/claudeCodeCli/types.ts`
  - 定义可注入的进程接口、受限选项、工厂类型和稳定错误码。
- `src/modules/llmproviders/claudeCodeCli/ClaudeCodeCliProcess.ts`
  - 仅使用 Zotero `Subprocess` 模式加载和启动绝对路径 `claude`；裸命令只经 `pathSearch` 解析。
  - 固定参数为 `-p --output-format stream-json --permission-mode plan --restricted --no-session-persistence --max-turns 1 --no-chrome`，不接受调用方追加参数。
  - 提供 `write`、`closeStdin`、`onLine`、`onExit`、`kill`、`getDiagnostics`，维护 task-scoped active set 和 shutdown cleanup。
  - 读取 stdout JSONL、drain stderr、保留退出码，并对 Bearer/token/path 等诊断脱敏。
- `src/modules/llmproviders/ClaudeCodeCliProvider.ts`
  - 实现 `ILlmProvider` 的 summary/chat/connection text turn。
  - 只发送 plain-text stdin frame（规范化换行并追加一个 LF），不传 prompt、session、MCP 或任意命令参数。
  - 解析 assistant message、assistant delta、`stream_event`/`content_block_delta` 和最终 `result`，拒绝工具/MCP/file/command 输出。
  - Base64、MCP、非安全 CLI 选项、malformed output、result error、timeout、abort 和非零退出均 fail-closed；错误消息不回显 prompt，退出码保存在 `exitCode`。
- `src/modules/llmproviders/index.ts`
  - 导出并加载 Claude CLI process/provider，使其注册到 `ProviderRegistry`；既有 Provider 保持注册。
- `src/hooks.ts`
  - 在插件 `onShutdown` 中调用 Claude CLI process cleanup。
- `test/claudeCodeCliProvider.test.ts`
  - 添加无 Zotero/Node child-process 依赖的 fake-process 测试，覆盖参数白名单、stdin framing、assistant/final parsing、无 exit final、MCP/Base64/权限 fail-closed、脱敏、stderr drain、退出码、abort/timeout、provider 注册。

`src/modules/llmproviders/types.ts` 在基线已包含 brief 要求的四个 Claude 字段，本轮未重复改写。

## 验证

- Claude focused esbuild + Mocha：**12 passing**。
- Codex runtime/provider focused esbuild + Mocha：**19 passing**。
- `npx --no-install tsc --noEmit --pretty false`：**PASS**。
- 目标 Prettier check：**PASS**。
- 目标 ESLint：**PASS**。
- `npm run build`（包含 i18n、打包、TypeScript、built-locale 检查）：**PASS**。
- `git diff --check`：**PASS**。
- 未运行生产 Zotero、已安装 XPI 或真实 Claude credential smoke；未读取/修改凭据，也未触碰 `/Users/alater/Zotero`。

官方 CLI 文档只读核对了 `-p` stdin、`stream-json`、`--permission-mode`、`--no-session-persistence`、`--no-chrome` 和 `--max-turns` 语义；本任务的 `--restricted` 能力仍需真实目标 CLI 版本在 credential-gated smoke 中验证，旧版本会以脱敏 diagnostics 和 `claude-cli-unsupported-flags` 失败。

## 未验证事项与风险

- 当前环境存在 `/Users/alater/.local/bin/claude`，但本任务未执行真实调用，因此未证明登录状态、订阅资格、实际 `--restricted` 支持、服务端 stream 事件完整形状或模型 entitlement。
- 固定参数白名单按 brief 精确执行，未加入 `--model`；endpoint 的 `model` 字段作为 AI Butler 元数据保留，但实际 CLI 模型选择依赖 Claude CLI 当前配置。若产品必须强制选择 endpoint model，需要另行批准并更新安全白名单/测试。
- CLI 默认工作目录/本机配置由 Claude 自身决定；本 Provider 不读取或复制 Claude credential 文件，也不启用 resume/session/MCP/命令执行/写文件接口。真实运行仍应在隔离且不含敏感仓库配置的目录进行验收。
- `npm test` 全量 harness 和动态 `llmProviders.test.ts` 未在本任务中运行，避免在未授权条件下触发真实 Claude CLI；Task 5 应使用临时 profile、明确凭据状态并单独记录结果。

## 回滚

回退本任务提交即可恢复 `4104925` 的 Provider 集合；不涉及 preferences、凭据、生产 Zotero 数据、已安装 XPI 或远端分支。禁用/删除 `claude-code-cli` endpoint 不影响既有 OpenAI、Codex 和其他 Provider。

## 提交

提交 hash 以最终 handoff 消息为准；未 push、未安装 XPI。

## Fix round — wait-first/stdout-later race

Review 发现的唯一 Important 已关闭：`raw.wait()` 完成时，进程现在先等待 stdout
read loop 完成（包括最后无换行 partial JSONL flush），再 drain stderr 并触发一次
`onExit`。stdout reader 异常由 wait loop 统一收口；无 `raw.wait()` 的测试/兼容路径
仍由 stdout 完成后触发 cleanup，`exitNotified` 保证不会双通知。

新增 fake-process 回归场景：raw wait 先返回 0，stdout 延迟返回无换行的
`{"type":"result","result":"late"}`。修复前测试在 stdout 释放前观察到 `[0]`
并失败；修复后先观察到空退出列表，释放 stdout 后收到完整 partial line 和一次
exit code 0。

Fix round verification：Claude focused **13 passing**；source `tsc --noEmit`、目标
ESLint/Prettier、`npm run build`（含 i18n/built-locale）均 **PASS**；未运行真实
Claude credential smoke。
