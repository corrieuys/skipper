/**
 * Curated local speech-to-text models the managed speech engine can run.
 *
 * Two engines serve them (see `engine-manager.ts`):
 *  - `whisper`: whisper.cpp `whisper-server` (`POST /inference`), ggml `.bin` models.
 *  - `nemo`: NVIDIA NeMo-Speech.cpp `nemo-speech serve`
 *    (`POST /v1/audio/transcriptions`, OpenAI-compatible subset), GGUF models.
 *
 * Every file is pinned to a Hugging Face revision and verified by size and
 * SHA-256 after download. `speakers` marks models the NeMo engine can combine
 * with the Sortformer diarizer (`SPEAKER_MODEL`) to tag words with speakers.
 */

export type SpeechEngineId = "whisper" | "nemo";

export interface SpeechModelFile {
  id: string;
  label: string;
  file: string;
  url: string;
  bytes: number;
  sha256: string;
  license: string;
}

export interface SpeechModel extends SpeechModelFile {
  engine: SpeechEngineId;
  languages: string;
  /** Can label speakers (NeMo engine + Sortformer diarizer). */
  speakers: boolean;
  /**
   * Cache-aware streaming model: a recording runs through one NeMo realtime
   * session (`speech/stream-transcriber.ts`) instead of one request per chunk.
   * Parakeet TDT / CTC are offline-only and stay on the per-chunk path.
   */
  streaming: boolean;
}

export const DEFAULT_SPEECH_MODEL_ID = "whisper-base.en";

const WHISPER_REV = "5359861c739e955e79d9a303bcbc70fb988958b1";
const whisperUrl = (file: string) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_REV}/${file}`;
const hfUrl = (repo: string, rev: string, file: string) => `https://huggingface.co/${repo}/resolve/${rev}/${file}`;

