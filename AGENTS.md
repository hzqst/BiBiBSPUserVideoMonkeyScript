# AGENTS.md

面向 AI Agent 的项目上手文档。目标：让你在**不读完整仓库**的情况下，知道去哪看、怎么改、怎么验证、哪里会踩坑。

阅读顺序：

1. 本文（操作性信息、约定、坑）
2. `docs/development.md`（详尽的架构与启动流程说明，本文件不复述其内容）
3. `README.md`（面向用户的功能清单）

> 本文写于 commit `db0ab2d`（`@version 2.18.1`）。若与代码不一致，以代码为准，并顺手修正本文。

---

## 一、项目是什么

**哔哩哔哩屏蔽增强器**（BIBIShield v2）：一个 Tampermonkey / ScriptCat 用户脚本，在 B 站页面按用户配置的规则屏蔽视频、评论、动态、直播间、弹幕等内容。

一个关键认知：**它不是普通网页应用，而是注入到第三方站点（B 站）的脚本**。因此：

- 所有输入来自 B 站 DOM 和 B 站接口，**随时可能变**，静态分析无法证明正确性
- 屏蔽时机分两类：DOM 层（渲染后移除，可能闪现）与**响应层**（改写接口响应，渲染前剔除）
- 大部分功能靠 `MutationObserver` / `PerformanceObserver` / 定时轮询驱动，而非框架生命周期

## 二、速查

| 项 | 值 |
|---|---|
| 语言 | TypeScript（`strict: true`，`target: ES2021`） |
| UI | Vue 2.7 + Element UI（均为**外部依赖**，见 §六） |
| 构建 | Rollup + esbuild + Less |
| 包管理器 | **pnpm**（不要用 npm/yarn） |
| 源码入口 | `src/web/main.ts` |
| 构建产物 | `dist/local_build.js`（IIFE，单文件） |
| 版本号来源 | `tamper_monkey.json` 的 `@version` |
| 路径别名 | `@/` → `src/web/` |
| 注释语言 | 中文 |

## 三、命令

```bash
pnpm install        # 安装依赖（首次）
pnpm build          # 生产构建 → dist/local_build.js
pnpm watch:dev      # 监听重建 + 静态服务 localhost:3000
pnpm ws             # WebSocket 热更新服务 ws://127.0.0.1:9000
```

- 生产构建会清空注释、`compact` 压缩（但 `minify: false`），并在文件头拼接 `// ==UserScript==`
- 开发构建保留注释、内联 source map
- `pnpm ws` 走 `src/test/main.ts` 入口，把代码推给已开页面 `eval` 执行，用于快速验证探针

## 四、质量门禁与验证（最重要的一节）

**这个仓库没有 CI、没有 lint、没有测试框架、没有 pre-commit 钩子。** 唯一的自动化关卡是类型检查，由 `rollup.config.mjs` 里的 `type-check` 插件在 `buildStart` 执行：

1. `pnpm exec tsc --noEmit`（检查 `.ts`）
2. `node scripts/check-vue-types.mjs`（把 `.vue` 里的 `<script lang="ts">` 抽成临时文件后再跑 tsc，忽略 `TS2307`）

两者任一失败都会 `this.error()` **让构建直接失败**，dev 与生产模式都会触发。

由此得到的验证纪律：

| 改动性质 | 最低验证 | 说明 |
|---|---|---|
| 纯类型/重构 | `pnpm build` 成功 | 类型检查通过即是最强静态证据 |
| 改 B 站选择器 / 接口路径 / 屏蔽判定 | `pnpm build` + **浏览器实测** | 静态检查证明不了 DOM 与接口是否还对得上 |
| 改 UI 面板 | `pnpm build` + **浏览器实测** | 同上 |

⚠️ **Agent 默认无法完成浏览器实测**（需要装 Tampermonkey、登录 B 站、打开对应页面）。因此：

