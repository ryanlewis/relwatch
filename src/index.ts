// Entrypoint: open the store, start the HTTP server, wire the scheduled jobs.
//
// The service is long-lived under systemd (Restart=on-failure). Jobs run
// in-process; nothing here may throw its way out of a job and take
// the process with it.
import { runCli } from "./cli.js";
import { BACKEND, DB_PATH, describeConfig } from "./config.js";
import { getStore, Store } from "./db.js";
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
  // A subcommand reads the store and exits; bare `relwatch` runs the service,
  // so the systemd unit is unaffected. This comes first because a read must not
  // announce itself as a service start, open the store for writing, or build an
  // LLM provider it will never call.
  const args = Bun.argv.slice(2);
  if (args.length > 0) {
    const { stdout, stderr, code } = runCli(args, () => new Store(DB_PATH, { readonly: true }));
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    process.exit(code);
  }

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
