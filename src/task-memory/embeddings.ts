import type { Database } from "bun:sqlite";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { embedMany } from "ai";
import { findLocalEmbeddingModel } from "./catalogue";
import type { EmbeddingServerManager } from "./local-server";
import { getTaskMemoryConfig, resolveApiKeySetting } from "./settings";

/**
 * One embeddings backend, resolved from the config page each time it is needed
 * (so a saved change applies without a restart). Both backends speak the
 * OpenAI-compatible `/v1/embeddings` wire format, so the AI SDK's
 * `createOpenAICompatible(...).embeddingModel` covers the managed llama-server
 * and any remote provider alike.
 *
 * `modelKey` names the vector space; rows embedded under another key are
 * re-embedded, never compared.
 */
export interface Embedder {
  modelKey: string;
  /** Documents longer than this are truncated before embedding (token window). */
  docMaxChars: number;
  /** Ensure the backend is reachable (starts the managed server when needed). */
  ready(): Promise<void>;
  embedDocuments(texts: string[]): Promise<Float32Array[]>;
  embedQuery(text: string): Promise<Float32Array>;
}

/** Why no embedder could be resolved, for tool results and the config page. */
export interface EmbedderUnavailable {
  reason: string;
}

const CUSTOM_DOC_MAX_CHARS = 6000;

function normalize(vec: number[]): Float32Array {
  const out = new Float32Array(vec.length);
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i]! * vec[i]!;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < vec.length; i++) out[i] = vec[i]! / norm;
  return out;
}

function makeClient(baseURL: string, apiKey: string | undefined, name: string) {
  return createOpenAICompatible({
    name,
    baseURL,
    // Undefined, not "": an empty string still sends a bearer header some local
    // servers reject.
    apiKey: apiKey || undefined,
  });
}

const TOO_LARGE = /too large|too many tokens|maximum context length|exceeds the context|context window|batch size/i;
const MIN_SHRINK_CHARS = 64;

/**
 * Embed a batch; when the endpoint rejects it, fall back to one value at a
 * time, and shrink any value the model reports as too long (chars per token
 * vary by content, so the catalogue's char cap is a guess, not a guarantee).
 */
async function embedResilient(
  call: (values: string[]) => Promise<number[][]>,
  values: string[],
): Promise<Float32Array[]> {
  if (values.length === 0) return [];
  try {
    return (await call(values)).map(normalize);
  } catch (batchErr) {
    if (values.length === 1 && !TOO_LARGE.test(String(batchErr))) throw batchErr;
  }
  const out: Float32Array[] = [];
  for (const value of values) {
    let text = value;
    for (let attempt = 0; ; attempt++) {
      try {
        out.push(normalize((await call([text]))[0]!));
        break;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!TOO_LARGE.test(message) || text.length <= MIN_SHRINK_CHARS || attempt >= 6) throw err;
        text = text.slice(0, Math.floor(text.length / 2));
      }
    }
  }
  return out;
}

async function embedWith(
  baseURL: string,
  apiKey: string | undefined,
  name: string,
  modelId: string,
  values: string[],
): Promise<Float32Array[]> {
  const model = makeClient(baseURL, apiKey, name).embeddingModel(modelId);
  // No SDK retries: a rejected batch is retried per value here, and transient
  // failures are retried by the manager's flush timer.
  return embedResilient(async (batch) => (await embedMany({ model, values: batch, maxRetries: 0 })).embeddings, values);
}

export function resolveEmbedder(
  db: Database,
  server: EmbeddingServerManager,
): Embedder | EmbedderUnavailable {
  const config = getTaskMemoryConfig(db);

  if (config.endpoint === "custom") {
    if (!config.customBaseUrl) return { reason: "No custom embeddings base URL is configured (Config > Task Memory)." };
    if (!config.customModel) return { reason: "No custom embeddings model id is configured (Config > Task Memory)." };
    const baseURL = config.customBaseUrl.replace(/\/+$/, "");
    const apiKey = resolveApiKeySetting(config.customApiKey);
    const modelKey = `custom:${baseURL}:${config.customModel}`;
    return {
      modelKey,
      docMaxChars: CUSTOM_DOC_MAX_CHARS,
      ready: async () => {},
      embedDocuments: (texts) => embedWith(baseURL, apiKey, "task-memory", config.customModel, texts.map((t) => t.slice(0, CUSTOM_DOC_MAX_CHARS))),
      embedQuery: async (text) => (await embedWith(baseURL, apiKey, "task-memory", config.customModel, [text]))[0]!,
    };
  }

  const model = findLocalEmbeddingModel(config.localModelId);
  if (!model) return { reason: `Unknown local embedding model: ${config.localModelId}` };
  if (!server.isBinaryInstalled()) return { reason: "The local embedding server is not downloaded yet (Config > Task Memory)." };
  if (!server.isModelInstalled(model.id)) return { reason: `The embedding model ${model.id} is not downloaded yet (Config > Task Memory).` };

  const ready = () => server.ensureRunning(model.id);
  return {
    modelKey: `local:${model.id}`,
    docMaxChars: model.docMaxChars,
    ready,
    embedDocuments: async (texts) => {
      await ready();
      return embedWith(server.getBaseUrl(), undefined, "llama-server", model.id, texts.map((t) => model.docPrefix + t.slice(0, model.docMaxChars)));
    },
    embedQuery: async (text) => {
      await ready();
      return (await embedWith(server.getBaseUrl(), undefined, "llama-server", model.id, [model.queryPrefix + text.slice(0, model.docMaxChars)]))[0]!;
    },
  };
}

export function isEmbedder(value: Embedder | EmbedderUnavailable): value is Embedder {
  return typeof (value as Embedder).embedDocuments === "function";
}
