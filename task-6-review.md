# Task 6 review

结论：PASS

审查范围：基线 `90a7611`（beta3 release）至 `72f748d`，仅检查 Codex GUI PATH 修复及其测试；未修改源码，未访问生产 Zotero 或凭据。

## 证据

- `src/modules/llmproviders/codexAppServer/CodexAppServerProcess.ts:114-127` 仍通过 Zotero `Subprocess.call` 启动，参数严格为 `arguments: ["app-server"]`、`stderr: "pipe"`；没有引入 shell 或 Node `child_process`。
- `:133-162` 仅在 `Services.appinfo.OS === "Darwin"` 或 Mac 平台标识下构造环境；PATH 只前置 `/usr/local/bin`、`/opt/homebrew/bin`，并去重保留继承 PATH。非 macOS 返回 `undefined`，调用参数不注入环境字段。
- `:142-157` 先读取 `Services.env.get("PATH")`，失败或为空时回退 `process.env.PATH`；`environmentAppend: true` 保留未覆盖的继承环境（包括 `HOME`、`CODEX_HOME` 及认证相关变量）。
- `:180-194` 保持显式绝对路径直通；bare command 仍必须经 `pathSearch` 解析为绝对路径，否则 fail closed。修复只影响 macOS 启动环境，不改变 binary 选择边界。
- `test/codexAppServerProvider.test.ts:508-619` 覆盖 bare command、Mac PATH 前置与继承、`environmentAppend: true`、Linux 不注入环境；因此旧启动契约和跨平台分支均有静态回归证据。
- 独立验证：`npm run lint:check` 通过；`npx tsc --noEmit` 通过；`npm run build` 及 i18n 检查通过；`git diff --check` 通过。

## 限制与建议

测试未直接断言 `HOME`/`CODEX_HOME` 的实际值，也未单独执行 `Services.env.get` 抛错后 `process.env.PATH` 的 fallback 分支；这是覆盖增强项，不构成当前 Critical/Important 缺陷。不带 `ZOTERO_PLUGIN_ZOTERO_BIN_PATH` 的裸 `npm test` 会受本机 harness 的 `No Zotero Found` 阻断；随后使用显式 Zotero 路径运行完整 harness，357 项测试通过。该结果仍不等同于生产配置下的 Codex 真实连接测试。
