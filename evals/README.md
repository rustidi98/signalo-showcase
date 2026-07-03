# Evals — how a model change can't silently make things worse

The scariest thing about building on language models is that a change — a new model
version, a reworded prompt, a cheaper provider — can degrade quality **invisibly**.
Nothing throws. The note still generates. It's just quietly worse, and you find out
from a clinic, weeks later, not from your pipeline.

The answer is an eval harness: a fixed set of graded cases that every candidate
model / prompt has to pass before it ships. It turns "the summaries feel fine" into
a number you can gate a deploy on.

## The shape of it

```
For each candidate (model, prompt) pair:
  run it against the frozen eval set
  grade each case (rule-based where possible, model-graded where not, human for the hard 5%)
  compare pass rate to the current production baseline
  BLOCK the change if any CRITICAL category regresses
```

Two kinds of eval, and you need both:

- **Capability evals** — can it do the thing at all? (Does it produce a valid,
  grounded note for this visit?)
- **Regression evals** — did a change break something that used to work? These are
  the ones that catch a silent downgrade.

## The rubric

A representative grading rubric for the medical-note task lives in
[`note-quality-rubric.md`](./note-quality-rubric.md). The important design choices:

- **Tiered gates.** Categories are graded CRITICAL / HIGH / normal. A CRITICAL
  failure (a hallucinated clinical fact, a coverage gap) **blocks the deploy**
  outright — 100% required. HIGH needs 95%+. This mirrors how a patient-safety bar
  actually works: some failures can't be averaged away.
- **Grounding is pass/fail, not a vibe.** "Did the note state something the
  transcript never said" is a binary, checkable claim, and it's the one that
  matters most.
- **Coverage is measured against duration, not bullet count.** A note that only
  covers the first five minutes of a forty-minute visit fails, no matter how many
  tidy bullets it has. (See
  [`../sanitized-code/llm-note-coverage-guard.ts`](../sanitized-code/llm-note-coverage-guard.ts).)

## Why this matters more in healthcare

In most products a slightly-worse summary is a minor UX regression. In a clinical
note it's a safety issue — a missed complaint, an invented finding. So the eval bar
isn't "better on average"; it's "no CRITICAL regression, ever." That's a different
engineering posture, and it has to be enforced by a gate, not by good intentions.
