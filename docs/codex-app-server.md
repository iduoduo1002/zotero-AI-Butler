# Codex App Server 配置与验证指南

本文说明 AI Butler 的原生 `codex-app-server` endpoint 如何启动、传递内容和记录执行状态。它针对本机已安装的 Codex CLI；不要求在 Zotero 中填写 API URL 或 API key。

## 先明确两个边界

1. **进程本地 ≠ 模型本地。** AI Butler 在本机启动 Codex App Server 子进程，并通过 stdio JSONL 通信；但发送到 Codex 回合的提取文本，仍可能根据 Codex 账号、所选模型和服务条款发送到云端。`networkAccess: false` 只约束 Codex 沙箱中的网络策略，不能保证云端模型看不到已经发送的文本。
2. **首版不提供 Zotero MCP 工具。** MCP 通道在首版保留但强制关闭。不要把“看到 MCP 字段”理解为已经连接或授权了 Zotero 读写工具。

如果必须保证内容只在本机处理，请使用已经单独验证过的数据驻留方案（例如本地/局域网模型），并在对应 endpoint 选择文本或 MinerU；不能用 Codex endpoint 的沙箱开关替代本地模型隔离证明。

## 前置条件

- 已安装可执行的 Codex CLI，并确保它属于启动 Zotero 的同一操作系统用户。
- 在终端完成登录：

  ```bash
  codex login
  codex login status
  ```

- 用以下只读命令确认 CLI 可以识别 App Server 子命令和版本：

  ```bash
  codex app-server --help
  codex --version
  ```

这些命令不会替代插件内的真实连接测试。不要读取、打印或提交 Codex 认证文件和 token。

## 添加和配置 endpoint

在 **AI 管家仪表盘 → 快捷设置 → 模型平台** 添加 **Codex App Server（本机登录）**。Codex endpoint 不需要 API 地址或 API key；可用性由模型字段和本机 Codex 会话决定。

| 设置                 | 默认值                 | 说明                                                                                                                                    |
| -------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Codex 二进制路径     | 留空                   | 由 Zotero Subprocess 的路径查找接口自动发现 `codex`。发现失败时填写可执行文件的绝对路径；不要只填写一个 shell 别名或只依赖终端 `PATH`。 |
| 角色                 | `sol`                  | Sol 负责规划、整合和独立验收；Luna 负责合同范围内的受约束子任务。                                                                       |
| Sol 模型 / 推理强度  | `gpt-5.6-sol` / `high` | 任务合同、规划和验收的默认组合。                                                                                                        |
| Luna 模型 / 推理强度 | `gpt-5.6-luna` / `max` | 有界、可验证子任务的默认组合。                                                                                                          |
| 审批策略             | `on-request`           | Codex 请求需要操作时按请求审批；可选值还包括 `untrusted` 和 `never`。实际能力仍受本机 Codex 配置影响。                                  |
| 沙箱策略             | `read-only`            | 默认只读。可选 `workspace-write` 和 `danger-full-access`；后两者会扩大本地文件风险。                                                    |
| 网络访问             | 关闭                   | 只对支持该策略的沙箱生效；危险全权限模式不使用此单独开关。关闭也不改变云端模型的数据驻留边界。                                          |
| MCP 通道             | 关闭且锁定             | 首版保留字段但无传输实现；运行时对启用值 fail-closed。                                                                                  |
| PDF 处理方式         | `text`                 | Codex provider 不支持 Base64 PDF。UI 和 endpoint 归一化都会固定为 text。                                                                |

### 文本、MinerU 与 Base64

Codex v1 的 provider 能力是文本输入和流式文本输出，`supportsPdfBase64` 为 false。因此：

- 普通 PDF 任务先提取文字，再把文本/Markdown 放入 Codex 回合。
- Codex endpoint 的界面只显示 text；全局 Base64 设置不会覆盖这个限制。
- 如果调用方明确请求 `mineru` 且该调用路径支持 MinerU，MinerU 产出的 Markdown 可以作为文本输入；这不是向 Codex 上传原始 PDF，也不会使 endpoint 获得 Base64 能力。
- 直接把 Base64 标记或 PDF 上传模式传给 Codex provider 会返回不支持错误，任务应停在可解释的失败状态，不应静默回退到另一种输入。

图片摘要仍属于单独的图像服务能力；Codex endpoint 对 image-summary 明确标记为不支持，不会伪装成普通文本成功。

## 连接测试和执行生命周期

点击 **测试连接** 后，插件会为本次任务启动任务级 Codex 子进程，执行最小文本回合。正常任务的协议顺序是：

1. 启动 `codex app-server`，通过 stdio JSONL 发送 `initialize`。
2. 没有现成 thread 时发送 `thread/start`，再发送 `turn/start`。
3. 监听文本增量、命令/审批/工具诊断和 `turn/completed`。
4. 回合结束后关闭客户端并回收任务级子进程。

