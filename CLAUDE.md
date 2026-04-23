# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Dualang ("X 光速翻译") is a Chrome Extension (Manifest V3) for X.com / Twitter that provides streaming bilingual translation. It is **OpenAI-compatible provider agnostic** — default is SiliconFlow's free `THUDM/GLM-4-9B-0414`; Moonshot Kimi and Qwen (via SiliconFlow) are first-class alternates. Super-fine (long-article) translation defaults to GLM as well; Moonshot Kimi is opt-in.

## Commands

```bash
npm install           # install esbuild + vitest + chrome-types
npm run build         # one-shot production bundle: src/content/index.ts → content.js, src/background/index.ts → background.js
npm run build:dev     # inline sourcemaps
npm run watch         # esbuild --watch
npm test              # vitest run (unit tests)
npm run test:watch    # vitest watch

cd e2e && npm install && npx playwright test                    # full e2e
cd e2e && npx playwright test tests/translation.spec.ts         # single spec
cd e2e && npx playwright test --ui                              # Playwright UI
```

**`content.js` / `background.js` / `popup.js` are build outputs** — gitignored. Source of truth is `src/`.

## Loading the Extension

1. `npm run build` (or `npm run watch` during development)
2. `chrome://extensions/` → Developer Mode → Load unpacked → pick the repo root

## E2E Test Harness

Playwright spawns `uv run python3 -m http.server 9999` from repo root (`reuseExistingServer: false`, ephemeral Chromium profile). Fixture uses `headless: false` + `--headless=new` (Chrome 112+ headless supports SW / extensions; `headless: true` does not).

## Runtime Architecture

Three contexts, wired by `chrome.runtime.sendMessage` and `chrome.runtime.connect` ports.

### `src/background/` — Service Worker

- **`index.ts`** — entry point: message router (`translate` / `getStats` / `resetStats` / `getHedgeStats`), port handlers (`keepalive` / `translate-stream` / `super-fine`), context menu, hedged-request orchestration, main→fallback switch, RTT sampling for adaptive hedge delay. Currently a large god function; see `handleTranslateBatch` for the main pipeline.
- **`api.ts`** — `doTranslateSingle` / `doTranslateBatchRequest` / `doTranslateBatchStream`. Batch protocol uses `===N===` delimiter (7-9B models handle it more reliably than JSON). Streaming uses SSE with incremental emission on each detected boundary.
- **`profiles.ts`** — Provider profile registry (strategy pattern). Each profile carries `endpointPath`, `temperature(settings)`, `thinkingControl` (`omit` / `enable-thinking-false` / `thinking-disabled`), `supportsStreaming`, `systemPromptSingle/Batch`. Profile order matters: QWEN3 before QWEN_LEGACY, GLM46 before GLM_LEGACY, Moonshot by baseUrl, generic fallback last.
- **`cache.ts`** — two-tier LRU: L1 in-memory `memCacheMap` (2000 entries) + L2 `chrome.storage.local['dualang_cache_v1']` (5000 entries, LRU eviction 20% on overflow). `cacheKey(text, lang, model, baseUrl)` = djb2 of `normalizeText(text) + '|' + lang + '|' + model + '|' + baseUrl`. Batch read via `getCacheBatch(hashes)` (single storage.get).
- **`rate-limiter.ts`** — `RateLimiter` singleton. Limits: `MAX_CONCURRENCY=100`, `MAX_RPM=500`, `MAX_TPM=3_000_000`, `MAX_TPD=Infinity`. Priority preemption: running task with lower priority gets `abort()` when higher-priority one queues. IO chain (`_withIoLock`) serializes storage RMW to avoid counter loss. `priority>=2` (user-immediate actions) bypasses limits and IO lock.
- **`settings.ts`** — `getSettings()` memoizes `chrome.storage.sync.get(...)` in `settingsCache`; `chrome.storage.onChanged` invalidates. `LANG_DISPLAY` maps BCP-47 codes to Chinese display names for prompts. `getMoonshotKey()` pulls super-fine opt-in key from `config.json` or sync settings.
- **`stats.ts`** — per-model aggregate (reqs / successes / RTT / tokens), cache hits, quality retries, last 20 errors. Persists to `chrome.storage.local['dualang_stats_v1']` debounced 2s. Consumed by popup Stats tab.
- **`error-report.ts`** — fatal-error badge writer (shown on popup as banner, clicked to dismiss).

