# Line Fusion + Smart Dictionary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add non-mutually-exclusive `lineFusionEnabled` and `smartDictEnabled` enhancements on top of existing display modes, with English-only dictionary annotation.

**Architecture:** Keep `displayMode` unchanged as the primary rendering mode, then layer two optional enhancements. `lineFusionEnabled` is a content-side rendering branch for multiline originals. `smartDictEnabled` is a separate background request (`annotateDictionary`) triggered after translation success and rendered as annotation spans on source text.

**Tech Stack:** TypeScript, Chrome Extension MV3, Vitest (unit/jsdom), Playwright (existing e2e harness).

---

### Task 1: Settings + UI Plumbing

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/popup/index.ts`
- Modify: `popup.html`
- Modify: `src/content/index.ts`
- Modify: `src/background/settings.ts`
- Test: `e2e/tests/manual-and-bilingual.spec.ts` (or new spec if needed)

- [ ] **Step 1: Add failing tests for new settings defaults and persistence**
Run:
```bash
npm test src/content/super-fine-bubble.test.ts
```
Expected: tests fail after adding assertions for new panel controls/settings defaults.

- [ ] **Step 2: Add new settings keys and defaults**
Implement:
```ts
lineFusionEnabled?: boolean;
smartDictEnabled?: boolean;
```
and default `false` in popup/content/background settings reads.

- [ ] **Step 3: Add popup controls and storage write**
Add two checkboxes in `popup.html`, wire read/write in `src/popup/index.ts` (`chrome.storage.sync.get/set`).

- [ ] **Step 4: Sync content runtime state**
In `src/content/index.ts`, add runtime flags and `chrome.storage.onChanged` handling; trigger re-render when either flag changes.

- [ ] **Step 5: Run tests**
Run:
```bash
npm test src/content/super-fine-bubble.test.ts
```
Expected: PASS.

### Task 2: Line Fusion Rendering

**Files:**
- Modify: `src/content/render.ts`
- Modify: `src/content/utils.ts`
- Modify: `styles.css`
- Test: `src/content/utils.test.ts`
- Test: `e2e/tests/manual-and-bilingual.spec.ts`

- [ ] **Step 1: Write failing tests for line split/alignment helpers**
Add helper tests in `src/content/utils.test.ts` for:
1. multiline original + multiline translation alignment,
2. mismatch fallback signal.

- [ ] **Step 2: Implement helper utilities**
Add minimal utilities (e.g. `splitIntoLines`, `alignTranslatedLines`) that return fallback when confidence is low.

- [ ] **Step 3: Add line-fusion render branch**
Update `renderTranslation(...)` to accept enhancement options and render:
```html
<div class="dualang-line-fusion-pair">
  <div class="dualang-line-fusion-orig"></div>
  <div class="dualang-line-fusion-divider"></div>
  <div class="dualang-line-fusion-trans"></div>
</div>
```
only when `lineFusionEnabled` and original has >=2 lines in `append|bilingual`.

- [ ] **Step 4: Add CSS styles**
Add line-fusion class styles and divider presentation; preserve existing mode behavior when fusion not active.

- [ ] **Step 5: Run tests**
Run:
```bash
npm test src/content/utils.test.ts
```
Expected: PASS.

### Task 3: Smart Dictionary Message Path

**Files:**
- Modify: `src/background/index.ts`
- Modify: `src/background/api.ts`
- Modify: `src/content/index.ts`
- Create: `src/content/smart-dict.ts`
- Test: `src/background/api.test.ts`
- Test: `src/content/utils.test.ts` (or new `smart-dict.test.ts`)

- [ ] **Step 1: Write failing tests for candidate extraction and dictionary parsing**
Add tests for English-only candidate extraction and malformed JSON fallback.

- [ ] **Step 2: Implement content-side candidate extraction**
Create `src/content/smart-dict.ts` with:
1. `isLikelyEnglishText(text)`,
2. `extractDictionaryCandidates(text)`,
3. minimal stopword filtering and token sanitization.

- [ ] **Step 3: Implement background `annotateDictionary` action**
In `src/background/index.ts` route new message action to `doAnnotateDictionary(...)`.
In `src/background/api.ts` implement request using existing provider settings and strict JSON response parsing.

- [ ] **Step 4: Trigger dictionary call after successful render**
In `src/content/index.ts`, after translation render success, conditionally call `chrome.runtime.sendMessage({ action: 'annotateDictionary', ... })` when:
1. `smartDictEnabled=true`,
2. display mode is not `translation-only`,
3. source text is English.

- [ ] **Step 5: Annotate DOM non-destructively**
Use safe text-node wrapping with `.dualang-dict-term` and `data-dict`, avoiding links/hashtags/mentions.

- [ ] **Step 6: Run tests**
Run:
```bash
npm test src/background/api.test.ts
npm test src/content/utils.test.ts
```
Expected: PASS.

### Task 4: Regression + E2E Verification

**Files:**
- Modify: `e2e/tests/manual-and-bilingual.spec.ts` (or add new `e2e/tests/line-fusion-and-dict.spec.ts`)

- [ ] **Step 1: Add e2e scenarios**
Cover:
1. line fusion appears for multiline source in `append`,
2. no fusion for single-line source,
3. dictionary annotation appears for English source when enabled,
4. dictionary is skipped in `translation-only`,
5. dictionary API failure does not break translation.

- [ ] **Step 2: Run local verification**
Run:
```bash
npm run typecheck
npm test
cd e2e && npx playwright test tests/manual-and-bilingual.spec.ts
```
Expected: all pass.

- [ ] **Step 3: Commit in logical chunks**
1. `feat(settings): add line fusion and smart dictionary toggles`
2. `feat(content): add line fusion rendering`
3. `feat(dict): add smart dictionary request and annotation`
4. `test(e2e): cover fusion and dictionary flows`
