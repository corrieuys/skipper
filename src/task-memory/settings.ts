import type { Database } from "bun:sqlite";
import { getStringSetting, setStringSetting } from "../config/app-settings";
import { DEFAULT_LOCAL_EMBEDDING_MODEL_ID, findLocalEmbeddingModel } from "./catalogue";

// Machine-scoped (runtime app_settings): which embeddings endpoint task memory
// uses. "local" is the llama-server Skipper downloads and runs itself; "custom"
// is any OpenAI-compatible /v1/embeddings endpoint (OpenAI, Ollama, LM Studio).
export const SETTING_TASK_MEMORY_ENDPOINT = "task_memory_embedding_endpoint";
export const SETTING_TASK_MEMORY_LOCAL_MODEL = "task_memory_local_model";
export const SETTING_TASK_MEMORY_CUSTOM_BASE_URL = "task_memory_custom_base_url";
export const SETTING_TASK_MEMORY_CUSTOM_API_KEY = "task_memory_custom_api_key";
export const SETTING_TASK_MEMORY_CUSTOM_MODEL = "task_memory_custom_model";

export type TaskMemoryEndpoint = "local" | "custom";

export interface TaskMemoryConfig {
  endpoint: TaskMemoryEndpoint;
  localModelId: string;
  customBaseUrl: string;
  /** Raw setting; may be a `${ENV_VAR}` reference. Resolved at call time. */
  customApiKey: string;
  customModel: string;
}

export function getTaskMemoryConfig(db: Database): TaskMemoryConfig {
  const endpointRaw = getStringSetting(db, SETTING_TASK_MEMORY_ENDPOINT, "local");
  const localRaw = getStringSetting(db, SETTING_TASK_MEMORY_LOCAL_MODEL, DEFAULT_LOCAL_EMBEDDING_MODEL_ID);
  return {
    endpoint: endpointRaw === "custom" ? "custom" : "local",
    localModelId: findLocalEmbeddingModel(localRaw) ? localRaw : DEFAULT_LOCAL_EMBEDDING_MODEL_ID,
    customBaseUrl: getStringSetting(db, SETTING_TASK_MEMORY_CUSTOM_BASE_URL, "").trim(),
    customApiKey: getStringSetting(db, SETTING_TASK_MEMORY_CUSTOM_API_KEY, ""),
    customModel: getStringSetting(db, SETTING_TASK_MEMORY_CUSTOM_MODEL, "").trim(),
  };
}

export interface SaveTaskMemoryConfigInput {
  endpoint?: string;
  localModelId?: string;
  customBaseUrl?: string;
  /** Omitted or empty keeps the stored key; the form never echoes it back. */
  customApiKey?: string;
  customModel?: string;
}

/** Returns an error message, or null when saved. */
export function saveTaskMemoryConfig(db: Database, input: SaveTaskMemoryConfigInput): string | null {
  if (input.endpoint !== undefined) {
    if (input.endpoint !== "local" && input.endpoint !== "custom") return "endpoint must be local or custom";
    setStringSetting(db, SETTING_TASK_MEMORY_ENDPOINT, input.endpoint);
  }
  if (input.localModelId !== undefined) {
    if (!findLocalEmbeddingModel(input.localModelId)) return `unknown local model: ${input.localModelId}`;
    setStringSetting(db, SETTING_TASK_MEMORY_LOCAL_MODEL, input.localModelId);
  }
  if (input.customBaseUrl !== undefined) {
    const url = input.customBaseUrl.trim();
    if (url && !/^https?:\/\//.test(url)) return "custom base URL must start with http:// or https://";
    setStringSetting(db, SETTING_TASK_MEMORY_CUSTOM_BASE_URL, url);
  }
  if (input.customApiKey !== undefined && input.customApiKey.trim()) {
    setStringSetting(db, SETTING_TASK_MEMORY_CUSTOM_API_KEY, input.customApiKey.trim());
  }
  if (input.customModel !== undefined) {
    setStringSetting(db, SETTING_TASK_MEMORY_CUSTOM_MODEL, input.customModel.trim());
  }
  return null;
}

/** `${ENV_VAR}` → process.env value; anything else is returned as written. */
export function resolveApiKeySetting(raw: string): string {
  const m = /^\$\{([A-Z0-9_]+)\}$/i.exec(raw.trim());
  if (m) return process.env[m[1]!] ?? "";
  return raw.trim();
}
