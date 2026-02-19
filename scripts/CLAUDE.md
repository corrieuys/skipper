# scripts

Dev helpers.

| file | use |
|---|---|
| `setup-whisper.sh` | Build `vendor/whisper.cpp` + fetch model. Required before `--start-whisper` |
| `test-preload.ts` | Bun preload for test runs |
| `test-with-cleanup.ts` | Test runner wrapper that nukes leftover DB files |
