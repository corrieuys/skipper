# tests

Playwright e2e suite. Unit tests live next to source as `*.test.ts` (run with `bun test`).

| dir | use |
|---|---|
| `e2e/` | Playwright specs against running server |

Config: `playwright.config.ts` in repo root. Run: `bun run test:e2e` (or via Playwright CLI). Tests assume server on default port — boot via own fixture or run `bun run index.ts` first.
