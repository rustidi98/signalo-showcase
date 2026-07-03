# Architecture

A tour of how Signalo is put together, at the level a senior engineer would want
before an interview. Every diagram renders on GitHub (Mermaid). The product's own
source stays private — this describes the shape and the reasoning, not the secrets.

---

## System, end to end

```mermaid
flowchart TD
    subgraph clients["Clients"]
        iOS["iOS app (Swift / SwiftUI)"]
        AND["Android app (Kotlin / Compose)"]
        WEB["Web portal (Next.js / React)"]
    end

    API["Backend API (NestJS)"]

    subgraph data["State"]
        PG[("PostgreSQL")]
        RD[("Redis / queues")]
        OBJ[("Object storage — audio")]
    end

    subgraph workers["Background workers"]
        POLL["Transcription orchestrator"]
        GPU["GPU speech-to-text (rented, scale-to-zero)"]
        AI["LLM pipeline — note · coaching · card"]
    end

    subgraph external["The clinic's existing systems"]
        MIS["Practice-management system"]
        CRM["CRM"]
        MCP["Read-only analytics connector (for AI assistants)"]
    end

    iOS & AND & WEB -->|"chunked, resumable upload"| API
    API --> PG & RD & OBJ
    API -->|"enqueue"| POLL
    POLL --> GPU
    GPU -->|"transcript + speaker turns"| AI
    AI -->|"structured note, coaching"| API
    AI -->|"auto-note"| CRM
    MIS -->|"schedule + patients (on-prem agent)"| API
    API --> MCP
```

Every arrow is a place something can fail — a dropped upload, a worker killed
mid-job, a model inventing a detail. Most of the engineering is about making each
step **reliable and honest**, not about the happy path.

---

## The recording lifecycle — a state machine

The single most important invariant: **a recording is never silently lost.** It
either reaches the doctor as a finished note or as an honest failure — never an
eternal spinner. That is enforced by a state machine plus an always-on reaper that
resolves anything stuck (see [`../sanitized-code/stuck-recording-reaper.ts`](../sanitized-code/stuck-recording-reaper.ts)).

```mermaid
stateDiagram-v2
    [*] --> Created
    Created --> Uploading: chunks arrive
    Uploading --> Uploaded: all chunks in
    Uploading --> UploadIncomplete: /complete but chunks missing
    UploadIncomplete --> Uploaded: reaper — partial finalize (30m quiet)
    UploadIncomplete --> Failed: reaper — 0 chunks, audio never arrived (2h)
    Uploaded --> Processing: claimed (FOR UPDATE SKIP LOCKED)
    Processing --> Done: transcript persisted
    Processing --> Failed: reaper — stuck > 10m
    Processing --> Uploaded: reaper — ghost job re-enqueued (capped)
    Done --> [*]
    Failed --> [*]
```

Why a reaper and not just retries: a process killed by a rolling deploy between
"claim" and "poll terminal status" leaves a row `Processing` forever. Nothing
in the request path will ever touch it again. A separate, always-on sweeper is the
only thing that can. It measures age by a **durable marker stamped once at claim**,
not by `updatedAt` — because a poll-tick that keeps bumping `updatedAt` would keep a
genuinely-stuck row looking "fresh" forever. That distinction is the whole bug class.

---

## Auth — and the discipline of never logging a user out by mistake

"False logout" (a user booted mid-visit despite a valid session) was the most
expensive recurring bug in the product's history — it came back eight times. The
fix was a principle enforced in code: **only end a session when it is positively
dead, never on a network hiccup.**

```mermaid
sequenceDiagram
    participant App as Mobile app
    participant API as Backend
    participant DB as Token store (hashed)

    App->>API: POST /auth/refresh (opaque token + device id)
    API->>DB: look up sha256(token)
    alt token is the current head
        API->>DB: rotate — issue new, re-stamp expiry
        API-->>App: new access + refresh
    else token already rotated (a replay)
        alt same device (or legacy no-device)
            note over API: lost response on a flaky link —<br/>a retry, not theft
            API-->>App: re-issue (never log out)
        else different device
            note over API: genuine replay → revoke the chain
            API-->>App: 401 (only truly-dead case)
        end
    end
```

The refresh token is stored only as a `sha256` hash, rotates on every use, and its
expiry is re-stamped on each refresh — so an active daily user's session is
effectively perpetual, and the only real defence against a lost device is the
Face ID / passcode gate, not a short token TTL. Sanitized implementation:
[`../sanitized-code/refresh-token-rotation.ts`](../sanitized-code/refresh-token-rotation.ts).

---

## The AI pipeline — honest by construction

```mermaid
flowchart LR
    A["Audio (chunks)"] --> B["GPU transcription"]
    B --> C["Speaker separation"]
    C --> D["LLM speaker-label cleanup<br/>(measured before it's trusted)"]
    D --> E["Structured medical note"]
    E --> F{"Coverage + grounding<br/>guard"}
    F -->|"passes"| G["Note reaches the doctor"]
    F -->|"fails"| H["Regenerate / flag —<br/>never ship a hollow note"]
```

The hard part of a medical note isn't generating text — it's keeping it *honest*.
A language model, left alone, will happily invent a tidy clinical detail that was
never said, or summarize the first three minutes of a forty-minute visit and call
it done. Two guards run before any note is shown: a **grounding** check (does the
note reflect what was actually said?) and a **coverage** check (does the output
span the full duration of the source, not just the opening?). See
[`../sanitized-code/llm-note-coverage-guard.ts`](../sanitized-code/llm-note-coverage-guard.ts)
and [`../evals/`](../evals) for how model changes are measured before they ship.

---

## Deployment topology

```mermaid
flowchart TD
    subgraph edge["Edge"]
        CDN["CDN / DNS / WAF"]
    end
    subgraph app["Application"]
        APIH["API host (managed PaaS)"]
        WEBH["Web host (VPS)"]
    end
    subgraph stateful["Stateful"]
        PGH[("Managed PostgreSQL")]
        R2[("Object storage — audio at rest")]
    end
    subgraph gpu["Elastic GPU"]
        POD["Rented GPU workers — scale to zero when idle"]
    end
    CDN --> APIH & WEBH
    APIH --> PGH & R2
    APIH -->|"submit / poll jobs"| POD
```

One deploy command ships the API, the web portal, and the edge config, then runs
health checks against all of them — a deploy isn't "done" until every surface
reports healthy. GPU workers are rented and **scale to zero** when there's no work,
so idle GPUs don't burn money (a mis-tuned setup once cost real money per day — see
[`../incidents/gpu-cost-blowup.md`](../incidents/gpu-cost-blowup.md)).

---

*These diagrams are sanitized and representative — the shapes and trade-offs are
real; client names, hosts, and secrets are removed.*
