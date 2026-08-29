# AI Butler Coding Plan 供应商扩展设计

## 1. 审核结论

本方案有条件通过，采用“协议复用 + CLI 隔离”的混合架构：Kimi Code 与 GLM Coding Plan 作为带供应商 profile 的 HTTP endpoint，复用现有 OpenAI-compatible/Anthropic transport；Claude Code 作为独立的受限 CLI Provider。不得把三者都实现成同一种“API key + Chat Completions”模型。

官方资料确认：Kimi Code 提供 OpenAI/Anthropic 兼容 API 和 API Key；GLM Coding Plan 提供 Anthropic Message、OpenAI Chat Completion、OpenAI Responses 三类端点；Claude Code 支持 `claude -p`、`stream-json`、`--permission-mode`、`--restricted` 等 CLI 能力，但其 Pro/Max 登录、Anthropic API 和第三方网关属于不同认证路径。

## 2. 目标

在现有 Codex App Server 改造基础上增加可维护的 Coding Plan 供应商目录：

1. 在模型平台中提供 Kimi Code、GLM Coding Plan、Claude Code CLI 的明确入口。
2. Kimi/智谱优先复用成熟 HTTP Provider，保留 API Key、重试、流式输出、PDF 文本提取和现有队列门禁。
3. Claude Code 使用本机 CLI 的非交互模式，限制为文本输入、只读/计划权限、单回合和无 MCP。
4. 不让供应商 profile 改变现有 OpenAI、Anthropic、Codex、Gemini、OpenRouter、火山方舟和 Ollama 的默认行为。
5. 对端点、模型、推理参数、凭据和 Coding Plan 资格保持可审计、可更新和可回滚。

## 3. 供应商与协议矩阵

| UI 供应商       | 内部 profile       | transport               | 默认地址                                          | 默认模型          | 认证                                  |
| --------------- | ------------------ | ----------------------- | ------------------------------------------------- | ----------------- | ------------------------------------- |
| Kimi Code       | `kimi-code`        | OpenAI Chat             | `https://api.kimi.com/coding/v1/chat/completions` | `kimi-for-coding` | Kimi Code API Key                     |
| GLM Coding Plan | `zhipu-glm-coding` | OpenAI Chat             | `https://open.bigmodel.cn/api/coding/paas/v4`     | `glm-5.3`         | GLM Coding Plan API Key               |
| Claude Code CLI | `claude-code-cli`  | local CLI / stream JSON | 本机 `claude` binary                              | `sonnet`          | Claude Code CLI 登录或 CLI 支持的认证 |

### Kimi Code 规则

- `kimi-for-coding` 为保守默认模型；`k3`、`k3-256k`、`kimi-for-coding-highspeed` 允许用户显式选择。
- 只有 K3 系列发送 `reasoning_effort`；K2.7 Code 系列保持其服务端默认 Thinking 行为，不发送不兼容字段。
- Kimi Code 的 API Key 只进入 Zotero HTTP 请求，不进入日志、ledger 或笔记元数据。

### GLM Coding Plan 规则

- 使用官方 OpenAI Chat Completion Base URL；默认模型 `glm-5.3`，用户可以输入官方支持的模型 ID。
- 未经协议验证不发送 `reasoning_effort`、图像或 MCP 参数；首版 PDF 统一使用提取文本/MinerU。
- 官方说明 Coding Plan 只限指定工具/产品环境；AI Butler 只承诺协议兼容，不承诺订阅额度资格或用量价格。

### Claude Code CLI 规则

- CLI 调用必须采用非交互模式：`-p`、`--output-format stream-json`、`--permission-mode plan`、`--restricted`、`--no-session-persistence`、`--max-turns 1`、`--no-chrome`。
- 仅把最终 assistant 文本和必要的 session/turn 诊断交给 AI Butler；不允许 CLI 在仓库或 Zotero 数据目录执行写入、命令或 MCP 工具。
- 二进制路径支持绝对路径和受控 path search；检测不到 `--restricted` 等能力时直接失败并给出版本升级提示。
- Claude Code Pro/Max 登录不转换成 API Key，也不读取或复制 Claude 凭据文件。

## 4. 数据模型与兼容性

保留现有 `LLMEndpoint.providerType` 作为 transport 类型，增加可选 `codingPlanVendor`/`codingPlanProfile` 字段；Kimi 与智谱的 transport 仍分别为 `openai-compat`，Claude CLI 使用新增 `claude-code-cli` provider。旧 endpoint 缺少新字段时行为完全不变。

```ts
type CodingPlanVendor = "kimi-code" | "zhipu-glm-coding" | "claude-code-cli";
type CodingPlanProtocol = "openai-chat" | "anthropic-messages" | "claude-cli";

interface CodingPlanProfile {
  id: CodingPlanVendor;
  label: string;
  protocol: CodingPlanProtocol;
  defaultApiUrl?: string;
  defaultModel: string;
  requiresApiKey: boolean;
  supportsStreaming: boolean;
  supportsPdfBase64: false;
  notes: string;
}
```

新增字段必须是 optional；旧 JSON、旧 preferences 和现有 API provider 不得被强制迁移。Kimi/智谱 profile 只提供默认值，用户保存后的 `apiUrl`、`apiKey`、`model` 仍是实际运行来源。

## 5. 安全、数据和队列边界

- 所有 Coding Plan HTTP 请求仅发送已提取文本/Markdown；拒绝 Base64、原始 PDF 文件和图片摘要。
- MCP 默认关闭且 fail-closed；不因供应商宣称支持 MCP 而自动启用。
- Sol/Luna 队列合同仍由 `gpt-5.6-sol/high` 负责规划与独立验收，`gpt-5.6-luna/max` 只执行有界子任务；Coding Plan provider 不得绕过 note-write gate。
- 账本只记录供应商 profile、模型、请求状态、脱敏诊断和 source hash；不记录 API Key、Bearer token、全文、CLI prompt 或绝对路径。
- 失败、超时、取消、401/403、额度限制和不支持参数必须保留机器可读错误码；不能静默切换到另一供应商并伪装成功。

## 6. 测试与验收

必须通过：

1. profile 默认值、URL/model normalization、API Key 必填/不进入 Codex rotation、旧 endpoint migration。
2. Kimi/智谱 OpenAI payload、模型特定 reasoning 参数、流式/非流式响应、401/429/超时和 Base64 拒绝。
3. Claude CLI 参数构造、JSONL/stream-json 解析、stderr 脱敏、退出码、取消、超时、版本/能力检查。
4. 现有 provider、Codex queue、ledger、Sol/Luna gate、i18n、build 和 Zotero harness 全部回归。
5. 有凭据时才执行真实 Kimi/GLM/Claude smoke；没有凭据时明确标记为未验证，不把 profile 存在当作连接成功。

## 7. 非目标

- 不实现 Kimi Code CLI 或 GLM 专属 CLI；它们的 HTTP API profile 已足以接入 AI Butler。
- 不实现第三方 Coding Plan 的 MCP 工具写入、自动修改 Zotero 库或代码仓库。
- 不把 Coding Plan 订阅资格、价格、额度和服务端模型能力写死为永久事实。
- 不修改 `/Users/alater/Zotero`、已安装 XPI、用户认证文件或远程仓库。

## 8. 回滚

新 profile 默认不启用；删除/停用 profile 即可恢复原路由。源码只在独立 Git 分支提交；每个任务有独立 commit、测试和审查记录，失败时回退到该任务前的 commit，不覆盖生产 profile。
