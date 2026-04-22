# Dualang 优化 TODO

## 待办（Code Review 遗留）

### Required

- [ ] **content/index.ts 类型补全**：`scanAndQueue` / `queueTranslation` / `handleSubBatchError` / `flushQueue` 局部变量 / `showStatus` / `hideStatus` / `showPassAndHide` / `showFail` / `injectTranslateButton` / `renderTranslation` / `perfLog` 仍为隐式 `any`。`TweetArticle` 已声明但 `(article as any)._dualangContentId` 处仍做 cast，要么全用 `TweetArticle`，要么删 `TweetArticle`。
- [x] ~~**统一单条与批量 API 的 system prompt**~~：已落地 — `composeSystemPrompt(profile, lang, { batch, strict, smartDict? })` 统一承担单条 / 批量 / 严格模式 / 字典融合四种变体，`doTranslateSingle` / `doTranslateBatchRequest` / `doTranslateBatchStream` 都通过它拿 prompt。
- [ ] **合并两处 `chrome.runtime.onInstalled` 监听**（background/index.ts:40 和 :51），空的 `chrome.alarms.onAlarm` handler 加一行注释说明"alarm 触发本身就是 keep-alive 的副作用，body 故意留空"。
- [ ] **清理未使用的 `enqueueTime`**：WeakMap 迁移后字段从 `_dualangEnqueueTime` 变成 `ArticleState.enqueueTime`，但仍只写入从未读取。要么删除、要么接入"排队等待时长"遥测。

### Suggestions

- [ ] **`setCache` 批量化**：`handleTranslateBatch` 成功路径里一个 for 循环串行 `await setCache`，每次都 `storage.get + storage.set`。加一个 `setCacheBatch(entries)`，合并成一次读 + 一次写。
- [ ] **`translationCache` 改真 LRU**：当前是 insertion-order FIFO，热门推文会被冷门推文的最近一次写入挤掉；`memCacheMap` 在 cache.ts 里做了 delete+reinsert 的 LRU，两边应一致。
- [ ] **`batchHash` 分隔符改 `\u0000`**：现在用 `\n---BATCH---\n`，如果推文正文含此字面值则会与另一批哈希碰撞（病态但非零概率）。
- [ ] **`LANG_DISPLAY['zh-TW']` 改为繁体字面**：`'繁体中文（台湾正体）'` 用简体字描述繁体，内部不一致 — 改成 `'繁體中文（台灣正體）'`。
- [ ] **`handleSubBatchError` 重试总是 `unshift` 到队首**：所有类型的重试都无条件进队列最前，可能让低优先级 retry 抢在新进视窗的高优之前。要么按原优先级重入队，要么加注释说明"重试优先于新请求是故意的"。
- [ ] **`inFlight` Map 无上限**：`background/index.ts:89` 的 `inFlight` 靠 `.finally()` 清理；绝大多数情况 SW 重启会一并清空。加一行注释说明这点，避免后人"修复"成 LRU 反而破坏不变式。

---

## 已完成

### P0 — 速度：消除关键路径 IO 瓶颈

- [x] **设置内存缓存**：`background.js` 每次翻译都 `chrome.storage.sync.get`，改为模块级变量缓存，`chrome.storage.onChanged` 时失效 ✅
- [x] **翻译两层缓存**：在 `chrome.storage.local`（L2）之上加内存 Map（L1，LRU 200 条），cache hit 零 IO 返回 ✅
- [x] **批量缓存并行读**：`handleTranslateBatch` 的串行 `for await getCache()` 改为一次 `getCacheBatch(hashes)`，单次 storage 读取 + 内存查表 ✅

### P1 — Token：减少无效 API 调用

- [x] **拆分并行 batch**：20 条一个请求改为每 5 条一批并行发送，首批 5 条结果先到先渲染 ✅
- [x] **完善语言检测**：补全繁体扩展区、区分日文（平假名/片假名）、阈值从 70% 降至 40% ✅
- [x] **文本规范化再 hash**：`normalizeText()` + `cacheKey()` 封装，两端（content/background）一致 ✅

### P2 — Token：更多跳过场景 & 测试修复

- [x] **扩展 skip 条件**：纯 URL（去 URL 后 < 6 字符）、纯 emoji/符号（无字母/汉字）跳过 ✅
- [x] **修复 mock HTML**：补全 `<a>` 链接、`<img alt>` emoji、操作栏、Show more、中文/繁体/纯 URL 推文 ✅
- [x] **补充测试场景**：简体中文跳过、繁体中文跳过、纯 URL 跳过、emoji img 提取、a 链接提取、Show more 重翻 ✅
- [x] **修复旧 mock 返回格式**：`---PARA---` 改为 `\n\n` ✅
- [x] **playwright.config.ts**：`python3` 改为 `uv run python3`（本地环境要求） ✅

### P3 — 功能完善

- [x] **实现目标语言设置**：popup 加 10 语言 `<select>`，background `LANG_DISPLAY` 动态 prompt，hash key 用真实 lang，content.js `isAlreadyTargetLanguage()` 感知目标语言 ✅
- [x] **手动翻译按钮 + 双语对照模式**：popup 加 `autoTranslate` 和 `bilingualMode` 开关；关闭自动翻译时显示「译」按钮；双语模式在译文上方插入原文段落 ✅
- [x] **支持 SiliconFlow GLM-4-9B-0414**：popup 加「快速配置」下拉框，一键切换 SiliconFlow 免费模型，manifest 新增 host_permissions ✅

### P4 — 批量翻译 & 速率控制

- [x] **整页批量翻译**：视口内推文合并为一次 API 请求（batch 20 / sub-batch 5），大幅降低并发请求数 ✅
- [x] **RateLimiter**：background.js 内实现并发/TPM/RPM/TPD 限流器，约束值：100 并发、500 RPM、3M TPM、无 TPD 限制 ✅
- [x] **首屏加速**：初始化扫描从 500ms 提前到 150ms，flush 调度从 50ms 降到 20ms，预加载边距 ±1 屏，请求 fire-and-forget ✅
- [x] **Show more 初版检测**：MutationObserver 检测推文文本区新增节点，自动移除旧翻译并重新排队（后在 P13 重构）✅

### P5 — 样式 & 渲染

- [x] **简化翻译样式**：删除蓝色背景、边框、padding、动画，翻译块继承 x.com 原生字体颜色，仅保留段落间距 ✅
- [x] **段落级翻译**：按 `\n\n` / `---PARA---` 拆分译文，每个段落独立 `<div class="dualang-para">`，保持阅读连续性 ✅
- [x] **失败图标**：右下角红色圆点带 ×，点击后高优先级重试；失败状态阻止自动入队 ✅

### P6 — API 错误处理 & 诊断

- [x] **Kimi API 错误分类捕获**：按官方文档处理 400/401/403/404/429/500+，区分 `engine_overloaded_error`（重试）、`exceeded_current_quota_error`（立即失败）、`rate_limit_reached_error`（按返回时间等待后重试）✅
- [x] **自动重试**：可重试错误最多 3 次指数退避，不可重试错误立即抛出中文提示 ✅
- [x] **性能日志**：content.js 内建 `perfCounters` + `perfLog`，每 10 秒输出 summary，覆盖 Observer 触发、队列、API RTT、渲染耗时等关键指标 ✅

### P7 — 配置管理

- [x] **外部配置文件**：新增 `config.json` 存放 Moonshot / SiliconFlow API Key，`.gitignore` 排除，代码通过 `chrome.runtime.getURL('config.json')` 动态读取 ✅
- [x] **配置模板**：新增 `config.example.json` 供开发者参考，不泄露真实 Key ✅

### P8 — 稳定性 & 性能补完

- [x] **Unobserve 已处理推文**：翻译完成或 pass/fail 后调用 `viewportObserver.unobserve()` + `preloadObserver.unobserve()`，避免长滚动中大量无效 Observer 回调 ✅
- [x] **Service Worker Keep-Alive**：content.js 建立持久 `chrome.runtime.connect` 端口；background.js 监听端口 + `chrome.alarms` 每分钟唤醒兜底；manifest 加 `alarms` 权限 ✅
- [x] **预加载防抖最大等待上限**：scheduleFlush 加 `_timerCreatedAt` 记录首次建 timer 时间；低优先级 timer 重置时检查已过 800ms 则立即 flush ✅
- [x] **补充测试**：新增 `status-and-reliability.spec.ts`，覆盖 pass 状态生命周期、loading→翻译完成、401 fail 点击重试、fallback popup 配置保存、fallback 自动切换共 5 个场景 ✅
- [x] **错误状态上报 popup**：background.js `reportFatalError()` 写入 `dualang_error_v1`；popup 打开时读取并展示红色可点击横幅，保存设置时自动清除；badge 红色 `!` 提示 ✅
- [x] **硅基流动免费 API 兜底**：`getSettings()` 加载 fallback 配置；`handleTranslateBatch` 在主 API 不可重试错误时自动切到 fallback；popup 新增兜底 API 配置区（开关/预设/Key/模型）；fallback 激活时 badge 显示橙色 `FB` ✅

### P9 — 架构重构

- [x] **esbuild + TypeScript 构建**：src/ 下 TypeScript 模块化开发，esbuild 打包为 IIFE 格式 content.js / background.js，globalSetup 自动构建，`@ts-nocheck` 全部移除，chrome-types 类型检查通过 ✅
- [x] **background.js 模块化**：拆分为 `cache.ts` / `settings.ts` / `rate-limiter.ts` / `api.ts` / `error-report.ts` + `index.ts` 薄编排层 ✅
- [x] **content.js 模块化 + withSlot RAII**：纯函数提取到 `utils.ts`，`withSlot()` 替代手动 activeRequests++/-- 消除漂移 bug ✅
- [x] **推文 ID 缓存**：`getTweetId()` 从 `/status/<id>` 链接提取推文 ID，`translationCache` Map 缓存翻译结果（500 条），虚拟 DOM 回收后重现的 article 零 IO 恢复翻译 ✅
- [x] **事件驱动调度器**：`scheduler.request(urgent?)` 替代 7 处散落的 `scheduleFlush()` 调用，`withSlot` 释放槽位时自动 drain 队列（urgent 80ms / normal 200ms / 满批次立即 / 800ms 硬上限）✅
- [x] **vitest 单元测试**：55 个测试覆盖 `isAlreadyTargetLanguage`、`shouldSkipContent`、`getTweetId`、`normalizeText`、`classifyApiError` 的所有分支 ✅
- [x] **流式批量翻译**：`enableStreaming=true` 时 content.js 通过 `chrome.runtime.connect('translate-stream')` 端口与 background 通信，SSE 流式解析 + `extractCompletedEntries()` 花括号计数增量 JSON 提取，每条翻译完成立即 `port.postMessage({action:'partial'})` 推送到 content 逐条渲染 ✅

### P10 — 压力测试发现的 4 个 bug

- [x] **不可重试错误传播**：`retryable` flag 在 background → content 完整传递，401/403/404 直接 showFail 不浪费 3 次重试 ✅
- [x] **JSON 截断部分恢复**：`doTranslateBatchRequest` 解析失败时调 `extractCompletedEntries` 做 partial recovery，能拿回的子批次先展示 ✅
- [x] **`scanAndQueue` 限流**：`pendingScanRoots` 只收集含 `article[data-testid="tweet"]` 的根节点，避免 X.com 每次 style/attr 变更都过一遍 querySelectorAll ✅
- [x] **`max_tokens` 估算**：非流式和流式两处统一为 `Math.max(maxTokens * texts.length, inputChars/3 + 80 * texts.length)`，既不浪费也不截断 ✅

### P11 — 用户操作优先级（三步走）

- [x] **Step 1：用户可见操作统一走 `translateImmediate`**：`showFail` 重试 / 手动翻译按钮 / Show more 全部走 priority 2 的立即翻译通道（绕过队列和并发上限）；`preloadObserver` 离开视窗时从 `pendingQueue` 摘除非高优推文，节省配额 ✅
- [x] **Step 2：priority ≥ 2 绕过限流冷却**：`RateLimiter._process` 对 priority 2+ 跳过 `_checkLimits` 和 `_withIoLock`，宁可让服务端返 429 也不让用户眼前的内容在本地等锁 ✅
- [x] **Step 3：并发赛跑（UI 勾选）**：popup 新增 `hedgedRequestEnabled` 开关（兜底 API 已开启时可见），background `raceMainAndFallback` 用 `Promise.any` 并发请求主+兜底 API，败者 abort 节省配额；priority ≥ 1（视窗内/show-more/手动）生效，preload 不赛跑 ✅

### P12 — Code Review 三项 blocking

