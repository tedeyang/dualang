import { describe, it, expect } from 'vitest';
import {
  adaptiveTimeoutMs,
  REQUEST_TIMEOUT_MS,
  LONG_CHUNK_TIMEOUT_MS,
} from './constants';

describe('adaptiveTimeoutMs', () => {
  it('短内容用 baseline（不会被缩到更短）', () => {
    expect(adaptiveTimeoutMs(500, REQUEST_TIMEOUT_MS)).toBe(REQUEST_TIMEOUT_MS);
    expect(adaptiveTimeoutMs(100, REQUEST_TIMEOUT_MS)).toBe(REQUEST_TIMEOUT_MS);
    expect(adaptiveTimeoutMs(0, REQUEST_TIMEOUT_MS)).toBe(REQUEST_TIMEOUT_MS);
  });

  it('中等内容在 baseline 与 scale 之间取 max', () => {
    // 4000 chars / 150 chars/sec = ~27s，低于 60s baseline → 取 baseline
    expect(adaptiveTimeoutMs(4000, LONG_CHUNK_TIMEOUT_MS)).toBe(LONG_CHUNK_TIMEOUT_MS);
  });

  it('长内容按 150 chars/sec 线性扩展', () => {
    // 20k chars → 133s
    expect(adaptiveTimeoutMs(20_000, REQUEST_TIMEOUT_MS)).toBe(134_000);
    // 30k chars → 200s，但被 max 180s 夹住
    expect(adaptiveTimeoutMs(30_000, REQUEST_TIMEOUT_MS)).toBe(180_000);
  });

  it('超长内容不超过 maxMs（默认 3 分钟）', () => {
    expect(adaptiveTimeoutMs(100_000, REQUEST_TIMEOUT_MS)).toBe(180_000);
  });

  it('可传入自定义 maxMs', () => {
    expect(adaptiveTimeoutMs(100_000, 10_000, 60_000)).toBe(60_000);
  });
});
