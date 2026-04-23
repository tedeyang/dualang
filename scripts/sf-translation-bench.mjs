#!/usr/bin/env node
/**
 * 硅基免费/低价 chat 模型翻译能力 benchmark。
 * 三档输入：短句、中段（5 句）、长段（10+ 句）；测 RTT、tokens、是否触发 402/429 等错误，
 * 译文质量做基本校验（含 CJK + 句数对得上）。
 *
 * 用 config.json 里的 SF API key。串行跑（避免互打 TPM）。
 */
import { readFile } from 'fs/promises';
const cfg = JSON.parse(await readFile(new URL('../config.json', import.meta.url)));
const SF_KEY = cfg.providers?.siliconflow?.apiKey;
if (!SF_KEY) { console.error('config.json 没有 siliconflow apiKey'); process.exit(1); }

const SF_URL = 'https://api.siliconflow.cn/v1/chat/completions';

// 候选模型：前 4 个是已知能用做对照（GLM=primary, Qwen3.5-9B=已上接力），
// 后面是这次新挖出来的、待验证。
const MODELS = [
  'THUDM/GLM-4-9B-0414',          // 当前 primary（基线）
  'Qwen/Qwen3.5-9B',              // 当前 sf-relay（基线）
  'Qwen/Qwen2.5-7B-Instruct',     // 页面标"免费" 非 deprecated
  'internlm/internlm2_5-7b-chat', // 页面标"免费" 非 deprecated
  'Qwen/Qwen3.5-4B',              // 更小，可能更快
  'Qwen/Qwen3.5-27B',             // 更大，可能更准
  'Qwen/Qwen3.5-35B-A3B',         // MoE 35B/3B-active
  'Qwen/Qwen3.6-35B-A3B',         // 更新一代 MoE
];

const SHORT = `Anthropic released Claude Opus 4.7 on April 16 at $5 per million input tokens.`;
const MEDIUM = `Anthropic released Claude Opus 4.7 on April 16 at $5 per million input tokens and $25 per million output tokens. SWE-bench Verified scored 92.3% against Opus 4.6's 85.9%. The interesting variable is not the benchmark. It is that GitHub Copilot, Amazon Bedrock, Notion, and Vercel AI Gateway all shipped Opus 4.7 support the same day. The propagation, not the model, is the story.`;
const LONG = `Agent infrastructure went production-grade at both frontier labs this week, and both labs also had to show what safety looks like once it runs. Anthropic shipped Opus 4.7, Claude Code Routines, and a rebuilt Claude Code desktop. OpenAI shipped an Agents SDK across seven sandbox providers and a Codex desktop with computer-use and 90+ plugins. In the same window, Vercel disclosed the year's first AI-platform-originated breach, and Anthropic published agents that beat human authors on an alignment benchmark 0.97 to 0.23 PGR. The architectural bet matters more than the benchmark this week. Anthropic chose managed runtime. OpenAI chose portable primitives. Both will ship, only one will set the default for how mid-sized teams deploy agents at scale. Most coverage read the week as "both labs shipped agent features" and missed the architectural split. The week Vercel disclosed its first AI-platform-originated breach is the week to ask which architecture confines blast radius when the next incident lands.`;

const TIERS = [
  { name: 'short', text: SHORT, expectMinChars: 15, expectMaxChars: 200 },
  { name: 'medium', text: MEDIUM, expectMinChars: 100, expectMaxChars: 600 },
  { name: 'long', text: LONG, expectMinChars: 250, expectMaxChars: 1500 },
];

const SYSTEM = '你是专业翻译。把用户给的英文翻译成简体中文。直接输出译文，不要任何解释、不要保留原文。';

