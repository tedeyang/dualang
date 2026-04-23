# 智能多模型路由器设计方案

状态：设计中（2026-04-23）
背景：本次长文精翻调参实测（docs/models_benchmark.md + provider-pool 接力 commit `ee1c83b`）发现单一模型 TPM 物理天花板严重限制长文翻译可用性；Moonshot + SiliconFlow 接力可 4.5min 跑完 307 段长文（完成率 100%）。但当前接力策略全硬编码在 `handleSuperFineStream` 里，不可配、不可扩、画像不持久。本文档定义面向多模型的智能路由架构。

---

## 1. 总体目标

把"provider/模型 = 静态配置"改成"provider 池 + 智能路由器"。用户：
- 自由增删模型（openai-compatible endpoint）
- 手动触发"测一下这个模型"（能力 + 性能画像）
- 在两种路由模式间切换：
  - **主从模式**（failover）：等价当前行为，主 API 跑，挂了走从
  - **智能模式**（smart routing）：按任务 + 负载 + 画像动态选 slot，可并发可接力
- 调节 `fastest ←→ best quality` 倾向（一个滑块，权重联动）

路由决策所依赖的画像**持续由线上翻译结果更新**（滑窗 EWMA），非一次性静态。

---

## 2. 核心数据模型

```ts
interface ProviderEntry {
  id: string;                  // "sf:Qwen/Qwen2.5-7B-Instruct"，存储主键
  label: string;               // UI 显示："Qwen 2.5 7B（硅基）"
  baseUrl: string;             // https://api.siliconflow.cn/v1
  model: string;               // Qwen/Qwen2.5-7B-Instruct
  apiKeyRef: string;           // 不存明文；指向 chrome.storage.local.keys[id]
  enabled: boolean;
  accountGroup?: string;       // 共享 TPM 桶的账号归并（同账号不同模型 = 同 group）
  tags?: string[];             // 用户标签："free" / "quality" / "fast"
}

interface ProviderCapability {  // 来自 sampler 或手填
  batch: 'proven' | 'broken' | 'untested';        // <tN>...</tN> 协议
  streaming: 'proven' | 'broken' | 'untested';
  thinkingMode: 'none' | 'optional' | 'forced';   // reasoning token 是否可关
  contextTokens?: number;
  observedAt: number;
}

interface PerformanceProfile {  // EWMA 统计
  rttMs: { short: EWMA; medium: EWMA; long: EWMA };
  tokensPerSec: EWMA;
  qualityScore: EWMA;     // 0..1，启发式 + 可选 judge
  successRate: EWMA;      // 1 - 错误率
  lastSampleAt: number;
}

interface LimitProfile {        // 来自 429 学习 + 用户手填
  tpmCap?: number;              // 观察到 429 时的 60s 滑窗 tokens 均值
  rpmCap?: number;
  tpdCap?: number;              // 日配额（若 provider 提供）
  costPerMtoken?: number;       // 可选，用于未来成本路由
  free: boolean;
  tpmConfidence: 'measured' | 'guessed';
}

interface LiveState {           // 非持久，背景 SW 内存
  tpmLog: Array<{ t: number; tokens: number }>;
  cooldownUntil: number;
  recent429s: number[];         // 最近 3 个 429 的时间戳
  disabled: boolean;            // 认证/模型不存在等永久错
  inflightCount: number;        // 并发中请求数
}
```

存储分层：
- `chrome.storage.sync`：`providers[]`, `capabilities[]`, `routingSettings`（小、可跨设备同步）
- `chrome.storage.local`：`apiKeys{}`, `performanceProfiles[]`, `limitProfiles[]`（大、本地）
- 内存（SW lifecycle）：`liveStateByProvider{}`

---

## 3. Sampler（API 采样器）

用户在 UI 点 "Test this model" 触发。一次采样跑如下 battery：

| 用例 | 输入 | 校验 |
|---|---|---|
| short single | 1 句（~80 chars） | CJK ≥ 30%、无英文残留、长度合理 |
| medium single | 5 句（~400 chars） | 同上 |
| long single | 10+ 句（~1000 chars） | 同上 |
| batch 5 段 `<tN>` | 5 段打包 | 5 个 tag 全回、索引正确、无多余 tag、每段 CJK 过关 |
| thinking off | `enable_thinking: false`（Qwen3 族） | 输出非空 |
| streaming on | SSE 流式 | 增量 decode 不断字 |

