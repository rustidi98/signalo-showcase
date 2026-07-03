/**
 * LLM note coverage + grounding guard (sanitized extract)
 * -------------------------------------------------------
 * A medical note generated from a visit transcript is worthless — worse than
 * nothing — if it isn't honest. Two failure modes matter, and neither shows up as
 * an error; both look like a perfectly nice note:
 *
 *   1. HALLUCINATION. The model invents a tidy clinical detail that was never
 *      said, because inventing structure is what language models do.
 *   2. PARTIAL COVERAGE. The model summarizes the first few minutes of a
 *      forty-minute visit and stops. You get a fluent, plausible note about the
 *      opening small-talk and nothing about the actual diagnosis at minute 30.
 *
 * The trap: a note with lots of bullet points *looks* thorough. Bullet count is
 * not proof of coverage. The only real check is temporal — do the note's
 * references actually span the full duration of the source, or do they all cluster
 * at the start? This guard runs before any note is shown to a doctor. A note that
 * fails is regenerated or flagged, never silently shipped.
 *
 * Sanitized: representative of the real guard; thresholds illustrative.
 */

export interface NoteSegment {
  /** Where in the recording this point is grounded, in seconds. */
  timeSec: number;
  text: string;
}

export interface CoverageReport {
  ok: boolean;
  reasons: string[];
  coveredFraction: number; // 0..1 — how much of the timeline the note touches
}

const MIN_COVERED_FRACTION = 0.6; // the note must span at least 60% of the visit
const MAX_GAP_FRACTION = 0.35; // and never leave a silent hole bigger than 35%

/**
 * Assert that a generated note actually covers the source, instead of trusting
 * that "it produced N bullets, so it must be complete".
 */
export function assertCoverage(
  segments: NoteSegment[],
  durationSec: number,
): CoverageReport {
  const reasons: string[] = [];

  if (durationSec <= 0) {
    return { ok: false, reasons: ["source duration unknown"], coveredFraction: 0 };
  }
  if (segments.length === 0) {
    return { ok: false, reasons: ["note has no grounded segments"], coveredFraction: 0 };
  }

  const times = segments
    .map((s) => s.timeSec)
    .filter((t) => Number.isFinite(t) && t >= 0 && t <= durationSec)
    .sort((a, b) => a - b);

  // Span from the first to the last grounded reference, as a fraction of the whole.
  const span = (times[times.length - 1] - times[0]) / durationSec;
  const coveredFraction = Math.min(1, span);
  if (coveredFraction < MIN_COVERED_FRACTION) {
    reasons.push(
      `note spans only ${(coveredFraction * 100).toFixed(0)}% of the ` +
        `${Math.round(durationSec / 60)}-min visit (min ${MIN_COVERED_FRACTION * 100}%)`,
    );
  }

  // The clustering check: even a wide span can hide a huge silent gap in the
  // middle. Find the largest gap between consecutive references.
  let maxGapSec = times[0]; // gap from t=0 to the first reference counts too
  for (let i = 1; i < times.length; i++) {
    maxGapSec = Math.max(maxGapSec, times[i] - times[i - 1]);
  }
  maxGapSec = Math.max(maxGapSec, durationSec - times[times.length - 1]);
  const maxGapFraction = maxGapSec / durationSec;
  if (maxGapFraction > MAX_GAP_FRACTION) {
    reasons.push(
      `note leaves a ${(maxGapFraction * 100).toFixed(0)}% silent gap ` +
        `(max ${MAX_GAP_FRACTION * 100}%) — likely truncated mid-visit`,
    );
  }

  return { ok: reasons.length === 0, reasons, coveredFraction };
}
