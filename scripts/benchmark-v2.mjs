#!/usr/bin/env node
// benchmark v2 — 翻译质量与性能测试，Claude 当评委（本脚本只收集输出）
// 改进点：
//   1. 对短文本（<= 100 chars）使用最简 prompt，避免多规则指令淹没小文本
//   2. Qwen 做温度网格（0.1/0.3/0.7/1.0），寻找它在长文本上翻车的温度成因
//   3. 请求间 2.5s 间隔，~24 RPM，SiliconFlow 免费档也安全
//   4. 结果写 JSON；后续由我（Claude）读 JSON 直接评分，不再依赖 LLM 评估器
//
// 用法：node scripts/benchmark-v2.mjs
// 输出：/tmp/bench_v2_phase1.json（模型对比）+ /tmp/bench_v2_qwen.json（Qwen 温度网格）

import fs from 'fs';

const CONFIG = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const MOON_KEY = CONFIG.providers?.moonshot?.apiKey;
const SF_KEY = CONFIG.providers?.siliconflow?.apiKey;
if (!MOON_KEY || !SF_KEY || MOON_KEY.startsWith('sk-your') || SF_KEY.startsWith('sk-your')) {
  console.error('config.json 缺少真实 API Key');
  process.exit(1);
}

// ===================== 测试文本 =====================
// 挑选分布在"推文实际长度谱"的样本 + 长文本压力档
const TEXTS = {
  en_10:   'Iranian mi',  // 极短、截断（测 prompt 韧性）
  en_80:   'Musk said Starship will reach Mars by 2028, calling it the most important milestone for humanity.',
  en_280:  'BREAKING: Federal Reserve announces surprise 50 basis point rate cut amid signs of rapid economic cooling. Chair Powell cited softening labor market, stalling consumer spending, and deteriorating small-business sentiment. Markets rallied on the news — S&P 500 surged 2.3% within minutes.',
  en_1000: `Washington — Three rounds of intense negotiations between US and Chinese trade officials in Geneva ended Thursday without a concrete agreement, though both sides described the talks as "productive" and "frank." The 72-hour marathon covered tariffs on semiconductors, rare-earth export controls, agricultural subsidies, and the status of TikTok's US operations. Treasury Secretary Yellen told reporters the two delegations had "meaningfully narrowed the gap" on several technical issues but remained "far apart" on structural policy changes. China's lead negotiator He Lifeng struck a more conciliatory tone, emphasizing that dialogue itself was progress and that both economies stood to gain from de-escalation. Behind the scenes, however, US officials expressed frustration over what they called Beijing's "selective enforcement" of previously agreed commitments. One senior administration official, speaking on condition of anonymity, warned that unless Beijing moves on IP enforcement within 60 days, the White House is "prepared to act unilaterally."`,
  jp_10:   'ホルムズ海峡',
  jp_100:  '日本政府は、ホルムズ海峡の安全確保に向けて、中東各国との協議を加速させる方針を明らかにしました。',
  jp_1000: `東京 — 日本銀行は金曜日の金融政策決定会合で、10年ぶりとなる追加の緩和策を発表した。植田総裁は記者会見で、最近の円安進行と国内消費の停滞を踏まえ、政策金利を0.1%引き下げ、長期国債の買い入れ枠を年間6兆円拡大すると説明した。市場の反応は複雑だった。東京株式市場は一時500円上昇したものの、午後には外国人投資家の売りに押されて上げ幅を縮小。一方で外国為替市場では、ドル円が瞬時に1円50銭円安方向に振れ、1ドル=157円台に突入した。経済アナリストの間では評価が割れている。野村総合研究所の田中氏は「円安を容認する明確なシグナル」と評価する一方、三井住友DSアセットマネジメントの森氏は「輸入インフレが家計を圧迫する局面で追加緩和は逆効果」と警鐘を鳴らした。企業側の反応も分かれた。トヨタ自動車は輸出採算の改善を歓迎する声明を出したが、イオングループは食品原料の輸入コストが年間数百億円増加する可能性を指摘。政府内部でも財務省と経済産業省の間で意見対立が表面化しつつあるとされ、今後の政策運営は難航が予想される。`,
};

// ===================== Prompt =====================

const PROMPT_FULL = (lang) => `你是专业翻译助手。请将用户提供的推文文本翻译成${lang}。

规则：
1. 如果原文已经是${lang}，直接返回原文，不要添加任何说明。
2. 只输出翻译结果，不要解释，不要添加额外内容（如"翻译："、"译文："等前缀）。
3. 保持原文的语气和风格，包括口语化、幽默、讽刺等语气。
4. 如果原文包含多个段落，请保留段落结构，各段落之间用换行符分隔。`;

// 短文本超简版：一句话、零规则。避免把 100 字的原文淹没在 200 字的规则中。
const PROMPT_SIMPLE = (lang) => `Translate the following to ${lang}. Output only the translation.`;

function pickPrompt(text, lang) {
  return text.length <= 100 ? PROMPT_SIMPLE(lang) : PROMPT_FULL(lang);
}

// ===================== HTTP 调用 =====================