Sampler 每个模型串行跑（避免自打 TPM），每次 case 间 sleep 1s。结果汇总为一份 `ProviderCapability` + `PerformanceProfile` 初始快照。

**代价控制**：单模型全 battery ~10 calls × 平均 1K tokens ≈ 10K tokens 一次采样。相当于翻译 30-50 段。UI 提示成本，用户手动触发。

---

## 4. 路由决策

### 4.1 两种模式

```
                 request
                    │
       ┌────────────┴────────────┐
       │                         │
  failover                    smart
    (主→从)                 (智能评分选 slot)
```

### 4.2 智能模式：评分函数

每个请求到达时，对候选 slot 计算得分，取最高。**所有项都归一化到 [0,1]**，权重线性组合后仍在 [0,1]，避免任何一项数值溢出或单项压制全局。

```
score(slot, tier, pref) ∈ [0, 1]  =
    w_speed(pref)   × speedScore(slot, tier)
  + w_quality(pref) × qualityScore(slot)
  + w_load          × loadHeadroom(slot)
  + w_stability     × stabilityScore(slot)
```

**权重约束**：`w_speed + w_quality + w_load + w_stability = 1`（恒等），保证组合分 ≤ 1。

| 分量 | 范围 | 计算 |
|---|---|---|
| `speedScore` | [0,1] | `clamp(log(10_000 / rttMs.p50[tier]) / log(10_000 / 100), 0, 1)` — 对数刻度：100ms→1.0，10s→0，1s→0.5。避免线性 `1/rtt` 在极端值上数值不稳。 |
| `qualityScore` | [0,1] | 启发式 EWMA，本身由设计约束在 [0,1] |
| `loadHeadroom` | [0,1] | `clamp(1 − tokensInWindow / tpmCap, 0, 1)` — tpmCap 未知时用默认 50K。 |
| `stabilityScore` | [0,1] | `successRateEWMA × (1 − min(1, recent429Count / 5))` — 近 60s 内 429 次数 0→满分、≥5→归零，成功率 EWMA 相乘得复合稳定性。 |

**硬性一票否决（直接从候选集剔除，不进入加权）**：见 §4.6。

**权重到偏好的映射**（`pref ∈ [0..1]`：0=最快，1=最好）：
```
w_speed     = 0.5 × (1 − pref)
w_quality   = 0.5 × pref
w_load      = 0.3         // 始终给 load 留权重，防打满某一路
w_stability = 0.2
```
再按总和归一：全部除以 `w_speed + w_quality + w_load + w_stability`（= 1.0）。
`w_load` 和 `w_stability` 固定，不随 pref 变 —— 这两项是"不翻车"的底线，与用户倾向无关。

**所有输入都有 clamp 保护**：
- rtt 低于 100ms → 按 100ms 算（避免 log 上溢）
- rtt 超过 10s → 按 10s 算（speedScore 饱和到 0）
- 缺失数据（untested slot）→ 给中性默认值（speedScore=0.5, qualityScore=0.5），但 `isUntested` 标记让 UI 提示"先测一下"

### 4.3 硬性一票否决（从候选集剔除）

不进入加权计算，直接 filter out：

| 条件 | 说明 |
|---|---|
| `state === PERMANENT_DISABLED` | auth 错 / 模型不存在等不可自愈错误 |
| `state === COOLING` 且 `cooldownUntil > now` | 最近错过、冷却中 |
| `capability.batch === 'broken'` 且当前任务是 batch | 能力缺失 |
| `capability.thinkingMode === 'forced'` 且当前配置禁用 thinking | 配置不兼容 |
| `ctxLen > capability.contextTokens` | 输入超出 context 上限 |

过滤后若候选集为空：
1. 若存在 PROBING 态的 slot，强制带入（带低权重，见 §4.7）
2. 否则 sleep 到最早 `cooldownUntil`，再重选
3. 若所有非 PERMANENT_DISABLED 的 slot 全都超 context：任务失败并提示用户

