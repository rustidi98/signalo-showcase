# If you're reviewing this repo — start here

You're probably a hiring engineer with fifteen minutes. This is the fast path:
what to look at, what to ask me, and the trade-offs I actually made. The product's
source is private (it holds patient data), so this repo is the architecture, the
reasoning, and sanitized extracts of the real code.

## What this is, in one line

A production clinical-workflow product — iOS, Android, web, backend, and GPU
transcription workers — that records a doctor–patient visit and turns it into a
grounded, structured clinical note. Led end to end with a solo, AI-assisted
delivery model and running in a real, paying clinic every day.

## Five files worth two minutes each

1. [`architecture/README.md`](./architecture/README.md) — the whole system as
   diagrams: the recording state machine, the auth flow, the AI pipeline.
2. [`sanitized-code/stuck-recording-reaper.ts`](./sanitized-code/stuck-recording-reaper.ts)
   — race-safe recovery of stuck jobs; the "measure age by a durable marker, not
   `updatedAt`" insight.
3. [`sanitized-code/refresh-token-rotation.ts`](./sanitized-code/refresh-token-rotation.ts)
   — device-bound refresh rotation; how you tell a dropped-response retry from a
   token replay.
4. [`incidents/false-logout.md`](./incidents/false-logout.md) — the bug that
   recurred eight times and what it taught about diagnosing from data, not theory.
5. [`evals/note-quality-rubric.md`](./evals/note-quality-rubric.md) — how a model
   change is stopped from silently degrading a clinical note.

## Five things to ask me about

- **Speaker identity across visits.** Diarization gives you "speaker A / B" in one
  recording. Knowing *who* they are, and keeping it stable across visits, is a
  different problem — voice fingerprints, an LLM cleanup pass, and *measuring* that
  pass before trusting it.
- **Keeping an LLM note honest.** Grounding + coverage guards, and why bullet count
  is not proof of completeness.
- **The false-logout class.** Why it recurred eight times, and why the real fix was
  making the bug *owned* by a mandatory reviewer, not just patched again.
- **Cost as a reliability property.** GPU scale-to-zero, per-call LLM pricing, and
  the incident where a healthy-looking pipeline quietly burned money.
- **A solo, AI-assisted delivery model.** The engineering system that makes
  it possible — see the companion repo,
  [ai-engineering-showcase](https://github.com/rustidi98/ai-engineering-showcase).

## Five real trade-offs I made (and would defend)

1. **Run a self-hosted GPU speech model instead of a managed STT API.** More ops
   burden; in exchange, control over cost, Russian-language quality, and the data
   path. For a bootstrapped clinical product that was the right call.
2. **Device-bound refresh rotation with explicit revocation.** The auth flow must
   distinguish a dropped-response retry from token replay and must not turn a
   transient read or network failure into a destructive logout.
3. **An always-on reaper instead of only in-request retries.** A process killed
   mid-job can't retry itself. Something outside the request path has to resolve
   stuck work — so the invariant "a recording is never silently lost" has an owner.
4. **Guards that can *reject* an AI note.** The pipeline is allowed to say "this
   note is too thin, regenerate" rather than shipping whatever the model produced.
   Slower, occasionally; safer than presenting an ungrounded note as fact.
5. **Deterministic first, model second.** Anything a regex can do reliably doesn't
   get an expensive, non-deterministic model call. Cheaper and more predictable.

## What I'd want you to take away

Not "can prompt a model" — everyone can now. The signal here is: **building a real
product on unreliable parts (flaky networks, dying workers, hallucinating models)
and making the whole thing reliable and reviewable — in production, for real
users, in a clinical setting.**

— Rustem Idiiatullin · rust.idi98@gmail.com