- [x] **Fix #1：流式模式 `activeRequests` slot 泄漏**：`flushQueueStreaming` 加 `slotReleased` flag，`done`/`error`/`timeout`/`onDisconnect` 四路任一触发时恰好一次释放，解决 SW 冷重启在任何消息到达前就 disconnect 的场景 ✅
- [x] **Fix #2：DOM 回收竞态**：`BatchItem` 入队时捕获 `tweetId`，`renderAndCacheResult` / `translateImmediate` / 手动按钮在 await 返回后比较当前 `getTweetId(article)`，不匹配则丢弃结果记 `recycleDrop` 日志，避免把 A 推文的翻译渲染到 X.com 复用后的 B 推文下 ✅
- [x] **Fix #3：RateLimiter TOCTOU + 多 victim 抢占**：`_withIoLock` 用 promise 链串行化 `_checkLimits` + `_persistAdd` 的 read-modify-write；`_preemptionPending` flag 防止并发高优 acquire 各自 abort 不同 victim ✅

### P13 — Show more 结构化检测（取代 P4 初版）

- [x] **长度差检测代替 containment 检查**：`_dualangLastTextLength` 基线在 `scanAndQueue` / `flushQueue` / `translateImmediate` / `renderAndCacheResult` 四处维护；MutationObserver 对 dualang-touched article 比较当前 vs 基线长度，任意层级的 mutation 都能命中 ✅
- [x] **静默期去抖（取代固定时长）**：`_dualangShowMoreTimer` 每次新 mutation 重置 80ms 定时器，语义从"X.com 动画总时长假设"变为"mutation 批次间的静默间隔"（基于浏览器事件循环特性）；合并 X.com 多次 mutation 为一次处理，消除状态闪烁和重复 API 调用 ✅
- [x] **`characterData` 观察**：MutationObserver 加 `characterData: true`，覆盖 X.com 就地替换文本节点 data 的场景 ✅
- [x] **渲染前重取 `tweetTextEl`**：`translateImmediate` 和 `renderAndCacheResult` 在 await 返回后重新 `article.querySelector('[data-testid="tweetText"]')`，避免 X.com wrapper swap 后渲染到 detached 节点 ✅

### P14 — 真实 X.com 本地 mock + 场景测试

- [x] **`x-real.html`**：接近 X.com 真实结构（cellInnerDiv / 嵌套 wrapper / `data-testid="tweet-text-show-more-link"` / User-Name / 引用推文嵌套 article / Twemoji img / mentions / hashtags / 中文+英文+URL 混排）；`window.xSim` 模拟器暴露三种 show-more 展开模式（append / innerHTML replace / wrapper swap）+ 虚拟 DOM 回收 + 追加/删除推文 ✅
- [x] **`real-scenarios.spec.ts` 6 个场景测试**：innerHTML 替换触发重翻、wrapper swap 触发重翻、中文跳过、mentions/hashtags 提取、嵌套引用推文各自独立翻译、DOM 回收中途触发 `recycleDrop`；对应 P11-P13 修复的回归守护 ✅

### P15 — 状态图标品牌化（成功=模型 favicon，失败=重试箭头）

- [x] **真实品牌 favicon 打包**：`icons/kimi.png` / `icons/moonshot.png`（月之暗面 platform.moonshot.cn favicon）、`icons/zai.svg`（z.ai CDN logo）、`icons/siliconflow.png`。`manifest.json` 加 `web_accessible_resources` 让 content script 在 x.com 上可用 `chrome.runtime.getURL()` 加载 ✅
- [x] **`src/shared/model-meta.ts`**：`getModelMeta(model, baseUrl)` 将模型 → { modelName, modelDescription, iconUrl, apiDeployUrl }。品牌图标随模型作者走（GLM 永远显示 z.ai），点击 URL 随 API 部署方走；后又调整为统一指向品牌官网首页（kimi.com / z.ai / siliconflow.cn） ✅
- [x] **`showSuccess(article, meta)`**：翻译完成后状态从 loading 变为模型品牌图标（16px），hover tooltip 显示模型名 + 一句话介绍 + 本次消耗 tokens（或"缓存命中"），点击 `window.open` 到官网；在 `renderAndCacheResult` / `translateImmediate` / `scanAndQueue` 的缓存恢复路径都接入 ✅
- [x] **失败状态改为重试箭头图标**：CSS 用 SVG mask 在红底上画刷新箭头，hover 时 -90° 旋转；tooltip 包含模型名和错误原因，点击重试 ✅
- [x] **Token 数据贯通**：`api.ts` 捕获 `response.usage`；`handleTranslateBatch` 返回 `{ translations, usage, model, baseUrl, fromCache }`；hedged 模式下返回胜者的 model/baseUrl；流式路径在每个 `partial` / `done` 消息里带上 model/baseUrl ✅
- [x] **测试**：`status-and-reliability.spec.ts` 加 2 个场景（成功图标验证 `<img src>` + tooltip + 点击打开；fail tooltip 含模型/错误/"点击重新翻译"）✅

### P16 — 翻译完整性保障（质量检查 + 陈旧缓存失效）

- [x] **`hasSuspiciousLineMismatch(original, translated)`**（`src/content/utils.ts`）：对 ≥ 150 字符的原文做三重检查 — 字符数急剧缩减（< 14%）、行数坍缩（原文 ≥ 3 行而译文不到一半）、段落严重合并（≥ 3 段变 1 段）。门槛避免误伤短推文的自然段落合并 ✅
- [x] **一次性质量重试**：翻译结果可疑 → 设 `_dualangQualityRetried` → 走 `translateImmediate(..., isQualityRetry=true)` 重试。`isQualityRetry` 触发 `sendMessage({ skipCache: true })`，`handleTranslateBatch` 绕过 `getCacheBatch`，避免刚写入的坏翻译把自己的重试吃掉。重试一次后不论结果都接受 ✅
- [x] **重试后仍不理想 → 显示 fail 图标而非 success**：`renderAndCacheResult` / `translateImmediate` 在 retry 用尽仍可疑时渲染结果但挂上 fail 图标，tooltip "译文与原文段落数差异过大，点击强制重新翻译"。用户可手动点击再试一次（点击会 reset `_dualangQualityRetried` + skipCache） ✅
- [x] **缓存返回不做质量检查**：`meta.fromCache=true` 时跳过 `hasSuspiciousLineMismatch`，缓存是已落盘的决策，重试只会浪费 API 调用 ✅
- [x] **`scanAndQueue` 陈旧缓存识别**：通过 tweetId 恢复翻译时比较 `extractText(currentTweetTextEl).length` 与 `cached.original.length`，当前文本 > 1.3× 则视为陈旧（例如截断→全文、列表→详情页、show-more 展开后 DOM 重建），删除缓存条目 → 回到正常排队路径 → 重新翻译；日志为 `cacheInvalidateStale` ✅
- [x] **`translationCache` 扩展**：条目加入 `{ model, baseUrl }`，`scanAndQueue` 恢复时 `showSuccess` 能展示正确的品牌图标 ✅
- [x] **测试**：7 条新增单元测试覆盖 `hasSuspiciousLineMismatch` 边界（字符比 / 行坍缩 / 段合并 / 短推文不触发 / 空译文 / 正常多行译文）；3 条新增场景测试（`qualityRetry` 日志 + 2 次 API + 最终展示新结果；两次都坏时 fail 图标可见；同 tweetId 长度暴涨触发 `cacheInvalidateStale` + 重翻）✅

### P17 — Cache ID 泛化（面向多站点）

- [x] **`getTweetId` → `getContentId`，策略链实现**（`src/content/utils.ts`）：按优先级尝试 `/status/<id>` (X) → `/statuses/<id>` (Mastodon) → `/comments/<id>` (Reddit) → `/item?id=<id>` (HN) → `?v=<11-char>` (YouTube) → `/post/<id>` (Bluesky) → `data-postId/commentId/messageId/entryId/threadId` 属性 → 元素自身 `id`；未命中返回 null，调用方对 null 情况跳过按 ID 的缓存优化（L2 文本哈希缓存不受影响）✅
- [x] **内部重命名**：`_dualangTweetId` → `_dualangContentId`，`tweetId` / `currentTweetId` / `prevTweetId` / `originalTweetId` → `contentId` / `currentContentId` / `prevContentId` / `originalContentId`，`BatchItem.tweetId` 字段、perfLog 键一并改名；`getTweetId` 保留为 `getContentId` 的别名以支持旧外部 import ✅
- [x] **9 条新增单元测试**：覆盖每种策略（X / Mastodon / Reddit / HN / YouTube / Bluesky / data 属性 / id 回退 / 全空返回 null）+ URL 模式优先于 data 属性的优先级检查 ✅

### P18 — 缓存验证改为精确文本匹配

- [x] **`_dualangLastText: string` 替代 `_dualangLastTextLength: number`**：4 处写入点（scanAndQueue / flushQueue / translateImmediate / renderAndCacheResult）统一存 `textContent`，不再只存长度 ✅
- [x] **MutationObserver 精确比较**：`currentText === prevText` 代替 `currentLen === prevLen`，捕获"长度不变但内容变"的编辑（X.com 编辑推文、同字数替换等）✅
- [x] **`scanAndQueue` 恢复路径严格校验**：用 `extractText(currentTweetTextEl) !== cached.original` 替代 1.3× 长度阈值。任何差异都作废缓存条目，`cacheInvalidateStale` perfLog 新增 `reason` 字段（`'edit'` / `'length-diff'` / `'no-baseline'`）✅
- [x] **新增 e2e**：同 contentId 下把文本从 "I really enjoy eating ... apples ..." 换为同长度的 "... grapes ..."，期望 `cacheInvalidateStale` 以 `reason: 'edit'` 触发，第二次 API 被调用，最终渲染新译文 ✅

### P19 — 三个免费翻译提供方 + providerType 架构

- [x] **SiliconFlow Qwen3-8B 预设**：`PRESETS['siliconflow-qwen3-8b']`，走既有 HTTP / OpenAI 兼容路径；fallback 预设也加了一份；`model-meta.ts` 识别 `qwen` 名称 → SiliconFlow 图标 + "阿里通义千问 — 开源中英文通用大模型（SiliconFlow 免费托管）"描述，点击跳 siliconflow.cn ✅
- [x] **Chrome 138+ / Edge Canary 143+ 浏览器本地 Translator API**：同一 W3C 标准接口 `self.Translator.create({sourceLanguage, targetLanguage})`，无需 API Key、完全离线、无 token 计费；runtime 用 `/Edg\//` 检测 UA 选图标（`chrome.svg` / `edge.svg`）和品牌 ✅
- [x] **新增 `providerType: 'openai' \| 'browser-native'` 设置**：popup 切到浏览器本地预设时，API Key / baseUrl / model / maxTokens / 流式 / fallback 开关整体置灰；settings.ts 默认 'openai' 保持向后兼容 ✅
- [x] **`requestTranslation()` 统一分发**（`src/content/index.ts`）：根据 `providerType` 走本地 Translator（无 background、无 rateLimiter）或 `chrome.runtime.sendMessage`；`flushQueueSendMessage` / `translateImmediate` / 手动按钮 / 质量重试都通过这个入口 ✅
- [x] **会话缓存**：`ensureBrowserSession(sourceLang, targetLang)` 按语言对复用 Translator session，切换语言或 providerType 时销毁老 session ✅
- [x] **`src/shared/model-meta.ts` 新增品牌映射**：qwen → SiliconFlow；browser-native → Chrome/Edge 按 UA 选 ✅
- [x] **文档 & 源码注释**：README 新增"参考资料"章节列出 SiliconFlow pricing / Moonshot platform / z.ai / Chrome Translator API / Edge Translator API / W3C explainer；`content/index.ts` 和 `model-meta.ts` 添加指向对应 spec / 定价页面的注释 ✅

### P20 — Popup 三 Tab 布局 + 自适应延迟赛马

- [x] **三 Tab 布局**（`popup.html` + `popup.css` + `popup.js`）：**主**（preset / key / model / 目标语言 / 自动翻译 / 双语） + **兜底 & 加速**（fallback 配置 / hedging 开关 / hedgedDelayMode） + **高级**（推理强度 / maxTokens / 流式）。`.tab-button` 驱动 `.tab-panel.active`，保存按钮跨 tab 共享 ✅
- [x] **延迟式赛马（hedged request）**：`raceMainAndFallback` 不再同时发两路；主立刻发起，延迟 `hedgeDelayMs` 后若主未返回才启动兜底；主在延迟内成功 → 兜底永不发起（节省配额）；主在延迟内失败 → 立即启动兜底（fallback 语义优先于赛跑）✅
- [x] **自适应延迟（`hedgedDelayMs: 'auto'`，默认）**：滚动窗口保留最近 20 次主 API 成功 RTT，返回 p95 夹在 `[HEDGE_FLOOR_MS=300, HEDGE_CEILING_MS=3000]`；样本不足时用 `HEDGE_BOOTSTRAP_MS=500` 保底 ✅
- [x] **UI 读数**：popup 通过新增 `getHedgeStats` 消息查询当前样本数 / p95 / 上下限，实时显示"自适应当前值：XXXms（主 API 最近 N 次 RTT 的 p95，夹在 300–3000ms 之间）" ✅
- [x] **测试**：
  - `延迟启动：主 API 足够快时兜底不发起` — `hedgedDelayMs=1000` + 主快速成功，断言 fallback 未被调用
  - `popup 暴露 getHedgeStats 接口` — 验证消息通道
  - `赛马败者被 abort 不触发 popup 错误横幅` — 防回归上面 P20 的 bug
  - 原有赛跑 / 双失败测试仍通过 ✅
