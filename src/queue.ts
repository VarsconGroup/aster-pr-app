import { config } from "./config.js";
import { runReview, type ReviewJob } from "./review.js";

type PendingJob = Omit<ReviewJob, "key"> & { key: string };

/**
 * A tiny in-memory scheduler that:
 *  - debounces rapid pushes to the same PR (coalesce `synchronize` bursts),
 *  - caps how many aster runs execute at once,
 *  - never runs the same PR twice concurrently (a request that arrives while a
 *    review is in flight is queued to run once, after the current one finishes).
 *
 * This is intentionally simple. For multi-instance / durable delivery, swap this
 * module for a BullMQ (Redis) queue — the public API (enqueueReview) stays the same.
 */

const debounceTimers = new Map<string, NodeJS.Timeout>();
const pending: PendingJob[] = [];
const inFlight = new Set<string>();
const rerunRequested = new Set<string>();
let active = 0;

export function enqueueReview(job: Omit<ReviewJob, "key">): void {
  const key = `${job.owner}/${job.repo}#${job.prNumber}`;
  const withKey: PendingJob = { ...job, key };

  const existing = debounceTimers.get(key);
  if (existing) clearTimeout(existing);

  debounceTimers.set(
    key,
    setTimeout(() => {
      debounceTimers.delete(key);
      schedule(withKey);
    }, config.debounceMs),
  );
}

function schedule(job: PendingJob): void {
  if (inFlight.has(job.key)) {
    // A newer review for this PR arrived while one is running. Run once more
    // after the current run finishes, against the latest job payload.
    rerunRequested.add(job.key);
    latest.set(job.key, job);
    return;
  }
  pending.push(job);
  pump();
}

// Track the most recent payload per key so a queued rerun uses the latest sha.
const latest = new Map<string, PendingJob>();

function pump(): void {
  while (active < config.concurrency && pending.length > 0) {
    const job = pending.shift()!;
    void run(job);
  }
}

async function run(job: PendingJob): Promise<void> {
  active++;
  inFlight.add(job.key);
  try {
    await runReview(job);
  } catch {
    // runReview already logged; swallow so one bad PR can't take down the loop.
  } finally {
    active--;
    inFlight.delete(job.key);
    if (rerunRequested.delete(job.key)) {
      const next = latest.get(job.key) ?? job;
      latest.delete(job.key);
      pending.push(next);
    }
    pump();
  }
}