**权重初始值**（可在"高级选项"中暴露）：
```
w_speed, w_quality 随 pref 联动
w_load = 0.3, w_stability = 0.2
speedScore_log_base_rtt_high = 10_000 (10s = 0 分)
speedScore_log_base_rtt_low  = 100    (100ms = 满分)
recent429_saturate_count = 5
cooldown_tpm_ms = 60_000
cooldown_5xx_ms = 300_000
cooldown_backoff_factor = 2
cooldown_cap_ms = 30 * 60_000
```

### 4.4 自恢复机制（half-open circuit breaker）

错误 slot 不能简单"永远禁用"。自恢复的节奏：**严禁再次撞墙 → 低流量探测 → 渐进放量 → 完全恢复**。

#### 状态机

```
             ┌──────────────────────┐
             │       HEALTHY        │ ← 默认；参与正常评分
             └──┬────┬──────────────┘
        429 或 5xx  │ auth / 404 / model-not-found
                │   │
                ▼   ▼
      ┌────────────────────────────┐
      │     COOLING (无探测)         │ ← cooldownUntil 之前禁用
      │  60s (429) / 300s (5xx)    │
      └────────┬───────────────────┘
               │ cooldownUntil 到期
               ▼
      ┌────────────────────────────┐
      │   PROBING (半开，低权重)      │ ← 带权重因子 probeWeight 参与评分
      │  probeWeight = 0.1 起步      │
      └──┬──────────────┬──────────┘
         │ 探测请求失败   │ 连续 3 次探测成功
         │ (同类错)       │
         ▼              ▼
    cooldown 翻倍    ┌──────────────────┐
    回到 COOLING     │    HEALTHY        │
    指数退避封顶     └──────────────────┘

    ┌──────────────────────────────┐
    │    PERMANENT_DISABLED          │
    │    (auth 错 / 模型不存在)       │
    │    只能用户手动重新启用          │
    └──────────────────────────────┘
```

#### PROBING 态的评分调整

```
if slot.state === PROBING:
  effective_score = raw_score × slot.probeWeight
```

`probeWeight` 起步 0.1 —— 此时即便 raw_score 很高，乘上 0.1 后也落到 0.1，基本只在其他 slot 全都不可用或同分极低时才被选中。

每次探测请求**成功**：
- `probeWeight *= 2`（即 0.1 → 0.2 → 0.4 → 0.8 → 1.0）
- `probeSuccessStreak += 1`
- 若 `probeSuccessStreak ≥ 3`：迁移 HEALTHY，`probeWeight = 1.0`，清 streak

每次探测请求**失败**（同类错误）：
- 重置 `probeSuccessStreak = 0`
- 回到 COOLING，`cooldownMs = min(cooldownMs × 2, cooldown_cap_ms)`（指数退避）
- 当下一次 cooldownUntil 到期 → 又进 PROBING，新 cooldownMs 已翻倍

探测请求**被其他错误打翻**（不同类 / 网络瞬断）：
- 不扣 streak、不退避；视为无效样本，下次继续探测

#### 为什么要用 probeWeight 而不是"只发 1/10 的流量"

两种实现都可行，但 probeWeight 方式更自然地融入评分：
- 评分器不需要知道"状态机"——只看 `effective_score`
- 若其他 slot 全都 PROBING 或更糟，自然选到当前 slot，不会因无流量可探测而卡死
- 用户体验上：PROBING 态的 slot 只在"反正都不好"时被允许尝试，不伤健康路径

#### 错误分类（决定走哪个恢复路径）

| HTTP / 错误特征 | 冷却类型 | 初始冷却 | 最终归宿 |
|---|---|---|---|
| 401 / 403 | PERMANENT_DISABLED | — | 用户改 key / 重新启用 |
| 404 / "model not found" | PERMANENT_DISABLED | — | 用户删此 slot / 改 model |
| 429 / rate limit | COOLING | 60s | 正常恢复流程 |
| 5xx | COOLING | 300s | 正常恢复流程 |
| 超时 / 网络错 | COOLING | 60s | 正常恢复流程（可能是偶发） |
| 格式错（delimiter 崩）| capability 降级 | — | `batch: broken`；依然可走 single 模式 |
| AbortError（主动取消）| 不扣分 | — | 忽略，不影响状态 |