- **不得**在只跑了 `pnpm build` 的情况下声称「功能正常」「已修复」
- 必须明确写出：类型检查已通过，但运行时行为未在真实页面验证
- 如需真实页面调试，可借助 `server/cdpClient.mjs`（见 `git log` 中 `feat(dev): 新增 CDP 页面调试客户端 cdpClient`）

## 五、目录与分层

```
src/web/
├── config/    静态配置：globalValue.ts（URL/常量）、ruleKeyListData.ts（规则键）、video_zoneData.ts
├── types/     共享类型：http / shielding / storage / video
├── core/      基础设施，不含业务：cache、http、util、EventEmitter、elEventEmitter、BilibiliEncoder
├── domain/    领域逻辑：shielding/（屏蔽引擎）、*ResponseRewrite、observeNetwork、watchUtil…
├── state/     localMKData.ts（GM 存储封装，所有配置项 getter/setter）、elData.ts
├── pages/     页面入口层：home / video / live / search / space / dynamic / message / popular / history
├── ui/        Vue 视图、组件、弹窗、样式；init.ts 挂载；App.vue 主面板
├── dev/       开发辅助（**注意 §七.1，当前未被剥离出生产包**）
├── main.ts    入口
├── router.ts  基于 URL 的路由
└── menu.ts    TM 菜单注册
```

分层依赖方向：`ui` / `pages` → `domain` → `core` → `types`。`state/localMKData.ts` 被各层广泛读取，属于事实上的全局配置中心。`config/` 是静态数据。**新增代码请遵守该方向，不要在 `core/` 里引入业务逻辑。**

各页面模型普遍暴露 `isUrlPage(url)` / `run()` 形态，由 `router.ts` 分发。

## 六、改动前必须知道的机制

### 6.1 启动流程

`src/web/main.ts` 先做一批**模块副作用导入**（顺序即注册顺序，见文件顶部），再在 `window.load` 时 `router.staticRoute()`，并启动 `watchUtil` 的 URL 变化与网络监听。新增全局功能通常要在这里挂一行导入，**漏挂就是静默失效**。

### 6.2 路由两阶段

- `staticRoute(title, url)`：首次进入页面，执行完整页面初始化
- `dynamicRouting(title, url)`：SPA 内跳转（URL 变、页面不刷新），只做部分逻辑

URL 变化靠 **每 1000ms 轮询 `location.href`** 检测，不是 History API 监听。SPA 路径下新增功能要同时考虑这两个入口。

### 6.3 EventEmitter 两种事件语义

`core/EventEmitter.ts` 是全局单例事件总线，分成两组语义，**容易用错**：

- 常规事件：`on` / `send`（经 `onPreHandle` 预处理，无订阅者时进 futures 队列待补发）/ `emit`（不过预处理、不缓存、无订阅者静默丢弃）/ `sendDebounce` / `sendAsync` / `emitAsync`
- 回调事件：`handler` + `invoke`（返回 Promise，轮询等 handler 注册），用于请求-响应

要点：需要「发布者先于订阅者执行也不丢事件」时必须用 `send`/`sendAsync`，用 `emit` 会丢。

### 6.4 响应层过滤的统一模式

`domain/` 下已有四件套：`homeResponseRewrite.ts`、`searchResponseRewrite.ts`、`commentResponseRewrite.ts`、`liveSectionResponseRewrite.ts`。它们遵循同一套双层架构，**新增响应层过滤请照抄这个模式**：

1. **页面上下文 fetch hook**：注入 `<script>`，因为 B 站页面的请求发生在页面 window 上，沙箱内的 hook 拦不到
2. **postMessage 往返判定**：hook 把待判定条目经 `postMessage` 发往沙箱，沙箱复用 `domain/shielding/*` 规则引擎逐项判定，回传命中索引
3. **超时放行**：判定超时（各模块 800ms / 2000ms 不等）或改写异常时**放行原始响应**并 `console.warn('[station-b-shield] ...')`，退化为 DOM 层兜底
4. **来源标记与去重**：屏蔽记录经事件输出到面板并标记【响应层过滤】；同一条目在同页重复请求时按指纹/rpid 去重

