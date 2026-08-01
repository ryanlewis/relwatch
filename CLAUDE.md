# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

A release tracker for a curated roster of upstream projects: poll, LLM-triage
each release once at ingest, and serve two surfaces off one SQLite store — a
dashboard and a daily email digest. It replaced an RSS reader that had been
pressed into service as release infrastructure, and the failure it exists to
prevent is the one that produced: a backlog nobody reads. `README.md` is the
user-facing contract; treat it as normative for config names, routes and the
digest's delivery behaviour, and update it alongside changes.

## Commands

```sh
bun install
bun run check                 # lint → typecheck → test. This is the gate.
bun run lint                  # oxlint --type-aware
bun run typecheck             # tsc --noEmit
bun test
bun run build                 # bun build --compile → ./relwatch

RW_BACKEND=stub bun run start # whole service, no LLM gateway needed
```

Single file, single test:

```sh
bun test src/db.test.ts
bun test --test-name-pattern "dismiss"
```

Coverage thresholds are enforced in `bunfig.toml` (90% line, 90% function), so
erosion fails `bun test` rather than eroding quietly. `src/test-env.ts` is
preloaded by the suite; it exists because `src/config.ts` reads `process.env`
once at import, and `RW_ADMIN_EMAILS` deliberately has no usable default.

## Hard rules

- **Nothing deletes a release.** Dismissal hides, soft-delete deactivates an
  app, and the store is the archive the dashboard exists to browse. Removing a
  roster entry hard would cascade away the history that is the point.
- **Everything rendered is untrusted.** Release titles, notes, feed contents
  and the LLM output derived from them all originate upstream. The `html` tag
  in `src/web/html.ts` escapes every interpolation; raw insertion goes through
  `raw()` so it greps. `href`s go through `safeUrl`.
- **No silent truncation, anywhere.** If the digest drops releases it says how
  many, in both parts, and leaves them unemailed for next time. This project
  exists because things were quietly not arriving.
- **No build step for the web surface.** Server-rendered HTML, plain form
  POSTs, one inline dependency-free script as an enhancement over forms that
  already work without it.
- **The dashboard is sub-path aware.** Every link, form action and redirect
  goes through `url()`; a hardcoded path breaks a prefixed deployment silently,
  with forms POSTing to a 404 that reads as a permissions problem.

## Architecture

```
config ←──────────── everything (env parsing; read once at import)
   ↑
  db  ←── poll ──→ source        store is the hand-off between all of them
   ↑       ↓
   │    triage
   │
  web    digest
   ↑       ↑
   └── scheduler ──┘        index.ts wires store + server + cron together
   │
  cli                       index.ts dispatches on argv before any of that
```

`src/db.ts` is the seam: `poll`, `triage`, `web` and `digest` all meet through
the `Store`, and none of them import each other.

### One view, four renderings

`web/views.ts` owns both what a view *contains* — `buildInboxView`,
`buildAppView`, `buildRosterView`, and the row caps they read under — and its
HTML. `web/formats.ts` renders the same objects as JSON and markdown. The
routes and `cli.ts` build a view and pick a renderer; neither queries the store
for a view itself.

That indirection is the point. The alternative had `relwatch inbox` and the
dashboard each deciding which exclusions "inbox" implies, which is the same
disagreement `inInbox` exists to prevent one level down. A filter added to a
route belongs in the builder, not in the route.

Markdown has no escaping story the way HTML does, so `inline()` is applied to
every interpolated value, exactly as the `html` tag is. It flattens whitespace
*before* escaping: the dangerous character is the newline, because a title
carrying one and a `## ` opens a section a reader cannot tell from ours.

### The CLI (`src/cli.ts`)

`index.ts` dispatches on `Bun.argv` before it logs a start line, opens the
store for writing, or builds a provider. Bare `relwatch` still runs the
service, so the systemd unit is untouched.

The store is opened **read-only**, which is load-bearing twice: a stale binary
run against a live database cannot migrate the schema out from under the
running service, and a typo'd `RW_DB` fails instead of creating an empty
database and reporting inbox zero off it.

Flag parsing is deliberately stricter than the query string, which falls back
to the page on a bogus `?verdict=`. A browser shows you what it did; a
mistyped flag in a script is answered silently and read as the truth.

### The three states a release can be in

These are independent axes, and most bugs here come from conflating two of
them:

- **dismissed** — something the operator did. Suppresses the release from a
  digest that hasn't gone out yet.
- **backfilled** — something the release *is*. Written by the seeding poll;
  never triaged, never emailed, never in the inbox.
- **emailed** — it went out. Does *not* auto-dismiss: a release sits in the
  inbox until it is acknowledged, however it was seen.