#### 定时器与 SW 生命周期

cooldown 到期是**懒惰判断**（pick 时比较 `cooldownUntil` vs `now()`），不依赖 `setTimeout`。SW 重启后只需 `cooldownUntil` 持久化在 `chrome.storage.local`，重启后自然恢复。

probeSuccessStreak 和 probeWeight 也持久化。但重启后若上次是 PROBING 中途，可以直接恢复到上次进度（保守做法）或重置到 `probeWeight = 0.1`（激进做法）。默认保守。

### 4.5 chunk 级路由 vs 请求级路由

- 单条翻译（短推文）：整个请求走同一个 slot；挂了一次性 failover 到次高分 slot
- 长文精翻（super-fine）：**每个 chunk 独立选 slot**，实现真正的接力。每 chunk 开始前重新评分、挑。

### 4.6 可选：并发执行

智能模式下 score 最高的 N 个 slot（N 由用户配置，默认 1）可**同时发送相同请求**，取最快返回者。——这是赛马模式（hedged request），代价 = 总 tokens × N，收益 = p95 延迟下降。
现在 `shouldHedge` 已有雏形（`src/background/pipeline.ts`），路由器接管后统一决策。

### 4.7 学习循环

每次请求完成后，调用 `router.recordOutcome(slot, {rtt, tokens, error, qualityProxy})`：
- EWMA 更新 `PerformanceProfile`
- 若 429：往 `LimitProfile.tpmCap` 推送新样本（`currentTokensInWindow` 近似为该 slot 实际 cap）
- 若持续错误：降低 `successRate` → 评分自动下降 → 短期内路由避开
- 若译文被用户点"重译"：`qualityScore` 负向反馈

---

## 5. 质量评分（难点）

V1 用**启发式组合**，不依赖 judge 模型：

```
qualityScore =
    0.30 × cjkRatioOK          // ≥30% 汉字占比
  + 0.25 × noEnglishLeak       // 无连续英文单词
  + 0.20 × tagFidelity         // <tN> 全回不缺失
  + 0.15 × urlPreserved        // URL / @mention / #tag 原样
  + 0.10 × lengthRatio         // 译文长度 / 原文长度 在 [0.7, 1.8] 内
```

每项 0/1，EWMA 平滑后得到整体质量画像。

**V2（将来）**：cross-model agreement（两个模型翻同一段对比）、定期用一个高能力模型做 judge、用户行为信号（重译按钮）。

---

## 6. UI 设计

### 6.1 Providers 管理（popup 新 tab）

```
┌─ Providers ─────────────────────────────────┐
│  [+ 添加 provider]                            │
│                                               │
│  ● Moonshot v1-8k                            │
│    moonshot-v1-8k · api.moonshot.cn          │
│    ✓ batch · ✓ stream · ⚡ 580ms (medium)    │
│    [测试] [编辑] [禁用]                        │
│                                               │
│  ● SiliconFlow GLM-4-9B-0414                 │
│    ...                                        │
│                                               │
│  ○ SiliconFlow Qwen2.5-7B                    │
│    ⚠ batch 协议崩 · ✓ single 可用 · 2.5s     │
│    [测试] [编辑] [禁用]                        │
└───────────────────────────────────────────────┘
```

### 6.2 路由配置

```
┌─ 翻译路由 ────────────────────────────────────┐
│                                               │
│  模式  ○ 主从  ● 智能                          │
│                                               │
│  倾向  [最快] ━━━━━━●━━━━━━ [最好]              │
│                                               │
│  并发请求数（智能模式）   [1▼]                  │
│                                               │
│  [展开高级选项]                                │
└───────────────────────────────────────────────┘
```

### 6.3 实时统计面板

```
┌─ 最近 60s 负载 ──────────────────────────────┐
│  Moonshot      ████░░░░░░ 18K / 150K (12%)   │
│  GLM-4-9B-0414 ████████░░ 28K / 35K (80%)    │
│  Qwen2.5-7B-I  ░░░░░░░░░░ 0 / 35K (cooling)  │
│                                               │
│  最近 100 次翻译：                             │
│    Moonshot: 62 (avg 540ms) ✓                │
│    GLM:      31 (avg 1.2s)  ✓                │
│    Qwen:     7  (avg 3.1s)  ⚠ 2 次 429        │
└───────────────────────────────────────────────┘
```

