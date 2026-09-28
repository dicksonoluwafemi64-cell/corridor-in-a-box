import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { BreakerRecord } from "@corridor/engine";
import {
  formatBreakerRecord,
  formatBreakerReset,
  formatBreakerTable,
  parseBreakerArgs,
} from "../packages/cli/src/breaker";

// packages/cli/src/index.ts calls process.exit(main(...)) at module top level
// and has no vitest path alias, so importing it directly would kill the test
// worker. Spawn it as a child process instead — also a more honest way to
// test a CLI's actual argv/exit-code/stdio contract. Everything that does not
// need a process (argument parsing, rendering) lives in packages/cli/src/breaker
// and is imported directly below, because the interesting properties of those
// are types and strings, not exit codes.

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
// Spawn `node node_modules/tsx/dist/cli.mjs` rather than `node_modules/.bin/tsx`.
// The `.bin` entry is a shell script (`tsx` / `tsx.cmd`) that cannot be spawned
// directly on Windows without a shell, which made every case in this file fail
// there with a null exit status. Going through the current interpreter and the
// bin target tsx itself declares is portable and needs no shell.
const TSX_CLI = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
const CLI = fileURLToPath(new URL("../packages/cli/src/index.ts", import.meta.url));

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [TSX_CLI, CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    // `process.env` minus DATABASE_URL by default: these cases must never
    // depend on whether the developer running them has one exported, and a test
    // that silently talks to a real database is worse than no test.
    env: { ...process.env, DATABASE_URL: "", ...env },
  });
}