- [x] **Fix: AbortError 不再进 fatal banner**（`src/background/api.ts`）：`callWithRetry` 将 `err.name === 'AbortError'` 与 `err.preempted` 同等处理 — 预期取消，不重试、不写 `dualang_error_v1`。修复 hedged 败者被 abort / rateLimiter 抢占时 popup 出现 "⚠️ signal is aborted without reason" 的 false alarm ✅
- [x] **E2e 基础设施**：`expandAllTabPanels(page)` helper 通过 `addInitScript` 注入 `.tab-panel { display: block !important }` CSS 覆盖，使 Playwright 能操作所有 tab 下的 input；popupPage fixture 自动应用，自建 popup 的测试（如 target-lang）调用 helper ✅

### P21 — 品牌收尾（改名 / 营销文案 / Qwen 图标 / 扩容）

- [x] **插件改名 X 光速翻译**：`manifest.json` `name` / `popup.html` `<title>` + `<h1>` / `README.md` 标题全部换掉；内部 CSS 类名、storage key、日志前缀保留为 dualang（避免升级破坏用户缓存和错误状态）✅
- [x] **描述营销化**：manifest `description` → "刷 X 不被翻译拖慢。视窗即译、点击秒回，多家模型并发赛跑，主 API 卡？自动切兜底 — 译文永远追得上你的滚动。"；popup 副标题 → "译文追得上你的滚动"；README 开篇 → "刷 X 时，译文应该像空气一样不被察觉。"✅
- [x] **Qwen 品牌视觉归位**：从 `assets.alicdn.com/g/qwenweb/qwen-chat-fe/0.2.40/favicon.png` 下载真 favicon → `icons/qwen.png` (64×64)；`model-meta.ts` 里 Qwen 条目改用自己的图标 + `apiDeployUrl: https://chat.qwen.ai/`（不再借 SiliconFlow 的），描述去掉"SiliconFlow 免费托管"尾巴；规则归一为"图标跟模型作者 / 点击跳模型作者" ✅
- [x] **默认缓存 ×10**：L1 内存 `MEM_CACHE_MAX` 200 → 2000；L2 storage `CACHE_MAX_SIZE` 500 → 5000；content-side tweetId `TRANSLATION_CACHE_MAX` 500 → 5000。`manifest.json` 追加 `unlimitedStorage` 权限以支撑 L2 更大容量（升级时 Chrome 会提示新权限）✅

### P22 — 监控系统化（日志分级 + 业务语义 + Stats tab）

- [x] **日志分级**：新增 `perfLog`（`console.debug`，verbose 内部埋点）与 `logBiz`（`console.log/warn/error`，业务事件）两个函数；DevTools Default 级不再被 `enqueue` / `scan` / `render` 刷屏，关键业务事件保留在默认输出 ✅
- [x] **业务语义 tag**：事件名从缩略重命名为 dot-分隔语义 — `translation.request.ok` / `translation.request.fail` / `translation.immediate.fail` / `translation.quality.retry` / `translation.quality.give_up` / `cache.invalidate.stale` / `cache.hit.full` / `dom.recycle.drop` / `fallback.activated` / `hedged.winner`。content 与 background 两端统一。原有 perfLog 事件若不属于业务事件则保留短名但降级为 debug ✅
- [x] **`src/background/stats.ts` 新模块**：内存累加 → debounce 2s → `chrome.storage.local.dualang_stats_v1`；SW 重启从 storage 恢复；三个消息接口 `getStats` / `resetStats` / `recordQualityRetry`；模型 key 归一（`browser-native` 不按 Chrome/Edge 拆分）✅
- [x] **插桩点**：`handleTranslateBatch` 成功/失败路径记录 `recordRequest(model, ok, rttMs, usage)`；fallback-on-fatal 用 fallback 模型独立记录；全/部分缓存命中记录 `recordCacheHit`；content 质量重试时 sendMessage(`recordQualityRetry`) ✅
- [x] **Popup "统计" tab**：宽度从 320 → 360；顶部三汇总卡（请求总数 / tokens 合计 / 缓存命中率）；各模型行带品牌图标 + `avg Xms` / `tokens Xk` / `请求 N` + 五色成功率条（≥95% 绿 / ≥80% 橙 / <80% 红）；下方最近错误 `<ul>` 展示 HH:MM:SS + 模型 + 红色错误文本；刷新 / 重置按钮；切到该 tab 立即拉一次 + 停留时每 3s 自动刷新；纯 CSS 可视化无 chart 库 ✅
- [x] **测试**：新增 `统计 tab：成功请求后展示模型行、tokens、成功率；错误进入日志` — 一次 200 + usage、一次 401，打开 popup 断言 tokens 非空、模型行可见、错误日志含 401 message；原 3 条依赖旧事件名的 e2e 更新为新 tag ✅

### P23 — 兜底优先 & 思考关闭 & Provider profile 抽象

- [x] **Fallback 优先于重试**：当配置了兜底 API 且不在 hedged 模式，主 API 只尝试 1 次（`maxRetries=0`），任何失败（retryable 或 fatal）立刻切兜底，跳过主上 3 次指数退避。主失败 5xx 的最坏情况从 ~14s 缩到 ~1s ✅
- [x] **思考模式默认关闭**：popup 推理强度改名"思考模式"，新增"关闭思考（推荐）"选项并设为默认；`settings.ts` 默认 `reasoningEffort='none'`；api.ts `applyThinkingMode` 按 profile 策略分发：Qwen3 → `enable_thinking:false`；GLM-4.6+ → `thinking:{type:disabled}`；Moonshot/通用 → 省略 `reasoning_effort` ✅
- [x] **Provider profile 注册表**（`src/background/profiles.ts`）：把 per-provider 的 endpoint / temperature / thinkingControl / supportsStreaming / system prompt 全部登记到 `ProviderProfile` 数组，`getProfile(settings)` 按 `matchBaseUrl` substring / `matchModel` regex 首匹配返回。api.ts 的三个 body builder 变成无分支的组装器。扩展新 provider = 加一行 profile 不用改主流程 ✅
- [x] **Profile 拆分**：`/qwen3|qwq/i` 走 QWEN3_PROFILE（enable_thinking:false），`/qwen/i` 兜底走 QWEN_LEGACY_PROFILE（**不**传 thinking 字段 — Qwen2.5 API 不支持该参数，误传会诱发 "on on on" 退化循环，bench v2 实测确认）✅

### P24 — Benchmark v2：Claude 评审 + 模型配置 UI 升级

- [x] **`scripts/benchmark-v2.mjs`**：Claude 人工评审替代 LLM 自评；短文本 ≤100 字符用 simple prompt；Qwen2.5 4 温度网格（0.1 / 0.3 / 0.7 / 1.0）；2.5s/req 节流；`/tmp/bench_v2_*.json` 输出 ✅
- [x] **Bench v2 三大发现** → `models_benchmark.md` 重写：
  - kimi-k2.5 必须 temperature=1（Moonshot API 拒绝其他温度；v1 报告 §6.1 建议无效）
  - Qwen2.5 在 T≥0.3 时约 30% 概率陷入 "on" 退化循环，**T=0.1 是唯一稳定温度** → `QWEN_LEGACY_PROFILE.temperature` 从 0.3 改 0.1
  - GLM-4-9B 是最稳定的免费主力（1.9s / 质量 8.7），推荐作为默认 ✅
- [x] **Popup 模型列表分组重组**：`<optgroup>` 按 bench 层级分 4 组（⭐ 推荐 / 免费主力 / 离线 / 实验慢），每个 `<option>` 带 `延迟 · 质量 · 成本` 三要素；fallback 下拉同步；默认主模型 `Qwen/Qwen2.5-7B-Instruct` → `THUDM/GLM-4-9B-0414`（稳定性优先）✅

### P25 — 翻译质量问题治理（日志 + 截图驱动）

- [x] **质量重试死循环**（日志 2045339181501866069）：223 字原文 → 22 字译文反复 give_up。根因：`hasSuspiciousLineMismatch` 未扣除 URL/@/#。修复：新增 `translatableCharCount`，长度门槛和字符比例都按"可翻译字符"计算 ✅
- [x] **重试复用原 prompt 无效**：首次压缩出短译文，重试仍然是同一 prompt 所以同结果。修复：profile 新增 `systemPromptStrict`（"不得省略、合并、总结"），`translate` 消息带 `strictMode: boolean`，质量重试自动带 `skipCache + strictMode` 双开 ✅
- [x] **Prompt 占位符被模型抄袭**（截图 Image 2 "这条翻译"）：BATCH_PROMPT 里 `{"translated":"第一条翻译"}` 示例被 7-9B 模型当 template 原样填充。修复：删除所有可被抄的示例文本，改成纯 schema 描述。附 "⚠️ 历史教训" 注释 ✅
- [x] **语言识别错误**（截图 Image 1 "codex is becoming a security agencyic IDE"）：37 字短文本避开 150 字门槛，输出根本不是中文还是放行。修复：新增 `isWrongLanguage(translated, targetLang)` — CJK 目标语下剥离 URL/@/#/标点/数字后 CJK 占比 <30% 判定语言错。加入质量检查：`suspicious = lineMismatch || wrongLanguage` ✅
- [x] **prompt 强化语言要求**：SINGLE_PROMPT 和 BATCH_PROMPT 规则 #1 改成 "输出必须完全是 {lang}；专有名词可音译或保留原样，但不得整句保留原文英文" ✅
- [x] **JSON 硬化**（日志 `"[\nned 1詹森夸大..."`）：Qwen2.5 偶发返回"JSON 外壳乱码 + 正文完整中文"。两层修复：(1) `body.response_format = {type:'json_object'}` 让服务端约束输出合法 JSON；(2) 新增 `salvageSingleTranslation(raw)`，`texts.length===1` 时从杂乱输出里救出 `"translated"` 值或纯 CJK 文本，要求 ≥10 CJK 字符才接受 ✅
- [x] **段落崩塌**（截图 Image 4：4 段原文 → 1 坨译文）：三层治理：(1) BATCH_PROMPT / STRICT_PROMPT 把"段落必须 1:1 保留、用 \\n\\n 分隔"升到规则 #1 硬指令；(2) 已有 `hasSuspiciousLineMismatch` 段落坍缩规则触发 strict retry；(3) 新增 `rebuildParagraphs(text, targetCount)` 客户端兜底 — 译文仍 1 段但原文 ≥3 段时，按中英文句末标点拆句、按目标段数均匀分组 ✅
- [x] **测试**：`utils.test.ts` 新增 16 条（URL 扣除 3 条、`isWrongLanguage` 8 条、`rebuildParagraphs` 5 条）；`real-scenarios.spec.ts` 新增"质量重试用严格 prompt"e2e 验证 API 收到 `strictMode=true` ✅

### P26 — 抛弃 JSON 批量格式（分隔符 + 纯文本）

