import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USAGE_SCRIPT, USER_AGENT, parseUsage, parseClaude, parseCodex, pace, until, chipText, level, worst } from "../lib/usage.js";

const NOW = Date.parse("2026-11-14T17:00:00Z");

const CLAUDE = {
  five_hour: null,
  seven_day: { utilization: 42.0, resets_at: "2026-11-18T10:00:00+00:00" },
  limits: [
    { kind: "weekly_all", group: "weekly", percent: 42, severity: "normal", resets_at: "2026-11-18T10:00:00+00:00", scope: null, is_active: true },
    { kind: "weekly_scoped", group: "weekly", percent: 21, severity: "normal", resets_at: "2026-11-18T10:00:00+00:00", scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: false },
    { kind: "session", group: "session", percent: 12, severity: "normal", resets_at: "2026-11-14T19:14:00+00:00", scope: null, is_active: true },
  ],
  spend: { used: { amount_minor: 0, currency: "USD", exponent: 2 }, limit: { amount_minor: 1000, currency: "USD", exponent: 2 }, enabled: true },
};

const CODEX = {
  id: 2,
  result: {
    rateLimits: { limitId: "codex", primary: { usedPercent: 33, windowDurationMins: 10080, resetsAt: 1795228292 }, secondary: null, credits: { hasCredits: true, unlimited: false, balance: "2102.3765045000" }, planType: "pro" },
    rateLimitsByLimitId: { codex: { limitId: "codex", limitName: null, primary: { usedPercent: 33, windowDurationMins: 10080, resetsAt: 1795228292 }, secondary: { usedPercent: 9, windowDurationMins: 300, resetsAt: 1794690000 }, planType: "pro" } },
    rateLimitResetCredits: { availableCount: 1, credits: [] },
  },
};

test("Claude: limits in Claude's order, plan, extra usage", () => {
  const p = parseClaude(`max\x1f${JSON.stringify(CLAUDE)}\n200`);
  assert.equal(p.error, null);
  assert.equal(p.plan, "Max");
  assert.deepEqual(p.limits.map((l) => [l.label, l.short, l.percent]), [
    ["Current session", "5h", 12], ["Weekly · all models", "wk", 42], ["Weekly · Fable", "Fable wk", 21],
  ]);
  assert.deepEqual(p.extras, ["Extra usage $0.00 of $10.00"]);
  assert.equal(chipText(p), "42% wk");
});

test("Claude: older answers without limits[], and every failure in words", () => {
  const p = parseClaude(`pro\x1f${JSON.stringify({ five_hour: { utilization: 80, resets_at: "2026-11-14T18:00:00Z" }, seven_day: null })}\n200`);
  assert.deepEqual(p.limits.map((l) => [l.label, l.percent]), [["Current session", 80]]);
  assert.match(parseClaude("!nologin").error ?? "", /Not signed in/);
  assert.match(parseClaude("!expired").error ?? "", /expired/);
  assert.match(parseClaude("max\x1f{}\n401").error ?? "", /expired/);
  assert.match(parseClaude("max\x1fbusy\n529").error ?? "", /529/);
  assert.match(parseClaude("max\x1fcurl: (6) Could not resolve host\n000").error ?? "", /reach.*resolve host/);
});

