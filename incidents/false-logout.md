# Postmortem: the "false logout" saga

> A user booted out of the app mid-session despite holding a perfectly valid
> session. It came back **eight times** over the product's life. It's the single
> most instructive bug I've shipped, because every recurrence taught the same
> lesson from a different angle: *diagnose from the data, not from a theory.*

**Impact.** A doctor or coordinator, mid-visit, suddenly staring at a login
screen. In a clinic that's not a minor annoyance — it interrupts a patient
encounter and erodes trust in the tool faster than almost any other failure.

**Severity.** High. Recurring. Owner-less until it became owned (see the fix).

---

## What it looked like

Every incident presented identically — "the app logged me out for no reason" — and
that sameness was the trap. It *looked* like one bug, so each time it was patched
as one bug. It was actually a whole **class** of bugs with different roots that all
surfaced as the same symptom. Chasing the symptom meant re-fixing it forever.

## The roots (yes, plural)

The eight recurrences traced to at least four genuinely different causes:

1. **A too-tight time window.** Refresh tokens rotate on every use. To tell a
   dropped-response retry from a stolen-token replay, the first version used a
   60-second grace window. On a flaky mobile network a stall longer than 60s is
   completely normal — so a *legitimate* retry past the window was mistaken for
   theft, and the session was revoked. → Replaced the time window with **device
   binding**: a spent token replayed from the same device is always a retry;
   only a different device triggers a revoke.

2. **A silent client-side read failure.** On cold start the client read its stored
   credentials inside a `try?` that swallowed the error. A transient keychain read
   failure looked identical to "no credentials" → the client logged itself out,
   with a valid token sitting right there. → A failed read must **throw**, not be
   treated as absent.

3. **Device-identity churn.** The client minted a fresh device identifier whenever
   a keychain read failed, and the server chain-revoked on an unrecognized device.
   So the client manufactured the very "different device" that triggered the
   logout. → A read failure must never mint a new identity.

4. **A refresh livelock.** Under one code path the client kept regressing to an
   older refresh token and re-presenting it; a grace mechanism that healed a
   single generation spun forever when the client was two generations behind. →
   A wall-clock bound on the multi-hop grace, plus a strike-count escalation to an
   honest re-login instead of an infinite loop.

## The one lesson

> **Diagnose auth bugs from the production token table BEFORE theorizing about the
> client.**

The breakthrough on the worst recurrence didn't come from reading code. It came
from querying the actual token rows for the affected user and *seeing* the chain:
which token was the head, which had rotated, which device ids were present, what
the timestamps said. The data made the root obvious in minutes after theories had
burned hours. Now that's the first step, not the last.

## What changed structurally

The deepest fix wasn't a code change — it was making the bug **owned**. This class
now has a dedicated review agent that must sign off on *any* change touching the
login / refresh / session / unlock path, on a presumption of guilt: the default
verdict is "needs fix" until every invariant is proven at a specific line. A bug
that recurs eight times isn't a coding failure, it's a *process* failure — there
was no standing owner to catch the ninth. Now there is.

The guiding principle, enforced in code:

> **Only end a session when it is positively dead. Never on a network hiccup, a
> transient read, or an ambiguous replay.** The cost of a wrong logout (an
> interrupted visit) far exceeds the cost of keeping a possibly-stale session
> alive one more refresh — and the real defence against a lost device is the
> biometric gate, not a twitchy server.

Sanitized implementation:
[`../sanitized-code/refresh-token-rotation.ts`](../sanitized-code/refresh-token-rotation.ts).
