# relwatch

relwatch watches a list of upstream projects for new releases, runs each one
through an LLM to work out whether it matters, and puts the result in two
places: a dashboard and a daily email digest.

```
┌─ MAJOR ────────────────────────────────────────────────────────┐
│ neovim  v0.12.0                                    [breaking]  │
│ Adds a built-in LSP client rewrite and drops the old API.      │
│  · vim.lsp.config() replaces lspconfig for most setups         │
│  · :checkhealth reports the migration path                     │
└────────────────────────────────────────────────────────────────┘
```

I built it because I was watching 38 projects through their `releases.atom`
feeds in an RSS reader, and that had quietly stopped working. Every GitHub repo
publishes one of those feeds, so it costs nothing to set up and it's fine for a
while. Then you open the reader to 108 unread entries and there's no way to tell
from the list which is the Neovim LSP rewrite and which is a lockfile bump. I
was marking everything read most mornings, which isn't really watching anything.

## Why not an RSS reader

Feed readers assume you want to read what they fetch. I didn't — I wanted to be
told about the few releases that needed something from me. Three places that
showed up:

- **Unread tracks whether I'd seen an entry, not whether it was worth seeing**,
  and the ordering is by arrival. relwatch triages each release as it comes in,
  so the dashboard sorts by importance and the digest leads with the major ones.
- **Subscribing to a project dumped its last ten releases in as unread news**,
  however old they were, so the cheap way to keep the pile down was to watch
  fewer things. relwatch stamps a watermark on an app's first poll and treats
  anything published before it as history: browsable, but never triaged, never
  emailed, never counted as unread.
- **A feed is a window, not an archive.** `releases.atom` carries only the most
  recent entries, so anything I hadn't got to eventually scrolled out of the
  feed, and out of the reader with it. relwatch keeps everything — dismissing a
  release hides it, removing an app deactivates it and keeps its history, and
  nothing is deleted.

## Status

Working, deployed, and something I use every day. Pre-1.0: `RW_*` names and
defaults can still change, and a change that breaks an operator is marked
`BREAKING CHANGE:` in the commit rather than left implied.

No releases are tagged. `main` is the only supported version.

## How it works

```
         ┌── GitHub Releases API (conditional, ETag)
poll ────┤                                            every 6 h
         └── RSS / Atom
              │
              ▼
         new rows ──► triage (one LLM call each) ──► verdict stored forever
              │
              ├──────────────► dashboard   an inbox of news, plus the archive
              │
              └──────────────► digest      daily, delivered through hubbub
```

**Poll.** Each app is a `github` ref (`owner/repo`) or an `rss` feed URL.
GitHub requests are conditional, so unchanged repos cost nothing against the
60/hr anonymous rate limit. One app failing is logged and skipped; it never
takes down the cycle.

**Triage.** One LLM call per release, at ingest, against a fixed schema:

```ts
{ verdict: "major" | "interesting" | "maintenance",
  summary: string,          // one sentence, what changed
  breaking: boolean,
  highlights: string[] }    // up to 3
```

A response that doesn't validate gets exactly one repair attempt with its own
output fed back. If that fails too, the error is stored and the release renders
as "not triaged" — never dropped.

**Two surfaces, one store.** The dashboard is the archive and the acknowledgement
queue; the digest is the push notification. They read the same SQLite file.

## Quick start