test("Codex: windows, credits, free resets", () => {
  const p = parseCodex(JSON.stringify(CODEX));
  assert.equal(p.plan, "Pro");
  assert.deepEqual(p.limits.map((l) => [l.label, l.short, l.percent]), [["5-hour window", "5h", 9], ["Weekly", "wk", 33]]);
  assert.deepEqual(p.extras, ["Credits 2,102", "1 free reset available"]);
  assert.equal(chipText(p), "33% wk");
  assert.match(parseCodex("!missing").error ?? "", /isn't installed/);
  assert.match(parseCodex('{"id":2,"error":{"message":"not logged in"}}').error ?? "", /not logged in/);
});

test("pace, time left and levels", () => {
  const week = 7 * 864e5;
  const at = (percent, leftMs, windowMs = week) => ({ label: "", short: "", percent, resetsAt: NOW + leftMs, windowMs });
  assert.equal(pace(at(38, 3.8 * 864e5), NOW), "On pace for ~85% at reset");
  assert.equal(pace(at(5, 6.9 * 864e5), NOW), "Light pace");
  assert.equal(pace(at(10, 3.5 * 864e5), NOW), "Light pace");
  assert.equal(pace(at(24, 11 * 36e5), NOW), "Will reset before you run out");
  assert.match(pace(at(80, 3.5 * 864e5), NOW), /^At this pace it runs out in /);
  assert.equal(pace(at(100, 1000), NOW), "Limit reached");
  assert.equal(until(NOW + (3 * 864e5 + 19 * 36e5), NOW), "3d 19h");
  assert.equal(until(NOW + (2 * 36e5 + 14 * 6e4), NOW), "2h 14m");
  assert.equal(until(NOW + 30e3, NOW), "1m");
  assert.deepEqual([level(10), level(80), level(95)], ["normal", "warn", "high"]);
  assert.equal(worst({ id: "codex", name: "", plan: "", limits: [], extras: [], error: null }), null);
});

test("the script reads both logins; the Claude token goes on stdin, never argv", () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-usage-"));
  try {
    const home = join(dir, "home"), bin = join(dir, "bin");
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(bin);
    const future = Date.now() + 3600e3;
    writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-SECRET", refreshToken: "r", expiresAt: future, subscriptionType: "max" } }, null, 2));
    writeFileSync(join(bin, "curl"), `#!/bin/sh
printf '%s\\n' "$@" > "${join(dir, "curl-argv")}"
cat > "${join(dir, "curl-stdin")}"
printf '%s' '${JSON.stringify({ limits: CLAUDE.limits })}'
printf '\\n200'
`);
    writeFileSync(join(bin, "codex"), `#!/bin/sh
while IFS= read -r line; do
  case $line in *'"id":2'*) printf '%s\\n' '${JSON.stringify(CODEX)}' ;; esac
done
`);
    chmodSync(join(bin, "curl"), 0o755);
    chmodSync(join(bin, "codex"), 0o755);
    const out = execFileSync("sh", ["-c", USAGE_SCRIPT, "corral", USER_AGENT], { encoding: "utf8", env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: "" } });
    const u = parseUsage(out);
    assert.equal(u.claude.error, null);
    assert.equal(u.claude.plan, "Max");
    assert.equal(u.claude.limits.length, 3);
    assert.equal(u.codex.error, null);
    assert.equal(u.codex.limits.length, 2);
    const argv = readFileSync(join(dir, "curl-argv"), "utf8");
    assert.doesNotMatch(argv, /SECRET/);
    assert.match(argv, /oauth-2025-04-20/);
    assert.match(argv, /corral-herdr-mod/);
    assert.equal(readFileSync(join(dir, "curl-stdin"), "utf8"), "Authorization: Bearer sk-ant-oat01-SECRET\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an expired login isn't sent anywhere", () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-usage-"));
  try {
    mkdirSync(join(dir, ".claude"));
    writeFileSync(join(dir, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "tok", expiresAt: 1000 } }));
    const out = execFileSync("sh", ["-c", USAGE_SCRIPT, "corral", USER_AGENT], { encoding: "utf8", env: { ...process.env, HOME: dir, PATH: "/usr/bin:/bin", CLAUDE_CONFIG_DIR: "" } });
    assert.match(parseUsage(out).claude.error ?? "", /expired/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("popover height follows what it shows", async () => {
  const { popoverHeight, shownProviders } = await import("../lib/usage.js");
  const claude = parseClaude(`max\x1f${JSON.stringify({ limits: CLAUDE.limits.slice(0, 2), spend: CLAUDE.spend })}\n200`);
  const codex = parseCodex(JSON.stringify({ id: 2, result: { rateLimits: { primary: { usedPercent: 33, windowDurationMins: 10080, resetsAt: 1795228292 }, credits: { hasCredits: true, balance: "2102.4" } }, rateLimitResetCredits: { availableCount: 1 } } }));
  // Measured from the drawn popover: 462 px detailed, about 176 compact.
  assert.equal(popoverHeight({ claude, codex }, false), 466);
  assert.equal(popoverHeight({ claude, codex }, true), 180);
  const missing = parseCodex("!missing");
  assert.deepEqual(shownProviders({ claude, codex: missing }).map((p) => p.id), ["claude"]);
  assert.equal(popoverHeight(null, false), 126);
});

test("Claude's own token, not an MCP server's stored after it", () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-usage-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    mkdirSync(bin);
    const future = Date.now() + 3600e3;
    writeFileSync(join(dir, ".claude", ".credentials.json"), JSON.stringify({
      claudeAiOauth: { accessToken: "CLAUDE_TOK", expiresAt: future, subscriptionType: "max", scopes: ["user:inference"] },
      mcpOAuth: { "srv|1": { accessToken: "MCP_TOK", expiresAt: 1000 } },
    }));
    writeFileSync(join(bin, "curl"), `#!/bin/sh\ncat > "${join(dir, "stdin")}"\nprintf '{"limits":[]}\\n200'\n`);
    chmodSync(join(bin, "curl"), 0o755);
    const out = execFileSync("sh", ["-c", USAGE_SCRIPT, "corral", USER_AGENT], { encoding: "utf8", env: { ...process.env, HOME: dir, PATH: `${bin}:/usr/bin:/bin`, CLAUDE_CONFIG_DIR: "" } });
    assert.equal(readFileSync(join(dir, "stdin"), "utf8"), "Authorization: Bearer CLAUDE_TOK\n");
    assert.equal(parseUsage(out).claude.plan, "Max");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex answers on a machine without timeout(1), like macOS", () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-usage-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    for (const tool of ["sh", "mktemp", "mkfifo", "rm", "sleep", "sed", "tr", "date", "cat"]) {
      const real = execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim();
      symlinkSync(real, join(bin, tool));
    }
    writeFileSync(join(bin, "codex"), `#!/bin/sh\nwhile IFS= read -r line; do case $line in *'"id":2'*) printf '%s\\n' '${JSON.stringify(CODEX)}' ;; esac; done\n`);
    chmodSync(join(bin, "codex"), 0o755);
    const started = Date.now();
    const out = execFileSync(join(bin, "sh"), ["-c", USAGE_SCRIPT, "corral", USER_AGENT], { encoding: "utf8", env: { HOME: dir, PATH: bin } });
    assert.equal(parseUsage(out).codex.error, null);
    assert.ok(Date.now() - started < 5000, "doesn't wait for the watchdog");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
