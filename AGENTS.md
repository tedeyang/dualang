# Repository Guidelines

## Project Structure & Module Organization

Dualang is a Chrome Manifest V3 extension for X.com translation. Source TypeScript lives in `src/`: `background/` handles service-worker API, cache, stats, and provider profiles; `content/` injects and renders translations on X.com; `popup/` builds the extension popup; `shared/` holds message contracts and model metadata. Unit tests are colocated as `src/**/*.test.ts`. Playwright tests and fixtures live in `e2e/tests/` and `e2e/fixtures/`. Extension metadata and assets are at the root (`manifest.json`, `popup.html`, `styles.css`) and `icons/`. Built files `content.js`, `background.js`, and `popup.js` are generated outputs and should not be edited directly.

## Build, Test, and Development Commands

- `npm install`: install TypeScript, esbuild, Vitest, and Chrome types.
- `npm run build`: bundle production extension files from `src/`.
- `npm run build:dev`: build with inline sourcemaps.
- `npm run watch`: rebuild bundles while developing.
- `npm run typecheck`: run `tsc --noEmit`.
- `npm test`: run Vitest unit tests matching `src/**/*.test.ts`.
- `npm run test:watch`: run Vitest in watch mode.
- `cd e2e && npm install && npx playwright test`: run browser extension E2E tests.
- `cd e2e && npx playwright test --ui`: debug E2E tests in Playwright UI.

## Coding Style & Naming Conventions

Use TypeScript ESM with 2-space indentation, semicolons, and single quotes, matching nearby files. Prefer `camelCase` for variables/functions and `PascalCase` for exported types. Keep provider behavior in `src/background/profiles.ts` and shared contracts in `src/shared/types.ts` rather than duplicating request shapes. There is no configured formatter or linter, so preserve the local style of the file you edit.

## Testing Guidelines

Add or update Vitest tests beside changed source files using `*.test.ts`; use `@vitest-environment jsdom` for DOM behavior. For runtime flows, settings, caching, translation rendering, or extension loading, add Playwright coverage in `e2e/tests/*.spec.ts` and fixtures in `e2e/fixtures/`. Run `npm run typecheck` and `npm test` before handoff; run E2E tests for UI, content-script, or service-worker changes.

## Commit & Pull Request Guidelines

Recent history uses Conventional Commit style: `feat(...)`, `fix(...)`, `refactor(#2): ...`, `chore(scope): ...`, and `style(scope): ...`. Keep commits scoped and imperative. Pull requests should include a concise summary, linked issue or task, test commands run, and screenshots or screen recordings for visible extension UI changes.

## Security & Configuration Tips

Keep API keys in local `config.json`; use `config.example.json` for documentation. `config.json`, generated bundles, logs, sessions, and `node_modules/` are ignored. The pre-commit hook blocks staged real-looking `sk-...` keys, but still review staged diffs before committing.
