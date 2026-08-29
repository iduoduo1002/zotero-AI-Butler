# Coding Plan 供应商指南

本文同时提供中文和 English 说明。Coding Plan profile 的目标是复用成熟协议，
不是把第三方订阅资格、额度、价格或模型能力写死为插件承诺。

## 中文

### 支持范围

| 设置项       | Kimi Code                                         | GLM Coding Plan                               | Claude Code CLI          |
| ------------ | ------------------------------------------------- | --------------------------------------------- | ------------------------ |
| profile      | `kimi-code`                                       | `zhipu-glm-coding`                            | `claude-code-cli`        |
| 协议         | OpenAI Chat Completions                           | OpenAI Chat Completions                       | 本机 CLI / `stream-json` |
| 默认完整地址 | `https://api.kimi.com/coding/v1/chat/completions` | `https://open.bigmodel.cn/api/coding/paas/v4` | 不适用                   |
| 默认模型     | `kimi-for-coding`                                 | `glm-5.3`                                     | `sonnet`                 |
| 认证         | Kimi Code API Key                                 | GLM Coding Plan API Key                       | 本机 Claude Code 登录    |

在 **快捷设置 → 模型平台** 添加 profile 后，保留默认完整 endpoint/model，
只有在供应商文档和账号实际支持时才改为其他值。Kimi/GLM 的 URL、API Key 和模型字段
均可编辑；Claude CLI 隐藏 API URL/API Key，只显示二进制路径、模型、权限与输出设置。

### Claude Code CLI 安全边界

每次调用都是独立的非交互文本回合，使用固定安全参数：

```text
-p --output-format stream-json --permission-mode plan --restricted
--no-session-persistence --max-turns 1 --no-chrome
```

设置页将权限模式锁定为 `plan`，`--restricted` 和 `stream-json` 始终开启；不支持这些
参数的 CLI 版本会 fail-closed，并给出升级提示。AI Butler 不读取、复制或转换 Claude
凭据文件，不把 Pro/Max 登录状态伪装成 Anthropic API Key，也不会启用 resume、MCP、命令
执行或写文件工具。模型字段记录用户选择，但 CLI 实际模型可用性仍由本机登录状态和 CLI
版本决定。

### PDF、MCP 和队列门禁

三类 profile 均只接收 Zotero 提取文本或 MinerU Markdown。Base64 PDF、原始 PDF 文件、
图片输入和 MCP 均关闭；设置页只提供“文本提取”和“MinerU”。这些限制由运行时再次校验，
不能通过手工修改 endpoint JSON 绕过。

Coding Plan profile 不改变任务队列的 Sol/Luna 语义：若任务使用 Codex App Server，
仍由 `gpt-5.6-sol/high` 规划与独立验收，由 `gpt-5.6-luna/high` 执行有界子任务（队列为
避免长文 `max` 推理超过回合上限而采用 high），最终
写入笔记前必须通过 note-write gate。供应商 API Key 不进入日志、账本、笔记 metadata
或 CLI 参数；笔记只追加可选 vendor/profile 标识。

### 资格与故障排查

“OpenAI 兼容”只说明请求协议可复用，不等于 Kimi Code 或 GLM Coding Plan 订阅允许
AI Butler、当前模型或当前额度。遇到 401/403，重新核对 profile、API Key 来源和订阅
资格；遇到 429，检查额度、限流和重试上限；不要把密钥或完整请求体复制到 issue。

Claude 测试失败时，先在与 Zotero 相同的操作系统用户下只读检查 `claude --version`
和本地登录状态，再把 CLI 的绝对路径填入设置。若错误指出 restricted/stream-json
参数不支持，应升级 CLI；插件不会自动移除参数，也不会使用任意危险参数代替。

连接测试成功只证明一次短文本调用成功，不证明真实 PDF、额度、长文本或最终笔记任务
已经通过。真实供应商 smoke 需要用户明确配置凭据后单独记录。

### 回滚

停用或删除对应 Coding Plan endpoint 即可回到已有 OpenAI、Anthropic、Gemini、OpenRouter、
火山方舟、Ollama 或 Codex endpoint。若需要源码回滚，回退 `feat: expose coding plan providers in settings`
提交前的版本；不要删除用户 preferences、凭据文件或生产 Zotero 数据。

## English

### Supported profiles

Kimi Code uses the full OpenAI-compatible endpoint
`https://api.kimi.com/coding/v1/chat/completions` and defaults to `kimi-for-coding`.
GLM Coding Plan uses the full OpenAI-compatible endpoint
`https://open.bigmodel.cn/api/coding/paas/v4` and defaults to `glm-5.3`.
Both require their vendor API key. Claude Code CLI uses the local authenticated
`claude` executable and defaults to `sonnet`; its API URL and API key fields are hidden.

### CLI and data boundaries

Each Claude call is one non-interactive text turn with fixed `plan`, `--restricted`,
`stream-json`, no session persistence, one max turn, and no Chrome. Unsupported CLI
versions fail closed. Claude credentials are never read or converted into API keys.
All profiles accept extracted text or MinerU Markdown only; Base64 PDFs, raw files,
images, and MCP are disabled. Coding Plan protocol compatibility does not guarantee
subscription entitlement, quota, pricing, or model access.

The existing Sol planning/Luna execution/independent acceptance and note-write gate
remain unchanged. API keys are excluded from logs, ledgers, note metadata, and CLI
arguments; notes may contain only optional vendor/profile identifiers.

### Troubleshooting and rollback

For 401/403, check the profile and vendor credential. For 429, check quota and rate
limits. For Claude failures, verify the CLI version and local login under the same OS
user as Zotero, then pin an absolute binary path. Do not remove safety flags to make a
test pass. A successful connection test proves only one short text request. Disable or
delete the profile endpoint to return to the existing providers; source rollback is the
commit immediately before `feat: expose coding plan providers in settings`.
