/**
 * The model classifies; the code scores (sanitized extract)
 * ---------------------------------------------------------
 * A recurring mistake in LLM products: ask the model to output a *score*. "Rate
 * this consultation 1–10." It will happily give you an 8. Run it again and it's a
 * 6. Swap the model and every historical number shifts. Now a manager is making
 * staffing decisions on a figure that isn't reproducible and can't be audited.
 *
 * The split that fixes it: let the model do only the fuzzy judgment it's actually
 * good at — "did *this specific thing* happen in the conversation?" — as a discrete
 * label per rubric step (done / missed / n-a). Everything numeric after that —
 * the weighted score, the traffic-light level, whether to escalate — is plain,
 * deterministic code. No model in the arithmetic.
 *
 * Why it matters:
 *   • Reproducible. Same labels → same score, every time. A manager can trust it.
 *   • Auditable. The score is explainable down to which weighted step failed —
 *     not "the model felt like a 6."
 *   • Stable across model swaps. Upgrading the classifier can't silently re-scale
 *     six months of history, because the scale lives in code, not in the prompt.
 *   • Robust to a cheap, noisy model. The classifier can be small and fast; the
 *     normalization below fails soft on missing or duplicate labels.
 *
 * Sanitized: a generic consult-quality rubric; weights, labels and thresholds are
 * illustrative. The real one runs per visit in production.
 */

/** The only thing the model produces per step. Not a number — a label. */
export type StepStatus = "done" | "missed" | "n/a";

export interface StepDef {
  id: string;
  /** Weights sum to 10 across the rubric. An implementation detail — the manager
   *  sees the *result*, never the coefficient table. */
  weight: number;
  label: string;
}

export interface StepResult {
  id: string;
  status: StepStatus;
}

export type Level = "green" | "yellow" | "red";

export interface RoleScore {
  score: number; // 1..10, computed — never emitted by the model
  level: Level;
  /** The single heaviest missed step, so the score is explainable at a glance. */
  topMiss: string | null;
}

/** A fixed rubric with a fixed order. A typo in an id here is a compile error when
 *  StepDef['id'] is a string-literal union from your shared types. */
const RUBRIC: readonly StepDef[] = [
  { id: "rapport", weight: 1, label: "built rapport" },
  { id: "needs_uncovered", weight: 2, label: "uncovered the real need" },
  { id: "value_before_price", weight: 2, label: "led with value before price" },
  { id: "price_stated", weight: 1, label: "stated the price plainly" },
  { id: "objection_handled", weight: 2, label: "handled the objection" },
  { id: "next_step_secured", weight: 2, label: "secured a concrete next step" },
];

/**
 * Normalize the model's output to EXACTLY the rubric's steps, in order.
 * Fail-soft: a missing id becomes "n/a"; extra or duplicate ids are dropped. This
 * is what makes the score stable when a cheap model returns partial or noisy JSON.
 */
function normalize(raw: StepResult[]): StepResult[] {
  const byId = new Map<string, StepStatus>();
  for (const r of raw) {
    if (!byId.has(r.id) && isStatus(r.status)) byId.set(r.id, r.status);
  }
  return RUBRIC.map((def) => ({ id: def.id, status: byId.get(def.id) ?? "n/a" }));
}

function isStatus(s: unknown): s is StepStatus {
  return s === "done" || s === "missed" || s === "n/a";
}

/**
 * The scoring. Pure arithmetic on the labels — no LLM, no side effects.
 *
 *   score = round( 10 * (weight of done steps) / (weight of applicable steps) )
 *
 * "n/a" steps leave the denominator, so a rep isn't punished for a step that
 * genuinely didn't apply to this conversation.
 */
export function scoreRole(raw: StepResult[]): RoleScore {
  const steps = normalize(raw);
  const weightOf = (id: string) => RUBRIC.find((d) => d.id === id)?.weight ?? 0;

  let doneWeight = 0;
  let applicableWeight = 0;
  for (const s of steps) {
    if (s.status === "n/a") continue; // excluded from the denominator
    const w = weightOf(s.id);
    applicableWeight += w;
    if (s.status === "done") doneWeight += w;
  }

  // Every step n/a → no basis to score. Say so; don't emit a fake number.
  if (applicableWeight === 0) {
    return { score: 0, level: "red", topMiss: null };
  }

  const score = clamp1to10(Math.round((10 * doneWeight) / applicableWeight));

  // Heaviest missed step — the one worth coaching first.
  const topMiss =
    steps
      .filter((s) => s.status === "missed")
      .sort((a, b) => weightOf(b.id) - weightOf(a.id))[0]?.id ?? null;

  return { score, level: levelFor(score), topMiss };
}

function levelFor(score: number): Level {
  if (score >= 8) return "green";
  if (score >= 5) return "yellow";
  return "red";
}

function clamp1to10(n: number): number {
  return Math.max(1, Math.min(10, n));
}

/**
 * Escalation is a code decision too, not a model one. Raise a flag when the
 * outcome wasn't reached OR any role scored red — never because the model "felt"
 * something was wrong. The model may supply a human-readable *reason*; it does not
 * get a vote on *whether* to escalate.
 */
export function shouldEscalate(scores: RoleScore[], outcomeReached: boolean): boolean {
  const anyRed = scores.some((s) => s.level === "red");
  return !outcomeReached || anyRed;
}
