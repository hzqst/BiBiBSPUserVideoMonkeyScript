# CLAUDE.md

本文件只保留「每次会话都必须遵守的项目硬规则 + 导航」。完整上手信息在 `AGENTS.md`，架构详解在 `docs/development.md`，**动手前请先读这两个**。

## 项目一句话

哔哩哔哩屏蔽增强器（BIBIShield v2）——注入 B 站页面的 Tampermonkey 用户脚本，TypeScript + Vue 2.7 + Rollup，源码在 `src/web/`，产物是单文件 `dist/local_build.js`。

## 硬性规则

### 改动边界

- **只改 `src/`（必要时 `plugin/`、`scripts/`、`tamper_monkey.json`）。不要直接改 `dist/local_build.js`**——它是构建产物，不入库，改了会被覆盖。
- 不要擅自改动构建契约：`rollup.config.mjs` 的 `external` / `output.globals`、`tsconfig.json` 的 `paths`。
- 上游更新频繁，改动尽量小、聚焦单一目的，降低合并冲突。

### 构建与验证

- 包管理器**只用 pnpm**。
- 声称「完成 / 通过 / 可提交」之前，必须跑过 `pnpm build`。这是本项目**唯一的自动化关卡**（`rollup.config.mjs` 的 `type-check` 插件执行 `tsc --noEmit` + `scripts/check-vue-types.mjs`，失败即构建失败）。
- 本项目**没有 CI、没有 lint、没有测试框架**。类型检查证明不了运行时正确性。
- 涉及 B 站 DOM 选择器、接口路径、屏蔽判定、UI 面板的改动，**必须真实浏览器验证**。你通常做不到（需装 Tampermonkey + 登录 B 站），此时**必须明确说明「仅类型检查通过，未做运行时验证」**，不得含糊声称功能正常。
- 依赖版本浮动（`pnpm-lock.yaml` 不入库，`package.json` 用 `^`），排查「本地构建与线上产物不一致」先想到这条。

### 代码约定

- 注释与文档用**中文**，风格跟随既有文件。
- 相对导入**写全 `.ts` 扩展名**；路径别名统一用 `@/`（→ `src/web/`）。
- 类型虽为 `strict`，但既有代码大量使用 `any`（B 站返回结构不确定）。**保持现状，不要顺手做类型收紧式重构**。
- 新增配置项：在 `state/localMKData.ts` 加一对 getter/setter 并**显式给出默认值**，再在 UI 视图暴露。
- `vue` / `dexie` 通过用户脚本头部 `@require` 以全局变量注入，属于 `external`。新增第三方库需同步改三处：`tamper_monkey.json` 的 `require`、`rollup.config.mjs` 的 `external` 与 `output.globals`。
- 改版本号只改 `tamper_monkey.json` 的 `@version`；产物固定名为 `dist/local_build.js`，发布时需手动改名。

### Commit

格式 `<type>(scope): <中文摘要>`；type 用 `feat` / `fix` / `refactor` / `docs` / `chore`，scope 英文小写小词（如 `comments`、`live`、`home`、`danmaku`、`rule`、`dev`、`build`）。

### 远端

`origin` 指向 fork `hzqst/BiBiBSPUserVideoMonkeyScript`，上游 `hgztask/BiBiBSPUserVideoMonkeyScript` **未配置 remote**。不要擅自 push 或改远端配置，先与用户确认。

## 已知问题（别被文档误导）

- **dev 模块没有被剥离出生产包**：`plugin/rollup-test-plugin.ts:39` 判断的是 `id.endsWith('dev.js')`，而 dev 模块早已是 `.ts`，该分支永不匹配，导致 WebSocket 客户端和 `unsafeWindow` 调试句柄进入产物。详见 `AGENTS.md` §7.1。
- `docs/development.md` §6.1 称 `tamper_monkey.json` 键名不带 `@` 前缀——**错的**，实际都带。
- `docs/development.md` §7.3 称生产构建会剥离 dev 代码——**当前未生效**。

## 导航

| 要找什么 | 去哪 |
|---|---|
| 脚本入口 / 启动顺序 | `src/web/main.ts` |
| 页面路由分发 | `src/web/router.ts` |
| 屏蔽判定引擎 | `src/web/domain/shielding/main.ts`（场景入口 `video.ts` / `comments.ts` / `live.ts`） |
| 响应层过滤范式 | `src/web/domain/*ResponseRewrite.ts`（四件套，统一双层架构） |
| 全部用户配置项 | `src/web/state/localMKData.ts` |
| 事件总线语义 | `src/web/core/EventEmitter.ts`（`send` 与 `emit` 语义不同，易用错） |
| 网络监听分发 | `src/web/domain/observeNetwork.ts` |
| 构建配置 | `rollup.config.mjs`、`plugin/` |
| 架构详解 | `docs/development.md` |
