// HTTP surface. Public read, mutations gated by the exe.dev proxy's auth
// headers; the route table lives in routes.ts.
import { BASE_PATH, PORT } from "../config.js";
import type { Store } from "../db.js";
import { handle } from "./routes.js";

export function startServer(store: Store): ReturnType<typeof Bun.serve> {
  const server = Bun.serve({
    port: PORT,
    // One bad request must never take the process down.
    error(err) {
      console.error("[web] unhandled:", err);
      return new Response("internal error\n", { status: 500 });
    },
    fetch: (req) => handle(req, { store }),
  });

  console.log(`[web] listening on :${server.port}${BASE_PATH || "/"}`);
  return server;
}
