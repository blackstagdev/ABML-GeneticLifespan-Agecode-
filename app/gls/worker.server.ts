// In-process worker: every minute, processes queued/retrying order jobs.
// Runs inside the single Render web instance (started from entry.server.tsx).
import { processDueJobs, processJob } from "./processor.server";

const INTERVAL_MS = 60 * 1000;

declare global {
  // eslint-disable-next-line no-var
  var agecodeWorkerStarted: boolean | undefined;
  // eslint-disable-next-line no-var
  var agecodeWorkerRunning: boolean | undefined;
}

async function tick() {
  if (global.agecodeWorkerRunning) return;
  global.agecodeWorkerRunning = true;
  try {
    await processDueJobs();
  } catch (error) {
    console.error("AgeCode worker tick failed", error);
  } finally {
    global.agecodeWorkerRunning = false;
  }
}

export function startWorker() {
  if (global.agecodeWorkerStarted || process.env.DISABLE_WORKER === "true") return;
  global.agecodeWorkerStarted = true;
  setInterval(tick, INTERVAL_MS).unref();
  setTimeout(tick, 5000).unref();
  console.log("AgeCode worker started");
}

// Process a job right away (after the webhook response) instead of waiting for the next tick.
export function processSoon(jobId: string) {
  setTimeout(() => {
    processJob(jobId).catch((error) => console.error("AgeCode job failed", jobId, error));
  }, 0);
}
