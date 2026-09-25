import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import {
    LocalWhisperAdapter,
    OpenAIAdapter,
    createTranscriptionAdapter,
    formatSpeakerTranscript,
} from "./transcription";
import type { RealtimeConfig } from "./config";

function makeConfig(overrides: Partial<RealtimeConfig> = {}): RealtimeConfig {
    return {
        transcription_provider: "local",
        transcription_endpoint: "",
        openai_transcription_model: "gpt-4o-transcribe",
        summarization_model: "claude-sonnet-4-6",
        summary_max_tokens: 500,
        cadence_seconds: 60,
        overlap_seconds: 5,
        summary_enabled: true,
        local_model: "whisper-base.en",
        speaker_labels: false,
        ...overrides,
    };
}

describe("LocalWhisperAdapter", () => {
    it("isConfigured returns false when endpoint is empty", () => {
        const adapter = new LocalWhisperAdapter("");
        expect(adapter.isConfigured()).toBe(false);
    });

    it("isConfigured returns true when endpoint is set", () => {
        const adapter = new LocalWhisperAdapter("http://localhost:8080/inference");
        expect(adapter.isConfigured()).toBe(true);
    });

    it("notConfiguredReason explains whisper is not running", () => {
        const adapter = new LocalWhisperAdapter("");
        expect(adapter.notConfiguredReason()).toContain("Whisper not running");
    });
});

