import { addRoute } from "../server";
import { ConversationManager } from "../conversations/manager";
import { parseRequestBody } from "./utils";
import { assetTextSync } from "../assets";

function loadConversationalSkipperPrompt(): string {
  try {
    return assetTextSync("prompts/conversational-skipper.md").trim();
  } catch {
    return "You are a conversational Skipper assistant for the Skipper multi-agent orchestration system. Help the user manage tasks and agents.";
  }
}

export function registerConversationRoutes(conversationManager: ConversationManager): void {
  // GET /api/conversations — list conversations
  addRoute("GET", "/api/conversations", (req) => {
    const url = new URL(req.url);
    const statusParam = url.searchParams.get("status");
    const status =
      statusParam === "active" || statusParam === "archived" ? statusParam : undefined;
    const conversations = conversationManager.getConversations(status);
    return Response.json({ conversations });
  });

  // POST /api/conversations — create new conversation
  addRoute("POST", "/api/conversations", async (req) => {
    try {
      const body = await parseRequestBody<{ title?: string }>(req);
      const systemPrompt = loadConversationalSkipperPrompt();
      const conversation = await conversationManager.createConversation(
        systemPrompt,
        body.title,
      );
      return Response.json({ conversation }, { status: 201 });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });

  // GET /api/conversations/:id — get conversation with messages
  addRoute("GET", "/api/conversations/:id", (_req, params) => {
    const conversation = conversationManager.getConversation(params.id);
    if (!conversation) {
      return Response.json({ error: "Conversation not found" }, { status: 404 });
    }
    const messages = conversationManager.getMessages(params.id);
    return Response.json({ conversation, messages });
  });

  // DELETE /api/conversations/:id — archive conversation
  addRoute("DELETE", "/api/conversations/:id", async (_req, params) => {
    const conversation = conversationManager.getConversation(params.id);
    if (!conversation) {
      return Response.json({ error: "Conversation not found" }, { status: 404 });
    }
    try {
      await conversationManager.archiveConversation(params.id);
      return Response.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 500 });
    }
  });

  // POST /api/conversations/:id/messages — send user message
  addRoute("POST", "/api/conversations/:id/messages", async (req, params) => {
    const body = await parseRequestBody<{ content?: string }>(req);
    if (!body.content || !body.content.trim()) {
      return Response.json({ error: "content is required" }, { status: 400 });
    }
    try {
      const message = await conversationManager.sendMessage(params.id, body.content.trim());
      return Response.json({ message }, { status: 201 });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });

  // GET /api/conversations/:id/messages — get message history
  addRoute("GET", "/api/conversations/:id/messages", (req, params) => {
    const conversation = conversationManager.getConversation(params.id);
    if (!conversation) {
      return Response.json({ error: "Conversation not found" }, { status: 404 });
    }
    const url = new URL(req.url);
    const afterId = url.searchParams.get("after") ?? undefined;
    const messages = conversationManager.getMessages(params.id, afterId);
    return Response.json({ messages });
  });

  // POST /api/conversations/:id/permission-mode — switch Claude --permission-mode
  addRoute("POST", "/api/conversations/:id/permission-mode", async (req, params) => {
    const body = await parseRequestBody<{ mode?: string }>(req);
    const mode = body.mode;
    if (mode !== "default" && mode !== "plan" && mode !== "bypassPermissions") {
      return Response.json({ error: "mode must be one of: default, plan, bypassPermissions" }, { status: 400 });
    }
    try {
      const conversation = await conversationManager.setPermissionMode(params.id, mode);
      return Response.json({ conversation });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 400 });
    }
  });

  // POST /api/conversations/:id/rename — rename conversation
  addRoute("POST", "/api/conversations/:id/rename", async (req, params) => {
    const body = await parseRequestBody<{ title?: string }>(req);
    if (!body.title || !body.title.trim()) {
      return Response.json({ error: "title is required" }, { status: 400 });
    }
    try {
      const conversation = conversationManager.renameConversation(params.id, body.title);
      return Response.json({ conversation });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return Response.json({ error: message }, { status: 404 });
    }
  });
}
