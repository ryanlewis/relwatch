// HTTP surface. Public read, mutations gated by the exe.dev proxy's auth headers
// (DESIGN §5.1). M4 fills in the dashboard and API routes; today it is /healthz.
import { PORT } from "../config.js";

const startedAt = Date.now();

export interface ServerDeps {
  /** Reported by /healthz so an uptime check can see the store is reachable. */
  releaseCount?: () => number;
}

export function startServer(deps: ServerDeps = {}): ReturnType<typeof Bun.serve> {
  const server = Bun.serve({
    port: PORT,
    // Never let one bad request take the process down; log and 500.
    error(err) {
      console.error("[web] unhandled:", err);
      return new Response("internal error\n", { status: 500 });
    },
    routes: {
      "/healthz": () => {
        let releases: number | null = null;
        try {
          releases = deps.releaseCount?.() ?? null;
        } catch (err) {
          // A broken store is worth reporting, not worth 500ing the health check
          // into — the distinction between "process up" and "store readable"
          // is exactly what an uptime check wants to see.
          console.error("[web] healthz: store unreadable:", err);
          return Response.json(
            { ok: false, error: "store unreadable" },
            { status: 503 },
          );
        }
        return Response.json({
          ok: true,
          uptime_s: Math.floor((Date.now() - startedAt) / 1000),
          ...(releases === null ? {} : { releases }),
        });
      },
    },
    fetch() {
      return new Response("not found\n", { status: 404 });
    },
  });

  console.log(`[web] listening on :${server.port}`);
  return server;
}
