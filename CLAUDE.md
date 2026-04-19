# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Dualang is a Chrome Extension (Manifest V3) for X.com/Twitter that provides bilingual translation using the Kimi (Moonshot) OpenAI-compatible API. There is no build step — the extension is loaded directly into Chrome as an unpacked extension.

## Loading the Extension

1. Open `chrome://extensions/`
2. Enable Developer Mode
3. Click "Load unpacked" and select the `dualang/` directory

## Running E2E Tests

```bash
cd e2e
npm install
npx playwright test                          # all tests (headless, no browser window)
npx playwright test tests/translation.spec.ts  # single file
npx playwright test --ui                     # Playwright UI mode
```

Tests run headless automatically. The fixture uses `headless: false` + `--headless=new` arg (Chrome 112+ headless with extension/Service Worker support — `headless: true` breaks extension loading).

The test suite starts a Python HTTP server on port 9999 (`uv run python3 -m http.server 9999` from repo root). `reuseExistingServer: false` ensures Playwright owns the server lifecycle (avoids stale-process failures). Tests load the extension into an ephemeral Chromium profile (empty string passed to `launchPersistentContext`).

## Architecture

The extension has three runtime contexts communicating via `chrome.runtime.sendMessage`:

**`background.js` (Service Worker)**
- Proxies all Kimi API calls to avoid CORS issues from X.com
- `RateLimiter` class enforces concurrent request cap (3), RPM (20), TPM (500k), TPD (1.5M) — limits stored in `chrome.storage.local`
- **Two-tier cache**: L1 in-memory LRU Map (`memCacheMap`, 200 entries) + L2 `chrome.storage.local` under `dualang_cache_v1` (500 entries, LRU eviction of 20% when full). Cache hits on L1 are zero-IO.
- **Batch cache reads**: `getCacheBatch(hashes)` reads all L2 cache keys in a single `storage.get` call instead of N sequential reads
- **Settings memory cache**: `getSettings()` caches the result in `settingsCache`; `chrome.storage.onChanged` invalidates it so the Service Worker never does synchronous storage reads on the hot path
- `cacheKey(text, lang, model, baseUrl)` uses `normalizeText()` + djb2 hash so minor whitespace differences don't cause cache misses
- Batch translation sends up to 5 tweets per API call with `response_format: { type: 'json_object' }`, parsing `{"results":[{"index":N,"translated":"..."}]}`
- `LANG_DISPLAY` map translates language codes to Chinese names for system prompts (e.g., `zh-CN` → `简体中文`)
- `temperature` is `1` for `kimi-k2.5` models, `0.3` for others

**`content.js` (injected into x.com and localhost:9999)**
- `MutationObserver` detects dynamically loaded tweets (`article[data-testid="tweet"]`), Grok AI summary cards (detected by 4-div children + `<time>` + disclaimer text), X Articles (inside `article[data-testid="tweet"]` with `[data-testid="twitterArticleRichTextView"]` body), and "Show more" expansions
- `findTweetTextEl(container)` helper unifies three text container selectors: `[data-testid="tweetText"]` (tweets), `[data-dualang-text="true"]` (Grok body, marked by us), `[data-testid="twitterArticleRichTextView"]` (X Articles long-form body)
- `IntersectionObserver` (rootMargin `0px 0px 600px 0px`) pre-queues tweets before they enter the viewport
- **Translation modes**: if `autoTranslate=true`, tweets are queued automatically; if `false`, a `<button class="dualang-btn">译</button>` is injected for manual translation
- **Display modes** (`displayMode` setting, 4 values; replaces the old boolean `bilingualMode`):
  - `'append'` (default) — original tweetText stays, translation appended below
  - `'translation-only'` — original hidden via `article[data-dualang-mode]` CSS selector; only translation shown
  - `'inline'` (段落对照) — `splitParagraphsByDom(tweetTextEl)` clones each original paragraph's DOM (preserves `<a>` / `<img>` / `@mention`), rendered as `.dualang-inline > .dualang-inline-pair > [.dualang-original-html + .dualang-para]` below the hidden tweetText
  - `'bilingual'` (整体对照) — full original HTML clone + full translation as `.dualang-bilingual > [.dualang-original-html + .dualang-para...]`
  - Legacy migration: old `bilingualMode=true` (no `displayMode` set) → `'inline'`; otherwise `'append'`
  - `data-dualang-mode` is set per article at render time, so mode switching only affects newly-translated tweets — existing cards keep their original mode until page reload
- Queue uses `pendingQueue` (Array) + `pendingQueueSet` (Set) for O(1) deduplication
- `BATCH_SIZE=20` tweets dequeued per flush, split into `SUB_BATCH_SIZE=5` parallel API calls — first 5 results render immediately
- Retries failed sub-batches up to 2× with 2s delay (5s on 429/rate-limit)
- `isAlreadyTargetLanguage(text, lang)` checks CJK ratio (zh), kana ratio (ja), hangul ratio (ko), latin ratio (en) — skips translation if already in target language
- `shouldSkipContent(text)` skips URL-only tweets (stripped < 6 chars) and pure emoji/symbol tweets

**`popup.js` / `popup.html`**
- Settings: API endpoint, API key, model, reasoning effort, max tokens, target language (10 options), auto-translate toggle, `displayMode` (4 options: 译文下方 / 仅译文 / 段落对照 / 整体对照)
- All settings persisted via `chrome.storage.sync`

**`styles.css`** — injected into X.com pages; styles `.dualang-translation`, `.dualang-btn`, `.dualang-original-html`, `.dualang-inline-pair`, `.dualang-bilingual` and uses `article[data-dualang-mode]` attribute selectors to hide the original `[data-testid="tweetText"]` for non-`append` modes

## Test Structure

```
e2e/
  fixtures/x-mock.html       # Mock X.com page with 7 tweet types
  tests/
    fixtures.ts              # Playwright fixture: extension context, extensionId, popupPage
    translation.spec.ts      # Core translation, batch, paragraph splitting
    cache.spec.ts            # L1/L2 cache hit behavior
    target-lang.spec.ts      # Target language setting + API prompt content
    manual-and-bilingual.spec.ts  # autoTranslate=false button + 4 displayMode variants
    skip-and-extract.spec.ts      # Skip conditions (zh/url/emoji), extractText with links/imgs
```

The mock HTML tweets cover: English with `<a>` links, English with `<img alt>` emoji, English single-para, Simplified Chinese (should skip), Traditional Chinese (should skip), URL-only (should skip), Show more expandable.
