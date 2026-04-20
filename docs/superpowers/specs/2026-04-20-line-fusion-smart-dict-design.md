# 逐行融合 + 智能字典 设计文档

## 1. 背景与目标

在现有 Dualang 对照体验上新增两项可叠加能力：

1. `逐行融合`：当原文为多行时，按“原文行 -> 分隔线 -> 译文行”显示，增强逐句对照感。
2. `智能字典`：仅对英文原文启用，在原文中的生僻/高难/俚语词旁追加 `【音标 + 释义】` 注释。

两项能力均为独立开关，与现有对照风格（`append` / `bilingual`）不互斥。

## 2. 非目标

1. 不重构现有 `displayMode` 主模型，不把模式改成多选枚举。
2. 不支持非英文原文的智能字典（本期明确英文-only）。
3. 不改动现有翻译主请求协议（`translate`）与缓存键结构。

## 3. 用户体验与交互

### 3.1 浮球面板（主入口）

在“对照风格”区块下追加两行独立开关：

1. `逐行融合`（`lineFusionEnabled`）
2. `智能字典`（`smartDictEnabled`）

说明：

1. 两开关彼此独立，可同时开启。
2. `逐行融合`仅在“对照语义”模式生效（`append` / `bilingual`）；在 `translation-only` 或 `inline` 下展示为可见但禁用态。
3. `智能字典`在 `translation-only` 下不生效（原文被隐藏，标注无展示位）。

### 3.2 Popup 设置（持久化入口）

在 `popup.html` 的展示设置区域新增同名两个 checkbox，写入 `chrome.storage.sync`，与浮球共享同一设置键。

## 4. 数据模型变更

`src/shared/types.ts` 的 `Settings` 新增：

```ts
lineFusionEnabled?: boolean;
smartDictEnabled?: boolean;
```

默认值（`popup` 与 `content`/`background settings` 同步）：

```ts
lineFusionEnabled: false
smartDictEnabled: false
```

## 5. 技术方案

### 5.1 总体架构

采用“主翻译链路不变 + 叠加增强层”：

1. 翻译仍由现有 `translate` / `renderTranslation` 完成。
2. `逐行融合`由 content 侧渲染器在已有卡片上按条件增强。
3. `智能字典`新增独立 background action：`annotateDictionary`，由 content 在翻译成功后异步触发，失败静默降级。

### 5.2 逐行融合渲染

新增渲染分支函数（建议位置：`src/content/render.ts`）：

`renderLineFusion(...)`

触发条件：

1. `lineFusionEnabled === true`
2. `displayMode` 为 `append` 或 `bilingual`
3. 原文“有效行数” >= 2

有效行定义：

1. 对 `extractText(tweetTextEl)` 按换行切分；
2. `trim` 后过滤空行。

行对齐算法（v1）：

1. 原文：`origLines[]`
2. 译文：优先按换行切成 `transLines[]`
3. 当 `abs(origLines.length - transLines.length)` 较大时，使用句末标点分句再按原文行数重分组
4. 计算对齐置信度（长度比例 + 行数差）
5. 置信度低则回退现有普通渲染（不输出错误 UI）

DOM 结构（每个 pair）：

```html
<div class="dualang-line-fusion-pair">
  <div class="dualang-line-fusion-orig">...</div>
  <div class="dualang-line-fusion-divider"></div>
  <div class="dualang-line-fusion-trans">...</div>
</div>
```

### 5.3 智能字典流程（英文-only）

#### 5.3.1 Content 触发时机

在 `renderAndCacheResult(...)` 成功路径中：

1. 若 `smartDictEnabled=false`，跳过。
2. 若原文非英文，跳过。
3. 若 `displayMode='translation-only'`，跳过。
4. 满足条件时异步请求 background：`annotateDictionary`。

#### 5.3.2 候选词筛选（content 预处理）

目标：减少 token 和噪音。

规则：

1. 仅英文 token（`[A-Za-z][A-Za-z'-]{2,}`）。
2. 过滤 URL/@/#/纯数字/停用词。
3. 去重后按词长、低频启发式排序，默认不设置硬上限（如后续出现性能瓶颈再加限流/上限策略）。

#### 5.3.3 Background 新动作

`runtime message`：

