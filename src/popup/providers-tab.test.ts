import { describe, it, expect } from 'vitest';
import {
  maskApiKey,
  circuitBadge,
  validateProviderForm,
  buildProviderEntry,
  renderCardHtml,
} from './providers-tab';

describe('maskApiKey', () => {
  it('returns placeholder for empty', () => {
    expect(maskApiKey('')).toBe('未设置');
  });
  it('short keys show prefix only', () => {
    expect(maskApiKey('sk-abc')).toBe('sk••••');
  });
  it('long keys show first 4 / last 4', () => {
    expect(maskApiKey('sk-1234567890abcdef')).toBe('sk-1••••cdef');
  });
});

describe('circuitBadge', () => {
  it('null on healthy / missing', () => {
    expect(circuitBadge(undefined)).toBeNull();
    expect(circuitBadge({
      state: 'HEALTHY', cooldownUntil: 0, cooldownMs: 0,
      probeWeight: 1, probeSuccessStreak: 0, lastTransitionAt: 0,
    })).toBeNull();
  });
  it('cooling shows remaining seconds', () => {
    const b = circuitBadge({
      state: 'COOLING', cooldownUntil: Date.now() + 30_000, cooldownMs: 60_000,
      probeWeight: 1, probeSuccessStreak: 0, lastTransitionAt: 0,
    });
    expect(b?.cls).toBe('pill--warn');
    expect(b?.text).toMatch(/cooling \d+s/);
  });
  it('probing shows weight percent', () => {
    const b = circuitBadge({
      state: 'PROBING', cooldownUntil: 0, cooldownMs: 0,
      probeWeight: 0.25, probeSuccessStreak: 1, lastTransitionAt: 0,
    });
    expect(b?.text).toBe('probing 25%');
  });
  it('permanent disabled is bad', () => {
    const b = circuitBadge({
      state: 'PERMANENT_DISABLED', cooldownUntil: 0, cooldownMs: 0,
      probeWeight: 1, probeSuccessStreak: 0, lastTransitionAt: 0,
    });
    expect(b?.cls).toBe('pill--bad');
  });
});

describe('validateProviderForm', () => {
  const base = { label: 'l', baseUrl: 'https://a.b/v1', model: 'm', apiKey: 'k' };
  it('accepts valid', () => expect(validateProviderForm(base)).toBeNull());
  it('label is optional (empty label still valid)', () => {
    expect(validateProviderForm({ ...base, label: '' })).toBeNull();
  });
  it('baseUrl required', () => {
    expect(validateProviderForm({ ...base, baseUrl: '' })).toMatch(/API 地址/);
  });
  it('baseUrl must be URL', () => {
    expect(validateProviderForm({ ...base, baseUrl: 'not-a-url' })).toMatch(/格式/);
  });
  it('baseUrl must be http(s)', () => {
    expect(validateProviderForm({ ...base, baseUrl: 'ftp://x/y' })).toMatch(/http/);
  });
  it('model required', () => {
    expect(validateProviderForm({ ...base, model: '' })).toMatch(/模型/);
  });
  it('apiKey required', () => {
    expect(validateProviderForm({ ...base, apiKey: '' })).toMatch(/API Key/);
  });
  it('apiKey optional in edit mode', () => {
    expect(validateProviderForm({ ...base, apiKey: '' }, { requireApiKey: false })).toBeNull();
  });
});

describe('buildProviderEntry', () => {
  it('derives id from baseUrl + model', () => {
    const e = buildProviderEntry(
      { label: 'GLM', baseUrl: 'https://api.siliconflow.cn/v1', model: 'THUDM/GLM-4-9B-0414' },
      1_700_000_000_000,
    );
    expect(e.id).toBe('sf:THUDM/GLM-4-9B-0414');
    expect(e.apiKeyRef).toBe(e.id);
    expect(e.enabled).toBe(true);
  });
  it('label defaults to empty string when not provided', () => {
    const e = buildProviderEntry(
      { label: '', baseUrl: 'https://api.siliconflow.cn/v1', model: 'M' },
      0,
    );
    expect(e.label).toBe('');
  });
});

describe('renderCardHtml', () => {
  const p = {
    id: 'sf:M', label: 'L', baseUrl: 'https://api.siliconflow.cn/v1', model: 'M',
    apiKeyRef: 'sf:M', enabled: true, createdAt: 0,
  };
  it('escapes label and model', () => {
    const html = renderCardHtml({
      provider: { ...p, label: '<img onerror="x">', model: 'a<b>' },
      maskedKey: 'sk••••',
    });
    expect(html).not.toContain('<img onerror');
    expect(html).toContain('&lt;img onerror');
    expect(html).toContain('a&lt;b&gt;');
  });
  it('shows 未测 pill when no capability', () => {
    const html = renderCardHtml({ provider: p, maskedKey: 'sk••••' });
    expect(html).toContain('未测');
  });
  it('shows batch ok when capability proven', () => {
    const html = renderCardHtml({
      provider: p, maskedKey: 'sk••••',
      capability: { batch: 'proven', streaming: 'proven', thinkingMode: 'none', observedAt: 0 },
    });
    expect(html).toContain('pill--ok');
    expect(html).toContain('batch: proven');
    expect(html).toContain('stream: ok');
  });
  it('marks disabled when provider.enabled=false', () => {
    const html = renderCardHtml({ provider: { ...p, enabled: false }, maskedKey: '' });
    expect(html).toContain('is-disabled');
    expect(html).toContain('启用'); // toggle button text
  });
});