- [x] **问题背景**：7-9B 参数小模型（Qwen2.5-7B / GLM-4-9B）同时处理 JSON 语法 + 翻译 + 段落保留认知负担过重。实测 bug：prompt 占位符被原样照抄（"第一条翻译"）、段落坍缩、偶发 JSON 外壳乱码（`"[\nned 1..."`）、`response_format:{type:'json_object'}` 也救不回来 ✅
- [x] **单条翻译零结构**：`isSingle=true` 时 user content 就是原文，system prompt 是 `SINGLE_PROMPT`，返回即译文；只在响应开头像 `{` / `[` / `===N===` 时才走 fallback 解析。去掉 `salvageSingleTranslation` 和 `response_format` ✅
- [x] **批量翻译 `===N===` 分隔符**（`src/background/profiles.ts`）：输入 `===0===\n文本\n\n===1===\n文本`，要求模型按同格式回写；段落分隔用真实空行保留不需转义；`BATCH_PROMPT` 显式"不要 JSON、不要 markdown"；占位符写成 `<TRANSLATION_0>` 且注明"占位符不可照抄"避免小模型抄袭 ✅
- [x] **`composeSystemPrompt(profile, lang, {batch, strict})`**：strict 前缀 `STRICT_PREFIX` 独立成模块变量，按需拼接到 single / batch 任一 base 前；profile 不再维护单独的 `systemPromptStrict` 字段 ✅
- [x] **`parseDelimitedBatch(raw, expectedCount)`**：主路径 `split(/^===\s*(\d+)\s*===\s*$\n?/m)` 取偶数索引作为 index、奇数索引作为内容；支持前置噪声 / 乱序 index / 内部空格 / 超出 expectedCount 忽略。降级 fallback 兼容 JSON 返回（强模型偶发 + 旧测试 mock）并能剥离 markdown 代码块 ✅
- [x] **api.ts 重写**：`doTranslateBatchRequest` 按 `isSingle` 分流；`doTranslateBatchStream` 按行检测 `===N===` 边界做流式增量推送；删除旧 `extractCompletedEntries` JSON 花括号计数器 ✅
- [x] **测试**：`profiles.test.ts` 新增 9 条 `parseDelimitedBatch`（标准 / 多段 / 前置噪声 / 乱序 / 越界 / 空格 / 无分隔符 / JSON fallback / markdown 包裹）+ 4 条 `composeSystemPrompt`（单条 / 批量 / 严格前缀位置）；8 个 e2e mock 文件的 tweet 计数正则改为 `/===\s*\d+\s*===|推文 \d+:/g` 兼容新旧格式；`real-scenarios` 质量重试断言改为在 prompts 数组里找含严格前缀的任一请求（不假定下标 1）— 3 轮全套 e2e 45/45 稳定通过 ✅

### P27 — 展示模式 4 选 1（替代 bilingualMode 布尔）

- [x] **新设置 `displayMode: 'append' | 'translation-only' | 'inline' | 'bilingual'`** 替代旧 `bilingualMode` 布尔。4 种模式语义：
  - `append`（默认）— 原文 tweetText 保留，译文 card 附加在下方
  - `translation-only` — 原文隐藏（CSS via `article[data-dualang-mode]`），仅显示译文
  - `inline`（段落对照，新）— 按 DOM 边界克隆原文各段 HTML（保留 `<a>` / `<img alt>` / `@` / `#`）+ 译文逐段交错渲染
  - `bilingual`（整体对照，升级自旧 bilingualMode）— 整段原文 HTML 克隆 + 整段译文分块 ✅
- [x] **`splitParagraphsByDom(tweetTextEl)` 新工具**（`src/content/utils.ts`）：按文本节点里的 `\n\n` 或连续 `<br><br>` 切段，返回 DocumentFragment 数组，保留段内 rich HTML（链接、emoji img、mention）；jsdom 下 7 条单元测试覆盖单段 / 文本节点 \n\n 拆段 / 保留链接 / 双 br / 单 br 不分段 / 纯空白段过滤 / 含 emoji+mention 的 3 段混排 ✅
- [x] **`article[data-dualang-mode]` 属性驱动 CSS**：每次 renderTranslation 时把当前模式打到 article 上，CSS 按属性选择器决定是否隐藏 `[data-testid="tweetText"]`。切换模式只影响新翻译的推文，已渲染的推文保留旧模式直到页面刷新（避免重绘抖动）✅
- [x] **迁移策略**：老用户若只有 `bilingualMode=true` 且无 `displayMode` → 自动映射到 `inline`（内容脚本 `normalizeDisplayMode(mode, legacyBilingual)` + popup 加载逻辑双端对齐）。`null` 哨兵避免 chrome.storage API 对 `undefined` 默认值的歧义 ✅
- [x] **Popup UI**：`bilingualMode` checkbox → `displayMode` select 4 选 1，提示"模式切换后，已翻译的推文保留旧模式；刷新页面可全量应用新模式" ✅
- [x] **CSS**：新增 `.dualang-original-html`（保留原文 pre-wrap + font-size）、`.dualang-inline-pair` / `.dualang-inline` 间距；`article[data-dualang-mode="translation-only"|"inline"|"bilingual"] [data-testid="tweetText"] { display: none; }` 精准隐藏原文 ✅
- [x] **测试**：`manual-and-bilingual.spec.ts` 重构为 5 个 describe（append / translation-only / inline / bilingual / 持久化+迁移），9 条 e2e 全绿；全套 e2e 48/48（两轮稳定）、vitest 124 条（原 117 + 7 新增 splitParagraphsByDom）✅

### P28 — 小模型流式 CJK 乱码治理

- [x] **问题**：Qwen2.5-7B / GLM-4-9B 等 7-9B 小模型在 SiliconFlow / z.ai 上开启 SSE 流式时，服务端在分片边界切断多字节 UTF-8 字符，JSON encoder 直接用 `�`（U+FFFD）替换不完整字节 —— 客户端怎么也修不回来。附带症状：字符级复读（"， ， ，"、"就 不 就不应该"），像是两段翻译被错乱合并 ✅
- [x] **profile 层禁流式**（`src/background/profiles.ts`）：
  - `QWEN_LEGACY_PROFILE.supportsStreaming = false`（Qwen2.5 系列）
  - 新增 `GLM_LEGACY_PROFILE`，正则 `/glm-4/i` 匹配 GLM-4-9B / 4-32B / 4-Plus 等非 4.6 系列，`supportsStreaming: false`；顺序放在 `GLM46_PROFILE` 之后，避免 `/glm-4/i` 抢在 4.6 之前
  - `GENERIC_PROFILE.supportsStreaming = false`（未知 endpoint 默认保守）
  - 流式现在只给 Moonshot / Qwen3（reasoning 需要早期反馈）/ GLM-4.6（大参数低切字概率）✅
- [x] **客户端兜底**（`src/background/api.ts`）：`parseStream` 和 `doTranslateBatchStream` 循环结束后 `decoder.decode()` 不带 `stream: true` 做最终 flush，清空 TextDecoder 内部字节缓冲，避免末尾多字节字符残留成 `�`。防御性修复，对所有 provider 生效 ✅
- [x] **popup UI 降级 Qwen2.5**：推荐组重排 GLM-4-9B 到第一位（标"默认"）+ Moonshot 次位；Qwen2.5-7B 移到"其他免费（有局限）"组，描述加"禁流式（CJK 偶发乱码）、数字易错"警告；兜底选择器同步降级 ✅
- [x] **测试**：`profiles.test.ts` 新增 GLM legacy 匹配 + streaming 字段断言（4.6 仍开、非 4.6 关）；全套 vitest 126 / e2e 48 通过 ✅

### P29 — 展示模式视觉与交互 bug 治理

- [x] **段落空行对齐**（styles + content/index.ts）：`append/translation-only/bilingual` 模式下把多段译文 `join('\n\n')` 放进单个 `<div class="dualang-para">`，靠 `white-space: pre-wrap` 原生渲染出和原文 `\n\n` 完全一致的空行（一整行 line-height）。旧做法是每段一个 div + `margin-top: 4px`，永远对不齐原文空行 ✅
- [x] **译文配色**：从 `#8b98a5`（luminance ~60%，过暗影响阅读）改到 `#c5ccd3`（~80%）；保留冷灰色调便于辨识"这是译文"，同时避免过暗 ✅
- [x] **`splitParagraphsByDom` 深度改写**（`src/content/utils.ts`）：X.com 主列表把整段推文包进一个 `<span>`，多段落通过 `\n\n` 藏在 span 内部 text node 里。旧实现只遍历顶层 childNodes 永远只拆出 1 段。新实现：克隆子树 → 所有 `<br>` 替换成 `\n` → `normalize()` 合并相邻文本节点 → TreeWalker 深度扫所有 text node 收集 `\n\n` 的 `(node, offset)` → 用 `Range.cloneContents()` 提取每段 fragment，自动保留跨层级的 `<span>` / `<a>` / `<img>` 壳。新增单测覆盖 X.com 真实结构（span 内 `\n\n` 分 3 段）✅
- [x] **Show more 跳页修复**：`handleShowMoreOrRecycle` 和 fail 状态手动重试路径里，`.dualang-translation.remove()` 的同时 `article.removeAttribute('data-dualang-mode')`。否则在 translation-only / inline / bilingual 模式下，过渡期原文仍被 CSS 隐藏、card 又没了，article 高度塌到 0，翻译回来再撑起 —— 两次跳变导致页面上移。摘属性后过渡期原文可见（自然高度），只剩一次切换 ✅
- [x] **测试**：vitest 126（新 splitParagraphsByDom 测 X.com 实际结构）、e2e 48/48 全绿 ✅

### P30 — 支持 X.com Grok AI 摘要卡

- [x] **场景**：X `/i/trending/<id>` 页面顶部的 Grok 自动生成摘要卡（含标题 / 时间戳 / 主体段落 / 免责声明）不是 `article[data-testid="tweet"]`，我们原来的扫描器直接跳过，不触发翻译 ✅
- [x] **定位锚点**：用 Chrome DevTools Protocol（localhost:9222 WebSocket）live inspect 实际 DOM，确认 Grok 卡无 `data-testid` / `role` / `aria-label`，唯一稳定结构：4 个子 DIV + 含 `<time>` + `children[3].textContent.trim().startsWith('This story is a summary of posts on X')`。不能只看子元素数 + time —— 页面级容器（buttons + HEADER + MAIN）也匹配，必须同时要求所有 4 个孩子都是 DIV + 免责声明位于 children[3] 首字符串 ✅
- [x] **`isGrokCardContainer(el)` + `findAndPrepareGrokCards(root)`**（`src/content/index.ts`）：粗筛用 `:has(time)` 选择器 + 向上 6 层找最小 Grok 卡；发现后在卡上打 `data-dualang-grok="true"`、body div 打 `data-dualang-text="true"`，之后复用 tweet 翻译管线 ✅
- [x] **`findTweetTextEl(container)` 抽象**：把散落 10 处的 `article.querySelector('div[data-testid="tweetText"]')` 归一成 `container.querySelector('[data-testid="tweetText"], [data-dualang-text="true"]')`。tweet 和 Grok 卡走同一查询 ✅
- [x] **`scanAndQueue` 扩容**：把 `findAndPrepareGrokCards(root)` 的结果拼到 articles 列表后面，一起走处理循环；processedTweets WeakSet / IntersectionObserver 注册 / contentId 缓存 / cache 命中恢复全部白送 ✅
- [x] **MutationObserver 扩展**：新增节点如果 `textContent.includes('This story is a summary of posts on X')` 就作为扫描根入队，确保 SPA 路由 / 动态插入 Grok 卡能被发现 ✅
- [x] **getContentId Grok 策略**（`src/content/utils.ts`）：有 `data-dualang-grok` 属性时，用 `children[0].textContent` 作为 ID（带 `grok:` 前缀），标题对同一 trending 话题稳定 ✅
- [x] **测试**：vitest 128（新增 2 条 Grok contentId 单测），e2e 48/48 全绿。**活页验证**：通过 DevTools Protocol reload 扩展后，trending 页 Grok 卡 10s 内被标记，11s 内渲染中文译文（"在一个近两个小时的谈话中，主持人 Dwarkesh Patel..."）✅

### P31 — 支持 X Articles（长文阅读视图）

- [x] **场景**：X 的"Articles" 长文页（url 模式 `/<user>/status/<id>` 但服务端返回为长文结构），DOM 里有 `[data-testid="twitterArticleReadView"]` / `[data-testid="twitter-article-title"]` / `[data-testid="twitterArticleRichTextView"]` / `[data-testid="longformRichTextComponent"]`；外壳仍是 `article[data-testid="tweet"]`，但内部**没有** `[data-testid="tweetText"]`，老扫描器找不到文本就跳过。实测 17k 字符长文（"Why Your AI-First Strategy Is Probably Wrong"）整篇不翻译 ✅
- [x] **定位锚点**：通过 Chrome DevTools Protocol live inspect 真实文章页；testid 稳定可靠（不像 Grok 卡需要结构嗅探）。选 `twitterArticleRichTextView`（纯正文）作为 tweetText 等价物，**不**选 `twitterArticleReadView` —— 后者包含标题和引擎计数（143 / 3.4K / 1.7M），会混进译文中间（首轮验证时"为什么你的'AI优先'战略很可能错了1437083.4K1.7M99%的..."就这么出现的）✅
- [x] **`findTweetTextEl` 第三个选择器**：在原有 `[data-testid="tweetText"], [data-dualang-text="true"]` 之上加 `[data-testid="twitterArticleRichTextView"]`。一处改动，扫描 / 翻译 / 渲染管线全部自动适配 —— 因为 article 外壳已经是 `article[data-testid="tweet"]`，scanAndQueue 原本就会捕获，只是老版本在 findTweetTextEl 返回 null 就卡住 ✅
- [x] **活页验证**：reload 扩展 + 刷新 `/intuitiveml/status/2043545596699750791`，83 秒后译文渲染完成（6229 字符干净中文，无引擎计数混入），延迟主要来自 17k 字符输入的 API 调用本身 ✅
- [x] **后续可选**：标题（`twitter-article-title`）未翻译 —— MVP 不做，需要的话后续加一个独立的伪容器映射过去。文章太长时的体感可通过 hedged race 和适度切块改善 ✅

