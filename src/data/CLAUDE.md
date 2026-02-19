# src/data

Read-only DB queries that feed HTML view-models.

| file | use |
|---|---|
| `queries.ts` | Big bag of typed query fns. Dashboard, forensics, token analytics, task/agent/team data shapes consumed by `html/components.ts` |

Keep mutations out — read-shape only.