describe("OpenAIAdapter", () => {
    const originalEnv = process.env.OPENAI_API_KEY;

    afterEach(() => {
        if (originalEnv !== undefined) {
            process.env.OPENAI_API_KEY = originalEnv;
        } else {
            delete process.env.OPENAI_API_KEY;
        }
    });

    it("isConfigured returns false when OPENAI_API_KEY is not set", () => {
        delete process.env.OPENAI_API_KEY;
        const adapter = new OpenAIAdapter("gpt-4o-transcribe");
        expect(adapter.isConfigured()).toBe(false);
    });

    it("isConfigured returns true when OPENAI_API_KEY is set", () => {
        process.env.OPENAI_API_KEY = "sk-test-key";
        const adapter = new OpenAIAdapter("gpt-4o-transcribe");
        expect(adapter.isConfigured()).toBe(true);
    });

    it("notConfiguredReason mentions OPENAI_API_KEY", () => {
        delete process.env.OPENAI_API_KEY;
        const adapter = new OpenAIAdapter("gpt-4o-transcribe");
        expect(adapter.notConfiguredReason()).toContain("OPENAI_API_KEY");
    });

    it("transcribe sends correct request to OpenAI", async () => {
        process.env.OPENAI_API_KEY = "sk-test-key";
        const adapter = new OpenAIAdapter("gpt-4o-transcribe");

        const originalFetch = globalThis.fetch;
        let capturedUrl: string | URL | undefined;
        let capturedInit: RequestInit | undefined;

        globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
            capturedUrl = url as string | URL;
            capturedInit = init;
            return new Response(JSON.stringify({ text: "Hello world" }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        };

        try {
            const result = await adapter.transcribe(
                Buffer.from("fake-audio").toString("base64"),
                "webm",
            );

            expect(result).toBe("Hello world");
            expect(capturedUrl).toBe("https://api.openai.com/v1/audio/transcriptions");
            expect(capturedInit?.method).toBe("POST");
            expect((capturedInit?.headers as Record<string, string>)?.Authorization).toBe(
                "Bearer sk-test-key",
            );

            const formData = capturedInit?.body as FormData;
            expect(formData.get("model")).toBe("gpt-4o-transcribe");
            expect(formData.get("response_format")).toBe("json");
            expect(formData.get("file")).toBeInstanceOf(Blob);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it("transcribe throws on non-200 response", async () => {
        process.env.OPENAI_API_KEY = "sk-test-key";
        const adapter = new OpenAIAdapter("whisper-1");

        const originalFetch = globalThis.fetch;
        globalThis.fetch = async () => {
            return new Response("Unauthorized", { status: 401 });
        };

        try {
            await expect(
                adapter.transcribe(Buffer.from("fake-audio").toString("base64"), "webm"),
            ).rejects.toThrow("OpenAI transcription API returned 401");
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});

describe("createTranscriptionAdapter", () => {
    it("returns LocalWhisperAdapter for local provider", () => {
        const config = makeConfig({
            transcription_provider: "local",
            transcription_endpoint: "http://localhost:8080/inference",
        });
        const adapter = createTranscriptionAdapter(config);
        expect(adapter).toBeInstanceOf(LocalWhisperAdapter);
    });

    it("returns OpenAIAdapter for openai provider", () => {
        const config = makeConfig({ transcription_provider: "openai" });
        const adapter = createTranscriptionAdapter(config);
        expect(adapter).toBeInstanceOf(OpenAIAdapter);
    });

    it("defaults to LocalWhisperAdapter for unknown provider", () => {
        const config = makeConfig();
        // @ts-expect-error — testing fallback for unexpected value
        config.transcription_provider = "something-else";
        const adapter = createTranscriptionAdapter(config);
        expect(adapter).toBeInstanceOf(LocalWhisperAdapter);
    });
});

describe("formatSpeakerTranscript", () => {
    it("writes one line per speaker turn", () => {
        const text = formatSpeakerTranscript([
            { word: "Hello", speaker: 1 },
            { word: "there.", speaker: 1 },
            { word: "Hi,", speaker: 2 },
            { word: "how", speaker: 2 },
            { word: "are", speaker: 2 },
            { word: "you?", speaker: 2 },
            { word: "Fine.", speaker: 1 },
        ]);
        expect(text).toBe("Speaker 1: Hello there.\nSpeaker 2: Hi, how are you?\nSpeaker 1: Fine.");
    });

    it("joins words without a speaker to the current turn", () => {
        expect(formatSpeakerTranscript([
            { word: "One", speaker: 1 },
            { word: "two" },
            { word: "three", speaker: 2 },
        ])).toBe("Speaker 1: One two\nSpeaker 2: three");
    });

    it("returns empty text when no word carries a speaker", () => {
        expect(formatSpeakerTranscript([{ word: "plain" }, { word: "words" }])).toBe("");
        expect(formatSpeakerTranscript([])).toBe("");
    });
});

describe("createTranscriptionAdapter speaker labels", () => {
    const speakerOpt = (adapter: unknown) => (adapter as { opts: { speakerLabels?: boolean } }).opts.speakerLabels;

    it("turns speaker labels on only for a model that supports them", () => {
        expect(speakerOpt(createTranscriptionAdapter(makeConfig({ local_model: "nemotron-3.5", speaker_labels: true })))).toBe(true);
        expect(speakerOpt(createTranscriptionAdapter(makeConfig({ local_model: "whisper-base.en", speaker_labels: true })))).toBe(false);
        expect(speakerOpt(createTranscriptionAdapter(makeConfig({ local_model: "nemotron-3.5", speaker_labels: false })))).toBe(false);
    });

    it("lets the caller turn speaker labels off (dictation)", () => {
        const config = makeConfig({ local_model: "nemotron-3.5", speaker_labels: true });
        expect(speakerOpt(createTranscriptionAdapter(config, { speakerLabels: false }))).toBe(false);
    });
});

describe("LocalWhisperAdapter speaker labels", () => {
    // A real 0.2 s clip so the adapter's ffmpeg conversion runs for real.
    async function tinyWavBase64(): Promise<string> {
        const path = `/tmp/skipper-test-${crypto.randomUUID()}.wav`;
        const proc = Bun.spawn({ cmd: ["ffmpeg", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "0.2", "-y", path], stdout: "ignore", stderr: "ignore" });
        await proc.exited;
        const b64 = Buffer.from(await Bun.file(path).arrayBuffer()).toString("base64");
        try { (await import("fs")).unlinkSync(path); } catch { /* ignore */ }
        return b64;
    }
    const hasFfmpeg = Bun.which("ffmpeg") !== null;

    it.skipIf(!hasFfmpeg)("asks for verbose_json + diarization and renders speaker lines", async () => {
        const adapter = new LocalWhisperAdapter("http://127.0.0.1:1/v1/audio/transcriptions", { speakerLabels: true });
        const originalFetch = globalThis.fetch;
        let form: FormData | undefined;
        globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
            form = init?.body as FormData;
            return Response.json({ text: "hi there hello", words: [{ word: "hi", speaker: 1 }, { word: "there", speaker: 1 }, { word: "hello", speaker: 2 }] });
        }) as typeof fetch;
        try {
            const text = await adapter.transcribe(await tinyWavBase64(), "webm");
            expect(text).toBe("Speaker 1: hi there\nSpeaker 2: hello");
            expect(form?.get("response_format")).toBe("verbose_json");
            expect(form?.get("diarization")).toBe("true");
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it.skipIf(!hasFfmpeg)("falls back to the plain text when the words carry no speaker", async () => {
        const adapter = new LocalWhisperAdapter("http://127.0.0.1:1/v1/audio/transcriptions", { speakerLabels: true });
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async () => Response.json({ text: "just text", words: [{ word: "just" }, { word: "text" }] })) as typeof fetch;
        try {
            expect(await adapter.transcribe(await tinyWavBase64(), "webm")).toBe("just text");
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it.skipIf(!hasFfmpeg)("sends plain json without speaker labels", async () => {
        const adapter = new LocalWhisperAdapter("http://127.0.0.1:1/inference");
        const originalFetch = globalThis.fetch;
        let form: FormData | undefined;
        globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
            form = init?.body as FormData;
            return Response.json({ text: "plain" });
        }) as typeof fetch;
        try {
            expect(await adapter.transcribe(await tinyWavBase64(), "webm")).toBe("plain");
            expect(form?.get("response_format")).toBe("json");
            expect(form?.get("diarization")).toBeNull();
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});

describe("LocalWhisperAdapter wav input", () => {
    it.skipIf(Bun.which("ffmpeg") === null)("converts a wav chunk (the app recorders' format)", async () => {
        const path = `/tmp/skipper-test-${crypto.randomUUID()}.wav`;
        await Bun.spawn({ cmd: ["ffmpeg", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "0.2", "-y", path], stdout: "ignore", stderr: "ignore" }).exited;
        const b64 = Buffer.from(await Bun.file(path).arrayBuffer()).toString("base64");
        try { (await import("fs")).unlinkSync(path); } catch { /* ignore */ }
        const adapter = new LocalWhisperAdapter("http://127.0.0.1:1/inference");
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async () => Response.json({ text: "from wav" })) as typeof fetch;
        try {
            expect(await adapter.transcribe(b64, "wav")).toBe("from wav");
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});
