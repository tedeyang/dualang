/**
 * Provider 采样器（P3）—— 对单个 provider 串行跑 short/medium/long single + batch-5 + stream。
 * 产出：ProviderCapability 一次性快照 + PerformanceProfile EWMA 初始值。
 *
 * 设计约束（docs/decisions/smart-router-design.md §3）：
 *   - 串行：不打自己的 TPM
 *   - case 间 sleep —— 给 provider 喘息
 *   - 进度回调：UI 可流式显示每 case 结果
 *   - 用户手动触发；成本 ~10K tokens / 次（UI 上提示）
 *
 * 刻意走与路由器完全相同的代码路径（doTranslateSingle / doTranslateBatchRequest）：
 * 这样采样结果就是"此 provider 在实际路径上的表现"的真实快照。
 */

import { doTranslateSingle, doTranslateBatchRequest } from '../api';
import type { Settings } from '../../shared/types';
import {
  validateTranslation,
  validateBatch,
  detectThinkingArtifacts,
  type QualityVerdict,
  type BatchVerdict,
} from './sampler-validators';
import { createEWMA } from '../../shared/ewma';
import type {
  ProviderCapability,
  ProviderEntry,
  PerformanceProfile,
} from '../../shared/router-types';

// ============ 样本文本 ============
// 英 → 中翻译。原先用品牌密集的科技新闻（Anthropic / Claude / OpenAI / Vercel 等），
// 导致正确译文里保留品牌名 → englishLeak 超阈值 → 正确译文被标 "broken"。
// 现在刻意选**不含专有名词**的通用工程语料：正确译文 ≈ 纯中文，不会和品牌保留混淆。

const SHORT_TEXT =
  'Engineers often find that the real bottleneck is caching, not the model itself.';

const MEDIUM_TEXT =
  'The team spent weeks tuning retrieval heuristics before the launch. ' +
  'The bottleneck turned out to be caching rather than model latency. ' +
  'Small synthetic tests missed the problem entirely. ' +
  'Only production traffic surfaced the failure mode. ' +
  'The incident review reshaped how the group plans load testing.';

const LONG_TEXT =
  'When long-context models hit production, the bottleneck shifts from parameters to plumbing. ' +
  'Engineers spend weeks tuning chunk sizes, retrieval heuristics, and caching layers. ' +
  'The model ships, but so does a fleet of ad-hoc schedulers around it. ' +
  'Rate limits become load-bearing infrastructure, not afterthoughts. ' +
  'Outages reveal which customers built abstractions and which wired things directly. ' +
  'Observability tells you which prompt template actually ran, but only if you logged the template id. ' +
  'The successful teams learn to treat the model like a flaky database: isolate, hedge, degrade gracefully. ' +
  'The others rebuild every six months as the interface shifts under them. ' +
  'Cost dashboards are next: per-feature token burn, not just total spend. ' +
  'By then, your infra looks more like distributed systems work than prompt engineering.';

const BATCH_TEXTS = [
  'The team often underestimates how much observability matters until production breaks.',
  'A new cache layer reduced average latency by almost forty percent this quarter.',
  'Small teams ship faster when they trust the build pipeline.',
  'Most outages came from rate limits rather than from code bugs.',
  'The post-mortem highlighted the cost of skipping load tests.',
];

// ============ 类型 ============

export type SamplerCaseName =
  | 'short-single'
  | 'medium-single'
  | 'long-single'
  | 'batch-5'
  | 'stream-medium';

export interface SamplerCaseResult {
  name: SamplerCaseName;
  ok: boolean;
  rttMs: number;
  tokens?: number;
  /** 非空表示发生了错误（API 抛错 / 解析失败），此时 ok=false */
  error?: string;
  /** 单 / 批量各返回一种；采样结束后统一用来判定 capability */
  verdict?: QualityVerdict | BatchVerdict;
  /** 原始输出（仅前 400 字符），用于 UI spot-check */
  outputHead?: string;
}

export interface SamplerOutput {
  caseResults: SamplerCaseResult[];
  capability: ProviderCapability;
  performance: PerformanceProfile;
  /** 总耗时 —— UI 展示给用户看 "这次采样花了 23s" */
  totalRttMs: number;
}

export type SamplerProgressCb = (r: SamplerCaseResult) => void;

export interface SampleInputs {
  provider: ProviderEntry;
  apiKey: string;
  /** 目标语言，默认 'zh-CN' —— 影响 prompt；sampler 校验默认按中文评判 */
  targetLang?: string;
}

// ============ 入口 ============

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const INTER_CASE_DELAY_MS = 1000;