Requires [Bun](https://bun.sh).

```sh
git clone https://github.com/ryanlewis/relwatch
cd relwatch
bun install

# Runs the whole service with a deterministic offline triage provider,
# so you need no LLM gateway to see it work.
RW_BACKEND=stub RW_DB=./relwatch.db bun run start
```

Then add something to watch, and poll it:

```sh
curl -X POST localhost:8000/api/apps \
  -H 'content-type: application/json' \
  -H 'x-exedev-email: you@example.com' \
  -d '{"kind":"github","ref":"neovim/neovim"}'
```

For that to be accepted, start the service with
`RW_ADMIN_EMAILS=you@example.com`. Mutations are admin-only and there is no
default admin — see [Authentication](#authentication).

Seed a roster from a file instead:

```sh
bun scripts/seed-roster.ts roster.json --backfill
```

where `roster.json` is an array of `{name, kind, ref, homepage}`.
`scripts/import-roster.ts` will generate one from a Miniflux category, if that
is what you are migrating away from.

## Configuration

Everything is an `RW_*` environment variable, so a systemd unit is the single
place a deployment differs from a local run. `src/config.ts` is the canonical
list; `example/relwatch.service` is a working starting point.

| Env | Default | Notes |
|---|---|---|
| `RW_DB` | `~/.local/share/relwatch/relwatch.db` | Created on first run, with its parent |
| `RW_PORT` | `8000` | |
| `RW_BASE_PATH` | *(root)* | Sub-path when mounted behind a reverse proxy, e.g. `/releases` |
| `RW_ADMIN_EMAILS` | *(empty)* | Comma-separated. **Empty means nobody is an admin** |
| `RW_DASHBOARD_URL` | *(none)* | Absolute URL, used only for the digest's links |
| `RW_TZ` | `Europe/London` | Governs cron schedules and the dashboard's day buckets |
| `RW_POLL_CRON` | `0 */6 * * *` | Quote it in a systemd unit — see below |
| `RW_DIGEST_CRON` | `0 8 * * *` | In `RW_TZ` |
| `RW_BACKEND` | `openai-responses` | `anthropic`, or `stub` for offline |
| `RW_OPENAI_BASE` | `https://chatgpt.int.exe.xyz/openai/v1` | See [LLM backends](#llm-backends) |
| `RW_OPENAI_MODEL` | `gpt-5.5` | |
| `RW_ANTHROPIC_BASE` | `https://llm.int.exe.xyz/anthropic/v1` | |
| `RW_ANTHROPIC_MODEL` | `claude-opus-5` | |
| `RW_LLM_CONCURRENCY` | `4` | |
| `RW_TIMEOUT` | `90s` | Per LLM call. Reasoning models are slow |
| `RW_RETRY_ATTEMPTS` | `3` | Retries on 5xx/429 only |
| `RW_RETRY_BASE_DELAY_MS` | `2000` | |
| `RW_GITHUB_TOKEN_FILE` | `~/.config/relwatch/github-token` | Optional; lifts 60/hr to 5000/hr |
| `RW_GITHUB_PER_PAGE` | `10` | Releases fetched per app per poll |
| `RW_BACKFILL_DEPTH` | `5` | Releases seeded per app on first poll |
| `RW_SOURCE_TIMEOUT` | `20s` | Per feed fetch |
| `RW_USER_AGENT` | `relwatch/0.1 (+…)` | Sent to GitHub and feeds |
| `RW_HUBBUB_BASE` | *(none)* | **Required for the digest** |
| `RW_HUBBUB_KEY_FILE` | `~/.config/relwatch/hubbub-key` | `0600`, read at call time |
| `RW_MAX_HTML_BYTES` | `122880` | Render guard under hubbub's 128 KiB cap |
| `RW_DRY_RUN` | `0` | Digest goes to a temp file; nothing is sent |

Numeric and duration knobs fall back to their default on garbage rather than
propagating `NaN`. A typo'd `RW_LLM_CONCURRENCY` would otherwise make every
poll cycle throw, and a typo'd `RW_TIMEOUT` would abort every LLM call
instantly — both one keystroke away in a unit file.

**Quote cron patterns in systemd.** `Environment=` splits on whitespace, so an
unquoted `RW_POLL_CRON=0 */6 * * *` arrives as `0`. A malformed pattern falls
back to the default and logs, rather than crash-looping.

### LLM backends

The two base URLs default to gateways on an [exe.dev](https://exe.dev) host
network, which authenticate the calling machine rather than a key — which is
why relwatch holds no LLM credentials on disk. Point them at any compatible
endpoint. The `openai-responses` backend targets the **Responses** API and
requires `stream: true` with `store: false`; `anthropic` targets Messages.
That difference is the entire reason `src/triage/` has a provider seam.

`RW_BACKEND=stub` uses a deterministic offline provider, which is how the whole
service runs on a laptop.

## The dashboard

Server-rendered HTML. No SPA, no build step, no client dependencies — the one
inline script is an enhancement layered over forms that work without it.

| Route | | |
|---|---|---|
| `GET /` | public | The inbox: news awaiting acknowledgement. `?verdict=`, `?app=`, `?all=1` |
| `GET /app/:id` | public | Per-app history — dismissed and backfilled included. `?hide=1` |
| `GET /roster` | public | The roster; add/remove controls for admins |
| `GET /healthz` | public | `{ok, apps, releases, inbox, pendingDigest, last_fetch, last_poll}` |
| `POST /api/releases/:id/dismiss` | admin | |
| `POST /api/releases/dismiss-all` | admin | Everything currently in the inbox |
| `POST /api/apps/:id/dismiss-all` | admin | Scoped to one app |
| `POST /api/apps` | admin | `{kind, ref, name?}` |
| `DELETE /api/apps/:id` | admin | Soft delete; `POST /api/apps/:id/delete` for forms |

`/healthz` sits outside `RW_BASE_PATH`, so an uptime check needn't know where
the dashboard is mounted.

`last_fetch` is activity: the most recent ingest, which stands still through
any stretch in which nothing ships. `last_poll` is liveness: it advances every
time a poll cycle gets an answer from at least one source, releases or not. A
monitor asking "is relwatch alive" should read `last_poll` — reading
`last_fetch` for that pages on every quiet day. It is `null` until the first
completed cycle after install or upgrade. The built-in watchdog (an ntfy alert
after 24 h, checked at digest time) reads `last_poll` for the same reason.

### What the inbox means

A release can be **dismissed** (you acknowledged it), **backfilled** (it was
never news), and **emailed** (it went out) independently. The inbox is
undismissed *and* not backfilled. Emailing does not auto-dismiss — a release
stays in the inbox until you clear it, however you first saw it. Dismissing
*does* suppress a release from a digest that hasn't gone out yet: dismissed
means seen, everywhere.

`?all=1` includes both hidden sets, so "all" means all.

### JSON and markdown

The three read routes render in three formats. `?format=json` and `?format=md`
sit alongside the page, and `Accept: application/json` or `text/markdown` does
the same thing for a caller that would rather set a header. An unrecognised
`?format=` falls back to the page rather than erroring, the same way a bogus
`?verdict=` falls back to no filter. The same two renderings are what
[the CLI](#the-cli) prints.

```sh
curl -s 'localhost:8000/?format=md'                  # the inbox, to read
curl -s 'localhost:8000/?format=json' | jq           # the inbox, to process
curl -s 'localhost:8000/?verdict=major&format=json'  # every filter still applies
curl -s 'localhost:8000/roster?format=md'
```

This exists because the alternative was reading the SQLite file over SSH with
a hand-written join, which duplicates the inbox definition in a second place
and gets it wrong the first time the two disagree. All three formats render
the *same* view object, so a filter that changes the page changes them with it.

Both formats carry the release id, which is what
`POST /api/releases/:id/dismiss` wants — so a caller can acknowledge what it
has read. The markdown says so at the foot of each list.

Two things worth knowing before you parse it:

- **`notes` is not included.** It is the raw upstream release body — the input
  to triage, routinely tens of kilobytes, and three hundred of them is not a
  payload anyone wants. What triage made of it is in `summary` and
  `highlights`; `url` is where the original lives.
- **The lists are capped** at 300 releases for the inbox and 200 for an app's
  history. JSON reports `limit` and `limit_reached`; markdown says so in the
  body. Hitting the cap is not silent in either.

The JSON gives each release the three states by name rather than leaving them
to be re-derived — `in_inbox`, `backfilled`, and the `dismissed_at` /
`emailed_at` / `triaged_at` stamps — because conflating any two of them is
where the bugs in this thing have come from. A release whose triage failed
carries `triage_error` with `verdict: null`; it is never dropped.

Markdown is escaped the way the HTML is. Release titles and LLM summaries are
upstream text, and a newline plus a `## ` in a title would otherwise open a
section a reader has no way to tell from one relwatch wrote.

### Authentication

Reads are unauthenticated. Mutations require the request to carry
`X-ExeDev-Email` matching an entry in `RW_ADMIN_EMAILS`.

This is only sound behind a proxy that **strips client-supplied copies of that
header** — behind the exe.dev proxy it is the user's verified identity;
reached directly it is whatever the caller typed. `RW_ADMIN_EMAILS` is empty by
default so an unconfigured deployment has no admins rather than trusting the
first identity it is handed. Anonymous callers reaching for an admin affordance
are redirected to the proxy's login; a signed-in non-admin gets a plain `403`,
because redirecting them would loop.

See [SECURITY.md](SECURITY.md) for what that assumption does and does not
cover.

## The digest

Daily, in `RW_TZ`, covering releases that are unemailed, undismissed and not
backfilled. **If there are none, nothing is sent.**

Delivery goes through [hubbub](https://github.com/ryanlewis/hubbub), which owns
the channel credentials and the recipient — relwatch holds one bearer key and
names a channel. There is no `RW_TO`: who receives the mail is a property of
the hub's `email` channel, not of this caller.

The payload is two renderings of one release set: an HTML newsletter grouped
major → interesting → maintenance → not triaged, and a plain-text **summary**
(counts plus the major items) under 4 KiB — not a parallel copy of the same
content.

Three rules govern sending:

- **Any 2xx is success.** `202` is the expected answer, not `200`: the hub's
  response window elapses before SMTP finishes, and `202` means durably
  spooled. `207` means reading the per-channel map, not just the status.
- **A send is never retried.** Delivery is at-least-once with no idempotency
  key, so a client retry is a duplicate digest. A timeout leaves `emailed_at`
  unset and tomorrow's digest covers the same releases — the one failure mode
  that self-heals.
- **Truncation is stated, never silent.** Over `RW_MAX_HTML_BYTES` the renderer
  drops from the end — maintenance before anything major — says how many went,
  in both parts, and marks only the included ids as emailed, so the remainder
  rolls into the next send.

A failed digest, and a poller that has not completed a cycle for 24 hours, both
raise an alert narrowed to a `ntfy` channel at high priority. Narrowing matters:
a broken email path must not swallow the notice that the email path is broken.
The staleness check reads the poll watermark, not the last ingest — a stretch
in which nothing ships is upstream being quiet, not relwatch being broken.

## The CLI

The same three views, read straight off the store. Bare `relwatch` runs the
service, exactly as the systemd unit expects; a subcommand reads and exits.

```sh
relwatch inbox                     # markdown, the default
relwatch inbox --json | jq         # the same view, machine-readable
relwatch inbox --verdict=major --all
relwatch app 12 --hide
relwatch roster
relwatch help
```

Use this when you are already on the host — over `ssh`, or with the service
stopped. Across a network, `?format=` on the HTTP routes is the same data
without needing a shell.

**The store is opened read-only.** That is not tidiness: a binary newer than
the running service would otherwise apply a migration on what the operator
thought was a read, and a typo'd `RW_DB` would create an empty database and
report inbox zero off it. A path that isn't there is an error.

Reads only. Dismissing is a mutation and goes through the HTTP surface, which
is where the admin check lives — the markdown output prints the route and the
ids to go with it.

## Deployment

One process, one SQLite file, one systemd unit.

```sh
bun build --compile --target=bun-linux-x64 --outfile relwatch-linux src/index.ts
scp relwatch-linux user@host:/opt/relwatch/relwatch
```

The compiled binary is ~96 MB and never delta-compresses, so it is a deploy
artefact rather than something to commit — `.gitignore` keeps both compile
targets out for that reason.

Copy `example/relwatch.service` to `/etc/systemd/system/`, fill in the
placeholders, and start it. Behind a reverse proxy, set `RW_BASE_PATH` to match
the route and make sure the proxy forwards `X-ExeDev-Email` while refusing a
client's own.

Files relwatch expects on the host, all `0600`:

- `~/.config/relwatch/hubbub-key` — the API key for the digest
- `~/.config/relwatch/github-token` — optional read-only PAT

## Development

```sh
bun run check     # lint → typecheck → test. This is the gate.
bun test src/db.test.ts
bun test --test-name-pattern "dismiss"
```

363 tests, all offline: HTTP goes through a typed `fetch` stub, triage through
a stub provider or an injected `generate`, delivery through a stubbed hub.
Coverage thresholds are enforced in `bunfig.toml`, so erosion fails the run.

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) and
CI enforces the subject line. [CLAUDE.md](CLAUDE.md) has the architecture notes,
the invariants worth knowing before changing behaviour, and the commit
conventions in full.

## Prior art

[newreleases.io](https://newreleases.io) and GitHub's own release notifications
both do the watching well, but they stop at delivery — you still read
everything. The difference here is the triage step and the split between news
and history. The trade is that they're hosted services anyone can sign up for,
and this is a binary you run yourself.

## Security

See [SECURITY.md](SECURITY.md). The short version: everything on a page came
from upstream and is escaped as such, admin identity is only as good as the
proxy asserting it, and reports go through GitHub's private advisory form.

## Licence

MIT — see [LICENSE](LICENSE).