### P32 — 长文按段切块翻译（修复 X Articles 译文坍缩）

- [x] **问题**：第二篇 X Article（21k 字符）整包送翻译时，GLM-4-9B 把**25 段原文压成 2 段输出**（模型在超长上下文下丢失段落结构）。inline 模式下 splitParagraphsByDom 检测到 5 段原文 DOM fragments，但只有 2 段有对应译文，剩下都是空的 pair ✅
- [x] **根因**：不是 DOM 检测问题，是**模型自身**在长输入下把多段译文揉成少数几个块。`splitParagraphsByDom` 老实现看 text node `\n\n` 已经够用，短文没问题，长文靠小模型保留段落结构本来就靠不住 ✅
- [x] **`requestTranslationChunked(text, priority, skipCache, strictMode)`**（`src/content/index.ts`）：当 `texts.length === 1 && text.length >= 4000 && paraCount >= 6` 时自动进入。把文本按 `\n\n` 切段，5 段一 chunk **串行**送 API（并发会把 MAX_CONCURRENT 占满 + rate limiter 串行化反而更易触发 30s 超时），每 chunk 超时放宽到 60s，全部完成后 `join('\n\n')` 作为单段译文返回。`requestTranslation` 内部自动分流，调用方（`translateImmediate` / `flushQueue` 两条路径）无需感知 ✅
- [x] **inline 模式段数严重不匹配降级**：原文 DOM 切出段数 < 译文段数 × 0.5 时，不再强行逐段配对（会造成 20+ 空 pair），退回 bilingual 风格渲染（整段克隆原文 HTML + 整段译文单块），`perfLog('inline.fallbackToBilingual', ...)` 记录。长文的自然场景是 DOM 段少、译文段多（因为 splitParagraphsByDom 看 text node 而 innerText 看 CSS block 布局） ✅
- [x] **质量检查对长文放行**：`hasSuspiciousLineMismatch` 加 `origTranslatable >= 5000` 跳过行数/段数坍缩检查。长文英中翻译的行数比例天然不同（英文 391 单 \n vs 中文 ~50），原门槛主要针对短推文的"模型压缩成一行"坏情况，长文误报率太高。字符级缩减检查保留（真正的截断会被捕获）✅
- [x] **活页实测**：两篇文章均成功
  - `intuitiveml/2043545596699750791`（17k 字符）：72s，7 段译文，status=success
  - `gemchange_ltd/2028904166895112617`（21k 字符）：93s，22 段译文，status=success ✅
- [x] **测试**：vitest 128 / e2e 48/48 全绿 ✅

### P33 — X Articles"超级精翻"按钮（Kimi 全文精翻）

- [x] **场景**：X Articles 长文页面。用户想要更高质量的翻译（比常规 GLM-4-9B 免费模型更精准、地道、保留专业术语），愿意接受较长耗时。按钮注入 article 右下角 `position: absolute`，点击触发 Kimi 全文翻译 ✅
- [x] **`isXArticle(article)` + `injectSuperFineButton(article)`**（`src/content/index.ts`）：scanAndQueue 里识别 article 是否含 `[data-testid="twitterArticleRichTextView"]`（推文 / Grok 卡不会有），是就在 article 右下角注入按钮。若 article 是 `position: static` 则补 `relative`（不覆盖 X.com 自有定位）。idempotent ✅
- [x] **`translateArticleSuperFine(article)`**（`src/content/index.ts`）：
  - 10min 超时（远超常规 30s），接受 Kimi 长耗时
  - `sendMessage({action:'translate', payload:{superFine:true, strictMode:true, skipCache:true, priority:2}})`：superFine 标记让 background 切换到 Kimi，strictMode 拼 STRICT_PREFIX 强制保留段落结构避免多段压成一段
  - 替换已有译文 card（之前 GLM 的那份），插 Kimi 新版 ✅
- [x] **Background 端 Kimi 覆写**（`src/background/index.ts` + `settings.ts`）：`handleTranslate(payload)` 里若 `payload.superFine` 则覆写 settings：`baseUrl=api.moonshot.cn/v1`、`model=moonshot-v1-128k`（128k 上下文避免 21k+ 字符文章被截断）、`apiKey` 从 `config.json` 的 moonshot 条目读，没有则报错提示用户配置。禁流式 / 禁兜底 / 禁赛马（精翻场景要可控）✅
- [x] **视觉反馈**（`styles.css`）：
  - `.dualang-super-btn`：蓝色胶囊按钮（#1d9bf0）右下角 `position: absolute`，hover 上移 + 阴影加深；禁用时灰色（#6b7280）
  - `@keyframes dualang-super-pulse`：2.4s ease-in-out 循环，`background-color` 在透明 ↔ `rgba(29,155,240,0.08)` 之间柔和脉冲
  - `article.dualang-super-translating [data-testid="twitterArticleReadView"]` 触发动画，圆角 10px 配背景过渡 ✅
- [x] **按钮文本状态机**：初始 "超级精翻" → 点击后 "精翻中…" (禁用) → 成功 "重新精翻" (允许再跑) / 失败回 "超级精翻" ✅
- [x] **活页实测**（intuitiveml/2043545596699750791 , 17k 字符）：
  - 按钮 0s 注入可见
  - 点击 → `translating` class 触发脉冲（视觉确认）
  - 48s 后 status=success，model=`moonshot-v1-128k`，6911 tokens，23543 字符 Chinese 译文
  - 按钮变"重新精翻" ✅
- [x] **测试**：vitest 128 / e2e 48/48 全绿 ✅

### P34 — 超级精翻流式 + 分段渲染（A+B 方案落地）

- [x] **问题**：原版超级精翻单请求全文 → Kimi 在 17k+ 字符下段落压缩（N 段压成 2 段）；48s 过程零反馈；没 cancel；感知慢 ✅
- [x] **新架构**：
  - **端到端流式 port**：content `chrome.runtime.connect({name:'super-fine'})` → background `handleSuperFineStream` → `doTranslateBatchStream` SSE 逐段推送
  - **按段切块**：一篇文章切 5 段一 chunk 串行翻译，段数天然对齐（不再靠模型保留结构）
  - **渐进渲染**：点击后立即渲染 N 个占位 slot（脉冲灰色 skeleton），每段译文到就填对应 slot + fade-in 动画
  - **进度可见**：按钮文本 `精翻中… (X/N)` 实时更新 ✅
- [x] **消息协议**（`src/background/index.ts`）：
  - `meta` → 元信息 `{paragraphs, chunks, model, baseUrl}`
  - `partial` → 单段译文 `{index, translated}`（前端按 index 填 slot）
  - `progress` → chunk 完成 `{completed, total}`（按钮文案更新）
  - `chunkFail` → 单 chunk 失败（不中止整体）
  - `done` → 全部完成 `{totalTokens, model, baseUrl, completed, total}`
  - `error` → 致命错误 ✅
- [x] **DOM block 段落提取**（`src/content/utils.ts::extractParagraphsByBlock`）：原来的 `extractText` clone 后 innerText 丢失 CSS 布局换行（X Articles tight layout 退化成 1 段）。新实现遍历 DOM leaf block 节点取 textContent，段数真实反映视觉段落 ✅
- [x] **`extractText` 修复**：改为直接读原元素 innerText（不 clone），保留 CSS block 布局换行。新增 `splitIntoParagraphs(text)` 在 `\n\n` 优先、`\n` 降级的策略下一致切段 ✅
- [x] **CSS skeleton**（`styles.css`）：
  - `.dualang-super-slot:not(--filled)` 蓝色脉冲背景 1.6s 循环
  - `.dualang-super-slot--filled` fade-in + translateY(2px→0) 0.35s ease-out 动画 ✅
- [x] **模型选择**：默认 `moonshot-v1-128k`（非 reasoning、128k 上下文、速度快、质量高）。`kimi-k2.5` 原计划但 bench v2 实测 28s/请求 × 29 chunks = 14 分钟不现实；`handleSuperFineStream` 已经从 `payload.model` 读取，popup 加"精翻模型"下拉就能切换 ✅
- [x] **活页实测**（intuitiveml 17k 字符 / 142 段）：
  - 按钮 1s 就绪；点击后 0s 立刻渲染 3 段；5s 11/142；40s 75/142；**80s 142/142 成功**
  - 对比原版（非流式）48s 全部等完，新版 1s 就能开始读 —— 感知速度提升 ~48×
  - 第一段译文："我们99%的生产代码是由人工智能编写的。上周二，我们在上午10点发布了一个新功能..." ✅
- [x] **测试**：vitest 128 / e2e 48/48 全绿 ✅

### 后续方向（未做）

- 精翻模型可选：popup 加下拉框暴露 `moonshot-v1-128k` / `kimi-k2.5` / `moonshot-v1-auto`，用户按需选（k2.5 需要先 bench 验证实际可用 + 单请求 latency 可接受）
- 取消按钮：翻译中按钮文案"✕ 取消"，abort 剩余 chunks（AbortController 已接好，只差 UI）
- 并发 chunks：当前串行 80s；2-3 路并发同发 Moonshot 允许的话可以再快 2-3×
- 142 段过细：很多是列表短项；合并 <40 字短段到相邻段可减到 ~50 段
- 标题翻译：X Articles 的 `twitter-article-title`、Grok 卡的 `children[0]`

---

## P35: 超级精翻浮球（floating bubble）

**目标**：把 X Articles 的静态"超级精翻"按钮换成右侧中部悬浮球，解决 3 个痛点：
1. 按钮在文章底部，要翻很久才能找到
2. 翻译过程看不到进度
3. 长文里的 img/video/链接丢失

**实现**：
- 新增 `super-fine-bubble.ts`（5 个 export：initBubble/trackArticle/untrackArticle/setBubbleState/disposeBubble）
  - 状态机 idle/translating/done/failed，SVG 进度环（--progress CSS 变量驱动）
  - 右侧中部 fixed 定位，Y 轴 pointer 拖动 + localStorage 记忆
  - hover mini 面板（summary + 取消/重翻按钮，100ms debounce）
  - IntersectionObserver 跟踪 article 可见性自动显隐；per-article observer 存入 `articleObservers: Map<Element, IntersectionObserver>`，disposeBubble 时全部 disconnect
  - document pointermove/pointerup handler 引用保存到 `ctx.docHandlers`，disposeBubble 时 removeEventListener 防泄漏
- 新增 `super-fine-render.ts`（3 个 export：renderInlineSlots/fillSlot/clearInlineSlots）
  - 按 AnchoredBlock.el 在原 DOM 节点 afterend 插入 skeleton slot，**不动原文**——img/video/link 天然保留
- 重构 `extractParagraphsByBlock` → `extractAnchoredBlocks` 返回 `AnchoredBlock[]`（el 引用 + 'text' | 'img-alt' kind）；`<img alt>` 作为独立 block，多张图 alt 合并成一段送翻译
- `src/content/index.ts`：
  - `initBubble` 在生命周期起点创建一次
  - scanAndQueue 识别 X Article 长文（≥4000 字 ∧ ≥6 段落）→ 打 `data-dualang-long-article` + `data-dualang-article-id`，跳过 viewport/preload observer，交给浮球
  - `translateArticleSuperFine` 改写：浮球状态驱动 + renderInlineSlots/fillSlot 渲染 + port 流式协议零改
- 删除 legacy：`injectSuperFineButton`、`payload.superFine` 分支、`.dualang-super-btn`/`.dualang-super-slot` CSS、`article.dualang-super-translating` 脉冲

**测试**：
- vitest 150 通过（新增：utils.test 4 + super-fine-render.test 4 + super-fine-bubble.test 12）
- e2e `super-fine-bubble.spec.ts`：长文不走常规翻译 + 浮球可见 + 点击后 slot 注入
- 全套 e2e 51/51 通过

**后续方向（未做）**：
- popup 下拉选择精翻模型（暴露 moonshot-v1-128k / kimi-k2.5）
- 并发 chunk（2-3 并行）加速长文
- 短段（<40 字）合并减少 slot 数
- 文章标题（twitter-article-title）翻译
- 双栏对照"阅读模式"（方案 E）

## P36: 精翻默认 provider 改为 GLM

Moonshot Kimi 免费层 TPM 不稳定，长文 ~29 chunks 串行容易中途触发限流。改为：
- **默认**：复用 `getSettings()`（SiliconFlow GLM-4-9B-0414，免费 + TPM 充足 + 已修 UTF-8 flush）
- **Opt-in Moonshot**：`payload.model` 以 `moonshot-` 或 `kimi-` 开头时切回 Kimi（需要 config.json 的 moonshot key）
- 去掉"超级精翻需要 Moonshot API Key"的硬门槛错误

