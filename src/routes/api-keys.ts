import { addRoute } from "../server";
import { getDb } from "../db/connection";
import { hashApiKey } from "../mcp/auth";
import { apiKeysPanel, type ApiKeyData } from "../html/pages/config.page";

export function listKeys(): ApiKeyData[] {
  return getDb()
    .prepare("SELECT id, name, created_at FROM api_keys ORDER BY created_at DESC")
    .all() as ApiKeyData[];
}

function panelHtml(): Response {
  return new Response(apiKeysPanel(listKeys()), {
    headers: { "Content-Type": "text/html" },
  });
}

export function registerApiKeyRoutes(): void {
  const db = getDb();

  addRoute("GET", "/api/api-keys", () => {
    return Response.json(listKeys());
  });

  addRoute("POST", "/api/api-keys", async (req) => {
    const contentType = req.headers.get("content-type") || "";
    let name: string | undefined;

    if (contentType.includes("application/json")) {
      const body = (await req.json()) as { name?: string };
      name = body.name?.trim();
    } else {
      const form = await req.formData();
      name = (form.get("name") as string | null)?.trim();
    }

    if (!name) {
      return Response.json({ error: "name is required" }, { status: 400 });
    }

    const id = crypto.randomUUID();
    const plainKey = `sk-${crypto.randomUUID().replace(/-/g, "")}`;
    const keyHash = hashApiKey(plainKey);

    db.prepare("INSERT INTO api_keys (id, name, key_hash) VALUES (?, ?, ?)")
      .run(id, name, keyHash);

    const isHtmx = req.headers.get("hx-request") === "true";
    if (isHtmx) {
      // The create form outerHTML-swaps #sk-api-keys-panel — re-render the
      // panel with the plaintext key revealed once.
      return new Response(apiKeysPanel(listKeys(), { name, key: plainKey }), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    return Response.json({ id, name, key: plainKey });
  });

  addRoute("DELETE", "/api/api-keys/:id", (req, params) => {
    const result = db.prepare("DELETE FROM api_keys WHERE id = ?").run(params.id);
    if (result.changes === 0) {
      return Response.json({ error: "not found" }, { status: 404 });
    }

    const isHtmx = req.headers.get("hx-request") === "true";
    if (isHtmx) return panelHtml();
    return Response.json({ deleted: true });
  });
}