各模块自带 `install()` 入口与开关（存在 `localMKData`），且被 `main.ts` 无条件 import —— **开关判断在模块内部**，不要以为加了 import 就等于开启功能。

### 6.5 屏蔽引擎契约

`domain/shielding/main.ts` 导出大量成对的 `blockXxx` / `asyncBlockXxx`，返回：

```ts
interface BlockResult {
    state: boolean;   // true = 需要屏蔽
    type?: string;    // 匹配到的规则类型
    matching?: string | number | boolean;
    msg?: string;
}
```

`video.ts` / `comments.ts` / `live.ts` 是各场景的组合判定入口，响应层与 DOM 层**共用同一套判定函数**。改判定逻辑时注意两个调用方都会受影响。

### 6.6 存储分层

| 存储 | 位置 | 用途 |
|---|---|---|
| `GM_setValue/GM_getValue` | `state/localMKData.ts` | 用户配置、开关。每个配置项一对 getter/setter，默认值用 `def*` 常量 |
| IndexedDB (Dexie) | `core/cache/bvDexie.ts` | 视频元数据缓存，带 TTL |
| 内存 | `core/cache/valueCache.ts` | 轻量缓存 |

新增配置项：在 `localMKData.ts` 加 getter/setter（含默认值）→ 在 UI 视图暴露 → 在业务处读取。**默认值必须显式给出**，不要依赖 `undefined`。

## 七、已知坑与不一致（截至 `db0ab2d`）

### 7.1 【已确认】dev 模块没有被剥离出生产包

`docs/development.md` 声称生产构建会剥离 `dev.js`。**实际没有生效。**

- 判定处：`plugin/rollup-test-plugin.ts:39` 写的是 `id.endsWith('dev.js')`
- 但 dev 模块早已从 `.js` 迁移为 `.ts`（`beecff9` 引入 `src/web/dev/dev.js`，`23fb8b4` 改为 `src/web/dev/dev.ts`），`plugin/tsResolve.ts` 解析出的 `id` 以 `dev.ts` 结尾
- 该分支**永远不匹配**，且 `main.ts` 对 `./dev/dev.ts` 的导入是无条件的

后果：`unsafeWindow.mk_window` / `elUtil` / `urlUtil` / `wsBuild` 以及整个 WebSocket 客户端（含 `ws://127.0.0.1:9000` 的 2s 自动重连逻辑）都会进入生产产物。实际是否真的发起连接仍受 `debuggerManagement.isWsService()` 开关约束，默认不连。

证据：`docs/development.md` §7.3 的描述与代码不符；且手头那份官方 2.18.1 产物中确实能找到 `connectWebSocket` / `wsBuild` / `mk_window`（注：该产物的来源 commit 未通过本地构建复现，仅作佐证）。

修复方向：把判定改为匹配 `dev/dev.ts`（空模块即可，`webWs.ts` 会随引用消失而被 tree-shake）。

### 7.2 `docs/development.md` 关于 `tamper_monkey.json` 的描述有误

文档 §6.1 说「键名不带 `@` 前缀」。实际 `tamper_monkey.json` 中 `@name` / `@version` / `@grant` / `@match` 等**都带 `@` 前缀**，另有 `alias`、`homepage` 两个不带前缀的字段。

### 7.3 版本号与产物名

- 改版本只改 `tamper_monkey.json` 的 `@version`
- 构建产物固定叫 `dist/local_build.js`，发布时需要**手动改名**为 `哔哩哔哩屏蔽增强器-<version>.js`（仓库没有自动改名脚本）

### 7.4 依赖版本浮动

`.gitignore` 排除了 `pnpm-lock.yaml`，且 `package.json` 用 `^` 范围。**同一 commit 在不同时间两次构建可能得到不同产物**。排查「本地构建结果与线上产物不一致」时先想到这条。