describe("corridor CLI", () => {
  it("prints usage and exits 2 with no args", () => {
    const r = run([]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage: corridor <validate|plan>");
  });

  it("exits 2 on an unknown subcommand", () => {
    const r = run(["frobnicate"]);
    expect(r.status).toBe(2);
  });

  it("prints usage and exits 2 when the file arg is missing", () => {
    const r = run(["validate"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage: corridor validate");
  });

  it("validate: exits 0 for a valid manifest", () => {
    const r = run(["validate", "corridors/reference.corridor.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('id="reference-testnet"');
  });

  it("validate: exits 1 for a structurally invalid manifest", () => {
    const r = run(["validate", "tests/fixtures/invalid.corridor.yaml"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("MANIFEST_INVALID");
    expect(r.stderr).toContain("source");
  });

  it("validate: exits 1 for a nonexistent path", () => {
    const r = run(["validate", "corridors/does-not-exist.yaml"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("cannot read or parse");
  });

  // Liveness has three states. The distinction that matters: a corridor whose
  // endpoints are merely PRESENT must never be reported as runnable — that is
  // how tooling ends up certifying a lane nobody has checked.

  it("plan: reports VERIFIED only when endpoints_verified_at is set", () => {
    const r = run(["plan", "tests/fixtures/verified.corridor.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("liveness: ✓ VERIFIED");
    expect(r.stdout).toContain("2026-01-01");
  });

  it("plan: reports UNVERIFIED for a fully-specified but unchecked corridor", () => {
    const r = run(["plan", "corridors/reference.corridor.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("liveness: ? UNVERIFIED");
    expect(r.stdout).toContain("NOT runnable");
    // Regression guard for the claim that got the project rejected: a corridor
    // with unconfirmed endpoints must never carry the green marker.
    expect(r.stdout).not.toContain("✓ VERIFIED");
  });

  it("plan: never reports a placeholder-endpoint corridor as runnable", () => {
    const r = run(["plan", "corridors/mx-example.corridor.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("UNVERIFIED");
    expect(r.stdout).not.toContain("✓ VERIFIED");
  });

  it("plan: reports all three liveness warnings for a corridor missing dest endpoints", () => {
    const r = run(["plan", "corridors/ng-cn.corridor.yaml"]);
    expect(r.status).toBe(0); // warnings don't fail the command
    expect(r.stdout).toContain("NOT RUNNABLE");
    expect(r.stdout).toContain("quotes will fail");
    expect(r.stdout).toContain("no per-customer KYC");
  });

  it("plan: reports VERIFIED for ng-cowrie", () => {
    const r = run(["plan", "corridors/ng-cowrie.corridor.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("liveness: ✓ VERIFIED");
    expect(r.stdout).toContain("2026-08-11");
  });

  it("plan: prints the status_note when present", () => {
    const r = run(["plan", "corridors/ng-cn.corridor.yaml"]);
    expect(r.stdout).toContain("PENDING");
  });
});

// --- corridor breaker -----------------------------------------------------
// A halt is only safe if reopening it is deliberate and recorded. These cases
// cover the two halves of that: the process contract (exit codes, messages) and
// the pure logic behind them (what parses, what renders).

describe("corridor breaker (process contract)", () => {
  // The headline case. A reset with no reason on record is indistinguishable,
  // months later, from somebody clearing alerts at 3am without reading the lane.
  it("reset without --reason exits 2 and says what is missing", () => {
    const r = run(["breaker", "reset", "ng-cn"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--reason");
    expect(r.stderr).toContain("requires");
  });

  it("reset with an empty --reason also exits 2", () => {
    const r = run(["breaker", "reset", "ng-cn", "--reason", "   "]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--reason");
  });

  it("reset with --reason but no DATABASE_URL exits 1, not 2", () => {
    // The arguments were fine; the environment is not. Collapsing these into one
    // code would tell an operator to fix their command when it is their env.
    const r = run(["breaker", "reset", "ng-cn", "--reason", "anchor restored"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("DATABASE_URL");
  });

  it("status without DATABASE_URL exits 1 and names the variable", () => {
    const r = run(["breaker", "status"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("DATABASE_URL");
  });

  it("exits 2 for a missing corridor id on reset", () => {
    const r = run(["breaker", "reset", "--reason", "why"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("requires a corridor id");
  });

  it("exits 2 on an unknown breaker subcommand", () => {
    const r = run(["breaker", "frobnicate"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unknown breaker subcommand");
  });

  it("exits 2 on an unknown flag rather than treating it as a corridor id", () => {
    const r = run(["breaker", "reset", "ng-cn", "--reason", "why", "--force"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unknown flag");
  });

  it("exits 2 on more than one corridor id", () => {
    const r = run(["breaker", "status", "a", "b"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("at most one corridor id");
  });

  it("prints the breaker usage for `corridor breaker` with no subcommand", () => {
    const r = run(["breaker"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("corridor breaker status");
    expect(r.stderr).toContain("--reason");
  });

  it("validate and plan keep working with no DATABASE_URL set", () => {
    // The breaker commands read a database; the manifest commands must not need
    // one, or a dev box without Postgres cannot check a manifest at all.
    expect(run(["validate", "corridors/reference.corridor.yaml"]).status).toBe(0);
    expect(run(["plan", "corridors/reference.corridor.yaml"]).status).toBe(0);
  });
});

describe("parseBreakerArgs", () => {
  it("accepts status with and without a corridor id", () => {
    expect(parseBreakerArgs(["status"])).toEqual({
      ok: true,
      command: { kind: "status", corridorId: undefined },
    });
    expect(parseBreakerArgs(["status", "ng-cn"])).toEqual({
      ok: true,
      command: { kind: "status", corridorId: "ng-cn" },
    });
  });

  it("accepts both --reason forms", () => {
    expect(parseBreakerArgs(["reset", "ng-cn", "--reason", "anchor restored"])).toEqual({
      ok: true,
      command: { kind: "reset", corridorId: "ng-cn", reason: "anchor restored" },
    });
    expect(parseBreakerArgs(["reset", "--reason=anchor restored", "ng-cn"])).toEqual({
      ok: true,
      command: { kind: "reset", corridorId: "ng-cn", reason: "anchor restored" },
    });
  });

  it("keeps a multi-word reason intact", () => {
    const r = parseBreakerArgs([
      "reset",
      "ng-cn",
      "--reason",
      "checked with the anchor on call",
    ]);
    expect(r.ok).toBe(true);
    if (r.ok && r.command.kind === "reset") {
      expect(r.command.reason).toBe("checked with the anchor on call");
    }
  });

  it("does not let a flag's value be mistaken for the corridor id", () => {
    // `--reason ng-cn` must not be read as the corridor; without this, a reset
    // aimed at the wrong lane would succeed silently.
    const r = parseBreakerArgs(["reset", "--reason", "why", "mx-example"]);
    expect(r.ok).toBe(true);
    if (r.ok && r.command.kind === "reset") expect(r.command.corridorId).toBe("mx-example");
  });

  it("refuses a reason that is only whitespace", () => {
    const r = parseBreakerArgs(["reset", "ng-cn", "--reason", "  \t "]);
    expect(r.ok).toBe(false);
  });

  it("returns the usage text for --help instead of a command", () => {
    const r = parseBreakerArgs(["--help"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("corridor breaker reset");
  });
});

describe("breaker status output", () => {
  const open: BreakerRecord = {
    corridorId: "ng-cn",
    state: "open",
    consecutiveFailures: 3,
    trippedAt: Date.parse("2026-09-28T12:00:00.000Z"),
    lastError: "RECONCILE_STALLED: anchor never reported a terminal status",
    updatedAt: Date.parse("2026-09-28T12:00:00.000Z"),
  };

  it("shows a halted lane with its mark, when it tripped and why", () => {
    const out = formatBreakerRecord(open, "ng-cn");
    expect(out).toContain("corridor: ng-cn");
    expect(out).toContain("OPEN");
    expect(out).toContain("2026-09-28T12:00:00.000Z");
    expect(out).toContain("RECONCILE_STALLED");
    expect(out).toContain("failures: 3 consecutive");
  });

  it("distinguishes a lane with no row from a healthy one", () => {
    // "No evidence" and "evidence of health" are different claims, and an
    // operator acting on the difference is the whole point of the command.
    const out = formatBreakerRecord(undefined, "brand-new");
    expect(out).toContain("UNKNOWN");
    expect(out).not.toContain("CLOSED");
  });

  it("shows a closed lane as accepting work", () => {
    const out = formatBreakerRecord(
      { corridorId: "ng-cn", state: "closed", consecutiveFailures: 0, updatedAt: 0 },
      "ng-cn",
    );
    expect(out).toContain("CLOSED");
    expect(out).toContain("accepting new runs");
  });

  it("never claims how close a lane is to tripping", () => {
    // The threshold is in the manifest, not the row. Reporting "1 short of
    // tripping" would be a guess, and a wrong one whenever the operator has
    // changed recovery.breaker.consecutive_failures. The count alone is honest.
    const out = formatBreakerRecord(
      { corridorId: "ng-cn", state: "closed", consecutiveFailures: 2, updatedAt: 0 },
      "ng-cn",
    );
    expect(out).toContain("failures: 2 consecutive");
    expect(out).toContain("still accepting new runs");
    expect(out).not.toContain("short of tripping");
  });

  it("lists every lane, halted ones first", () => {
    const closed: BreakerRecord = {
      corridorId: "aaa-closed",
      state: "closed",
      consecutiveFailures: 0,
      updatedAt: 0,
    };
    const out = formatBreakerTable([closed, open]);
    const lines = out.split("\n");
    // Header, rule, then rows. The halted lane must not be the second data row.
    expect(lines[0]).toContain("CORRIDOR");
    expect(lines[0]).toContain("STATE");
    expect(lines[2]).toContain("ng-cn");
    expect(lines[3]).toContain("aaa-closed");
  });

  it("says so plainly when nothing has failed anywhere", () => {
    expect(formatBreakerTable([])).toContain("no breaker state recorded");
  });

  it("confirms a reset with who did it, when and why", () => {
    const out = formatBreakerReset(
      {
        corridorId: "ng-cn",
        state: "closed",
        consecutiveFailures: 0,
        resetBy: "ezedike",
        resetReason: "anchor confirmed healthy",
        resetAt: 5000,
        updatedAt: 5000,
      },
      "ezedike",
      true,
    );
    expect(out).toContain("CLOSED");
    expect(out).toContain("ezedike");
    expect(out).toContain("anchor confirmed healthy");
    // The lane really was halted, so there is no caveat to print.
    expect(out).not.toContain("not halted");
  });

  it("flags a reset of a lane that was not halted", () => {
    // Resetting a healthy lane usually means re-running a command someone
    // thought had failed. Saying "reopened" there would be a lie.
    const out = formatBreakerReset(
      {
        corridorId: "ng-cn",
        state: "closed",
        consecutiveFailures: 0,
        resetBy: "ezedike",
        resetReason: "why not",
        resetAt: 5000,
        updatedAt: 5000,
      },
      "ezedike",
      false,
    );
    expect(out).toContain("was not halted");
  });
});