export const SPEECH_MODELS: SpeechModel[] = [
  {
    id: "whisper-base.en",
    label: "Whisper base.en",
    engine: "whisper",
    file: "ggml-base.en.bin",
    url: whisperUrl("ggml-base.en.bin"),
    bytes: 147_964_211,
    sha256: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
    license: "MIT",
    languages: "English",
    speakers: false,
    streaming: false,
  },
  {
    id: "whisper-small.en",
    label: "Whisper small.en",
    engine: "whisper",
    file: "ggml-small.en.bin",
    url: whisperUrl("ggml-small.en.bin"),
    bytes: 487_614_201,
    sha256: "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d",
    license: "MIT",
    languages: "English",
    speakers: false,
    streaming: false,
  },
  {
    id: "whisper-medium.en",
    label: "Whisper medium.en",
    engine: "whisper",
    file: "ggml-medium.en.bin",
    url: whisperUrl("ggml-medium.en.bin"),
    bytes: 1_533_774_781,
    sha256: "cc37e93478338ec7700281a7ac30a10128929eb8f427dda2e865faa8f6da4356",
    license: "MIT",
    languages: "English",
    speakers: false,
    streaming: false,
  },
  {
    id: "whisper-large-v3-turbo-q5_0",
    label: "Whisper large-v3-turbo (q5_0)",
    engine: "whisper",
    file: "ggml-large-v3-turbo-q5_0.bin",
    url: whisperUrl("ggml-large-v3-turbo-q5_0.bin"),
    bytes: 574_041_195,
    sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
    license: "MIT",
    languages: "Multilingual (99 languages)",
    speakers: false,
    streaming: false,
  },
  {
    id: "whisper-large-v3-turbo",
    label: "Whisper large-v3-turbo",
    engine: "whisper",
    file: "ggml-large-v3-turbo.bin",
    url: whisperUrl("ggml-large-v3-turbo.bin"),
    bytes: 1_624_555_275,
    sha256: "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
    license: "MIT",
    languages: "Multilingual (99 languages)",
    speakers: false,
    streaming: false,
  },
  {
    id: "nemotron-3.5",
    label: "NVIDIA Nemotron 3.5 ASR 0.6B",
    engine: "nemo",
    file: "nemotron-3.5-asr-streaming-0.6b.q8_0.gguf",
    url: hfUrl("nvidia/nemotron-3.5-asr-streaming-0.6b", "1c8deaecc64b91f034d73e08dd8b64625eb3395d", "nemotron-3.5-asr-streaming-0.6b.q8_0.gguf"),
    bytes: 741_548_352,
    sha256: "a5c435f294eea8f88ce68dd27b8c3bfea7f777cb2fbba04fcd30eaa555f429ae",
    license: "NVIDIA Open Model License (OpenMDW 1.1)",
    languages: "40 language-locales",
    speakers: true,
    streaming: true,
  },
  {
    id: "nemotron-en",
    label: "NVIDIA Nemotron Speech EN 0.6B",
    engine: "nemo",
    file: "nemotron-speech-streaming-en-0.6b.q8_0.gguf",
    url: hfUrl("nvidia/nemotron-speech-streaming-en-0.6b", "ebe59e5a817142986528bbbee5dba8db7b38ed50", "nemotron-speech-streaming-en-0.6b.q8_0.gguf"),
    bytes: 699_872_960,
    sha256: "d9a01898d2a611c8764e23a1c2f45e70bbd5a425dc4de93692ac951dd603812d",
    license: "NVIDIA Open Model License",
    languages: "English",
    speakers: true,
    streaming: true,
  },
  {
    id: "parakeet-tdt-v3",
    label: "NVIDIA Parakeet TDT 0.6B v3",
    engine: "nemo",
    file: "parakeet-tdt-0.6b-v3.q8_0.gguf",
    url: hfUrl("nvidia/parakeet-tdt-0.6b-v3", "541d1f99c6b0c3cd0b11a95167540bb8edefd82b", "parakeet-tdt-0.6b-v3.q8_0.gguf"),
    bytes: 713_975_456,
    sha256: "e3880d0aaaaf2c308ea2c35016b2b895c423eb3fda924c1b463d1c19b7f4d32e",
    license: "CC-BY-4.0",
    languages: "25 European languages",
    speakers: false,
    streaming: false,
  },
  {
    id: "parakeet-ctc-1.1b",
    label: "NVIDIA Parakeet CTC 1.1B",
    engine: "nemo",
    file: "parakeet-ctc-1.1b.q8_0.gguf",
    url: hfUrl("nvidia/parakeet-ctc-1.1b", "20e63a0fed6aedba145b74b826dbd41df0941730", "parakeet-ctc-1.1b.q8_0.gguf"),
    bytes: 1_178_100_960,
    sha256: "6584fc0fdacf1c220401ea4c3a1d5b44454b655c141cb8672178072c203d92b8",
    license: "CC-BY-4.0",
    languages: "English",
    speakers: false,
    streaming: false,
  },
];

/** Sortformer 4-speaker diarizer, loaded next to a `speakers` NeMo model when speaker labels are on. */
export const SPEAKER_MODEL: SpeechModelFile = {
  id: "sortformer-4spk-v2",
  label: "Sortformer 4-speaker v2 (speaker labels)",
  file: "diar_streaming_sortformer_4spk-v2.q8_0.gguf",
  url: hfUrl("nvidia/diar_streaming_sortformer_4spk-v2", "5240a64075176943f677d30fa2171c780229f341", "diar_streaming_sortformer_4spk-v2.q8_0.gguf"),
  bytes: 147_075_776,
  sha256: "0679cfeb1ce356d0dea9470b31274f4bfc7eb927497d82005483770666da998a",
  license: "CC-BY-4.0",
};

export function findSpeechModel(id: string | null | undefined): SpeechModel | null {
  if (!id) return null;
  return SPEECH_MODELS.find((m) => m.id === id) ?? null;
}

/** The configured model, or the default when the stored id is unknown. */
export function resolveSpeechModel(id: string | null | undefined): SpeechModel {
  return findSpeechModel(id) ?? findSpeechModel(DEFAULT_SPEECH_MODEL_ID)!;
}

/** A catalogue model or the speaker model, by id (for delete). */
export function findSpeechModelFile(id: string | null | undefined): SpeechModelFile | null {
  if (id === SPEAKER_MODEL.id) return SPEAKER_MODEL;
  return findSpeechModel(id);
}
