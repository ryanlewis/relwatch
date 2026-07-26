// Entrypoint: open the store, start the HTTP server, wire the scheduled jobs.
//
// The service is long-lived under systemd (Restart=on-failure). Jobs run
// in-process (DESIGN §3); nothing here may throw its way out of a job and take
// the process with it.
import { BACKEND, DB_PATH, describeConfig } from "./config.js";
import { getStore } from "./db.js";
import { startScheduler } from "./scheduler.js";
import { AiSdkProvider } from "./triage/aisdk.js";
import type { Provider } from "./triage/index.js";
import { StubProvider } from "./triage/stub.js";
import { startServer } from "./web/server.js";

function buildProvider(): Provider {
  // RW_BACKEND=stub runs the whole service on a laptop, off the internal DNS
  // the real backends need.
  if (process.env["RW_BACKEND"] === "stub") {
    console.warn("[main] using the offline triage stub — no LLM calls will be made");
    return new StubProvider();
  }
  return new AiSdkProvider(BACKEND);
}

function main(): void {
  console.log(`[main] relwatch starting — ${describeConfig()}`);

  const store = getStore(DB_PATH);
  const provider = buildProvider();

  startServer(store);
  const scheduler = startScheduler({ store, provider });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      console.log(`[main] ${signal} — stopping`);
      scheduler.stop();
      process.exit(0);
    });
  }
}

main();

// A stray rejection must not kill the service — the next scheduled run retries.
process.on("unhandledRejection", (reason) => {
  console.error("[main] unhandledRejection:", reason);
});