```ts
{
  action: 'annotateDictionary',
  payload: {
    text: string,              // 英文原文
    targetLang: string,        // 当前翻译目标语言
    candidates: string[],      // content 预筛候选
    contentId?: string
  }
}
```

返回：

```ts
{
  success: boolean,
  data?: {
    entries: Array<{
      term: string,
      ipa: string,             // e.g. "/kæp/"
      gloss: string,           // 短释义
      level: 'rare' | 'advanced' | 'slang'
    }>
  }
}
```

模型提示要求：

1. 仅从 `candidates` 中选择。
2. 词条数量不设置硬上限（由模型按“有价值程度”返回；后续按性能数据再做限制）。
3. `gloss` 简短，不写长句解释。
4. 输出严格 JSON，违规则按空结果降级。

#### 5.3.4 标注渲染

标注格式：

`term【/ipa/ gloss】`

实现策略：

1. 只处理可安全替换的文本节点，不进入链接、`@mention`、`hashtag`、代码块等节点。
2. 用 `<span class="dualang-dict-term" data-dict="...">term</span>` 包裹词本体，注释用 `::after` 展示，避免直接污染原文本字符串。
3. 关闭开关或重渲染时，清理所有 `.dualang-dict-term` 并恢复纯文本显示。

## 6. 缓存与失效

新增 content 侧字典缓存（内存）：

1. key：`contentId + normalizeText(originalText)`
2. value：`entries + ts`
3. TTL：与 `TRANSLATION_CACHE_TTL_MS` 一致

失效条件：

1. show-more 或内容编辑导致 `originalText` 改变
2. DOM recycle 命中新内容 ID
3. 用户关闭 `smartDictEnabled`

## 7. 重渲染策略

现有逻辑只在 `displayMode` 变化时 `reRenderAllForModeChange()`。

扩展为：当 `lineFusionEnabled` 或 `smartDictEnabled` 变化且 `enabled=true` 时，也触发同一批量重渲染入口，确保已翻译内容实时切换效果。

## 8. 错误处理与降级

1. 字典请求超时/失败：仅记录 telemetry，UI 不报错，不影响翻译结果。
2. 字典 JSON 不合法：按空结果处理。
3. 行融合对齐低置信：自动回退普通对照，不显示失败态。
4. 任何增强层失败不得阻断 `showSuccess` 状态图标逻辑。

## 9. 性能预算

1. 字典请求仅在英文原文且开关开启时触发。
2. 同一 `contentId+text` 只请求一次（缓存命中复用）。
3. 本期不做候选词和返回词条硬上限；若监测到 token/延迟异常，再补限额与分级抽样策略。
4. 增强渲染必须在主翻译渲染后异步执行，避免阻塞首屏译文出现。

## 10. 测试方案

### 10.1 单元测试（Vitest）

1. 设置默认值与归一化（新字段）
2. 行切分与对齐算法：
   - 多行正常对齐
   - 行数不等重分组
   - 低置信回退
3. 英文检测与候选词筛选
4. 字典 JSON 解析与非法返回降级

### 10.2 组件/内容逻辑测试

1. 开关变化触发重渲染
2. `translation-only` 下智能字典不生效
3. show-more 后字典缓存失效并重算

### 10.3 E2E（Playwright）

1. `append + lineFusionEnabled=true`：多行原文出现“原文-横线-译文”结构
2. 单行原文时不出现逐行融合结构
3. `smartDictEnabled=true` + 英文原文：出现 `【/ipa/ gloss】` 标注
4. 中文原文：不触发字典请求
5. 字典接口失败：译文仍正常显示，无错误横幅

## 11. 分阶段上线建议

1. Phase 1：先上 `逐行融合`（纯 content 渲染，低风险）
2. Phase 2：接入 `智能字典`（新增 background action + 缓存）
3. Phase 3：探索“翻译 + 字典同请求同返回”的联合协议（减少额外 RTT），并做 A/B 对比：
   - 路径 A：现有双请求（translate + annotateDictionary）
   - 路径 B：单请求结构化返回（translation + dictionary entries）
4. Phase 4：根据日志调优候选词筛选、对齐阈值与性能护栏

---

该设计保持了现有翻译链路与模式模型稳定性，把新增能力限制在“可独立开关、可独立降级”的增强层，优先保证主路径稳定与性能可控。
