// Preloaded by `bun test` (see bunfig.toml). Runs before any module is imported,
// which matters because config.ts reads process.env once at load.
//
// Only settings whose *default* is deliberately unusable in production belong
// here. RW_ADMIN_EMAILS is the case that forced this file to exist: it defaults to
// empty so an unconfigured deployment has no admin, and the web tests need an
// identity that actually clears the gate.
process.env.RW_ADMIN_EMAILS ??= "admin@example.com";
