// Entrypoint: open the store, start the HTTP server, wire the scheduled jobs.
//
// The service is long-lived under systemd (Restart=on-failure). Jobs run
// in-process (DESIGN §3); nothing here may throw its way out of a job and take
// the process with it.
import { DB_PATH, describeConfig } from "./config.js";
import { getStore } from "./db.js";
import { startServer } from "./web/server.js";

function main(): void {
  console.log(`[main] relwatch starting — ${describeConfig()}`);
  const store = getStore(DB_PATH);
  startServer(store);
  // M6 wires the poll and digest crons here.
}

main();

// A stray rejection must not kill the service — the next scheduled run retries.
process.on("unhandledRejection", (reason) => {
  console.error("[main] unhandledRejection:", reason);
});
