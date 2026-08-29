# AI Butler 原生 Codex App Server 改造设计

## 1. 目标

在 `iduoduo1002/zotero-AI-Butler` fork 上增加一个原生 `codex-app-server` 模型 Provider，使 AI Butler 可以像 LLM-for-Zotero 一样直接调用本机已登录的 Codex，而不是把 Codex 当作一个需要 API key 的 OpenAI 兼容端点。

改造必须同时满足：

1. 现有 OpenAI-compatible、OpenAI Responses、Gemini、Anthropic、OpenRouter、Ollama 等 API Provider 继续可用。
2. 现有任务队列、PDF 提取、摘要/精读、重试、取消和 Zotero 笔记落库继续工作。
3. Codex 调用使用 `codex app-server` 的 stdio JSONL 协议，并保留 thread、turn、事件、审批和诊断信息。
4. 任务运行采用明确的 Sol/Luna 角色：Sol 使用 `gpt-5.6-sol` + `high` 负责任务合同、规划、整合与独立验收；Luna 使用 `gpt-5.6-luna` + `max` 执行被拆解且可验证的子任务。
5. 失败必须可见、可重试、可中断、可回滚，不能悄悄把 Codex 失败伪装成普通 API 成功。

## 2. 非目标

- 不覆盖当前 `/Users/alater/Zotero` 数据目录，不直接改写已安装 XPI。
- 不在首版把所有 Zotero 写入工具暴露给 Codex；需要库级读写时，后续接入带 bearer scope 的 LLM-for-Zotero MCP 通道，并保留人工确认。
- 不实现云端 Chat Completions 到 App Server 的旁路代理；AI Butler 直接管理本机 App Server 生命周期。
- 不声称 `networkAccess:false` 等 sandbox 选项能保证 PDF 内容不离开云端模型。需要本地模型隔离时另行设计并验证。

## 3. 架构

```text
AI Butler TaskQueue
        |
        v
  LLMService / NoteGenerator
        |
        +--> API Providers (现有链路，保持不变)
        |
        +--> CodexAppServerProvider
                  |
                  +--> CodexAppServerProcess (Zotero Subprocess)
                  |       stdio JSONL
                  |
                  +--> thread/start -> turn/start -> item/turn events
                  |                  -> turn/completed
                  |
                  +--> TaskLedger (task/thread/turn/role/approval/artifact)
```

Codex Provider 对上层提供与 `ILlmProvider` 兼容的摘要/聊天接口，对下层负责进程、JSON-RPC request/response、通知分发、超时、取消和进程清理。所有 Codex 请求必须携带稳定的 `executionId`，不能把 Zotero item id 当作跨重试全局 id。

### 3.1 Codex 进程与协议

- 自动发现或允许设置 Codex 二进制路径；首选 `codex app-server`。
- 启动后发送 `initialize`，失败则 Provider 不可用并返回可操作错误。
- 每个执行建立独立 thread；每个重试建立新的 turn，或在明确可恢复时 resume。
- 监听 `item/agentMessage/delta`、命令/工具/审批事件、`turn/completed` 和错误通知。
- `AbortSignal` 触发 `turn/interrupt`，超时后先中断再回收进程。
- 关闭插件或 Zotero 时释放进程与临时订阅，不能遗留僵尸 Codex。

### 3.2 内容策略

- Codex 首版接收已提取的文本/Markdown；当 endpoint 为 Codex 时禁止沿用 Base64 PDF 输入模式。
- 保留 Zotero item key、附件 source key、SHA-256 和文本提取方式的元数据。
- 不把 Bearer token、绝对路径、PDF Base64 或全文写入普通日志。
- 图片摘要继续使用现有 ImageSummaryService；Codex 不支持时明确标记为 unsupported，而不是静默回退。

### 3.3 Sol/Luna 编排

首版使用结构化任务合同而非隐式提示词：

