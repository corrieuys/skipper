# src/conversations

Chat conversations with Skipper or other agents. Separate from task pipeline.

| file | use |
|---|---|
| `manager.ts` | Conversation CRUD. Send message. Spawn agent instance per convo. Permission mode (default/plan/bypassPermissions). Persist message parts |

Routes: `src/routes/conversations.ts`.
