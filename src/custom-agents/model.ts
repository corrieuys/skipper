import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { resolveHeaders, resolveSecret, type CustomAgent } from "./store";

/**
 * Definition → a language model the AI SDK can call.
 *
 * OpenAI-compatible chat completions is the one wire format, and it is the same
 * one served by the commercial APIs (OpenAI, xAI, Groq, OpenRouter, Together,
 * Azure) and by every common local runner (LM Studio, llama.cpp's `llama-server`,
 * Ollama, vLLM). The differences between them are all expressible as config:
 *
 * - **local servers** need no key at all — an empty `apiKey` sends no
 *   Authorization header, rather than sending an empty one that some servers 401
 * - **Azure** authenticates with an `api-key` header instead of a bearer token
 *   and requires `api-version` in the query string, which is what `queryParams`
 *   is for
 * - **OpenRouter and friends** want attribution headers, which are just headers
 *
 * `apiKey` and every header/query value go through `${ENV_VAR}` resolution here,
 * at call time — that is what lets an operator configure an agent through the UI
 * while keeping the real secret in the daemon's environment.
 */
export function buildModel(agent: CustomAgent): LanguageModel {
  return buildProvider(agent)(agent.modelId);
}

function buildProvider(agent: CustomAgent) {
  const queryParams = resolveHeaders(agent.queryParams);
  return createOpenAICompatible({
    name: agent.name || agent.id,
    baseURL: agent.baseUrl,
    // Undefined, not "": an empty string still sends `Authorization: Bearer `,
    // which llama.cpp and LM Studio can reject.
    apiKey: resolveSecret(agent.apiKey) || undefined,
    headers: resolveHeaders(agent.headers),
    ...(Object.keys(queryParams).length > 0 ? { queryParams } : {}),
  });
}

export interface ProbeResult {
  ok: boolean;
  /** Model ids the endpoint advertises, when it implements `GET /models`. */
  models: string[];
  message: string;
}

/**
 * Ask an endpoint what it can do, for the agent editor's Test button.
 *
 * `GET {baseUrl}/models` is the check because every OpenAI-compatible server
 * implements it, it costs no tokens, and its response doubles as the model
 * picker — which is what makes a local runner usable, since LM Studio and
 * llama.cpp model ids are long paths nobody wants to retype.
 *
 * A 404 on /models is not a failure. Some proxies only serve /chat/completions,
 * so it is reported as "reachable, no model list" rather than a broken config.
 */
export async function probeEndpoint(agent: CustomAgent, timeoutMs = 10_000): Promise<ProbeResult> {
  const url = new URL(`${agent.baseUrl.replace(/\/+$/, "")}/models`);
  for (const [key, value] of Object.entries(resolveHeaders(agent.queryParams))) {
    url.searchParams.set(key, value);
  }

  const headers: Record<string, string> = { ...resolveHeaders(agent.headers) };
  const key = resolveSecret(agent.apiKey);
  if (key) headers.Authorization = `Bearer ${key}`;

  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 404) {
      return { ok: true, models: [], message: "Reachable. This endpoint does not list models, so enter the model id yourself." };
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 300);
      return { ok: false, models: [], message: `${res.status} ${res.statusText}${body ? ` — ${body}` : ""}` };
    }

    const json = await res.json() as { data?: Array<{ id?: unknown }> };
    const models = Array.isArray(json.data)
      ? json.data.map((m) => String(m?.id ?? "")).filter(Boolean).sort()
      : [];
    return {
      ok: true,
      models,
      message: models.length > 0 ? `Reachable. ${models.length} model(s) available.` : "Reachable, but no models were listed.",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, models: [], message: `Could not reach ${agent.baseUrl}: ${message}` };
  }
}