### 7.5 `vue` 与 `dexie` 是外部依赖，不能被打包

二者通过用户脚本头部的 `@require` 从 CDN 以全局变量 `Vue` / `Dexie` 注入：

- `rollup.config.mjs` 的 `external: ['vue', 'dexie']` 与 `output.globals` 必须与之保持一致
- 新增第三方库同理：加 CDN `@require` + 加 `external` + 加 `globals`，否则会被打进产物或运行时报 `undefined`
- `core/externalLibraryVerification.ts` 负责校验外部库是否加载成功

### 7.6 其他

- `rollup.config.mjs` 的 `clearComments` 用正则 `/^\s+\/\/.*|^\/\/.*|\/\*[\s\S]*?\*\//gm` 处理**最终产物**，会删掉任何以 `//` 开头的行。若产物中出现该类字符串（模板字符串跨行 `//`），有被误删的风险。
- `config/globalValue.ts` 里的 `wsLocalHost`（`ws://localhost:3011`）与 `dev/webWs.ts` 实际使用的 `ws://127.0.0.1:9000`、`server/wsServer.ts` 的 `PORT = 9000` 不一致，前者当前是死值。
- 主面板快捷键默认反引号键（`` ` ``），可在设置面板自定义；配置项在 `localMKData.ts` 的 `getDrawerShortcutKey` 附近。
- Tampermonkey 元信息里含 `*://localhost:5173/*` 这类开发用 `@match`，改动 `@match` 时注意不要误删线上必需项。

## 八、约定

### 8.1 Commit

格式：`<type>(scope): <中文摘要>`，摘要描述**做了什么、为什么**，可写多句。

- 常用 type：`feat` / `fix` / `refactor` / `docs` / `chore`
- scope 用英文小写小词，历史实际用过：`comments`、`live`、`home`、`video`、`danmaku`、`rule`、`ui`、`dev`、`build`、`plugin`、`core`、`response`、`debug`、`types`
- 示例（摘自真实历史）：
  - `feat(comments): 评论区响应层全局安装并合并响应过滤开关`
  - `fix(danmaku): 限制弹幕屏蔽仅在视频播放页生效`
  - `refactor(build): 提取 tsResolve 插件为共享模块供主构建与 ws 测试构建共用`

### 8.2 代码

- 注释与文档用**中文**，风格跟随既有文件（导出的配置 getter 用 `/** ... */` 写明用途与默认值）
- 相对导入**带 `.ts` 扩展名**（`allowImportingTsExtensions: true`，tsResolve 也支持补全，但既有代码统一写全）
- 路径别名统一用 `@/`，不要写 `../../..`
- 项目虽开 `strict`，但既有代码大量使用 `any`（B 站返回结构不确定）。**保持现状，不要顺手做类型收紧式重构**——那会扩大改动面且难以验证
- 每个配置开关在 `localMKData.ts` 里成对出现 getter/setter，命名沿用 `isXxxGm` / `getXxx` / `setXxx`

### 8.3 常见任务

「新增屏蔽规则」「新增页面适配」「改 TM 元信息」「改全局常量」的步骤，`docs/development.md` §10 已给出，直接照做。

## 九、协作边界

- **改 `src/`，不要改 `dist/local_build.js`**（产物不入库，且会被覆盖）
- 不要动 `plugin/`、`rollup.config.mjs`、`tsconfig.json`、`tamper_monkey.json` 的既有契约（如 `globals`、`paths`），除非任务本身就是改构建
- 本仓库是一个 fork：`origin` 指向 `hzqst/BiBiBSPUserVideoMonkeyScript`，上游 `hgztask/BiBiBSPUserVideoMonkeyScript` **未配置 remote**。要同步上游需自行 `git remote add upstream`
- 上游更新频繁（近期几乎每天有提交），改动尽量小、聚焦，降低与上游的合并冲突