### `src/content/` — X.com injection

- **`index.ts`** — large IIFE (currently undergoing refactor): scheduler, IntersectionObserver viewport/preload, MutationObserver for dynamic loads + show-more + DOM recycle, pendingQueue + dedup Set, streaming vs sendMessage dispatch, render pipeline across 4 display modes, status indicators, super-fine wire-up.
- **`super-fine-bubble.ts`** — right-side floating bubble state machine (`idle` / `translating` / `done` / `failed`), Y-axis drag with localStorage persistence, hover mini-panel with cancel/retry, X文 logo via CSS `color-mix(--progress)` + bubble/extension icons sharing the design.
- **`super-fine-render.ts`** — inline slot skeletons inserted after each original DOM block via `insertBefore(slot, block.el.nextSibling)`. Preserves original `<img>` / `<video>` / `<a>` / `@mention`.
- **`utils.ts`** — `shouldSkipContent`, `isAlreadyTargetLanguage` (CJK / kana / hangul / latin ratio), `extractText` (uses innerText to keep CSS block boundaries), `splitParagraphsByDom` (TreeWalker + Range for HTML-preserving paragraph split), `extractAnchoredBlocks` (leaf-block walker returning `{el, kind: 'text' | 'img-alt', text}`), `getContentId` (strategy chain: X status / Mastodon / Reddit / HN / YouTube / Bluesky / `data-*` / Grok title / `el.id`).

### `src/shared/`

- **`types.ts`** — message-contract interfaces + `normalizeText`. Currently partially used (ongoing typing-tightening refactor).
- **`model-meta.ts`** — brand icon + one-liner + deploy URL for a given `(model, baseUrl)`. Used by content's success-status icon. Duplicated in `popup.js` (TODO: bundle popup and dedupe).

### Container abstraction

`findTweetTextEl(container)` resolves three selectors uniformly:
- `[data-testid="tweetText"]` — normal tweets
- `[data-dualang-text="true"]` — Grok summary card body (marked by `findAndPrepareGrokCards`)
- `[data-testid="twitterArticleRichTextView"]` — X Articles long-form body

Grok cards have no stable testid/role; detection uses 4-div children + internal `<time>` + disclaimer text prefix. Once matched, card gets `data-dualang-grok="true"` and body gets `data-dualang-text="true"`.

### Display modes (`displayMode`, 4 values)

- `append` (default) — original tweetText visible, translation card appended below.
- `translation-only` — original hidden via `article[data-dualang-mode="translation-only"] [data-testid="tweetText"] { display: none }`, only translation.
- `inline` (段落对照) — `splitParagraphsByDom(tweetTextEl)` clones original paragraph DOM (preserves `<a>` / `<img>` / mentions), each paired with matching translation inside `.dualang-inline-pair`.
- `bilingual` (整体对照) — whole original HTML clone + whole translation.

Legacy migration: `bilingualMode=true` (no `displayMode`) → `'inline'`; otherwise `'append'`. `data-dualang-mode` is set per-article at render time, so flipping the mode only affects newly-translated cards.

## Request Flow

### Normal translation (viewport / preload / manual click)

