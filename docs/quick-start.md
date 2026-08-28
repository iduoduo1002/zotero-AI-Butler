# 快速开始

本指南将帮助您在 5 分钟内完成 Zotero AI Butler 的安装与配置。

## 1. 安装插件

1. 访问 [GitHub Releases 页面](https://github.com/steven-jianhao-li/zotero-AI-Butler/releases)
2. 下载最新版本的 `.xpi` 文件
3. 打开 Zotero，点击菜单 **"工具"** → **"插件"**
4. 将下载的 `.xpi` 文件拖拽到插件窗口中，完成安装

## 2. 配置 API

> 本项目为开源平台，**不提供**大模型 API 密钥，需自行根据需求选择大模型平台并获取 API 密钥。

1. 在任意论文条目上右键 → **"AI 管家仪表盘"**
2. 进入 **"快捷设置"** 选项卡
3. 进入 **模型平台** 页面，添加或展开您的 AI 平台（例如 Google Gemini）
4. 填入 API 密钥和模型名称，点击 **"测试连接"** 确认可用

> 💡 **提示**：详细的 API 配置方法请参阅 [API 配置指南](api-configuration.md)

Google Gemini 官方 API 配置示例：

![Google Gemini 官方 API 配置示例](images/quick-start-google-gemini-api-config.png)

5. 在对应模型详情中使用 **"测试连接"** 按钮测试连接是否成功。

Google Gemini 官方 API 测试连接成功示例：
![Google Gemini 官方 API 测试连接成功示例](images/quick-start-google-gemini-api-test.png)

> ⚠ 若使用第三方中转平台，测试连接成功并不代表大模型 API 可用，需以实际功能为准。

## 3. 配置本机 Codex App Server（可选）

Codex App Server endpoint 使用当前操作系统用户的 Codex 登录状态，不在 Zotero 中填写 API 地址或 API 密钥。它适合希望由本机 Codex 负责规划、执行和验收的工作流。

### 3.1 登录 Codex

在与 Zotero 相同的操作系统用户下，在终端执行：

```bash
codex login
codex login status
```

第二条命令应显示当前登录状态。不要把认证文件、token 或完整终端日志复制到问题报告中。

### 3.2 添加 endpoint

1. 打开 **AI 管家仪表盘 → 快捷设置 → 模型平台**。
2. 添加 **Codex App Server（本机登录）**。
3. **Codex 二进制路径**可以留空，让 Zotero 的进程接口自动查找 `codex`；如果自动查找失败，填写 Codex 可执行文件的绝对路径。Zotero 启动的进程不会继承您终端中所有的 shell `PATH`，因此绝对路径是可靠的回退方案。
4. 选择角色并确认模型与推理强度：Sol 为 `gpt-5.6-sol` + `high`，Luna 为 `gpt-5.6-luna` + `max`。除非您明确知道账号和模型服务支持其他组合，否则保留角色默认值。
5. 默认保持审批 `on-request`、沙箱 `read-only`、网络访问关闭。
6. 点击 **测试连接**。此按钮会尝试一次 Codex App Server `initialize` 和最小 `Say OK` 回合；看到成功提示只说明本次连接测试成功，不等于已完成真实 Zotero 文献任务。

Codex endpoint 的 PDF 处理方式固定为 **文本**：provider 拒绝 Base64 PDF，且不会把全局 Base64 设置静默转换为可用的文件上传。若调用方明确选择并支持 MinerU，可先生成 Markdown，再以文本发送；当前 Codex endpoint 设置页不提供 MinerU 选项。

首版 **MCP 通道保留但不可用**，设置项锁定为关闭。手工写入 `mcpEnabled: true` 会被运行时拒绝（fail-closed），不会因此连接 Zotero 工具。

关于审批、沙箱、网络和数据驻留的边界，请参阅 [Codex App Server 配置指南](codex-app-server.md)。

## 4. 开始使用

配置完成后，有两种主要使用方式：

### 方式一：自动扫描新论文

开启此功能后，当您向 Zotero 添加新论文时，AI 管家会自动将其加入总结队列。

**开启步骤**：

1. 打开 **"AI 管家仪表盘"**
2. 点击 **"🚀 开始自动扫描"**
3. 设置保存后即刻生效

![开启自动扫描功能](images/quick-start-auto-scan.png)

开启后，拖入新 PDF 论文时将自动进入任务队列：

![自动扫描效果演示](images/在仪表盘中开启自动扫描新文献功能后，AI管家会自动处理新添加的论文.gif)

### 方式二：扫描未总结 / 未精读论文（批量补齐库中已有文献）

对于已存在于 Zotero 中的旧论文，可以使用批量扫描功能分别补充 **AI 总结** 或 **AI 精读**。

**使用步骤**：

1. 打开 **"AI 管家仪表盘"**
2. 点击 **"🔍 扫描未总结论文"** 或 **"📚 扫描未精读论文"**
3. AI 管家会按目录结构列出所有缺少对应笔记的论文
4. 勾选需要分析的论文（可按目录全选）
5. 点击 **"添加到队列"**

![扫描未总结或未精读论文](images/quick-start-scan-library.png)

![批量添加到队列](images/quick-start-batch-add.png)

## 下一步

- 了解更多 API 配置选项：[API 配置指南](api-configuration.md)
- 遇到问题？查看：[常见问题 FAQ](faq.md)