## P37: 浮球 & 扩展 icon 品牌统一（hole icon）

- 浮球内嵌的 SVG `X / 文` 双字符 logo 改为 `<img>` 引用 `icons/icon48.png`，通过 `chrome.runtime.getURL` 加载
- `holeicon.png` → `hole2_48px.png` 两轮迭代，ImageMagick Lanczos + PNG8 palette 压缩重新生成 16/48/128
- `.dualang-bubble-logo` CSS 改为 `position: absolute; inset: 6px; object-fit: contain; border-radius: 50%`，去掉不再需要的 `color-mix` 渐变（done/failed 仅靠背景色切换）

## P38: 浮球变成全局快捷设置面板（常驻）

**背景**：浮球原本只承担长文"精翻"入口（article-scoped，滚动消失）。改版后常驻右侧中部，hover 展开快捷设置面板；长文检测到时面板里额外出现"精翻此文"按钮。

**面板结构**：
- **顶部行**：`开启翻译`（主 pill 开关）+ `字典`（mini 开关）左右分布
- **显示**（分组头左对齐 + 分隔线）：只看原文 / 只看译文 / 对照 三选一
- **对照**：强调原文 / 强调译文 两选一；`逐行` mini 开关内嵌在分组头右侧（非对照模式下 muted）
- **模型**：`VISIBLE_MODEL_PRESETS` 列表，每行带最近 5 分钟平均延迟 pill 徽章；命中当前设置的行有 active 蓝框
- **精翻此文**（条件显示）：仅当检测到长文 + 翻译开启时展示
- 所有控件经 `chrome.storage.sync` 双向同步；content / bubble 的 `onChanged` 监听器负责回灌

**联动逻辑（wire panel actions to live content）**：
- `enabled` 切换 → `disableAndReset` / `enableAndScan` 立即生效
- `displayMode` 切换 → `reRenderAllForModeChange` 用 `translationCache` 就地重渲染，不重翻
- 模型切换 → `onPickModel` 一次 `chrome.storage.sync.set` 覆写 `baseUrl/model/providerType` + 从 config.json 读对应 provider 的 key（`getProviderKey` 消息走背景层 —— content 无 `web_accessible_resources` 权限直接 fetch）

**面板视觉**：
- 主 pill 开关 36×20，mini 变体 26×14；选中态渐变蓝
- 分组头 `.dualang-bubble-group-header`：`<span.label>` 左侧 + `<span.line>` 延伸；舍弃原"居中大写标题 + 伪元素下划线"的上下式
- 紧凑化：padding 14→12/14、宽度 268→260、section 间距 14→10、segment padding 7/4→6/4、model row 8/12→6/10，整体节省 ~60px 垂直

**删除的旧代码**：
- 浏览器原生 W3C Translator API provider（user gesture 要求 + 下载 race condition 太折腾，功能收益低）
- legacy `injectSuperFineButton` / `.dualang-super-btn` 按钮 + 所有 `article.dualang-super-translating` 样式
- `processedTweets` 从 `const WeakSet` 改 `let` 以便 re-enable 时重建

## P39: 展示风格扩展 —— 逐行融合 + 智能字典

**新增两个正交开关**：

1. **逐行融合（lineFusionEnabled）**：对照模式下，多行原文（≥2 行）的译文逐行交错在对应原文行之下，中间用细分隔线隔开。append 模式 tweetText 隐藏，pair 内同时克隆原文行 + 译文行（否则会出现"原文两次 + 孤立分隔线"的坏视觉，是 code-review 抓出的 blocker）。bilingual 模式同理。data-dualang-line-fusion="true" 驱动 CSS 隐藏 tweetText + 分级强调（append 亮原文暗译文 / bilingual 反之）。
2. **智能字典（smartDictEnabled）**：英文原文里的高难词加注释（真实 DOM 子 span，非 `::after`，可选中复制朗读）。难度按 GLM 金标集校准的 `cet6 / ielts / kaoyan` 三档，渲染为"六级 / 雅思 / 考研"中文徽章 + 轻微色差（淡蓝 / 淡金 / 淡红）。`cet4` 及以下常见词不收。

**对齐算法** (`line-fusion.ts`)：
- 行数一致 → 直接对齐（confident=true）
- 译文单行 + 原文多行 → 按句末标点重分组（CJK 标点直接切、西文标点仅在前导 ≥3 词字符时切以避免"Dr. Smith"误拆）；每个槽都非空才 confident
- 其他不匹配场景（译文超出 / 不足）→ confident=false 回退到非 fusion 渲染（不强行合并 / 填空）

**字典应用** (`smart-dict.ts`)：
- `isLikelyEnglishText`：latin / (latin + cjk) > 0.75 且 latin ≥ 12
- `extractDictionaryCandidates`：清 URL/@/#，去 stopwords（~100 词），封顶 `MAX_CANDIDATES = 40`
- `applyDictionaryAnnotations`：TreeWalker 遍历文本节点，按 term 正则 `\b` 单词边界匹配，插入 `<span class="dualang-dict-term">WORD<span class="dualang-dict-def" data-level=...>【六级 /ipa/ 释义】</span></span>`
- 配套 `applyDictWithBaseline` / `clearDictWithBaseline` 包装：每次注入后同步 `ensureState(article).lastText = tweetTextEl.textContent || ''`，避免 MutationObserver 把字典 span 当"文本变化"触发 show-more 重翻循环
- 字典 toggle 快路径 `toggleDictionaryAcrossVisible`：只加 / 移 span，不重渲译文卡、不再次打 API（过去切字典一次触发几十条 `annotateDictionary` 请求）

**熟字典缓存**：
- `dictCache: Map<contentId|originalText, { entries, ts }>`，LRU + TRANSLATION_CACHE_MAX 上限 + TTL 一致
- show-more 时 `dropByContentId` 失效，`disableAndReset` 时全清

**字典 API**（初版，独立路径）：
- `chrome.runtime.sendMessage({ action: 'annotateDictionary', payload: { text, targetLang, candidates } })` → background → `doAnnotateDictionary`
- 走 `rateLimiter.acquire` 与翻译主路径共享 RPM/TPM 预算、记 `recordRequest` / `recordError`
- 失败时返回 `{ entries: [] }` 静默降级，主翻译链路不受影响

**测试**：9 个新 e2e scene（bilingual fusion / append fusion / single-line no-fusion / 字典 happy path / translation-only skip / 非英文 skip / 字典 API 失败 / 逐行融合回退 / 对齐低置信）+ 4 个新 vitest unit + 5 个新 parser 测试。

## P40: 翻译 + 字典融合一次调用（combined call）

**目标**：把独立的 `annotateDictionary` 请求并入翻译批量请求，减一次 RTT、共享上下文。

**协议扩展**：
- `TranslateBatchPayload` 新增 `smartDict?: boolean` 和 `englishFlags?: boolean[]`（与 texts 对齐，per-item 英文标记，content 判断一次 background 不重做）
- `TranslateBatchResult` 新增 `dictEntries?: (DictionaryEntry[] | null)[]`

**Prompt**：
- `composeSystemPrompt(opts.smartDict)` 在 batch 基础上追加 `BATCH_DICT_SUFFIX` —— 要求被标记 `===N=== (dict)` 的条目在译文后输出 `---DICT---` 段，四段式 `term|/IPA/|释义|level`
- `buildBatchUserContent(texts, smartDictIndices)` 在对应 index 的 header 后补 `(dict)` 标记
- `parseDelimitedBatchWithDict` 拆出 translations + dictEntries；失败回落到老 `parseDelimitedBatch`

**管道打通**：
- `handleTranslateBatch(englishFlags?)` → 把 englishFlags 全量映射为 `smartDictIndices` 子集 index → 传给 `doTranslateBatchRequest`
- in-flight dedup key 加 `dict:...` 后缀（防止"字典开"与"字典关"两路请求共享同一个不带字典的结果）
- `applyBatchResult` 接受 `dictOut?` 缓冲区，把 API 返回的字典映射回全量下标
- `runFallback` / `raceMainAndFallback` 同样传递 `smartDictIndices`

**Content 侧消费**：
- `flushQueueSendMessage` 把 `data.dictEntries[j]` 传给 `renderAndCacheResult(item, translated, meta, freshDict)`
- 成功时 `applyDictWithBaseline` 直接渲染 —— 省掉 `maybeApplySmartDictionary` 的独立 API 往返
- 为空 / undefined 时回退到独立字典 API 路径（缓存命中、非英文、模型省略 ---DICT--- 均覆盖到）
- `translateImmediate`（Show more / 质量重试）同样消费 `response.data.dictEntries?.[0]`

**词汇分级**（按 `docs/superpowers/reports/2026-04-20-glm-mixed-request-benchmark.md` 金标校准）：
- `DictionaryEntry.level`: `'cet6' | 'ielts' | 'kaoyan'`（GLM-4-9B 在 32 词金标集 96.88% 准确）
- 不收 cet4 及以下常见词；模型 label `cet4 / rare / advanced` 等在 normalizer 里被丢弃，entry 保留但无徽章
- 渲染为中文徽章 `六级 / 雅思 / 考研` + `data-level` 属性驱动 CSS 色差

## P41: Combined call 小模型退化兜底（tolerant parser + retry + 熔断）

**触发场景**：GLM-4-9B 多条 batch 遇到 `===N=== + (dict) + ---DICT---` 三层标记偶发退化 —— 输出重复词（`into into into into`）、`===` 结尾残缺（`===1 (dict)\n...`）、`---DICT---` 首字母被当成 index（`===D (dict)`）。

**三层防护**：

1. **宽松解析**（`parseDelimitedBatchWithDict`）：正则从 `/^===\s*(\d+)\s*===(?:[^\n]*)\n?/m` 放宽为 `/^={2,}\s*(\d+)\s*(?:={2,})?[^\n]*\n?/m` —— 结尾 `===` 变可选。能抢救一条就抢救一条。
2. **零成功时重试（不带字典）**：`doTranslateBatchRequest` 检测 `successCount === 0` → 递归一次同请求但去掉 `smartDictIndices`。丢字典保翻译，比整批失败好。失败条目会触发 content 侧的独立字典 API fallback。
3. **会话级熔断**：`combinedFailures: Map<model, number>` 记录本会话每个 model 的 combined parse 失败次数，≥3 次后后续 `doTranslateBatchRequest` 对该 model 跳过 combined（等同不带 smartDict 调用），SW 重启或一次成功即清零。避免"每次请求都浪费一次 combined 再重试"。

**可观测性**：
- `dict.request.ok / dict.request.fail / dict.response.ok / dict.response.fail / dict.skip.noCandidates / dict.request.err` 六种日志在 content / background 分别发出，含 model、rttMs、candidates 数、entries 数、错误信息
- combined parse 失败会 `console.warn('[Dualang] combined call parse failed')` 带 200 字 raw preview、当前 model、熔断计数

**单独字典 prompt 放宽**（`doAnnotateDictionary`）：原版"cet4 及以下一律不收"太严格，典型短推文（没有显著高难词）返回空。新版鼓励抽 1-3 个"中文读者可能不熟悉的词"（学术 / 低频 / 俚语 / 专业），level 从 cet6/ielts/kaoyan 选；只明确拒绝 everyday cet4。

## P42: 隐藏 Moonshot / Kimi 预设（UI 层）

- `ModelPreset.hidden?: boolean` 字段；`moonshot-k2.5` / `moonshot-v1-8k` 标 `hidden: true`
- 新导出 `VISIBLE_MODEL_PRESETS = MODEL_PRESETS.filter(p => !p.hidden)`；popup 下拉 + 浮球模型列表均消费可见集
- `detectPreset` 仍遍历完整 `MODEL_PRESETS`，老用户 storage 里还留着 moonshot 配置也能被识别（不破坏历史设置）
- popup.html 删掉硬编码的两个 `<option value="moonshot-*">`、折叠空掉的"实验 / 慢" optgroup；placeholder 从 moonshot 改 SiliconFlow；API Key hint 去掉 Kimi 链接

## P43: 字典本地难度预筛（Zipf + 音节 + 词长）

**动机**：把"筛词"从模型挪到插件本地。之前的 prompt 要模型自己判断"哪些词该收"，小模型经常漏 / 误收 / 输出空；且每次都花 token 反复判断常见词。