---

## 7. 实施阶段

| Phase | 内容 | 估算复杂度 |
|---|---|---|
| **P1** | 数据模型 + 存储迁移 + 现有设置平滑升级 | M |
| **P2** | Providers 管理 UI（增删改，apiKey 存 local） | M |
| **P3** | Sampler（test button → 采样 → 写 capability+profile） | L |
| **P4** | Profile EWMA 持久化 | S |
| **P5** | Router 基础设施 + failover 模式（等价当前行为） | M |
| **P6** | Smart 路由算法（评分 + chunk 级挑选） | L |
| **P7** | 实时统计面板 | M |
| **P8** | 质量评分 V1 启发式 | S |
| **P9** | 并发/赛马选项（P6 之上扩展）| S |
| **P10** | 高级选项面板（权重可调）| S |

建议顺序：P1 → P2 → P3 → P4 → P5 → P6 → P7。P8/P9/P10 按需。

每个 phase 内部严格"代码 + 测试 + 实测"闭环，避免大爆炸。

---

## 8. 兼容性与迁移

- 现有 `settings` 单 provider 自动映射为 `providers` 里的第一条，`routingMode: 'failover'`，`fallback*` 映射为第二条。行为完全不变。
- `config.json` 里的 Moonshot key 自动识别为一个 provider entry。
- 用户打开新版 popup，首次看到 providers 列表，自带 2-3 条迁移来的条目。

---

## 9. 风险与开放问题

1. **chrome.storage.sync 100KB 限制**：多模型 + 画像可能超。→ 方案：画像存 local，profiles 按 id 分 key。
2. **SW 重启后 LiveState 丢失**：冷却、tpmLog 全清零。→ 方案：把 cooldownUntil 序列化到 local 持久化；tpmLog 重启后从 0 起算可接受（SW 重启不频繁）。
3. **并发更新 profile 冲突**：多个请求同时完成时写 EWMA。→ 方案：加一个内存串行写入器（与 rate-limiter 现有 `_withIoLock` 同构）。
4. **sampler 耗配额**：→ 方案：先跑 short-single 判活，再跑完整 battery；UI 显示预计 tokens。
5. **评分函数调权**：默认值可能对不同用户次优。→ 方案：收集使用数据后迭代；提供 preset（"tweet 阅读" / "长文精翻"）。
6. **delimiter 失效不应永久禁用**：模型可能某次格式失误但多数时候正常。→ 方案：capability 分三档 `proven / broken / untested`，broken 但质量 EWMA 仍过线的可降级为 single-mode 使用。
7. **加密 apiKey**：存 chrome.storage.local 明文。→ 现状已如此（config.json），可接受；真要加密需要主密码，UX 差。

---

## 10. 本方案与当前代码的关系

现有 `handleSuperFineStream` 里的 Slot[] pool + pickSlot 实际上是**手写了一个特殊情况的智能路由**。本方案等同于把它：
- 抽出成通用 `Router` 服务
- 把 slot 的 `budget/tpmLog/cooldownUntil` 挪到 `ProfileService` 管理
- 把"选谁"的决策逻辑从硬编码"最少 tokens 用过"升级为评分函数
- 把配置来源从代码硬写升级为用户可配
- 在短推文翻译路径上也启用（当前短推文仅走单一 `handleTranslateBatch`）

当前接力代码不丢弃，作为 P5 failover 模式的实现基础。

---

## 11. 首个可交付里程碑（定义 MVP）

**M1**：数据模型 + Providers UI + Sampler short 用例 + 基础 failover 路由。
- 用户能在 popup 加/删 provider
- 能一键 test 某个 provider（返回 RTT + batch 能力）
- 开关"路由模式"生效，挂了走备用
- 实测：两个 provider 配置下，主挂后从自动接管

M1 让现有"接力"从硬编码变成用户可控，体验上已经比现状好。后续 phase 叠加智能。
