# src/contracts

Wire-level DTO types shared by every output surface: the `/data` JSON API,
server-rendered HTML, WS push, MCP task tools and skipper connect.

| file | use |
|---|---|
| `types.ts` | Task/agent/team/escalation/forensics/dashboard/realtime data shapes |

Rules:
- Every field JSON-serializable — no `Date`, no `Map`, no class instances.
  These types ARE the contract a remote/native client sees.
- `src/data` returns these shapes; `src/html` renders them; `src/routes/data`
  serializes them. Dependencies point here, never from here into `src/html`.
- `src/html/components.ts` and `src/html/realtime-components.ts` re-export the
  moved names for legacy importers — prefer importing from here in new code.
