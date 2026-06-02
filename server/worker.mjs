import { closePool } from "./db.js";
import { assertWorkerRuntimeConfig } from "./config.js";
import { runWorkerOnce } from "./verification-worker.js";

const once = process.argv.includes("--once") || process.env.MFA_WORKER_ONCE === "true";
const pollMs = Number(process.env.MFA_WORKER_POLL_MS || 5_000);
let stopping = false;

assertWorkerRuntimeConfig();

process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});

async function main() {
  do {
    const result = await runWorkerOnce();
    console.log(JSON.stringify({ at: new Date().toISOString(), ...result }));
    if (once || stopping) break;
    if (!result.claimed) await sleep(pollMs);
  } while (!stopping);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
