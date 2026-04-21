/**
 * bench-tag-format.mjs
 *
 * 测试 <t0>...</t0> XML 标签格式在三个硅基流动模型上的指令遵循率，
 * 为是否从 ===N=== 切换到 XML 标签格式提供数据支持。
 *
 * 每个模型跑 15 批次，批次大小随机 2-5 条，批次间等待 5s（≤12 RPM，低于硅基 15 RPM 上限）。
 * 结果输出到 /tmp/bench_tag_format_<timestamp>.json。
 *
 * 用法：node scripts/bench-tag-format.mjs
 */

import fs from 'fs';

const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const apiKey = cfg?.providers?.siliconflow?.apiKey;
if (!apiKey) throw new Error('missing providers.siliconflow.apiKey in config.json');

const BASE_URL = 'https://api.siliconflow.cn/v1/chat/completions';

// 补测：仅 Qwen3-8B，加 enable_thinking:false（上轮未加导致 10/15 超时）
const MODELS = [
  'Qwen/Qwen3-8B',
];

// ---------- 测试语料 ----------
// 覆盖：短推、多段、含 URL/@/#、技术内容、口语、长文
const TWEETS = [
  // 短推
  'Just shipped a new feature. Feels good.',
  'Monday again. Why does time move so fast?',
  'Lit.',
  // 含提及与标签
  'Congrats to @elonmusk on the launch! #SpaceX #Falcon9',
  'The #AI revolution is here. Are you ready?',
  // 含 URL
  'Check out the docs at https://docs.example.com/getting-started for more details.',
  'Full thread: https://twitter.com/example/status/123456789',
  // 技术内容
  'The new transformer architecture reduces memory usage by 40% without sacrificing accuracy on GLUE benchmarks.',
  'Gradient checkpointing trades compute for memory — essential for training large models on consumer GPUs.',
  'We open-sourced our RAG pipeline. Star it if useful: github.com/example/rag',
  // 多段落
  `We've been building in silence for 6 months.\n\nToday we're finally ready to show you what we made.\n\nIt's going to change how you think about productivity.`,
  `First principle: every abstraction has a cost.\n\nMost devs ignore this until performance becomes a crisis.\n\nLearn to see the cost before it bites you.`,
  // 口语 / 俚语
  "No cap, this is the best ramen I've ever had. Tokyo>>>>",
  'The audacity of some people, I swear.',
  "Y'all are not ready for what's coming next week.",
  // 专业名词
  'Quantitative easing has diminishing marginal returns once the liquidity trap is reached.',
  'The new ECJ ruling on data sovereignty has significant implications for transatlantic GDPR compliance.',
  // 引用风格
  '"The best time to plant a tree was 20 years ago. The second best time is now." — Chinese Proverb',
  // 数字 + 统计
  'Global smartphone shipments fell 3.2% YoY in Q1 2025, marking the fifth consecutive quarter of decline.',
  // 单词 / 纯专名（预期 verbatim pass 或空翻）
  'Notion. Obsidian. Roam. None of them stick for me.',
];

// ---------- Prompt ----------
const SYSTEM_PROMPT = `You are a professional translator. Translate each tagged segment from English to Simplified Chinese.

Rules:
1. Output must be entirely in Chinese. Proper nouns may be transliterated or kept in the original language.
2. Keep the exact XML tag structure: <tN>...</tN> where N is the index number.
3. Preserve paragraph breaks (blank lines) within each segment.
4. Output ONLY the tagged translations. No extra text outside the tags.`;

function buildUserContent(texts) {
  return texts.map((t, i) => `<t${i}>\n${t}\n</t${i}>`).join('\n\n');
}

// ---------- 解析器 ----------
function parseTaggedResponse(raw, expectedCount) {
  const result = new Array(expectedCount).fill(null);
  // 宽松匹配：允许标签内首尾有空行
  const re = /<t(\d+)>([\s\S]*?)<\/t\1>/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const idx = parseInt(m[1], 10);
    if (idx >= 0 && idx < expectedCount) {
      result[idx] = m[2].trim();
    }
  }
  return result;
}

// 检测 "on on on" 类退化
function hasDegeneration(text) {
  if (!text) return false;
  // 同一个词/字连续出现 4 次以上
  return /(\b\w+\b)(\s+\1){3,}/.test(text) || /(.{2,8})\1{4,}/.test(text);
}

