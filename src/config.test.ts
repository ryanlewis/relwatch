import { describe, expect, test } from "bun:test";
import {
  BACKENDS,
  boolEnv,
  describeConfig,
  durationEnv,
  expandHome,
  intEnv,
  isBackend,
  normaliseBasePath,
} from "./config.js";

// These guards exist to stop a systemd typo becoming a silent misbehaviour, so
// the garbage cases matter more here than the happy paths.

describe("intEnv", () => {
  test("parses a valid integer", () => {
    expect(intEnv("8", 4, 1)).toBe(8);
  });

  test("treats unset and blank alike as unset", () => {
    // A bare `Environment=RW_LLM_CONCURRENCY=` must not read as a deliberate 0:
    // Number("") is 0, and 0 concurrency would stall every poll cycle.
    expect(intEnv(undefined, 4, 1)).toBe(4);
    expect(intEnv("", 4, 1)).toBe(4);
    expect(intEnv("   ", 4, 1)).toBe(4);
  });

  test("falls back rather than propagating NaN", () => {
    // NaN reaching p-limit throws on every cycle; the fallback keeps it running.
    expect(intEnv("four", 4, 1)).toBe(4);
    expect(intEnv("1e999", 4, 1)).toBe(4); // Infinity is not finite
  });

  test("enforces the minimum", () => {
    expect(intEnv("0", 4, 1)).toBe(4);
    expect(intEnv("-3", 4, 1)).toBe(4);
    expect(intEnv("0", 4, 0)).toBe(0); // 0 is legitimate where min allows it
  });

  test("floors a fractional value", () => {
    expect(intEnv("4.9", 1, 1)).toBe(4);
  });
});

describe("durationEnv", () => {
  test("reads the unit suffixes", () => {
    expect(durationEnv("90s", 1)).toBe(90_000);
    expect(durationEnv("2m", 1)).toBe(120_000);
    expect(durationEnv("1h", 1)).toBe(3_600_000);
    expect(durationEnv("500ms", 1)).toBe(500);
  });

  test("treats a bare number as milliseconds", () => {
    expect(durationEnv("250", 1)).toBe(250);
  });

  test("tolerates whitespace and case", () => {
    expect(durationEnv(" 90 S ", 1)).toBe(90_000);
  });

  test("falls back on garbage rather than yielding NaN", () => {
    // AbortSignal.timeout(NaN) aborts immediately, which would turn every LLM
    // call into an instant failure — the worst possible reading of a typo.
    expect(durationEnv("ninety seconds", 90_000)).toBe(90_000);
    expect(durationEnv("90x", 90_000)).toBe(90_000);
    expect(durationEnv("", 90_000)).toBe(90_000);
    expect(durationEnv(undefined, 90_000)).toBe(90_000);
  });

  test("rejects a non-positive duration", () => {
    expect(durationEnv("0", 90_000)).toBe(90_000);
    expect(durationEnv("0s", 90_000)).toBe(90_000);
  });

  test("accepts a fractional value", () => {
    expect(durationEnv("1.5s", 1)).toBe(1_500);
  });
});

describe("boolEnv", () => {
  test("reads the usual spellings both ways", () => {
    for (const t of ["1", "true", "TRUE", "yes"]) expect(boolEnv(t, false)).toBe(true);
    for (const f of ["0", "false", "No"]) expect(boolEnv(f, true)).toBe(false);
  });

  test("falls back when unset or unrecognised", () => {
    expect(boolEnv(undefined, true)).toBe(true);
    expect(boolEnv("", true)).toBe(true);
    expect(boolEnv("maybe", false)).toBe(false);
  });
});

describe("expandHome", () => {
  test("expands a leading ~/", () => {
    expect(expandHome("~/x/y")).toStartWith("/");
    expect(expandHome("~/x/y")).toEndWith("/x/y");
  });

  test("leaves absolute and relative paths alone", () => {
    expect(expandHome("/abs/path")).toBe("/abs/path");
    expect(expandHome("rel/path")).toBe("rel/path");
    // Only "~/" expands — a literal "~foo" is not a home reference.
    expect(expandHome("~foo")).toBe("~foo");
  });
});

describe("normaliseBasePath", () => {
  test("keeps a well-formed prefix", () => {
    expect(normaliseBasePath("/analytics")).toBe("/analytics");
  });

  test("adds the leading slash and strips trailing ones", () => {
    expect(normaliseBasePath("analytics")).toBe("/analytics");
    expect(normaliseBasePath("/analytics/")).toBe("/analytics");
    expect(normaliseBasePath("/analytics///")).toBe("/analytics");
  });

  test("normalises root to the empty string", () => {
    // So BASE_PATH + "/app/1" is "/app/1", not "//app/1".
    expect(normaliseBasePath("/")).toBe("");
    expect(normaliseBasePath("")).toBe("");
    expect(normaliseBasePath("   ")).toBe("");
  });

  test("supports a nested prefix", () => {
    expect(normaliseBasePath("/tools/analytics/")).toBe("/tools/analytics");
  });
});

describe("isBackend", () => {
  test("accepts the two known backends and nothing else", () => {
    for (const b of BACKENDS) expect(isBackend(b)).toBe(true);
    expect(isBackend("gemini")).toBe(false);
    expect(isBackend("")).toBe(false);
  });
});

describe("describeConfig", () => {
  test("names the backend, model and store in one line", () => {
    const line = describeConfig();
    expect(line).toContain("backend=");
    expect(line).toContain("model=");
    expect(line).toContain("db=");
    expect(line).toContain("tz=");
    expect(line).not.toContain("\n");
  });
});
