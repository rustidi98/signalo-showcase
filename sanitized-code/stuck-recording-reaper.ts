/**
 * Stuck-recording reaper (sanitized extract)
 * ------------------------------------------
 * A recording is uploaded in chunks, claimed by a worker, transcribed on a rented
 * GPU, then persisted. The worker marks the row PROCESSING, submits the GPU job,
 * and polls for the terminal result. If that process is killed between "submit"
 * and "observe terminal status" — a rolling deploy, an OOM, a crash — the row sits
 * PROCESSING forever. Nothing in the request path will ever touch it again, and
 * the doctor sees an eternal "preparing note…" spinner. That is a *silent
 * failure*: the most dangerous kind, because it looks like nothing is wrong.
 *
 * A separate, always-on sweeper is the only thing that can resolve it. Two ideas
 * in this extract are the ones worth pointing at:
 *
 *   1. RACE-SAFE across replicas. Every state transition is a conditional
 *      `updateMany` guarded on the *current* status (a compare-and-set). Two
 *      reaper instances — or the reaper and the worker's own poll tick — can act
 *      on the same row in the same instant; only one write lands (count === 1),
 *      the loser no-ops. No locks, no leader election needed.
 *
 *   2. AGE BY A DURABLE MARKER, NOT `updatedAt`. The naive reaper matches rows
 *      "PROCESSING and updatedAt older than N minutes". But a poll tick that keeps
 *      writing to the row keeps bumping `updatedAt`, so a genuinely-stuck row stays
 *      "fresh" forever and is never reaped — the exact bug the first version had.
 *      The fix: measure age from a marker stamped ONCE when the job is claimed and
 *      never touched again. A row the `updatedAt` path structurally cannot see is
 *      picked up here, its GPU job is resolved, and it's acted on by *actual* job
 *      state — not a guess.
 *
 * Sanitized: names, hosts, and ticket numbers removed; the logic is unchanged.
 */

import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "./prisma.service";
import { GpuJobClient } from "./gpu-job-client";

@Injectable()
export class StuckRecordingReaper {
  private readonly log = new Logger(StuckRecordingReaper.name);

  /** Reap a PROCESSING row this much past its last update. Wide enough that a
   *  slow-but-healthy long recording is never reaped by mistake. */
  private static readonly STUCK_MS = 10 * 60 * 1000;
  /** The "forever-fresh" horizon: measured from the durable claim marker. */
  private static readonly GHOST_MS = 30 * 60 * 1000;
  /** If this many GPU status calls fail in one sweep, the provider is likely
   *  down — abort rather than mass-fail healthy jobs, and alert once. */
  private static readonly BREAKER = 3;

  constructor(
    private readonly db: PrismaService,
    private readonly gpu: GpuJobClient,
  ) {}

  /** One sweep. Runs on a short interval from an always-on timer. */
  async sweep(): Promise<{ reaped: number }> {
    let reaped = 0;
    reaped += await this.reapByUpdatedAt();
    reaped += await this.reapGhosts();
    return { reaped };
  }

  /** The simple case: PROCESSING and quiet for longer than the happy path. */
  private async reapByUpdatedAt(): Promise<number> {
    const cutoff = new Date(Date.now() - StuckRecordingReaper.STUCK_MS);
    const candidates = await this.db.recording.findMany({
      where: { status: "PROCESSING", updatedAt: { lt: cutoff } },
      select: { id: true },
      take: 100, // cap one sweep; chronic cases get caught on later ticks
    });

    let reaped = 0;
    for (const { id } of candidates) {
      // Compare-and-set: only the reaper that still sees PROCESSING wins.
      const res = await this.db.recording.updateMany({
        where: { id, status: "PROCESSING", updatedAt: { lt: cutoff } },
        data: { status: "FAILED" },
      });
      if (res.count === 1) {
        reaped++;
        await this.reconcileVisit(id); // never strand the visit in "processing"
        this.log.warn(`reaped stuck recording ${id} (PROCESSING > 10m)`);
      }
      // count === 0 → lost the race to another reaper or the worker's poll. No-op.
    }
    return reaped;
  }

  /**
   * The subtle case: rows the `updatedAt` path structurally can't see because a
   * poll tick keeps bumping `updatedAt`. Select instead by the DURABLE marker
   * stamped once at claim, then resolve each against real GPU state.
   */
  private async reapGhosts(): Promise<number> {
    const cutoff = new Date(Date.now() - StuckRecordingReaper.GHOST_MS);
    const ghosts = await this.db.recording.findMany({
      where: { status: "PROCESSING", claimedAt: { lt: cutoff } },
      select: { id: true, gpuJobId: true },
      take: 20, // each candidate is one outbound HTTP call — keep the fan-out small
    });

    let reaped = 0;
    let transientErrors = 0;
    for (const rec of ghosts) {
      if (transientErrors >= StuckRecordingReaper.BREAKER) {
        this.log.error("GPU provider looks degraded — aborting ghost sweep");
        break; // circuit breaker: a provider blip must not mass-fail live jobs
      }
      if (!rec.gpuJobId) {
        // Submit never landed a job id and re-issuing risks a duplicate run →
        // terminal FAILED, never a blind retry.
        if (await this.fail(rec.id, "no job id")) reaped++;
        continue;
      }

      const state = await this.gpu.resolve(rec.gpuJobId);
      switch (state.kind) {
        case "transient": // provider hiccup — skip, don't touch the row
          transientErrors++;
          break;
        case "in_progress": // genuinely still running — leave it alone
          break;
        case "completed": // result exists but persist is stuck — alert, never reap
          await this.alertCompletedButStuck(rec.id);
          break;
        case "gone": // job is dead, audio intact → re-enqueue for a fresh run
        case "failed":
          await this.reEnqueue(rec.id); // (capped elsewhere so it can't loop)
          break;
      }
    }
    return reaped;
  }

  /** FAILED via compare-and-set, then reconcile the linked visit. */
  private async fail(id: string, reason: string): Promise<boolean> {
    const res = await this.db.recording.updateMany({
      where: { id, status: "PROCESSING" },
      data: { status: "FAILED" },
    });
    if (res.count !== 1) return false;
    await this.reconcileVisit(id);
    this.log.error(`terminal FAILED recording ${id}: ${reason}`);
    return true;
  }

  /** A FAILED recording must never leave its visit stuck "processing" — that's
   *  the eternal spinner from the doctor's side. Idempotent, guarded. */
  private async reconcileVisit(recordingId: string): Promise<void> {
    await this.db.visit.updateMany({
      where: { recordingId, status: { in: ["pending", "recording", "processing"] } },
      data: { status: "failed" },
    });
  }

  private async reEnqueue(id: string): Promise<void> {
    await this.db.recording.updateMany({
      where: { id, status: "PROCESSING" },
      data: { status: "UPLOADED" }, // a claimer picks it up for a fresh GPU run
    });
  }

  private async alertCompletedButStuck(id: string): Promise<void> {
    // Result exists on the GPU side but persistence keeps throwing. Reaping would
    // lose the transcript; re-enqueue would waste a GPU run. Neither is safe →
    // surface it to a human (throttled), and let persistence keep retrying.
    this.log.error(`recording ${id}: GPU completed but persist stuck — needs a human`);
  }
}