// ---------- API 调用 ----------
async function callModel(model, texts, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: 0.3,
        max_tokens: Math.max(512, texts.join('').length * 3),
        // Qwen3 默认开 thinking；必须显式关掉才会快速输出翻译（不关会花大量 token 推理）
        ...(model.includes('Qwen3') || model.includes('QwQ') ? { enable_thinking: false } : {}),
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserContent(texts) },
        ],
      }),
    });
    const rttMs = Date.now() - t0;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, rttMs, error: `HTTP ${res.status}: ${body.slice(0, 120)}` };
    }
    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content ?? '';
    return { ok: true, rttMs, raw, usage: data.usage };
  } catch (e) {
    return { ok: false, rttMs: Date.now() - t0, error: e.name === 'AbortError' ? 'timeout' : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 主循环 ----------
const BATCHES_PER_MODEL = 15;
const RPM_DELAY_MS = 5_000; // 5s → ≤12 RPM

function pickBatch(seed) {
  // 可重复的伪随机批次：大小 2-5，从 TWEETS 里取不重叠子集
  const size = 2 + (seed % 4);
  const start = (seed * 3) % (TWEETS.length - size);
  return TWEETS.slice(start, start + size);
}

async function benchModel(model) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Model: ${model}`);
  console.log(`${'='.repeat(60)}`);

  const results = [];

  for (let i = 0; i < BATCHES_PER_MODEL; i++) {
    const texts = pickBatch(i);
    process.stdout.write(`  batch ${String(i + 1).padStart(2)}/${BATCHES_PER_MODEL} (${texts.length} tweets) ... `);

    const call = await callModel(model, texts);

    if (!call.ok) {
      console.log(`FAIL  ${call.error}`);
      results.push({ batch: i, texts, ok: false, error: call.error, rttMs: call.rttMs });
      await sleep(RPM_DELAY_MS);
      continue;
    }

    const parsed = parseTaggedResponse(call.raw, texts.length);
    const allPresent = parsed.every(v => v !== null && v.length > 0);
    const anyDegen = parsed.some(hasDegeneration);
    const tagCount = parsed.filter(v => v !== null).length;

    const status = allPresent && !anyDegen ? 'OK  ' : (!allPresent ? 'MISS' : 'DEGEN');
    console.log(`${status}  tags=${tagCount}/${texts.length}  rtt=${call.rttMs}ms`);

    if (status !== 'OK  ') {
      console.log(`    raw preview: ${call.raw.slice(0, 200).replace(/\n/g, '↵')}`);
    }

    results.push({
      batch: i, texts, ok: true, rttMs: call.rttMs,
      parsed, allPresent, anyDegen, tagCount,
      raw: call.raw,
      usage: call.usage,
    });

    await sleep(RPM_DELAY_MS);
  }

  // 统计
  const callOk = results.filter(r => r.ok);
  const parseOk = callOk.filter(r => r.allPresent && !r.anyDegen);
  const tagMiss = callOk.filter(r => !r.allPresent);
  const degen = callOk.filter(r => r.anyDegen);
  const rtts = callOk.map(r => r.rttMs).sort((a, b) => a - b);
  const p50 = rtts[Math.floor(rtts.length * 0.5)] ?? 0;
  const p95 = rtts[Math.floor(rtts.length * 0.95)] ?? 0;

  console.log(`\n  ── 汇总 ──`);
  console.log(`  API成功:     ${callOk.length}/${results.length}`);
  console.log(`  完全解析:    ${parseOk.length}/${callOk.length}  (${pct(parseOk.length, callOk.length)}%)`);
  console.log(`  标签缺失:    ${tagMiss.length}  (${pct(tagMiss.length, callOk.length)}%)`);
  console.log(`  退化输出:    ${degen.length}  (${pct(degen.length, callOk.length)}%)`);
  console.log(`  RTT p50/p95: ${p50}ms / ${p95}ms`);

  return { model, results, summary: { apiOk: callOk.length, total: results.length, parseOk: parseOk.length, tagMiss: tagMiss.length, degen: degen.length, p50, p95 } };
}

function pct(n, d) { return d === 0 ? 'N/A' : ((n / d) * 100).toFixed(1); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------- 入口 ----------
const allResults = [];
for (const model of MODELS) {
  const r = await benchModel(model);
  allResults.push(r);
}

// 最终对比表
console.log(`\n${'='.repeat(60)}`);
console.log('最终对比（<tN> 标签格式，硅基流动）');
console.log('='.repeat(60));
console.log(`${'模型'.padEnd(35)} ${'完全解析%'.padStart(10)} ${'标签缺失%'.padStart(10)} ${'退化%'.padStart(8)} ${'p50'.padStart(7)} ${'p95'.padStart(7)}`);
console.log('-'.repeat(80));
for (const { model, summary: s } of allResults) {
  const name = model.split('/').pop().padEnd(34);
  console.log(
    `${name} ${pct(s.parseOk, s.apiOk).padStart(10)} ${pct(s.tagMiss, s.apiOk).padStart(10)} ${pct(s.degen, s.apiOk).padStart(8)} ${String(s.p50).padStart(6)}ms ${String(s.p95).padStart(6)}ms`
  );
}

// 保存原始结果
const outFile = `/tmp/bench_tag_format_${Date.now()}.json`;
fs.writeFileSync(outFile, JSON.stringify(allResults, null, 2));
console.log(`\n原始数据已保存到 ${outFile}`);
