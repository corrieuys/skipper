# scripts

Dev helpers.

| file | use |
|---|---|
| `setup-whisper.sh` | Build `vendor/whisper.cpp` + fetch model. Required before `--start-whisper` |
| `test-preload.ts` | Bun preload for test runs |
| `test-with-cleanup.ts` | Test runner wrapper that nukes leftover DB files |
| `gen-assets.ts` | Generate `src/generated/embedded-assets.js` (+ `.d.ts`) — the manifest of files baked into the binary. Re-run on asset add/remove (`bun run gen:assets`) |
| `gen-lucide-icons.ts` | Generate `src/html/public/lucide-icons.json` (all Lucide icons' inner SVG + search keywords + a popular subset) from the `lucide-static` devDependency. Committed + embedded (server render + the icon picker read it). Re-run after bumping lucide-static: `bun run gen:icons` (also runs gen:assets) |
| `build-binary.ts` | Cross-compile standalone binaries into `dist/` via `bun build --compile` (`bun run build [targets…]`). Regenerates the manifest first |
| `release.ts` | Prepare a release (`bun run release`): build all targets + `dist/SHA256SUMS`, then print the manual `git tag`/`gh release create` recipe. Makes NO git/gh writes — publishing is manual |
