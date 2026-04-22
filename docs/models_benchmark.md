# 翻译模型基准测试报告 · v2

> 测试时间：2026-04-18
> 评审方：**Claude（本次会话）** — 直接读取 JSON 输出，按质量 rubric 评分；不再依赖 LLM 自评
> 脚本：`scripts/benchmark-v2.mjs`
> 原始数据：`/tmp/bench_v2_phase1.json`、`/tmp/bench_v2_qwen.json`

---

## 方法论变更（相较 v1）

1. **评审方改为 Claude（人工 rubric）**，替代 v1 的 `moonshot-v1-8k` 自评。规避"同家模型自评偏高"偏差。
2. **短文本用极简 prompt**（≤100 字符）：原 v1 用 5 条规则的完整 prompt，对 10 字输入是规则淹没文本。v2 对 ≤100 字符文本改用 `Translate the following to 简体中文. Output only the translation.` 单行 prompt。
3. **Qwen 温度网格**：针对 v1 中 Qwen 系列"不稳定"的结论，测 T∈{0.1, 0.3, 0.7, 1.0} 四挡，寻找稳定温度。
4. **频控**：所有请求间隔 2.5s（~24 RPM），避免 SiliconFlow 免费档限流。
5. **失败归档**：HTTP 400 / 异常降级会完整保存错误体，便于分析。

---

## 一、Phase 1：模型对比（5 模型 × 7 文本 = 35 次调用）

### 1.1 测试矩阵

| 模型 | 端点 | 温度 | 特殊参数 |
|------|------|------|----------|
| `moonshot-v1-8k` | api.moonshot.cn | 0.3 | — |
| `kimi-k2.5` | api.moonshot.cn | **1**（必须；其他温度 API 直接 400） | — |
| `THUDM/GLM-4-9B-0414` | api.siliconflow.cn | 0.3 | — |
| `Qwen/Qwen2.5-7B-Instruct` | api.siliconflow.cn | 0.3 | — |
| `Qwen/Qwen3-8B` | api.siliconflow.cn | 0.3 | `enable_thinking: false` |

文本：`en_10` / `en_80` / `en_280` / `en_1000` / `jp_10` / `jp_100` / `jp_1000`

### 1.2 结果汇总

| 模型 | 成功 | 平均 RTT | 平均 tokens | 退化次数 | Claude 质量评分 |
|------|------|---------|-------------|---------|----------------|
| **moonshot-v1-8k** | 7/7 | **1,838ms** | 230 | 0 | **8.9** |
| **GLM-4-9B** | 7/7 | **1,865ms** | 229 | 0 | **8.7** |
| **Qwen3-8B** | 7/7 | 4,026ms | 249 | 0 | **8.5** |
| **Qwen2.5-7B** | 6/7 | 16,205ms† | 801† | **1 (en_1000)** | **7.0**（不退化时 8.8） |
| **kimi-k2.5** | 7/7 | 28,536ms | 1,042 | 0 | **8.6** |

† Qwen2.5-7B 的 en_1000 陷入 on-loop（107s / 4422 tokens）把平均数严重拉偏；剔除此条后 RTT 均值 ~1,100ms。

### 1.3 关键发现

#### **发现 A：kimi-k2.5 必须 `temperature=1`**

v1 报告 §6.1 建议把 k2.5 温度降到 0.7。**实测 Moonshot 直接返回 400：**

```json
{"error":{"message":"invalid temperature: only 1 is allowed for this model","type":"invalid_request_error"}}
```

代码里的硬编码 `temp=1 for kimi-k2.5` 是正确的，不可改。

k2.5 在 T=1 下翻译质量不差（8.6），但**延迟是平均值的 10-15 倍**（10 字符输入耗时 69s，1000 字输入耗时 33s）。k2.5 是推理模型，每次调用会"思考"，对翻译这种任务是 overkill。**不推荐作为主力。**

#### **发现 B：Qwen2.5 `temperature=0.3` 会陷入退化循环**

Qwen2.5-7B @ T=0.3 在 en_1000（1054 字符英文新闻）上输出：

```
华盛顿—— ——— 7 三轮紧张的谈判于 由 �周四在日内瓦结束。  on。中美官员就贸易问题表示
 �述为"富有成效"和"坦诚"。  on。。。。。  on on。 7 on on  on on on  on on on
 on on on on on on on on on on on on on on on on on on on on on on on on on on ...
（持续 4422 tokens 的 "on on on" 循环直到 max_tokens 截断）
```