取消会尝试 `turn/interrupt`；如果 thread/turn id 尚未可用，会终止本次任务级进程。达到回合超时后先发起中断，再回收进程。关闭 Zotero 时，插件会清理已登记的 Codex 进程。

队列中的 Codex 任务还会保留 Sol 规划、Luna 执行和 Sol 验收的关系。只有验收为 `PASS` 且产物 probe 成功，才会写入最终 Zotero 笔记；`PARTIAL`、`BLOCKED`、取消、超时和解析失败都不会被写成成功。

## 审计信息与脱敏

Codex execution ledger 和笔记元数据可以关联以下最小信息：

- `executionId`、`parentExecutionId`、角色、模型、推理强度；
- `threadId`、`turnId`、必要的 request/事件诊断 ID；
- 审批策略、沙箱策略、网络开关和状态；
- 当前附件的 source SHA-256（如果读取附件成功则记录验证来源）、产物摘要和 probe 状态。

日志和诊断边界不包括 prompt、PDF 正文、PDF Base64、Bearer/API key 或绝对本地路径。复制连接详情、ledger 行或截图给维护者前，仍应人工检查是否含有本地环境信息。

## 故障排查

### `codex login status` 失败

重新执行 `codex login`，确认登录的是启动 Zotero 的同一操作系统用户。不要把 token 或认证文件复制到 Zotero 配置、endpoint 字段、Git 或问题报告中。登录状态正常也不保证所选模型有权限，仍需在 endpoint 中执行连接测试。

### 找不到 Codex 可执行文件

先在终端运行 `command -v codex`，再确认返回的是可执行文件而非失效链接或仅能由 shell 解释的别名。把最终可执行文件的**绝对路径**填入 Codex 二进制路径；留空时插件会请求 Zotero Subprocess 自动查找，但该查找受 Zotero 运行时环境影响。修改路径后重新点击 **测试连接**。

### 连接测试失败或提示 App Server 不可用

确认 `codex app-server --help` 能运行，并检查 endpoint 的模型、角色和推理强度。先保留 `on-request`、`read-only`、网络关闭，再逐项调整策略。测试失败时查看界面提供的短错误和状态，不要把服务端回显的 prompt 或全文写入日志。

### Base64 / `pdf-base64` 不支持

这是 Codex endpoint 的设计限制，不是 API key 错误。把该 endpoint 的 PDF 模式保持为 text；如果需要复杂排版，使用支持调用方显式选择的 MinerU 流程生成 Markdown。不要通过把全局模式改为 Base64 来绕过 fail-closed 检查。

### MCP 被拒绝

首版 MCP 通道没有可用传输，也没有 Zotero 工具授权。保持开关关闭；`mcpEnabled: true` 被拒绝是预期的安全行为，不要通过修改本地配置绕过它。

### 任务取消、超时或重试后状态不清楚

先等待任务状态落到取消、失败或可重试状态，再检查队列中的 execution/thread/turn 关联。重新打开 Zotero 后重新测试；不要在同一任务上同时启动多个回合。若怀疑进程残留，退出 Zotero 后确认没有由本插件启动的 Codex 子进程，再重新启动。对真实资料重试前，先用临时 profile 和测试条目。

### 测试套件与真实 smoke 的区别

provider/ledger 单元测试使用 fake process 或注入回调，只能验证协议、脱敏、门控和失败路径。`npm run build`、`npm run lint:check` 和 `npm test` 的结果也不能替代临时 Zotero profile 中的真实登录、连接测试、摘要/精读和笔记写入证据。没有真实 smoke 记录时，不要声称 demo 已通过。

## 回滚与恢复

### 使用者回滚

1. 在 endpoint 设置中停用或删除 Codex endpoint。
2. 将路由切回已验证的 API provider 或本地模型 provider。
3. 若只是在临时 profile 中测试，关闭该 profile 并恢复测试快照；不要用生产 profile 做批量回滚。
4. 已生成的 Zotero 笔记不因 endpoint 停用而自动删除；需要清理时先列出精确的测试条目并保留备份。

### 维护者回滚

保留原始 XPI、构建产物摘要和工作区提交作为回滚点。若需撤销本次文档/实现变更，应针对精确提交执行审查后的 Git 回滚，不使用覆盖生产目录的命令。不要把 `/Users/alater/Zotero` 当作开发安装目标，也不要在未确认 profile 快照前删除数据。

## 验证声明

本指南描述的是实现合同和操作路径，不是当前主机的成功证明。每次发布前应单独保存脱敏记录，至少包含：Codex CLI 登录状态、版本、help 退出码、绝对二进制路径是否解析、lint/build/test 退出状态、实际测试数和错误摘要，以及是否执行过真实临时-profile Zotero/Codex smoke。记录中不得包含 token、PDF 正文、完整本地路径或未经确认的 demo 结论。