1. Content `scanAndQueue` registers each article with `viewportObserver` + `preloadObserver` (rootMargin ≈ `viewportHeight`).
2. On observer hit → `queueTranslation` enqueues + dedup Set. Scheduler flushes batches of 20, split into sub-batches of 5 with max 5 concurrent.
3. `requestTranslation` dispatches: long article single text → `requestTranslationChunked` (5-paragraph chunks, serial); normal → `chrome.runtime.sendMessage({action:'translate', payload:{texts, priority, skipCache, strictMode}})` with 30s timeout.
4. Background `handleTranslateBatch`: cache batch-read → in-flight dedup by batch-hash → rate-limiter acquire → hedged vs non-hedged → main→fallback fallback → cache write → stats record. Returns `{translations, model, baseUrl, fromCache, usage}`.
5. Content renders per `displayMode`, caches result in `translationCache` keyed by `getContentId(article)`.

### Super-fine (long X Articles)

1. Content detects long article (`isXArticle && blocks≥6 && chars≥4000`), skips auto-translate, `bubble.trackArticle(article)`.
2. User clicks bubble → `translateArticleSuperFine`: `extractAnchoredBlocks` → `renderInlineSlots` (skeletons after each original block) → `chrome.runtime.connect({name:'super-fine'})` port.
3. Background `handleSuperFineStream`: default GLM via `baseSettings`; Moonshot opt-in only if `payload.model` starts `moonshot-`/`kimi-`. Serial chunks of 5 paragraphs each via `doTranslateBatchStream`. Emits `meta` / `partial` (per paragraph) / `progress` (per chunk) / `chunkFail` / `done` / `error`.
4. Content `fillSlot(article, index, text)` on each partial; bubble state → `done` / `failed` on terminal.

### Quality retry

`hasSuspiciousLineMismatch(original, translated)` + `isWrongLanguage(translated, target)` flag compressed/wrong-language output. First occurrence → `_dualangQualityRetried=true` + re-queue with `skipCache=true, strictMode=true` (STRICT_PREFIX prompt forbids summarization). Second occurrence → surface `showFail` with click-to-force-retry.

## Test Layout

```
src/**/*.test.ts          # vitest unit tests (150)
e2e/tests/*.spec.ts       # Playwright specs
e2e/fixtures/x-mock.html  # mock tweets: EN link/img/plain, zh-CN/zh-TW (should skip),
                          # URL-only (skip), show-more, long article fixture
```

Key specs: `translation.spec.ts` (core + batch + paragraph split), `cache.spec.ts` (L1/L2), `target-lang.spec.ts` (prompt content), `manual-and-bilingual.spec.ts` (4 displayModes), `skip-and-extract.spec.ts` (skip conditions / extractText with links+imgs), `super-fine-bubble.spec.ts` (bubble + long-article gate), `status-and-reliability.spec.ts`, `auto-translate.spec.ts`, `settings.spec.ts`, `real-scenarios.spec.ts`.

## Non-obvious conventions

- **DOM expandos** — `_dualang*` fields are attached to article Elements (enqueue time, high-priority flag, content-ID snapshot, show-more baseline, quality-retry budget, super-fine port). Migration to `WeakMap<Element, ArticleState>` is in progress.
- **`data-dualang-mode` attribute** drives CSS visibility of the original `tweetText`. Removal on render / cache-restore / fail-retry is load-bearing — forgetting it causes layout shift.
- **Profile matching is order-sensitive** — see the PROFILES array comment in `profiles.ts`. `/qwen/i` matches qwen3; `/glm-4/i` matches 4.6.
- **`priority>=2`** = user-immediate (show-more / manual button / retry); bypasses rate-limiter IO lock. Long waits on user-visible actions are a UX regression.
- **Stream decoder flush** — after reader loop, call `decoder.decode()` (no args) to flush trailing bytes; otherwise the last multi-byte CJK char can render as `U+FFFD`. Both `parseStream` and `doTranslateBatchStream` do this.
- **Streaming is disabled for Qwen2.5 / GLM-4-9B** in profiles — their SiliconFlow-hosted SSE splits CJK mid-character on chunk boundaries; `response.json()` integral decode avoids the corruption.
