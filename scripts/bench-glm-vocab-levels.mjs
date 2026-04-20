import fs from 'fs';

const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const apiKey = cfg?.providers?.siliconflow?.apiKey;
if (!apiKey) throw new Error('missing siliconflow api key');

const url = 'https://api.siliconflow.cn/v1/chat/completions';
const model = 'THUDM/GLM-4-9B-0414';

const gold = [
  ['important', 'cet4'],
  ['travel', 'cet4'],
  ['culture', 'cet4'],
  ['compare', 'cet4'],
  ['reduce', 'cet4'],
  ['quality', 'cet4'],
  ['effective', 'cet4'],
  ['normal', 'cet4'],
  ['ambiguous', 'cet6'],
  ['controversial', 'cet6'],
  ['subtle', 'cet6'],
  ['mitigate', 'cet6'],
  ['ubiquitous', 'cet6'],
  ['trajectory', 'cet6'],
  ['consensus', 'cet6'],
  ['paradox', 'cet6'],
  ['cohesion', 'ielts'],
  ['lexical resource', 'ielts'],
  ['coherence', 'ielts'],
  ['register', 'ielts'],
  ['articulate', 'ielts'],
  ['discourse', 'ielts'],
  ['nuanced', 'ielts'],
  ['fluency', 'ielts'],
  ['epistemology', 'kaoyan'],
  ['ontological', 'kaoyan'],
  ['inferential', 'kaoyan'],
  ['heuristic', 'kaoyan'],
  ['paradigmatic', 'kaoyan'],
  ['dialectical', 'kaoyan'],
  ['axiomatic', 'kaoyan'],
  ['teleological', 'kaoyan'],
];

const terms = gold.map(([t]) => t);
const valid = ['cet4', 'cet6', 'ielts', 'kaoyan'];
const systemPrompt =
  'You are an English vocabulary grader for Chinese learners. ' +
  'Return strict JSON only: {"items":[{"term":string,"difficulty":"cet4|cet6|ielts|kaoyan"}]}. ' +
  'Classify each input term into exactly one bucket.';
const userPrompt = `Terms: ${JSON.stringify(terms)}`;

function parseResponse(raw) {
  const code = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const unwrapped = (code ? code[1] : raw).trim();
  const first = unwrapped.indexOf('{');
  const last = unwrapped.lastIndexOf('}');
  const jsonStr = first >= 0 && last > first ? unwrapped.slice(first, last + 1) : unwrapped;
  const parsed = JSON.parse(jsonStr);
  return Array.isArray(parsed?.items) ? parsed.items : [];
}

function score(items) {
  const pred = {};
  for (const it of items) {
    const term = String(it?.term || '').toLowerCase().trim();
    const d = String(it?.difficulty || '').toLowerCase().trim();
    if (!term) continue;
    pred[term] = d;
  }
  const confusion = {
    cet4: { cet4: 0, cet6: 0, ielts: 0, kaoyan: 0, other: 0 },
    cet6: { cet4: 0, cet6: 0, ielts: 0, kaoyan: 0, other: 0 },
    ielts: { cet4: 0, cet6: 0, ielts: 0, kaoyan: 0, other: 0 },
    kaoyan: { cet4: 0, cet6: 0, ielts: 0, kaoyan: 0, other: 0 },
  };
  const misses = [];
  let hit = 0;
  for (const [term, g] of gold) {
    const p = pred[term.toLowerCase()] || 'other';
    if (p === g) hit += 1;
    if (valid.includes(p)) confusion[g][p] += 1;
    else confusion[g].other += 1;
    if (p !== g) misses.push({ term, gold: g, pred: p });
  }
  return {
    accuracy: Number((hit / gold.length).toFixed(4)),
    hit,
    total: gold.length,
    confusion,
    misses: misses.slice(0, 16),
  };
}

async function run(round) {
  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0,
      max_tokens: 1200,
    }),
  });
  const latencyMs = Date.now() - t0;
  if (!res.ok) {
    const err = await res.text();
    return { round, http: res.status, latencyMs, error: err.slice(0, 220) };
  }
  const data = await res.json();
  const raw = String(data?.choices?.[0]?.message?.content || '').trim();
  try {
    const items = parseResponse(raw);
    return {
      round,
      http: 200,
      latencyMs,
      jsonParseOk: true,
      itemCount: items.length,
      report: score(items),
      rawPreview: raw.slice(0, 160),
    };
  } catch (e) {
    return {
      round,
      http: 200,
      latencyMs,
      jsonParseOk: false,
      parseError: String(e?.message || e),
      rawPreview: raw.slice(0, 220),
    };
  }
}

const rounds = Number(process.argv[2] || '2');
for (let i = 1; i <= rounds; i += 1) {
  // eslint-disable-next-line no-await-in-loop
  const out = await run(i);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(out));
}