**新模块 `src/background/difficulty.ts`**（参考 `docs/refs/difficulty.ts`）：
- `analyzeWord(word, opts)` 返回 `{ word, zipf, freqScore, syllables, length, domainBoost, rawScore, level: 0-4 }`
- `filterHardCandidates(list, { threshold, max, domainWords })` 按 rawScore 降序取 top-N，阈值 0.5 ≈ B2+
- `syllableCount` 自己实现：元音分组扫描 + CVCe 哑 e 扣一 + VVCe 保留 + C+le 保留（规则用 `make/time/smile/create/able/table` 这些金标验证）
- 数据源：`src/background/common-en-words.ts` 内嵌 ~1500 个 COCA/Oxford 高频词 Set；词表命中 → Zipf=6.5（视作 cet4 以下），未登录 → Zipf=2.0（视作 C1+）
- 性能：单词 ~2-10 µs，一批 10-15 候选 < 0.3 ms，相对 1-2s 的 API 调用基本免费
- 体积：+30KB 到 `background.js`（词表），content 零影响

**共享层调整**：
- 把 content/smart-dict.ts 里的 `extractDictionaryCandidates` / `isLikelyEnglishText` / `MAX_CANDIDATES` 上提到 `src/shared/english-candidates.ts`，background 也能用；content/smart-dict.ts 保留 DOM 注入和 `DictEntry` / `levelBadge` 等
- `STOPWORDS` 也上移；分层：content 端的 STOPWORDS 是"极保守基础停用词"（~130），background 的 COMMON_EN_WORDS 才是真正的难度阈值决定者（~1500）

**两条字典路径都打 filter**：
- `doAnnotateDictionary`（独立字典 API）：`handleAnnotateDictionary` 在进 doAnnotateDictionary 前先 `filterHardCandidates(rawCandidates, { max: 6 })`；全空（推文都是简单词）→ 直接 `dict.skip.allEasy` 日志 + 返回空，**不再发 API**
- `handleTranslateBatch`（combined call）：对每条英文 text，`extractDictionaryCandidates` → `filterHardCandidates(..., { max: 6 })` → `perItemCandidates[i]`。无难词的 item 不会被打 `(dict:)` 标记
- `buildBatchUserContent` 支持 `perItemCandidates`：把候选直接写进 user message "`===0=== (dict: mercurial obscure enigmatic)`"，模型被限定只能从这些候选里出字典 —— 免去"该不该收"的判断
- `BATCH_DICT_SUFFIX` prompt 更新说明这个新契约："括号里的词是预筛过的高难候选，字典条目只能从这些候选里选"

**日志增强**：
- `dict.request.ok` 从只有 `{candidates, entries}` 改为 `{raw, hard, entries, rttMs}`，直接看到过滤前 / 过滤后 / 模型返回的三段数据
- `dict.skip.allEasy { raw, hard: 0, textLen }` 记录"候选 > 0 但本地预筛判定全简单 → 省了一次 API"的场景

**测试**：`src/background/difficulty.test.ts` 11 个单测（syllable 边界、analyzer 基线、filter 排序 / 阈值 / 领域加权）；`profiles.test.ts` 更新 buildBatchUserContent 覆盖新 `(dict: w1 w2)` 形态。

## P44: Combined call 惠及 count=1 + Dict cap 10→6 + 原样回译变 pass

**动机**：P42 CDP 实测 60s 产生 13 次独立 `annotateDictionary` API 调用、0 次 combined（全部 count=1 sub-batch），combined 优化名存实亡。同时候选 ≥ 13 的请求 RTT 达 9-13s，user 抱怨等字典；还有 2 次 `translation.quality.give_up` 是模型把短推 / 专名推文"原样返回英文"导致红叉。

**三改动**：

1. **Combined call 惠及单条 batch**（`src/background/api.ts doTranslateBatchRequest`）：
   - 旧：`dictRequested = !isSingle && ...` —— 硬编码跳过单条
   - 新：`useStructured = !isSingle || !!dictIndices` —— 只要启用字典就用 `===N===` 结构，单条也不例外
   - 单条 + 字典：走 batch 格式 + 合并翻译 + 字典进一次 API，跳过独立 `annotateDictionary`
   - 单条无字典：仍走纯文本（零结构开销）
   - 解析分支同步：`if (!useStructured) { 纯文本 } else { 分隔符 ± dict }`；retry-without-dict 失败兜底对单条回落到纯文本路径

2. **Dict max: 10 → 6**（`handleAnnotateDictionary` 和 `handleTranslateBatch` 两处）：
   - bench 实测：候选 20+ 的请求 RTT 9-13s，生成 10 条字典是大头；降到 6 后输出体积减半、RTT 预计降到 5-7s
   - 学习价值"前 6 个最难"已足够；词汇过载反而降低阅读效率

3. **原样回译 → showPass 而非 showFail**：
   - 新 utility `isVerbatimReturn(original, translated)`（`src/content/utils.ts`）：归一化空白 / 大小写后比较相等
   - 覆盖场景：短推（"Lit."）、纯专名（"Notion Obsidian"）、纯引述 —— 模型没法翻译只好原样返回
   - `renderAndCacheResult` / `translateImmediate` 先判 verbatim：命中 → `logBiz('translation.verbatim.pass')` + `showPassAndHide`，跟"已经是目标语言"走同一条"灰点跳过"通路
   - 不再走 `quality.retry → give_up` 两次重试 + 红叉 UX；真正的低质量翻译（语言错 / 段落坍缩）仍走原逻辑
   - 5 个单测覆盖（完全相同、大小写 / 空白差、真翻译、部分翻译、空串防误判）

**CDP 实测验证**（P42 的 `scripts/cdp-probe-dict.mjs` 连 9222 跑 60s）：三处优化都看到日志实锤 —— `dict.response.ok entries: 6` 稳定、`translation.verbatim.pass` 替代部分 give_up、`candidates: 27 → entries: 0`（本地全筛掉）免 API 调用。

## P45: 字典注入目标按 displayMode 分发（bilingual/inline bug）

**症状**：用户在 `displayMode: "bilingual"` 下反馈"页面看不到任何 dict 翻译"，但日志显示 `dict.response.ok entries: 6` 正常触发。

**根因**：styles.css 在 `bilingual` / `inline` / `translation-only` / `line-fusion` 下 CSS 把原生 `[data-testid="tweetText"]` 设为 `display: none`；用户看见的"原文"其实是 card 里的克隆 `.dualang-translation .dualang-original-html`。但 `applyDictWithBaseline(article, tweetTextEl, entries)` 把字典 `<span>` 打进了那个隐藏元素 —— DOM 里有，屏幕上看不到。

**修复**（`src/content/index.ts`）：
- 新增 `dictTargetEls(article, fallback)`：按 `displayMode` 路由
  - `append` → `[tweetTextEl]`（可见）
  - `translation-only` → `[]`（用户看不到原文，不注字典）
  - `inline / bilingual / line-fusion` → card 内的所有 `.dualang-original-html` 克隆块
- `applyDictWithBaseline` / `clearDictWithBaseline` 两个 wrapper 都先扫干净 `fallback` + 所有克隆块里的残留 span，再按当前 mode 注入。mode 切换（append → bilingual）时旧位置不会留 span 不动
- 基线 `lastText` 仍基于 `tweetTextEl.textContent`（show-more 检测看的是原生 tweetText，跟字典注哪儿无关）；MutationObserver 的 `.dualang-dict-term` skip 守卫不受影响（看 class 而非位置）
- inline 模式下多段落克隆天然每个都被注释 —— `applyDictionaryAnnotations` 的 `used` set 是 per-call 的，每个克隆独立 scope，同词多处出现都能标上

## P46: extractText 链接 / @mention 折行修复 + model logo 位置 + 字典联动

**症状 1（灾难折行）**：X.com 把 `@TensorFlow` / `#HuggingFace` / `reut.rs/xxx` 等 `<a>` 用 CSS 渲染成独占视觉行，`innerText` 在前后塞 `\n`。extractText 产出 `using\n@TensorFlow\n,\n@opencvlibrary\n...` 形态，模型忠实复现这些换行，生成的译文渲染成孤立 token 竖排。

**修复**（`src/content/utils.ts extractText` 末尾新增 `reflowStrandedTokens`）：
- 段落分隔 `\n\n` 永远保留
- 段内单 `\n` 若任一侧命中 strand token（`@foo` / `#foo` / `https?://\S+` / 纯短标点 `,` `、` `/` `|` `-`）→ `\n` 消成空格
- 三种判定：整行是 strand / 上行尾是 strand / 当前行首是 strand；覆盖 `..., and @pycharm` 和 `@pycharm ...` 两种连锁断行形态
- 长链接不再加长度上限（早期 `\S{1,40}` 导致长 URL 被漏判）

**症状 2（品牌 logo 飘到右上）**：translation-only / inline / line-fusion 下 tweetText 被 CSS 隐藏，`showSuccess` 却把 status 元素插在 `tweetTextEl.nextSibling`（即隐藏元素和 card 之间），视觉上浮到 card 右上角。

**修复**（`src/content/index.ts showSuccess`）：把 status 的插入锚点从 `tweetTextEl.nextSibling` 改为 `card.nextSibling`；复用旧 status 时若位置不对也重新搬到 card 之后。对所有 displayMode 稳定落右下。

**字典联动**（`src/content/super-fine-bubble.ts`）：翻译总开关关闭时字典 checkbox 视觉 unchecked + `disabled` + 套 `--muted` 样式；不覆盖存储里的 `smartDictEnabled`，重新开启翻译时字典自动恢复到用户原先的偏好。

## P47: Linkify 多形态识别 + line-fusion 原文保真

**动机**：P39 的 `linkifyText` 只识别 `https?://...`；X.com 实际会把 `reut.rs/xyz` / `github.com/foo` / `@user` / `#tag` 作为显示文本（真实 href 在 `<a>` 上）。line-fusion 用字符串重渲染 → 原文里所有非 https 锚点都变纯文本，失去可点击。

**linkifyText 四形态**（`src/content/render.ts`）：
1. `https?://\S+` 完整 URL（原有）
2. **bare 短链**：白名单 TLD（com/io/to/me/ly/rs/gg/ai/dev/co/cn/...）+ 路径，自动补 `https://` 前缀
3. `@username` → `https://x.com/username`，lookbehind 排除 email（`foo@bar.com`）
4. `#hashtag` → `https://x.com/hashtag/xxx`，Unicode 支持中/日/韩话题

四类按顺序匹配，重叠时先入优先（`https://a.com/@foo` 不会被 `@foo` 切开）。

**原文 DOM 保真**（`src/content/utils.ts splitLinesByDom`）：新函数按单 `\n` 把 tweetTextEl 切成 `DocumentFragment[]`，完整保留原 `<a href>` / `target` / `rel`。render.ts line-fusion 路径优先用它，原 X.com 真实链接直接可点；行数对不上时回落字符串 + linkifyText 兜底。

**测试**：新增 6 条 linkify 单测（bare 短链 / @mention / #hashtag / email 不误伤 / 完整 URL 优先 / splitLinesByDom DOM 锚点保留）。

## P48: 浮球状态机升级 + 点击切换开关 + hover watchdog

**新状态**（`src/content/super-fine-bubble.ts` + `styles.css`）：
- `--off`（关闭）：灰底、logo 去饱和、环不可见
- `--idle-ok`（启用空闲）：右下角 14px 绿底 ✓ 徽章（SVG 画的勾）
- `--busy`（翻译中）：蓝色扫描弧线围绕旋转 1.2s 线性 + 呼吸放大 + 发光
- `--has-error`（阻碍型错误）：右下角红底 × 徽章，pop 入场动画；与 `--busy` 可叠加
- super-fine 的 done / failed 保留

**activity 计数**：content/index.ts 在 `withSlot` 和 port stream 两条路径 `activeRequests++/--` 时调 `bubble.setTranslationActivity(n)`；翻译并发 → 气球 busy，回落 0 → busy 消失。`translateImmediate` / `translateImmediateBoost` 独立通道也补了 activity bookends。

**点击切换 enabled**：从旧的"toggle panel pinned"改为 `writeSettings({ enabled: !enabled })`；移除 `--pinned` 状态（CSS 规则同步删除）。segment 按钮"只看原文"仍然通过 enabled=false 实现，两条写路径幂等无竞争。

**hover watchdog**：保留 `pointerenter/leave` 主路径（低延迟响应），新增 document 级 `pointermove` watchdog。panel 可见时按 `root` / `panel` 包围盒 ±16px 走廊实时判断，离开 180ms 收起。`window.blur` 也强制收起。修复"DOM 替换 / 布局抖动吞掉 pointerleave 导致面板挂住"的老 bug。

**阻碍型错误红叉**：监听 `chrome.storage.local.onChanged` 的 `dualang_error_v1` key —— background 的 `callWithRetry` 对不可重试错误（401/403/quota/content_filter/批量结构错）自动写入该 key，下次成功时 `clearErrorState()` 自动清除。个位数单条重试失败不触发。初始化读一次已有状态；有错误时让位 `--idle-ok`，让红叉独占右下角。

