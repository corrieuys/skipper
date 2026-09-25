import { addRoute } from "../server";
import { getDb } from "../db/connection";
import { isExperimental } from "../config/feature-flags";
import { getSpeechEngine } from "../speech/engine-manager";
import { findSpeechModelFile } from "../speech/catalogue";
import { speechStatusResponse } from "../html/fragments/speech-config.fragment";
import { htmlResponse, parseRequestBody } from "./utils";

// Local speech model management for the config page's Real-time transcription
// panel (experimental): the status fragment (polled while a download or start
// runs), the download of whatever the selected model still needs, and delete of
// a downloaded model. Model and speaker-label choice post to /api/realtime/config
// like the other panel fields.

function notFound(): Response {
  return Response.json({ error: "Not found" }, { status: 404 });
}

function status(): Response {
  return htmlResponse(speechStatusResponse(getSpeechEngine().getStatus(getDb())));
}

export function registerSpeechRoutes(): void {
  addRoute("GET", "/api/config/speech/status", () => {
    if (!isExperimental()) return notFound();
    return status();
  });

  addRoute("POST", "/api/config/speech/download", () => {
    if (!isExperimental()) return notFound();
    const engine = getSpeechEngine();
    if (!engine.isDownloading()) {
      // Fire and forget: the status fragment polls progress. Binary, model and
      // (when speaker labels are on) the speaker model, each only when missing.
      void engine.installForConfig(getDb()).catch((err) => {
        console.error(`[speech] download failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    // Render after the download has registered so the fragment shows progress + polls.
    return new Promise<Response>((resolve) => setTimeout(() => resolve(status()), 50));
  });

  addRoute("POST", "/api/config/speech/delete", async (req) => {
    if (!isExperimental()) return notFound();
    const body = await parseRequestBody<{ model?: string }>(req);
    const model = findSpeechModelFile(body.model);
    if (!model) return Response.json({ error: "Unknown model" }, { status: 400 });
    try {
      const freed = getSpeechEngine().deleteModel(model);
      console.log(`[speech] deleted ${model.label} (${freed} bytes)`);
    } catch (err) {
      // Refusals (in use, still downloading) show in the status block.
      getSpeechEngine().noteError(err instanceof Error ? err.message : String(err));
    }
    return status();
  });
}
