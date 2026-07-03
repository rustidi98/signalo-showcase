# Sanitized code

Representative extracts from the production codebase. Each file is **sanitized** —
client names, hosts, secrets, internal ticket numbers, and medical specifics are
removed — but the shape, the reasoning, and the trade-offs are exactly what runs.
They're chosen to show the parts a senior engineer would actually ask about, not
the boilerplate.

| File | The real problem it solves |
|---|---|
| [`stuck-recording-reaper.ts`](./stuck-recording-reaper.ts) | A recording must **never be silently lost.** How an always-on sweeper resolves anything stuck — race-safe across replicas, and immune to the "forever-fresh row" trap. |
| [`refresh-token-rotation.ts`](./refresh-token-rotation.ts) | **Never log a user out by mistake.** Telling a dropped-response retry apart from a stolen-token replay, using device binding instead of a fragile time window. |
| [`llm-note-coverage-guard.ts`](./llm-note-coverage-guard.ts) | A medical note must be **honest.** Rejecting an LLM summary that only covers the first few minutes of a long visit — bullet count is not proof of coverage. |

Full context for two of these lives in [`../incidents/`](../incidents) — the
postmortems that made them necessary.
