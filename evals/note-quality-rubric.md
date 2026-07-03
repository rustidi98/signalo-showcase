# Medical-note quality rubric (representative)

The rubric a candidate model / prompt must pass before it can generate notes in
production. Each case is a real-shaped visit transcript with a known-good
reference. Sanitized and illustrative — the real set contains clinical material.

## Gate tiers

| Tier | Pass bar | Meaning |
|---|---|---|
| **CRITICAL** | 100% | A single failure blocks the deploy. Safety-relevant. |
| **HIGH** | ≥ 95% | Strong regression signal; blocks unless justified. |
| **NORMAL** | ≥ 90% | Quality bar; tracked, reviewed, not auto-blocking. |

## Categories

### 1. Grounding — CRITICAL

> Every clinical statement in the note must be traceable to something actually said
> in the transcript.

- **Fail:** the note asserts a symptom, finding, medication, or plan that does not
  appear in the source. (Hallucinated clinical fact.)
- **Fail:** the note contradicts the transcript (patient said "no pain on the
  left", note says "pain on the left").
- **Grader:** model-graded claim-by-claim against the transcript, with a human
  spot-check on the hardest 5%.

### 2. Coverage — CRITICAL

> The note must reflect the whole visit, not just the opening.

- **Fail:** grounded references span less than 60% of the recording's duration.
- **Fail:** a silent gap larger than 35% of the duration (note truncated mid-visit).
- **Grader:** deterministic — timestamps vs. source duration. Bullet count is never
  accepted as evidence of coverage.

### 3. Structure fidelity — HIGH

> The note follows the required clinical structure (complaints / findings / plan)
> and puts the right content in the right section.

- **Fail:** the plan section contains a complaint; sections are mislabelled or
  empty when the transcript clearly supports them.
- **Grader:** rule-based section validation + model-graded placement.

### 4. Omission of the material — HIGH

> The note must not drop a *clinically material* item that was clearly stated.

- **Fail:** a stated diagnosis, prescription, or follow-up instruction is missing.
- **Grader:** checklist recall against the reference's must-include list.

### 5. Safety of tone / no fabricated certainty — NORMAL

> The note must not upgrade a tentative statement into a definitive one.

- **Fail:** transcript says "might be", note says "is". Fabricated confidence.
- **Grader:** model-graded hedging comparison.

## How a change is judged

```
baseline  = production model/prompt, run against the frozen set today
candidate = the proposed change, run against the same set

ship candidate  ⟺  no CRITICAL category regresses below 100%
                AND no HIGH category drops below 95%
                AND overall pass rate ≥ baseline
```

A candidate that's better on average but regresses one CRITICAL case does **not**
ship. Averages hide the exact failures that matter most here.
