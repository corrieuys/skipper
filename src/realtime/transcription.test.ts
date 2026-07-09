import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import {
    LocalWhisperAdapter,
    OpenAIAdapter,
    createTranscriptionAdapter,
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