```text
executionId
parentExecutionId
role = sol | luna
model
reasoningEffort
zoteroItemKey / attachmentKey
sourceSha256
threadId / turnId
approvalPolicy / sandboxPolicy / networkAccess
inputDigest / outputDigest
status = planned | running | awaiting_approval | passed | partial | blocked | failed
```

对需要编排的任务执行：

1. Sol 生成任务合同、验收条件和可并行的 Luna 子任务。
2. Luna 只接受合同中声明的输入、输出格式和权限范围。
3. Sol 读取 Luna 产物与证据摘要，独立给出 `PASS`、`PARTIAL` 或 `BLOCKED`。
4. 只有 Sol 验收通过且 `TaskArtifacts.probe` 成功，AI Butler 才写入最终笔记。

队列默认仍为并发 1；同一 Codex 进程内不并发发送 turn。后续如需提高吞吐，再按 thread/进程池做显式并发改造。

## 4. 代码改动边界

### Provider/runtime

- 新增 Codex App Server JSON-RPC 类型、进程管理器、协议客户端和 `CodexAppServerProvider`。
- 扩展 `ILlmProvider`/`LLMOptions`，增加 role、executionId、thread/turn、事件与取消能力，同时不破坏现有实现。
- 将 reasoning effort 解析、模型兼容性和 Codex 可用性检查集中到 provider 层。

### 队列/笔记/记录

- 在 `LLMService`、`NoteGenerator`、`TaskQueue` 和 deep-read 流程中传递执行上下文。
- 增加 append-only task ledger 或等价的可审计结构；现有 Zotero prefs 快照继续作为队列状态，不承担完整审计职责。
- 扩展 `llmNoteMetadata`，写入 provider、role、model、execution/thread/turn、source hash、验收状态和产物摘要。

### 设置/UI

- 新增 Codex endpoint 类型和设置项：binary path、model、reasoning effort、approval policy、sandbox/network policy、MCP 开关（默认关闭）。
- Codex endpoint 不显示 API key 输入；连接测试必须执行真实 `initialize` + 最小 `thread/start`/`turn/start` 回合，而不是只校验字段。
- 队列界面显示 thread/turn、审批等待、失败原因和 Sol 验收状态。

### 测试与发布

- 单元测试：JSONL framing、请求 id 匹配、事件解析、超时/中断、进程回收、模型/effort 校验、ledger 脱敏。
- 集成测试：mock app-server 完成 summary/chat、retry、interrupt、approval 和 resume。
- 真实 smoke/demo：本机 `codex login`、Codex App Server 回合、授权测试 PDF、AI Butler 笔记落库、重启/失败路径。
- 构建 XPI 前执行 lint、类型检查、测试、manifest 与 i18n 检查；保留原始 XPI 与源码 commit 作为回滚点。

## 5. 验收门槛

### 必须通过

1. 现有 API Provider 测试不回归。
2. Codex 设置页可保存、可测试连接、错误可读。
3. 真实 Codex App Server 完成至少一个摘要或精读任务；日志中能关联 execution/thread/turn。
4. 取消、超时、重试、Zotero 重启后状态均可解释，不遗留 Codex 进程。
5. Sol 规划、Luna 执行、Sol 独立验收三段证据齐全；验收失败不得写最终笔记。
6. 仅处理目标附件：source key 与 SHA-256 一致，不能误读兄弟附件或把整个库搜索结果当作当前 PDF。
7. 运行记录不泄露 API key、bearer token、PDF Base64、全文或绝对本地路径。

### 暂不阻塞首版的增强项

- 多 Codex 进程池与高并发。
- 带人工确认的 Zotero MCP 写操作。
- 图片输入、原始 PDF 文件工具和本地模型网络隔离证明。

## 6. 回滚

- 所有源码修改只发生在 `codex/codex-app-server` 分支。
- 发布前保存原始 XPI、构建产物 SHA-256 和 Zotero profile 备份。
- 首版默认不自动替换生产 XPI；先在临时 profile 安装验证。
- 任何真实数据写入前先使用测试条目/测试库，失败时删除测试笔记并恢复 profile 快照。
