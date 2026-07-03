# Postmortem: a GPU pipeline quietly burning money

> A new transcription workload started costing real money per day — not from a bug
> that broke anything, but from a cost profile nobody was watching. The product
> kept working perfectly the whole time. That's exactly why it's worth writing up:
> the most expensive failures often aren't outages, they're **healthy-looking spend.**

**Impact.** Meaningful, avoidable GPU cost per day on a bootstrapped product where
every dollar matters. No user-facing symptom — which is the point.

**Severity.** Medium. Financial, not availability. Caught by watching spend, not by
an alert on errors.

---

## What happened

A batch of transcription jobs was routed to an expensive top-tier GPU class. Three
factors multiplied:

1. **The wrong GPU tier for the job.** The workload was pinned to the most
   powerful (most expensive) cards, when a mid-tier card would transcribe this
   audio comfortably within latency budget.
2. **Volume.** Many jobs, each holding an expensive card for its full run.
3. **Retries.** A retry path re-ran jobs several times on failure, each retry
   paying full GPU price again.

Cost tier × volume × retry multiplier. None of the three alone would have been
noticed; together they showed up as a spend line climbing while every dashboard
stayed green.

## How it was found

Not by an alert — there was no error to alert on. By periodically checking the
**actual spend rate** against expectation. The provider exposes a current-spend
figure via its API; comparing that number to "what should this be costing?" is the
only thing that catches this class. A health check tells you the system is *up*. It
does not tell you the system is *affordable*.

## The fix

- **Right-size the tier.** Move the workload to cheaper GPU classes that meet the
  latency requirement. The most powerful card is rarely the cheapest way to hit a
  deadline.
- **Scale to zero.** Idle GPU workers were reconfigured to scale to zero when
  there's no work — the correct posture is "minimum workers = 0", not a warm
  standby pool sitting idle billing by the second.
- **Bound the retries.** Cap re-runs so a permanently-failing job can't loop
  forever paying full GPU price each time.

## The lessons

> **Cost is a first-class reliability property, and you have to watch it directly.**

- **Instrument spend like you instrument errors.** "Is it working?" and "is it
  affordable?" are different questions with different signals. Green health checks
  answered the first and said nothing about the second.
- **Default to the cheapest resource that meets the SLA**, then measure — not the
  most powerful one "to be safe". "To be safe" is how you overpay.
- **Every retry is a real cost, not a free safety net.** An unbounded retry on a
  metered resource is a slow-motion money leak.
- **Scale to zero beats warm standby for spiky, latency-tolerant work.** Paying for
  idle capacity is paying for nothing.

This is why cost tracking is wired through the whole AI pipeline now — every model
call is priced and attributed, GPU workers scale to zero, and anything a
deterministic rule can do doesn't get an expensive model call at all.
