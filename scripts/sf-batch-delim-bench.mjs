#!/usr/bin/env node
/**
 * 批量分隔符耐受性 benchmark：用 super-fine 实际使用的 <tN>...</tN> 协议测每个候选模型。
 * 关键校验：
 *   1. 标签数量是否匹配（输出里有 N 个 <tK> 和 N 个 </tK>，K 与输入索引一致）
 *   2. 每条译文非空、汉字含量 ≥ 30%
 *   3. 译文不丢段、不合并、不超量（与原文条数严格一致）
 */
import { readFile } from 'fs/promises';
const cfg = JSON.parse(await readFile(new URL('../config.json', import.meta.url)));
const SF_KEY = cfg.providers?.siliconflow?.apiKey;
const MS_KEY = cfg.providers?.moonshot?.apiKey;

const SF_URL = 'https://api.siliconflow.cn/v1/chat/completions';
const MS_URL = 'https://api.moonshot.cn/v1/chat/completions';

const SYSTEM = `请将以下多条推文分别翻译成简体中文。
每条推文在用户消息中用 XML 标签 <tN>...</tN> 包裹（N 为数字索引，用户会给出具体值）。

输出格式（严格遵守）：
按相同的 <tN>...</tN> 标签结构输出对应译文，标签里的 N 必须与用户消息里的 N 一一对应（不得改写、不得使用其他数字）。

规则：
1. 每条译文必须写在对应的 <tN> 与 </tN> 之间。
2. 译文中的段落分隔用真实空行保留；不要 JSON 转义。
3. 输出必须完全是简体中文；专有名词可保留原样。
4. 不要 markdown 代码块、不要解释、不要在标签外输出任何文字。
5. 如果某条原文已是简体中文，按原文返回（含段落结构）。`;

// 5 段不同长度的英文（模拟 super-fine chunk）
const TEXTS = [
  `Anthropic released Claude Opus 4.7 on April 16 at $5 per million input tokens.`,
  `SWE-bench Verified scored 92.3% against Opus 4.6's 85.9%. The interesting variable is not the benchmark.`,
  `OpenAI shipped an Agents SDK across seven sandbox providers and a Codex desktop with computer-use and 90+ plugins.`,
  `Vercel disclosed the year's first AI-platform-originated breach. Mandiant was engaged for forensic response.`,
  `The architectural bet matters more than the benchmark this week. Anthropic chose managed runtime. OpenAI chose portable primitives.`,
];

function buildUserMsg(texts) {
  return texts.map((t, i) => `<t${i}>${t}</t${i}>`).join('\n');
}

function parseOutput(out, expectedN) {
  // 提取 <tK>...</tK> 段；K 必须在 [0, expectedN)
  const result = new Array(expectedN).fill(null);
  const tagRe = /<t(\d+)>([\s\S]*?)<\/t\1>/g;
  let m;
  let extraN = 0;
  while ((m = tagRe.exec(out))) {
    const idx = parseInt(m[1], 10);
    if (idx >= 0 && idx < expectedN) {
      if (result[idx] !== null) {
        // 重复
      } else {
        result[idx] = m[2].trim();
      }
    } else {
      extraN++;
    }
  }
  return { result, extraN };
}

const hasCJK = (s) => /[一-鿿]/.test(s);
const cjkRatio = (s) => {
  if (!s) return 0;
  return ((s.match(/[一-鿿]/g) || []).length) / s.length;
};

async function callBatch(model, url, key) {
  const t0 = Date.now();
  const body = {
    model,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: buildUserMsg(TEXTS) },
    ],
    temperature: 0.3, max_tokens: 4096, stream: false,
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const rttMs = Date.now() - t0;
  if (!resp.ok) return { rttMs, ok: false, status: resp.status, error: (await resp.text()).slice(0, 200) };
  const data = await resp.json();
  return {
    rttMs, ok: true,
    output: data.choices?.[0]?.message?.content || '',
    promptTokens: data.usage?.prompt_tokens,
    completionTokens: data.usage?.completion_tokens,
    totalTokens: data.usage?.total_tokens,
  };
}