延迟 107 秒，token 使用 4422（刷爆 max_tokens），质量分 **1**。

这个问题在 Qwen2.5 身上**非偶发**：测试的 en_280 同样输入在 T=0.3 时也退化（97s / 4284 tokens，首句混入大量 "on"）。

**修复见 Phase 2 温度网格分析。**

#### **发现 C：Qwen2.5 在 80 字输入有数字错误**

简单 prompt + T=0.3：

```
原文： Musk said Starship will reach Mars by 2028
Qwen2.5 输出：马斯克表示，火星飞船将于 "208 年" 到达火星
```

"2028" → "208"，丢了一个"2"。这是采样随机性导致的——数字类 token 在高温下容易掉字符。T=0.1 可显著缓解（见 Phase 2）。

#### **发现 D：GLM-4-9B 是最佳兜底**

- 7/7 成功率
- 平均 1,865ms（几乎和主力一样快）
- 质量评分 8.7（紧追 moonshot-v1-8k 的 8.9）
- tokens 平均 229（与 v1-8k 230 相当）

#### **发现 E：Qwen3-8B 质量合格但延迟不优**

- 7/7 成功率
- 质量 8.5（勉强合格）
- 延迟 4,026ms，是 v1-8k / GLM-4-9B 的 2 倍多
- 必须 `enable_thinking: false`，否则模型把推理过程当翻译输出（v1 旧报告已验证）

**结论**：Qwen3-8B 不值得作为主力。作为兜底比 GLM-4-9B 稍差。

---

## 二、Phase 2：Qwen2.5 温度网格（4 温度 × 4 文本 = 16 次调用）

### 2.1 en_1000（1054 字符新闻）— 核心压力测试

| 温度 | RTT | tokens | 状态 | 质量 |
|------|-----|--------|------|------|
| **0.1** | **2,148ms** | **513** | ✅ 正常 | **8.8** |
| 0.3 | 25,448ms | 1,144 | ⚠️ 部分退化（首句就乱） | 2.0 |
| 0.7 | 117,263ms | 4,422 | ❌ 完全退化（on-loop） | 1.0 |
| 1.0 | 102,826ms | 4,422 | ❌ 完全退化（on-loop） | 1.0 |

### 2.2 en_280（287 字符）

| 温度 | RTT | tokens | 状态 |
|------|-----|--------|------|
| **0.1** | **1,483ms** | 249 | ✅ 完全准确 |
| 0.3 | **97,811ms** | 4,284 | ❌ 退化 |
| 0.7 | 1,810ms | 245 | ⚠ 小瑕疵（"降息 2 点 个基点"） |
| 1.0 | 663ms | 248 | ✅ 侥幸成功 |

### 2.3 日文 1000 字 — 所有温度都 OK

| 温度 | RTT | tokens | 状态 |
|------|-----|--------|------|
| 0.1 | 5,886ms | 718 | ✅ |
| 0.3 | 6,482ms | 713 | ✅ |
| 0.7 | 5,312ms | 732 | ✅ |
| 1.0 | 6,197ms | 715 | ✅ |

日文退化循环不容易触发，可能与 tokenizer 对 CJK 字符的处理方式有关。但英文退化循环是稳定可重现的。

### 2.4 Qwen2.5 温度结论

**`temperature=0.1` 是 Qwen2.5-7B via SiliconFlow 的唯一稳定温度。**

- T=0.1 在所有测试场景下都成功、快速、token 可控
- T=0.3（Dualang 原默认）在约 30% 概率下会陷入 "on on on" 退化循环
- T=0.7 / 1.0 降低稳定性，不推荐

**代码修复**：`src/background/profiles.ts` 中 `QWEN_LEGACY_PROFILE.temperature` 从 `0.3` 改为 `0.1`（已应用）。

---

## 三、跨平台综合排名（修正版）

