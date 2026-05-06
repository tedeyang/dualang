# X.com Status 页滚动跳动 bug 调查

**Status**: Partially fixed (2026-05-06)
**Affected URL pattern**: `https://x.com/<user>/status/<id>` 长 reply thread

## 1. 用户原始症状

> 在评论区滚动鼠标，页面会自动向下滑动到底部。

进一步描述的复现剧本（bilingual + 字典 ON）：
1. 滚到 thread 底部，等所有可见推文翻译完成
2. 鼠标滚轮**向上**滚一页
3. 等待
4. 页面自动滚回到底部

## 2. 调查方法

### 2.1 自动化复现尝试

最终路径（前几次失败的细节略）：
- Playwright `launchPersistentContext` 启 Chromium，`--load-extension` 加载已构建的 dualang
- 注入用户提供的 `auth_token` + `ct0` cookie 跳过 Google OAuth（X 的 OAuth 检测 Playwright 痕迹会拒绝登录；从用户 DevTools 复制 cookies 是当前唯一可行的本地化登录方案）
- 反爬 flag：`ignoreDefaultArgs: ['--enable-automation']` + `--disable-blink-features=AutomationControlled` + 真实 Chrome UA + `addInitScript` 抹掉 `navigator.webdriver`
- `chrome.storage.sync.set` 通过扩展 SW 写入测试期所需配置

> **教训**：Chrome 137+ 默认禁用 `--load-extension` 与 `--remote-debugging-port` 并存。CDP attach 路线行不通，必须让 Playwright 自己拉 Chromium。

### 2.2 探针设计

```js
// 触发 200px+ 跳跃时打印最近 5 条 tweetText 子树 mutation
addEventListener('scroll', () => {
  const dy = scrollY - lastY;
  if (Math.abs(dy) > THRESHOLD) console.warn('JUMP', dy, recentMuts.slice(-5));
  lastY = scrollY;
}, { passive: true });

new MutationObserver(ms => { /* 记录 closest('[data-testid="tweetText"]') 的 mutation */ })
  .observe(document.body, { subtree: true, childList: true, characterData: true });
```

加强版（捕捉所有 attribute mutation 来源 + 标记是否我方触发）见 todo.md 测试脚本。

### 2.3 初始假设（advisor 建议两条）

1. **X.com 的焦点推文居中行为**：`/status/<id>` URL 自带"focal tweet 居中"逻辑，扩展插入译文卡片改变 focal tweet offset 后，X 的 MutationObserver 重新触发 centering。
2. **smart-dict `replaceWith` 破坏 Chrome scroll anchor**：`applyDictionaryAnnotations` 用 `node.replaceWith(frag)` 在 `tweetText` 内做文本节点切换，scroll anchor 落点是该 `tweetText` 时，anchoring 失效。

## 3. 实际根因

### 3.1 主因：translationCache contentId 共享单 slot 导致重翻死循环

**用户日志现场**：
```
cache.invalidate.stale {contentId: '2051760086729785622', cachedLen: 39, currentLen: 32, reason: 'length-diff'}
translation.request.ok ...
dict.response.ok ...
cache.invalidate.stale {contentId: '2051760086729785622', cachedLen: 39, currentLen: 32, reason: 'length-diff'}
```

同一 `contentId`、相同 `39/32` 长度反复触发。

**机制**：
- `src/content/index.ts:1024`（旧）：`stale = !cached.original || currentText !== cached.original` —— 任意文本差异 → 作废
- X 的虚拟化对同一推文会在**截断态**（`...show more`，~32 字符）和**完整态**（~39 字符）之间反复切换 DOM
- 两态共享同一 `contentId`，单 slot cache 只能存其中一个 → 另一个文本一出现就触发 invalidate → 重翻 → 缓存覆盖 → 旧文本再出现又 invalidate → 死循环
- 每轮死循环都会重新插入译文卡片 + 重新写 dict span，DOM 高度反复抖动 → 累积 scroll anchor 补偿 → 视觉上"自动滑到底"

### 3.2 次因：dict span 注入触发 scroll anchor 补偿

Playwright trace 现场（用户上滚过程中）：
```
+521ms scroll: dy=-98 (用户向上滚)
+532ms mut:    ttMuts=1   ← dict 写入原文 tweetText
+541ms scroll: dy=+62    ← 9ms 后 scroll 反弹 62px（向下）
```

**机制**：
- `bilingual` 模式下 `dictTargetEls` 找不到 `.dualang-original-html` 克隆（render.ts:140-149 注释明确说 bilingual 不再克隆原文，靠 CSS 调暗），fallback 到原文 `tweetText`
- `applyDictionaryAnnotations` 写 `【释义 /ipa/】` 进 inline 流，导致 `tweetText` 行宽 / 行数变化
- Chrome scroll anchor 检测到锚点元素位置变化 → 调整 `scrollY` 补偿 → 视觉上几十 px 反弹

### 3.3 X.com 自身虚拟化的 attribute 批量 mutation

用户加强版探针记录到的 JUMP 现场：
```
14 条 mutation 同时 fire (ours: false)
class: css-175oi2r
type: attributes
add: 0, rm: 0
```

X 的 React/CSS-in-JS 虚拟化会在用户滚动停留时一次性改动 13+ 个 cell 容器的属性（疑似 `style` / `class` 切换），引发 reflow。我们没法控制这个源。