async function callOnce(model, text, signal) {
  const t0 = Date.now();
  const body = {
    model, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: text }],
    temperature: 0.3, max_tokens: 2048, stream: false,
  };
  const resp = await fetch(SF_URL, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SF_KEY}` },
    body: JSON.stringify(body),
  });
  const rttMs = Date.now() - t0;
  const status = resp.status;
  if (!resp.ok) {
    const errText = await resp.text();
    return { rttMs, status, ok: false, error: errText.slice(0, 200) };
  }
  const data = await resp.json();
  const out = data.choices?.[0]?.message?.content || '';
  const usage = data.usage || {};
  return {
    rttMs, status, ok: true, output: out,
    promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalTokens: usage.total_tokens,
  };
}

const hasCJK = (s) => /[一-鿿]/.test(s);
const cjkRatio = (s) => {
  if (!s) return 0;
  const cjk = (s.match(/[一-鿿]/g) || []).length;
  return cjk / s.length;
};
const hasEnglishLeak = (s) => {
  // 翻译里如果还有大量连续英文单词，说明没翻
  const eng = (s.match(/[A-Za-z]{4,}/g) || []).length;
  return eng > 5;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('# Dualang SF 免费模型翻译 benchmark\n');
console.log(`待测模型: ${MODELS.length} 个\n输入档: short (${SHORT.length} chars) / medium (${MEDIUM.length}) / long (${LONG.length})\n`);

const results = {};
for (const model of MODELS) {
  results[model] = { tiers: {} };
  console.log(`\n──── ${model} ────`);
  for (const tier of TIERS) {
    process.stdout.write(`  [${tier.name}] ... `);
    let r;
    try {
      r = await callOnce(model, tier.text);
    } catch (e) {
      r = { ok: false, error: e.message };
    }
    if (!r.ok) {
      console.log(`❌ status=${r.status ?? '?'} err=${(r.error || '').slice(0, 140)}`);
      results[model].tiers[tier.name] = { ok: false, status: r.status, error: r.error };
      // 如果是 402 / 401 类，整个模型放弃后续 tier
      if (r.status === 401 || r.status === 402 || r.status === 404 || r.status === 403) {
        console.log(`  ↳ 永久性错误，跳过此模型剩余 tier`);
        break;
      }
    } else {
      const out = r.output.trim();
      const cjkR = cjkRatio(out);
      const lenOk = out.length >= tier.expectMinChars && out.length <= tier.expectMaxChars;
      const langOk = hasCJK(out) && cjkR >= 0.4;
      const noLeak = !hasEnglishLeak(out);
      const quality = (langOk && noLeak ? '✓' : '⚠️') + (lenOk ? '' : ' (len?)');
      console.log(`${quality} rtt=${r.rttMs}ms tokens=${r.totalTokens} (out ${r.completionTokens}) cjk=${(cjkR * 100).toFixed(0)}% outLen=${out.length}`);
      results[model].tiers[tier.name] = {
        ok: true, rttMs: r.rttMs, totalTokens: r.totalTokens, completionTokens: r.completionTokens,
        cjkRatio: cjkR, lenOk, langOk, noLeak, preview: out.slice(0, 80),
      };
    }
    await sleep(1500);  // 模型间 + 档间间隔，避免互打 TPM
  }
}

// 汇总
console.log('\n\n======== 汇总 ========');
console.log('模型                                  short_rtt  med_rtt  long_rtt  总tokens  质量');
console.log('-'.repeat(95));
for (const [model, r] of Object.entries(results)) {
  const t = r.tiers;
  const fmtRtt = (k) => t[k]?.ok ? `${t[k].rttMs}ms`.padStart(8) : (t[k]?.status ? `[${t[k].status}]`.padStart(8) : '   skip ');
  const totalTok = ['short', 'medium', 'long'].reduce((s, k) => s + (t[k]?.totalTokens || 0), 0);
  const qOk = ['short', 'medium', 'long'].every((k) => t[k]?.ok && t[k].langOk && t[k].noLeak);
  const qLabel = qOk ? '✓ 通过' : (Object.values(t).some((x) => x.ok) ? '⚠ 部分' : '❌');
  console.log(`${model.padEnd(38)} ${fmtRtt('short')} ${fmtRtt('medium')} ${fmtRtt('long')} ${String(totalTok).padStart(8)}  ${qLabel}`);
}

console.log('\n\n======== 接力候选筛选（成功 + 质量通过） ========');
for (const [model, r] of Object.entries(results)) {
  const t = r.tiers;
  const qOk = ['short', 'medium', 'long'].every((k) => t[k]?.ok && t[k].langOk && t[k].noLeak);
  if (qOk) {
    const avgRtt = Math.round(['short', 'medium', 'long'].reduce((s, k) => s + t[k].rttMs, 0) / 3);
    console.log(`  ✓ ${model.padEnd(36)} avgRtt=${avgRtt}ms`);
  }
}

console.log('\n──── 译文样本（long tier 前 80 字符） ────');
for (const [model, r] of Object.entries(results)) {
  const p = r.tiers.long?.preview;
  if (p) console.log(`  ${model.padEnd(36)} ${p}`);
}