The inbox means **news awaiting acknowledgement**: undismissed *and* not
backfilled. `listReleases`, `counts().inbox`, the app page's tallies and
`dismissAll` all have to share that one definition, or the header, the list and
the button disagree with each other. `?all=1` passes both include flags, so
"all" means all.

### The seed watermark

`apps.seeded_at` is stamped on an app's first successful poll and never moves.
Anything published before it is history, however late it is discovered. An app
with **no** watermark is being seeded by definition, so everything that poll
returns is history too.

This is load-bearing rather than defensive. Backfill reads `RW_BACKFILL_DEPTH`
per app while a routine poll reads `RW_GITHUB_PER_PAGE`, so the first poll after
a backfill discovers a second wave of genuinely old releases — and a feed that
reorders itself, or an ETag that churns, does the same thing later. Without the
watermark those land as today's news, which is exactly the backlog this project
replaced.

### Poll (`src/poll.ts`, `src/source/`)

A failure for one app is logged and skipped, never fatal to the cycle. The
`Source` interface is the only thing that knows a wire format; `github.ts` uses
conditional requests and stores the ETag **only after rows land**, so a crash
mid-insert can't leave an ETag claiming we hold releases we never wrote.

GitHub reports an exhausted anonymous quota as a plain `403`, indistinguishable
from a private repo without reading `x-ratelimit-remaining`. `SourceError`
carries `rateLimited` so the poller abandons the cycle rather than spending a
request per remaining app to learn the same thing.

### Triage (`src/triage/`)

One LLM call per release, at ingest, verdict stored forever. Batching was tried
and abandoned — models drop ids from a large batch, and per-release calls make
that failure structurally impossible rather than detected-and-repaired.

The provider seam exists because the two backends need different call shapes:
Responses requires `stream: true` and `store: false` so it must use
`streamObject`; Anthropic is a plain `generateObject`.

**`streamObject` must be drained before awaiting `.object`.** It is lazy —
nothing is pulled from the response until something consumes it, so
`await stream.object` alone never settles, produces no error, writes no log
line, and pins a core. It presents as unexplained CPU rather than a stuck job.
The `for await (… ) void partial` loop is not stylistic.

A failed triage stores `triage_error`, leaves `triaged_at` NULL for a later
sweep, and never drops the release — it renders as "not triaged".

### Digest (`src/digest/`)

**Never retry a send.** Delivery through hubbub is at-least-once with no
idempotency key, so a client retry is a duplicate digest in someone's inbox. A
timeout leaves `emailed_at` unset and tomorrow's digest covers the same
releases — the one failure mode that self-heals. Any 2xx is success; `202` is
the expected answer, not `200`; `207` requires reading the per-channel map.

`emailed_at` is marked only for the ids actually included, so anything the size
cap dropped rolls into the next send. Byte budgets are counted in bytes, not
characters: the caps are byte caps and titles carry emoji.

### Scheduler (`src/scheduler.ts`)

Cron callbacks are `async` and awaited. Writing them as `void guard(…)` looks
right and silently defeats croner's `protect` option — a job that returns
immediately looks finished, so an overrunning poll would race itself. Every job
runs inside `guard`, which logs a throw and swallows it, because an unhandled
throw in a cron callback drops that schedule until the next restart.

## Conventions

- Comments here are load-bearing: they record *why* a non-obvious choice was
  made, usually the failure mode it prevents. Preserve them when editing, and
  write in that register rather than narrating what the code does.
- `src/config.ts` is the canonical list of tunables. A knob added there needs a
  row in README.md's configuration table.
- No hostnames, emails or deployment paths in code. Anything host-specific is
  an `RW_*` env var with a fail-closed or fail-loud default.
- Tests are offline: sources go through a typed `fetch` stub, triage through
  `StubProvider` or an injected `generate`, delivery through a stubbed hub.
  New behaviour should be provable the same way.
- British spelling in prose; `-ise` not `-ize`.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/), enforced by the
`commits` job in CI:

```
<type>(<scope>)!: <subject, imperative, lower case, no full stop>
```

`type` is one of `feat` `fix` `docs` `style` `refactor` `perf` `test` `build`
`ci` `chore` `revert`. `scope` is optional and names the area rather than the
file: `config`, `db`, `poll`, `source`, `triage`, `web`, `digest`, `scheduler`,
`cli`.
Repo-wide changes take no scope. `deps` is Renovate's, not yours. Subjects stay
within 72 characters.

`style` means presentation only — the dashboard's and digest's CSS and layout.
Code formatting is not a commit of its own.

A change to an `RW_*` name or default, a route, or the digest's delivery
behaviour is breaking: mark it `!` after the scope and add a `BREAKING CHANGE:`
footer saying what an operator has to do. This applies before 1.0 too.

The body is the point. It records *why*, in the same register as the comments:
the failure mode avoided, the alternative rejected and what it cost, what was
deliberately left alone. A subject that needs no body is usually a commit that
did not need making.
