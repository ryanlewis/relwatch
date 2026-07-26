// Admin auth via the exe.dev proxy (DESIGN §5.1).
//
// The proxy injects X-ExeDev-Email / X-ExeDev-UserID for authenticated users
// and strips any client-supplied X-ExeDev-* headers. That stripping is the
// entire basis for trusting them — the header is only trustworthy *behind* the
// proxy. Reached directly (a local run, a bypassed port) it is whatever the
// client says it is, which is why local dev fakes it deliberately rather than
// falling back to an implicit "allow".
//
// The deployment target adds a hop: Caddy sits between the proxy and this
// process, so Caddy must forward the header and must not accept a client's own.
import { ADMIN_EMAILS, BASE_PATH } from "../config.js";

export const EMAIL_HEADER = "x-exedev-email";
export const USER_ID_HEADER = "x-exedev-userid";

export interface Identity {
  email: string | null;
  userId: string | null;
  isAdmin: boolean;
}

export function identify(req: Request): Identity {
  const email = req.headers.get(EMAIL_HEADER)?.trim().toLowerCase() || null;
  const userId = req.headers.get(USER_ID_HEADER)?.trim() || null;
  return {
    email,
    userId,
    isAdmin: email !== null && ADMIN_EMAILS.includes(email),
  };
}

/**
 * Where to send an anonymous visitor who reached for an admin affordance.
 * The login route is served by the proxy, not by this process.
 */
export function loginUrl(req: Request): string {
  const path = new URL(req.url).pathname;
  return `/__exe.dev/login?redirect=${encodeURIComponent(path)}`;
}

/**
 * Gate a mutation. Returns a Response to send when the caller isn't an admin,
 * or null when they are.
 *
 * Anonymous callers get a redirect to login; a signed-in non-admin gets a plain
 * 403, because bouncing them to login would loop them straight back here.
 */
export function requireAdmin(req: Request): Response | null {
  const identity = identify(req);
  if (identity.isAdmin) return null;

  if (identity.email === null) {
    return new Response(null, { status: 302, headers: { location: loginUrl(req) } });
  }
  return new Response("forbidden\n", { status: 403 });
}

/** Absolute path within this app, honouring the sub-path it is mounted at. */
export function url(path = "/"): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${BASE_PATH}${suffix === "/" ? "/" : suffix}`;
}