export async function runSampler(
  inputs: SampleInputs,
  signal: AbortSignal,
  onProgress: SamplerProgressCb = () => {},
): Promise<SamplerOutput> {
  const { provider, apiKey } = inputs;
  const targetLang = inputs.targetLang || 'zh-CN';

  const baseSettings: Settings = {
    apiKey,
    baseUrl: provider.baseUrl,
    model: provider.model,
    providerType: 'openai',
    targetLang,
    maxTokens: 2048,
    enableStreaming: false,
    reasoningEffort: 'none',
  };

  const caseResults: SamplerCaseResult[] = [];
  const totalStart = Date.now();

  async function runCase(name: SamplerCaseName, fn: () => Promise<SamplerCaseResult>) {
    if (signal.aborted) return;
    let r: SamplerCaseResult;
    try {
      r = await fn();
    } catch (e: any) {
      r = {
        name,
        ok: false,
        rttMs: 0,
        error: (e?.message || String(e)).slice(0, 200),
      };
    }
    caseResults.push(r);
    onProgress(r);
    await sleep(INTER_CASE_DELAY_MS);
  }

  await runCase('short-single', () => runSingle('short-single', SHORT_TEXT, baseSettings, false, signal));
  await runCase('medium-single', () => runSingle('medium-single', MEDIUM_TEXT, baseSettings, false, signal));
  await runCase('long-single', () => runSingle('long-single', LONG_TEXT, baseSettings, false, signal));
  await runCase('batch-5', () => runBatch('batch-5', BATCH_TEXTS, baseSettings, signal));
  await runCase('stream-medium', () => runSingle('stream-medium', MEDIUM_TEXT, { ...baseSettings, enableStreaming: true }, true, signal));

  const totalRttMs = Date.now() - totalStart;

  return {
    caseResults,
    capability: deriveCapability(caseResults),
    performance: derivePerformance(caseResults),
    totalRttMs,
  };
}

// ============ 单条 case ============

async function runSingle(
  name: SamplerCaseName,
  text: string,
  settings: Settings,
  isStream: boolean,
  signal: AbortSignal,
): Promise<SamplerCaseResult> {
  const t0 = Date.now();
  const r: any = await doTranslateSingle(text, settings, signal);
  const rttMs = Date.now() - t0;

  // doTranslateSingle 两种返回：stream → {translated}；non-stream → 原始 OpenAI JSON
  const translated = (
    r.translated
      || r.choices?.[0]?.message?.content
      || ''
  ).trim();
  const usage = r.usage;
  const verdict = validateTranslation(text, translated);
  const hasThinkArtifacts = detectThinkingArtifacts(translated);
  return {
    name,
    ok: verdict.pass && !hasThinkArtifacts,
    rttMs,
    tokens: usage?.total_tokens,
    verdict,
    outputHead: translated.slice(0, 400),
  };
}

async function runBatch(
  name: SamplerCaseName,
  texts: string[],
  settings: Settings,
  signal: AbortSignal,
): Promise<SamplerCaseResult> {
  const t0 = Date.now();
  const r = await doTranslateBatchRequest(texts, settings, signal);
  const rttMs = Date.now() - t0;
  const verdict = validateBatch(texts, r.translations || []);
  return {
    name,
    ok: verdict.pass,
    rttMs,
    tokens: r.usage?.total_tokens,
    verdict,
    outputHead: (r.translations || []).join(' | ').slice(0, 400),
  };
}

// ============ 聚合：cases → capability + performance ============

export function deriveCapability(cases: SamplerCaseResult[]): ProviderCapability {
  const byName = new Map(cases.map((c) => [c.name, c]));
  const batch = byName.get('batch-5');
  const stream = byName.get('stream-medium');
  // 如果 short/medium single 里任何一个输出带 thinking artifact —— 标 forced
  const thinkingForced = cases.some(
    (c) => c.outputHead && /<think/i.test(c.outputHead),
  );
  return {
    batch: !batch ? 'untested' : batch.ok ? 'proven' : 'broken',
    streaming: !stream ? 'untested' : stream.ok ? 'proven' : 'broken',
    thinkingMode: thinkingForced ? 'forced' : 'optional',
    observedAt: Date.now(),
  };
}

export function derivePerformance(cases: SamplerCaseResult[]): PerformanceProfile {
  const byName = new Map(cases.map((c) => [c.name, c]));
  const mkRtt = (name: SamplerCaseName): ReturnType<typeof createEWMA> => {
    const c = byName.get(name);
    return c && c.ok ? createEWMA(c.rttMs) : createEWMA();
  };
  const successCount = cases.filter((c) => c.ok).length;
  const total = Math.max(cases.length, 1);
  const successRate = createEWMA(successCount / total);
  const qualityScore = createEWMA(successCount / total);

  // tokens/sec：用所有成功 case 的 tokens 和 rtt 粗估
  const successful = cases.filter((c) => c.ok && c.tokens && c.rttMs);
  let tps = createEWMA();
  if (successful.length) {
    const sumTokens = successful.reduce((s, c) => s + (c.tokens || 0), 0);
    const sumMs = successful.reduce((s, c) => s + c.rttMs, 0);
    tps = createEWMA(sumMs > 0 ? (sumTokens * 1000) / sumMs : 0);
  }

  return {
    rttMs: {
      short: mkRtt('short-single'),
      medium: mkRtt('medium-single'),
      long: mkRtt('long-single'),
    },
    tokensPerSec: tps,
    qualityScore,
    successRate,
    lastSampleAt: Date.now(),
  };
}