## 4. 已落地修复

### 4.1 `translationCache` 改成多 variant per contentId

新文件 `src/content/translation-cache.ts`：
- `Map<contentId, { variants: CachedVariant[], ts }>`，每桶最多 5 variant
- `match(contentId, currentText)`：按文本精确命中，未命中返回 undefined（**永远不主动 invalidate**）
- `set(contentId, value)`：同 `original` 替换、不同 `original` 追加
- `any(contentId)`：取最近写入 variant，供 mode 切换 / toggle restore 使用

迁移点：
- `src/content/index.ts:984-1002` 读路径：`get + 比较 + invalidate` → `match` 命中即用
- `src/content/index.ts:837` show-more 路径：移除 `translationCache.delete()` 和 `dictCache.dropByContentId()`
- 3 处 `set()` 调用：API 不变

### 4.2 `withoutScrollAnchorOneFrame` 包裹我方 DOM 改动

```ts
function withoutScrollAnchorOneFrame<T>(fn: () => T): T {
  const root = document.documentElement;
  const prev = root.style.overflowAnchor;
  root.style.overflowAnchor = 'none';
  try { return fn(); }
  finally { requestAnimationFrame(() => { root.style.overflowAnchor = prev; }); }
}
```

应用于：
- `applyDictWithBaseline` / `clearDictWithBaseline`
- `reRenderAllForModeChange`（mode 切换重渲染）
- `scanAndQueue` cache-restore 分支的 `renderTranslationLocal`
- `handleShowMoreOrRecycle` 的 card 移除 + rescan

原理：在我方同步 DOM 改动那一帧关掉 anchor 选择，避开 anchor "补偿性"位移；下一帧 RAF 自动恢复，X 自身的 anchor 行为不受影响。

### 4.3 单元测试覆盖

`src/content/translation-cache.test.ts` 新增 9 条测试，重点 case：

```
'repro of stale-loop bug: ping-pong between two variants never invalidates'
```

直接 assert 100 次 39↔32 切换全部 cache hit、零 invalidate。

## 5. 走过的弯路

### 5.1 全局 `html { overflow-anchor: none }` —— 反向加剧

加了一版"全局禁用 scroll anchoring"的 CSS rule，预期治本。但用户报告新症状：
> 页面会缩短，单条评论看起来向上移动，滚动条向下跳一小段

这恰好是 anchor **没工作**的特征 —— X 上方虚拟化压缩了一段内容，scrollY 没补偿，可见区跟着上移。说明：

- 默认 anchor 行为对 X 是有用的（X 改 attribute 改高度时能保稳）
- 全局禁用 = 把这层稳定性也拆了
- **回退**：删除 `html { overflow-anchor: none }` 规则。只保留我方 DOM 改动的局部禁用

> **教训**：scroll anchor 是 Chrome 兜底防抖机制，只在我们**自己**触发的、我们不希望 anchor 补偿的 mutation 上局部关掉，不要全局动它。

### 5.2 length-diff 启发式（短于 cached 不算 stale）

最初提议的修复："只在 `current.length >= cached.length` 时才作废"。用户直接否决：
> 这个修复怎么也不对，有没有更彻底的 cache 方案

否决合理 —— 启发式留着结构性问题，长于 cached 同样可能是另一个变体（编辑、show-more 展开），单 slot 永远是错位的。多 variant 才是对的方向。

## 6. 未解决残留

撤回全局 anchor 禁用之后，用户仍然观察到滚动小跳，探针指向 X.com 的 `css-175oi2r` 批量 attribute mutation。我们能做的：

- ✅ 不让自己（cache 循环 / dict / card）放大问题
- ❌ 拦不住 X 自家虚拟化引发的 reflow

可选的更激进路径（**未实施**）：

1. **scroll lock（用户停留时）**：监听 wheel/key，500ms 内无用户输入 + scrollY 变化 → 强制还原。会跟 X 内部 scrollTo 冲突
2. **bilingual 模式下渲染 hidden mirror tweetText 给 dict 用**：彻底避免 dict 写原文。改动量大，违背"零克隆"设计
3. **dict 渲染改成 hover tooltip**：不占 inline 流空间。UX 改动大

下一轮如果还要推，建议从 #2 入手 —— 影响面可控，跟现有渲染管线兼容（inline 模式已经有 `.dualang-original-html` 克隆机制）。

## 7. 可复用产出

| Artifact | 用途 |
|---|---|
| `src/content/translation-cache.ts` | 多 variant 缓存，可复用到任何"key 共享但内容多态"的场景 |
| `withoutScrollAnchorOneFrame()` (helper in `index.ts`) | 任何会改 viewport 内 DOM 高度的同步操作都该套一层 |
| `e2e/`-style cookie-inject Playwright 套路 | 走过 X 反爬 + 真实 session 自动化测试的最小可行模板（见 `/tmp/playwright-test-scroll-jump.js`，已删除） |
| 探针（scroll-jump + mutation 标注 ours/X） | 区分"我方触发的 reflow"vs"X 自家 reflow"的标准查询脚本，复用于其他 reflow 类 bug |

## 8. 关联 commits

待提交：
- `feat(cache): multi-variant translationCache to break stale-loop bug` —— §4.1 + §4.3
- `fix(scroll): wrap DOM-mutating paths in overflow-anchor:none for one frame` —— §4.2