const CANDIDATES = [
  { model: 'THUDM/GLM-4-9B-0414', url: SF_URL, key: SF_KEY, label: 'GLM-4-9B (primary 基线)' },
  { model: 'Qwen/Qwen2.5-7B-Instruct', url: SF_URL, key: SF_KEY, label: 'Qwen2.5-7B (用户警告过分隔符炸)' },
  { model: 'internlm/internlm2_5-7b-chat', url: SF_URL, key: SF_KEY, label: 'internlm2.5-7b' },
  { model: 'Qwen/Qwen3.5-9B', url: SF_URL, key: SF_KEY, label: 'Qwen3.5-9B (当前 sf-relay；reasoning 模型)' },
  { model: 'moonshot-v1-8k', url: MS_URL, key: MS_KEY, label: 'Moonshot v1-8k (基线对照)' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`# 批量分隔符耐受 benchmark\n输入: ${TEXTS.length} 段，最长 ${Math.max(...TEXTS.map((t) => t.length))} chars\n`);

const results = {};
for (const c of CANDIDATES) {
  console.log(`\n──── ${c.label} (${c.model}) ────`);
  let r;
  try {
    r = await callBatch(c.model, c.url, c.key);
  } catch (e) {
    r = { ok: false, error: e.message };
  }
  if (!r.ok) {
    console.log(`❌ status=${r.status ?? '?'} err=${(r.error || '').slice(0, 160)}`);
    results[c.label] = { ok: false, status: r.status, error: r.error };
    await sleep(1500);
    continue;
  }

  const { result, extraN } = parseOutput(r.output, TEXTS.length);
  const filledCount = result.filter(Boolean).length;
  const cjkOk = result.filter((x) => x && cjkRatio(x) >= 0.3).length;
  const allTagsPresent = result.every(Boolean);
  const noExtraTags = extraN === 0;
  const noEmptyOnFilled = result.every((x) => x === null || x.trim().length > 0);

  const verdict =
    !allTagsPresent ? `❌ 标签缺失 ${TEXTS.length - filledCount}/${TEXTS.length}` :
    !noExtraTags ? `⚠ 多余标签 ${extraN}` :
    cjkOk < TEXTS.length ? `⚠ ${TEXTS.length - cjkOk} 条非中文/低汉字率` :
    `✓ 通过`;

  console.log(`  ${verdict}  rtt=${r.rttMs}ms tokens=${r.totalTokens} (out ${r.completionTokens})`);
  console.log(`  解析：tags=${filledCount}/${TEXTS.length}  cjk_ok=${cjkOk}/${TEXTS.length}  extra_tags=${extraN}`);
  result.forEach((x, i) => {
    const orig = TEXTS[i].slice(0, 50);
    const trans = x ? x.slice(0, 50) : '⛔ MISSING';
    console.log(`    <t${i}> "${orig}..."`);
    console.log(`         → "${trans}"`);
  });
  // 打印原始输出片段（前 400 字符）便于人工 spot-check
  console.log(`  原始输出 head: ${r.output.slice(0, 220).replace(/\n/g, '↵')}`);

  results[c.label] = {
    ok: true, rttMs: r.rttMs, totalTokens: r.totalTokens,
    filledCount, cjkOk, extraN, allTagsPresent, noExtraTags, verdict,
  };
  await sleep(2000);
}

console.log('\n\n======== 汇总 ========');
console.log('模型 / 标签                                              结果         rtt    tokens    解析');
console.log('-'.repeat(100));
for (const [label, r] of Object.entries(results)) {
  if (!r.ok) {
    console.log(`${label.padEnd(54)} ❌ status=${r.status ?? '?'}`);
  } else {
    console.log(`${label.padEnd(54)} ${r.verdict.padEnd(10)} ${(r.rttMs + 'ms').padStart(7)} ${String(r.totalTokens).padStart(7)}  tags=${r.filledCount}/5 cjk=${r.cjkOk}/5 extra=${r.extraN}`);
  }
}

console.log('\n======== 接力可用性结论 ========');
const usable = Object.entries(results).filter(([_, r]) => r.ok && r.allTagsPresent && r.noExtraTags && r.cjkOk === TEXTS.length);
console.log(`通过 batch 协议测试的模型 (${usable.length}):`);
usable.forEach(([label, r]) => console.log(`  ✓ ${label}  (rtt ${r.rttMs}ms)`));
const broken = Object.entries(results).filter(([_, r]) => r.ok && !(r.allTagsPresent && r.noExtraTags));
console.log(`\nbatch 协议有问题的模型 (${broken.length}):`);
broken.forEach(([label, r]) => console.log(`  ✗ ${label}  ${r.verdict}`));