## P49: 品牌 logo 点击重译 + retranslateBoost（温度+提示双重扰动）

**动机**：成功后用户点击 logo 之前打开官网；但真实场景是"对当前译文不满意 → 想让模型试试手气"。重新调接口比跳外链价值大得多。

**改动**（`src/content/index.ts showSuccess.onclick`）：
- 清 `.dualang-translation` + `data-dualang-mode` + `qualityRetried` 标记
- 新函数 `translateImmediateBoost(article, tweetTextEl)`：走 `requestTranslation([text], 2, true, true, { retranslateBoost: true })` —— priority 2 绕限流、skipCache 避开缓存坏翻译、strictMode STRICT_PREFIX 防压缩、retranslateBoost 触发后端双扰动
- tooltip 改为 `当前模型：X\n描述\ntokens\n点击重新翻译，试试手气（绕过缓存，更强提示）`
- logo 旋转状态 `.dualang-status--retranslating`：品牌 img 1.1s 线性旋转 + 脉动发光；showSuccess 回流时覆盖 className 自然停掉

**retranslateBoost 管道**（`src/shared/types.ts` + `src/background/*`）：
- `TranslateBatchPayload.retranslateBoost?: boolean`
- `handleTranslateBatch` / `handleTranslateStream` 入口派生 settings 副本（`temperatureBoost: 0.3, retranslateBoost: true`），不污染 settingsCache
- `composeSystemPrompt` 接 `retranslateBoost` → 前置 `BOOST_PREFIX`（"用户对上次译文不满意，请用更精准、地道的目标语重译，允许换措辞但保留原意"），置于 STRICT_PREFIX 之前
- `effectiveTemperature(profile, settings)`：读 `temperatureBoost`（+0.3），clamp `[0, 0.9]`；api.ts 三个调用点（doTranslateSingle / doTranslateBatchStream / doTranslateBatchRequest）全部切到这里
- 长文 `requestTranslationChunked` 也透传 `retranslateBoost` 到 port payload

## P50: storage quota 兜底（cache / stats）

**动机**：chrome.storage.local 配额约 5MB；长期使用 + 长译文会让 L2 缓存触顶，写入直接抛 `QuotaExceededError`，连带影响后续 setCache 调用链。

**`src/background/cache.ts`**：
- `CACHE_MAX_SIZE` 5000 → **500**；5000 条长译文容易超限，500 条覆盖重度浏览 session + L1 内存 2000 条热缓存足够兜底
- `setCache` 捕获 quota 异常 → 额外删 50% 最旧条目后重试一次（激进清理模式）

**`src/background/stats.ts`**：
- `schedulePersist` 捕获 quota 异常 → 丢弃 errors 数组（统计数字比最近错误日志重要），重试写入

## P51: 译文多媒体保真（`[[Mn]]` 占位符 + 原 DOM clone）

**症状**：X Articles 在 translation-only 模式下译文卡里完全没有原文嵌入的图片 / 视频 / 音频。CDP 探针实测 `intuitiveml/status/2043545596699750791` 有 5 张 `tweetPhoto` 嵌在 `twitterArticleRichTextView` 内，译文卡只剩文字。

**根因**：`extractText(tweetTextEl)` 用 `innerText` 只拿字符；媒体元素对字符串序列不可见；模型输出自然没有媒体；渲染再走 `linkifyText` 也只能看到文本。

**修复（`src/content/utils.ts`）** —— 新增 `extractTextWithMedia(el): { text, media: HTMLElement[] }`：
- 扫描 `<img>/<video>/<audio>`，向上爬 4 层找最近 `[data-testid="tweetPhoto"]` 或 `<a>` 外层包装（保留 X.com 点击放大的 href + 完整样式）
- 同一 `tweetPhoto` 下多张 img 去重
- 沿用 dict-def 的 detach-extract-reattach 模式：原 DOM 里临时换成 `[[M0]]` / `[[M1]]` 文本节点 → 读 innerText → 还原
- 返回的 media 是 `cloneNode(true)` 快照，不改动原 DOM，可多处插入

**渲染（`src/content/render.ts`）** —— `renderTranslation` 的 `enhancements` 增 `media?: HTMLElement[]`；新 helper `substituteMediaAndLinkify(text, media, usedMedia)`：
- 扫描译文里的 `[[Mn]]` → 用 `media[n]` 的 clone 替换（每次替换再 clone 一次，允许跨 card / 跨段复用）
- 其余片段仍交 `linkifyText` 处理 URL / @mention / #hashtag
- `usedMedia: Set<number>` 在整张 card 的所有段 / 行间共享
- **tail 兜底**：渲染末尾扫 `usedMedia`，把模型吞掉占位符的媒体追加到 card 尾（`.dualang-media-tail` 类，略降低饱和），确保绝不丢

贯通所有显示路径（inline / line-fusion / append-bilingual-translation-only），每种模式译文卡都能承载媒体。

**Prompt（`src/background/profiles.ts`）** —— SINGLE_PROMPT + BATCH_PROMPT 各加一条：
> 形如 `[[M0]]`、`[[M1]]` 的标记是媒体占位符，按原文出现位置原样保留，不要翻译、删除或改写里面的数字。

**CSS（`styles.css`）** —— `.dualang-media` 限 max-width 100% + 圆角 12px；`.dualang-media-tail` 略降透明度。X.com 内层 grid 样式继续工作，不另写。

**状态存储（`src/content/article-state.ts`）** —— `ArticleState.media?: HTMLElement[]`；三条提取入口（normal batch / translateImmediate / translateImmediateBoost）写入；`renderTranslationLocal` 读取传给 renderTranslation。

**范围限制**：只处理 `findTweetTextEl` 容器内的媒体。规则推文的 sibling `tweetPhoto`（在 tweetText 之外）不在本次处理；它们在 translation-only 模式下本来就不被 CSS 隐藏，保留原有行为。

**测试**：9 条新单测（utils 5 条：无媒体 / 单图 tweetPhoto / 多图排序 / video+audio / 共享容器去重；render 4 条：translation-only 正常替换 / 模型吞占位符 tail 兜底 / 多媒体相对顺序 / 空媒体）。

## P52: 长文翻译自适应超时 + 自适应 max_tokens

**动机**：CDP 实测 20k 字 X Article 走 translateImmediate 路径（isLongText 判定基于 \n\n 切段，147 段 DOM 段落经常压成 < 6 段文本段落 → 走固定路径而非 chunked），连续被两个固定值打败：
1. `REQUEST_TIMEOUT_MS = 30s` 对 20k 字输入不够（GLM-4-9B 约需 60-120s）→ 超时 → 质量重试 → 又超时 → 反复
2. `max_tokens = 4096` 固定上限 → 模型吐到 ~4096 tokens（≈ 700 字中文）就被硬截 → `transLen: 713` 反复出现 → 触发质量重试死循环 + 最终红叉

**自适应超时（`src/content/constants.ts`）** —— `adaptiveTimeoutMs(charCount, baselineMs, maxMs=180_000)`：
- 公式：`min(maxMs, max(baselineMs, chars/150 * 1000))`
- 150 chars/sec 是 GLM-4-9B on SiliconFlow 经验值（20-40 tokens/s × 4 chars/token 的 0.5x 安全余量）
- 短内容用 baseline 保底，3 分钟封顶防挂死
- 20k 字 → 134s；4k 字 → 60s baseline；500 字 → 30s baseline

三条路径切到动态超时：
| 路径 | 旧 | 新 baseline + 动态 |
|------|----|----|
| `requestTranslation` Promise.race | 30s 固定 | 30s + chars/150s |
| `flushQueueStreaming` port 超时 | 30s 固定 | 30s + chars/150s |
| `requestChunkViaPort` chunk 超时 | 60s 固定 | 60s + chars/150s |

**自适应 max_tokens（`src/background/api.ts`）** —— 新 `computeMaxTokens(settings, texts)` 统一替代旧的 `maxTokensPerItem` / `maxTokensForBatch`：
- 公式：`min(32_000, max(userCap × count, chars/2 + count × 120))`
- 比率从旧 `chars/3` 改 `chars/2`（CJK 目标语言译文字符 × 1.5-2 token；英→中译文字符约为输入 70%，留安全余量）
- 32k 硬上限防配额浪费 + 规避 provider 的硬 cap（通常 8k-32k）
- 20k 字单文：4096 → **10120**（够翻完整篇）
- 100k 字：20120 → 32000（硬上限）
- 短文本继续用 userCap 保底行为不变

**同步更新：**`pipeline.ts estimateTokens` 和 `background/index.ts handleTranslateStream` 的内联估算也改 chars/2，保证 rate-limiter 配额预估与真实 max_tokens 一致，避免"limiter 放行但真实输出超限触发 TPM"。

**测试**：5 条超时测 + 5 条 max_tokens 测（基线 / 短文保底 / 长文扩展 / 硬上限 / 自定义 cap）。

## P53: 长文管线与常规管线的职责切分（架构记录）

**背景**：长文渲染偶现黑屏 / 图像塌陷 / 「图像」字样 slot / 部分段落未翻译。排查过程中发现根因是**两条管线对同一篇长文都跑了**，具体表现：

- Super-fine（`super-fine-render.ts`）：通过 `extractAnchoredBlocks` 走 leaf-block 遍历，只抽文本，通过 inline slot 追加到每个原块 `afterend`，**不克隆媒体、不动原 DOM**
- Regular（`render.ts`）：通过 `extractTextWithMedia` 把媒体换成 `[[Mn]]` 占位符，渲染时 `cloneNode(true)` 把 X 的 `[data-testid="tweetPhoto"]` 脚手架（绝对定位 + `padding-bottom` 比例撑高）整块克隆进 card。克隆到 `.dualang-line-fusion-orig` / `.dualang-para` 后失去撑高父级 → 容器塌 0 / `background-image` 占位叠黑 / 视频 poster 显示异常

**设计决策**：长文一律只走 super-fine，regular 管线对长文短路。**不考虑**"只保留某种显示模式"的方案（line-fusion / translation-only / inline 都走 `substituteMediaAndLinkify` 克隆媒体，无一豁免）。

**管线短路点**（实际代码里，命名为 long-article route guard）：
- `scanAndQueue` 识别 `isXArticle + isLongRichElement` → 打 `data-dualang-long-article="true"` + `data-dualang-article-id` → 走浮球 `setLongArticle` 路径 → 不 `viewportObserver.observe` / 不 `preloadObserver.observe`
- Super-fine 的触发保留在浮球"精翻此文"按钮（P35 原设计）
- 常规入口在后续 session 里探讨过增加 `isLongArticleRoute(article)` 哨兵到 `queueTranslation` / `translateImmediate` / `translateImmediateBoost` / `handleShowMoreOrRecycle`，让 mutation observer / show-more / cache-restore 回路也不会把长文推进 render.ts —— 该方案**已回滚**，当前依赖 `scanAndQueue` 的 `return` + 不注册 observer 作为主要路障。**回归策略**：若未来再次复现长文被常规管线染指，用 attribute 哨兵强行兜底

**副作用**：
- `extractAnchoredBlocks` 对 img-alt 块的处理在 prod 场景下产出「图像」 / 「嵌入式视频」 / 「方形资料图片」等 X 本地化占位符 —— 作为文本送翻译后返回依旧是"图像"（已是目标语言），slot 呈现为无意义的单词。探索过"过滤 img-alt 块"和"译文=原文的 noop slot 折叠"两种方向，**均已回滚**，等未来有更完整的 CTA 重构再合入
- 普通推文的媒体克隆问题（非长文场景）不受影响，`[[Mn]]` 占位符 + `substituteMediaAndLinkify` 的既有 tail 兜底继续生效（P51）

**i18n 已落地**（`src/shared/i18n.ts`，commit 51c8fd0）：`ctaTranslateNow` / `ctaCancel` / `ctaRetry` / `ctaRetryFail` 四条 CTA 文案 × zh-CN/zh-TW/en/ja/ko 五语言，为未来统一 CTA 状态机预留

**待办（不一定要做）**：
- [ ] 评估 CTA 状态机重构：文章头部右对齐链接形态的 `立即 X 光速翻译` / `取消翻译` / `重新翻译` / `重试翻译`，合并浮球"精翻此文"和一般推文手动按钮两条入口（已探索一版实现，被回滚）
- [ ] 若 A/B 测试倾向保留浮球入口，把 i18n 字符串下放到浮球面板的精翻按钮上，移除 hardcoded "精翻此文"
- [ ] `extractAnchoredBlocks` 的 img-alt 分支长期来看价值为负（alt 几乎总是 X 本地化占位），考虑默认跳过，配合 smart-dict / figure caption 走更精准的路径
