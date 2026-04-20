# GLM 混合请求测试报告（翻译 + 字典 + 词汇分级）

日期：2026-04-20  
模型：`THUDM/GLM-4-9B-0414`（SiliconFlow）  
接口：`https://api.siliconflow.cn/v1/chat/completions`

## 1. 测试目标

1. 验证 GLM 是否能稳定处理“翻译 + 字典”同请求结构化返回。  
2. 验证 GLM 是否能按 `cet4|cet6|ielts|kaoyan` 口径输出词汇难度分级。  
3. 记录延迟、可解析性、分级一致性，作为后续回归基线。

## 2. 混合请求实测（短/中/长英文篇章）

请求要求：返回严格 JSON，包含：

```json
{
  "translation": "简体中文整段翻译",
  "dictionary": [
    { "term": "", "ipa": "", "gloss": "", "level": "rare|advanced|slang" }
  ]
}
```

结果：

| Case | HTTP | Latency | JSON 解析 | 译文长度 | 字典条数 |
|---|---:|---:|---|---:|---:|
| short | 200 | 3881ms | true | 68 | 4 |
| medium | 200 | 9176ms | true | 197 | 9 |
| long | 200 | 21678ms | true | 417 | 23 |

结论：

1. 三档文本均可返回可解析结构化结果。  
2. 长文延迟显著上升，字典条目数明显增多。  
3. 当前模型具备“翻译+字典同返”可行性，但需上线后监控 token 与时延。

## 3. 词汇难度分级实测（四六级/雅思/考研）

### 3.1 篇章抽词分级（探索性）

在含基础词、学术词、考试语境词的文本上测试，模型可输出结构化标签，但早期样本呈现 `cet6` 偏置（如大量词归为 `cet6`，`kaoyan` 命中不稳定）。

### 3.2 金标词表校准（正式）

脚本：`scripts/bench-glm-vocab-levels.mjs`  
词表：32 词（`cet4/cet6/ielts/kaoyan` 各 8）  
轮次：3 轮（`temperature=0`）

每轮结果一致：

1. `jsonParseOk=true`，`itemCount=32`。  
2. 准确率：`31/32 = 96.88%`。  
3. 唯一稳定误判：`cohesion`（gold=`ielts`，pred=`cet6`）。

混淆矩阵（3 轮一致）：

| Gold \\ Pred | cet4 | cet6 | ielts | kaoyan | other |
|---|---:|---:|---:|---:|---:|
| cet4 | 8 | 0 | 0 | 0 | 0 |
| cet6 | 0 | 8 | 0 | 0 | 0 |
| ielts | 0 | 1 | 7 | 0 | 0 |
| kaoyan | 0 | 0 | 0 | 8 | 0 |

## 4. 复现实验命令

```bash
# 词表校准（推荐）
node scripts/bench-glm-vocab-levels.mjs 3
```

说明：该脚本读取仓库根目录 `config.json` 中的 `providers.siliconflow.apiKey`。

## 5. 综合结论

1. GLM 可稳定支持“翻译 + 字典”同请求结构化返回。  
2. GLM 可执行 `cet4|cet6|ielts|kaoyan` 分级，且在固定词表上表现稳定。  
3. 当前主要边界是 `cet6` 与 `ielts` 近邻词的分类漂移（已观测到 `cohesion`）。  
4. 若进入产品化，建议引入“词表白名单校准 + 在线抽样复核”双保险策略。