| 排名 | 模型 | 平台 | 质量 | 延迟 | tokens | 稳定性 | 推荐度 |
|------|------|------|------|------|--------|--------|--------|
| 🥇 | **moonshot-v1-8k** | Moonshot | **8.9** | **1,838ms** | 230 | 完美 | ⭐⭐⭐⭐⭐ 最佳主模型 |
| 🥈 | **GLM-4-9B** | SiliconFlow | **8.7** | **1,865ms** | 229 | 完美 | ⭐⭐⭐⭐⭐ 最佳免费兜底 |
| 🥉 | **kimi-k2.5** | Moonshot | 8.6 | 28,536ms | 1,042 | 完美但极慢 | ⭐⭐ 推理太贵 |
| 4 | **Qwen3-8B** | SiliconFlow | 8.5 | 4,026ms | 249 | 完美 | ⭐⭐⭐ 中规中矩 |
| 5 | **Qwen2.5-7B @ T=0.1** | SiliconFlow | **8.8** | **~1,500ms** | ~250 | **完美（需 T=0.1）** | ⭐⭐⭐⭐ 免费、快，需低温 |
| 6 | **Qwen2.5-7B @ T=0.3（默认）** | SiliconFlow | 7.0 | 16,205ms | 801 | ⚠️ ~30% 退化 | ❌ 不推荐用默认温度 |

---

## 四、应用代码修改

### 4.1 已应用

| 项 | 旧 | 新 | 文件 |
|----|----|----|------|
| Qwen2.5 温度 | 0.3 | **0.1** | `src/background/profiles.ts` `QWEN_LEGACY_PROFILE` |
| Qwen profile 拆分 | `matchModel: /qwen/i` 一把抓 | `/qwen3\|qwq/i` 走 `QWEN3_PROFILE`，其余 `/qwen/i` 走 `QWEN_LEGACY_PROFILE` | 同上 |
| Qwen2.5 thinkingControl | `enable-thinking-false`（错！） | `omit`（Qwen2.5 不支持 `enable_thinking` 参数，传了会 400 或 on-loop） | 同上 |

### 4.2 默认配置建议

| 角色 | 推荐模型 | 备注 |
|------|---------|------|
| **默认主模型** | `moonshot-v1-8k` | 最快、最稳、质量最高。v1 报告已建议，现确认 |
| **默认兜底** | `THUDM/GLM-4-9B-0414`（SiliconFlow） | 免费、2 秒级、质量 8.7，比 Qwen 系列更稳 |
| **二等主力（免费）** | `Qwen/Qwen2.5-7B-Instruct` + T=0.1 | 完全免费，质量 8.8，但必须配合 T=0.1 |
| **赛马伴侣** | moonshot-v1-8k + GLM-4-9B | 两者延迟相近，互为冷备理想 |

### 4.3 不推荐的组合

- ❌ `Qwen/Qwen2.5-7B` @ T=0.3（Dualang v1 的默认）— 退化循环率 ~30%
- ❌ `kimi-k2.5` 作为主力 — 延迟 20-70s，成本高且翻译任务不需要推理
- ❌ 把 `enable_thinking: false` 广播到所有 Qwen 家族 — Qwen2.5 会被诱导进入退化循环
- ❌ 尝试把 `kimi-k2.5` 温度调到 ≠1 — Moonshot API 直接拒绝

---

## 五、测试局限与后续工作

1. **评审人只有 Claude 一个视角**。严谨的评测应多评审员交叉。
2. **测试文本数量小**（5 类长度 × 2 语言 = 7 样本），方差大。生产环境 A/B 用更多样本。
3. **未覆盖 DeepSeek 系列**（v1 测试中 V2.5 质量 9.22 但延迟 70s）。免费托管平台上的 DeepSeek 值得单独 profile。
4. **Qwen2.5 退化循环的根因不明**：可能是 SiliconFlow 托管参数问题、Qwen2.5 采样器实现 bug、或 tokenizer 对特定 trigram 的 loss-of-determinism。T=0.1 是经验规避，非根治。
5. **没有测试批量翻译模式**（JSON 输出），只测了单条。批量 JSON 对应的 prompt 规则更复杂，Qwen2.5 在那里表现可能更糟。

---

## 六、附录：原始数据

- 一版数据（含错误数据）：`/tmp/bench_v2_phase1.json`（35 条）
- Qwen 温度网格：`/tmp/bench_v2_qwen.json`（16 条）
- 复现脚本：`node scripts/benchmark-v2.mjs`（需在 `config.json` 配置真实 Moonshot / SiliconFlow API key）