async function callOpenAI({ endpoint, apiKey, model, temperature, systemPrompt, userText, extraBody = {} }) {
  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userText },
    ],
    temperature,
    stream: false,
    ...extraBody,
  };
  const t0 = Date.now();
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const rttMs = Date.now() - t0;
    if (!res.ok) {
      const errText = await res.text();
      return { ok: false, rttMs, error: `HTTP ${res.status}`, body: errText.slice(0, 300) };
    }
    const data = await res.json();
    return {
      ok: true,
      rttMs,
      translated: data.choices?.[0]?.message?.content?.trim() || '',
      usage: data.usage || null,
    };
  } catch (e) {
    return { ok: false, rttMs: Date.now() - t0, error: String(e?.message || e) };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===================== Phase 1: 模型对比 =====================

async function runPhase1() {
  // 目标："moonshot-v1-8k 为对照" + "kimi-k2.5@0.7（原报告建议降温）" +
  //      "GLM-4-9B（最快兜底候选）" + "Qwen2.5-7B（待优化模型）"
  // kimi-k2.5 强制 temperature=1（Moonshot 限制：其他温度返回 400）
  // Qwen2.5 不传 enable_thinking（实测误传会陷入 on-loop 退化）
  // Qwen3-8B 必须 enable_thinking:false
  const configs = [
    { label: 'moonshot-v1-8k',
      endpoint: 'https://api.moonshot.cn/v1/chat/completions',
      apiKey: MOON_KEY, model: 'moonshot-v1-8k', temperature: 0.3 },
    { label: 'kimi-k2.5',
      endpoint: 'https://api.moonshot.cn/v1/chat/completions',
      apiKey: MOON_KEY, model: 'kimi-k2.5', temperature: 1 },
    { label: 'glm-4-9b',
      endpoint: 'https://api.siliconflow.cn/v1/chat/completions',
      apiKey: SF_KEY, model: 'THUDM/GLM-4-9B-0414', temperature: 0.3 },
    { label: 'qwen2.5-7b',
      endpoint: 'https://api.siliconflow.cn/v1/chat/completions',
      apiKey: SF_KEY, model: 'Qwen/Qwen2.5-7B-Instruct', temperature: 0.3 },
    { label: 'qwen3-8b',
      endpoint: 'https://api.siliconflow.cn/v1/chat/completions',
      apiKey: SF_KEY, model: 'Qwen/Qwen3-8B', temperature: 0.3,
      extraBody: { enable_thinking: false } },
  ];

  const results = [];
  for (const cfg of configs) {
    for (const [textKey, text] of Object.entries(TEXTS)) {
      const prompt = pickPrompt(text, '简体中文');
      console.log(`[phase1] ${cfg.label} × ${textKey} (${text.length}字, prompt=${prompt === PROMPT_SIMPLE('简体中文') ? 'simple' : 'full'})`);
      const r = await callOpenAI({
        ...cfg, systemPrompt: prompt, userText: text,
      });
      results.push({
        model: cfg.label, textKey, inputLen: text.length,
        prompt: prompt === PROMPT_SIMPLE('简体中文') ? 'simple' : 'full',
        temperature: cfg.temperature,
        ...r,
      });
      console.log(`   → ${r.ok ? `${r.rttMs}ms, ${r.usage?.total_tokens ?? '?'} tokens` : `FAIL: ${r.error}`}`);
      await sleep(2500);
    }
  }
  return results;
}

// ===================== Phase 2: Qwen 温度网格 =====================

async function runPhase2Qwen() {
  // Qwen2.5-7B 在原报告最差（5.60 平均）。测 4 个温度 × 4 个代表长度
  // 关键点：原报告的"英文 1000/3000 字翻车"和"日文 3000 字地名错乱"应被覆盖
  const temps = [0.1, 0.3, 0.7, 1.0];
  const textKeys = ['en_10', 'en_280', 'en_1000', 'jp_1000'];

  const results = [];
  for (const temp of temps) {
    for (const textKey of textKeys) {
      const text = TEXTS[textKey];
      const prompt = pickPrompt(text, '简体中文');
      console.log(`[phase2-qwen] T=${temp} × ${textKey} (${text.length}字)`);
      const r = await callOpenAI({
        endpoint: 'https://api.siliconflow.cn/v1/chat/completions',
        apiKey: SF_KEY,
        model: 'Qwen/Qwen2.5-7B-Instruct',
        temperature: temp,
        systemPrompt: prompt, userText: text,
        // 关键修复：Qwen2.5 不传 enable_thinking（会 400 或退化成 on-loop）
      });
      results.push({
        model: 'qwen2.5-7b',
        textKey, inputLen: text.length,
        prompt: prompt === PROMPT_SIMPLE('简体中文') ? 'simple' : 'full',
        temperature: temp,
        ...r,
      });
      console.log(`   → ${r.ok ? `${r.rttMs}ms, ${r.usage?.total_tokens ?? '?'} tokens` : `FAIL: ${r.error}`}`);
      await sleep(2500);
    }
  }
  return results;
}

// ===================== 主 =====================

async function main() {
  console.log('=== Phase 1: 4 模型 × 5 文本（en_10/80/280/1000, jp_10/100/1000）===');
  const p1 = await runPhase1();
  fs.writeFileSync('/tmp/bench_v2_phase1.json', JSON.stringify(p1, null, 2));
  console.log(`\n✅ Phase 1 完成，${p1.length} 条结果 → /tmp/bench_v2_phase1.json`);

  console.log('\n=== Phase 2: Qwen2.5-7B 温度网格（4 温度 × 4 文本）===');
  const p2 = await runPhase2Qwen();
  fs.writeFileSync('/tmp/bench_v2_qwen.json', JSON.stringify(p2, null, 2));
  console.log(`\n✅ Phase 2 完成，${p2.length} 条结果 → /tmp/bench_v2_qwen.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
