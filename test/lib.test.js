import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { quote, splitNul, splitSections, SECTION } from "../lib/sh.js";
import { sshArgs, pickLocalPort, forwardsFrom, parseLsofListen, terminalName, LABEL } from "../lib/forward.js";
import { join, normalize, basename, dirname, relative, extension } from "../lib/paths.js";

test("quote survives a real shell", () => {
  for (const v of ["plain", "with space", "it's", "$HOME `x` \"q\"", "", "a\nb", "--flag"]) {
    assert.equal(execFileSync("sh", ["-c", `printf %s ${quote(v)}`], { encoding: "utf8" }), v);
  }
});

test("NUL and section splitting", () => {
  assert.deepEqual(splitNul("a\0b c\0"), ["a", "b c"]);
  assert.deepEqual(splitNul(""), []);
  assert.deepEqual(splitSections(`one\n${SECTION}\ntwo\n`), ["one", "two\n"]);
  assert.deepEqual(splitSections(`\n${SECTION}\n`), ["", ""]);
});

test("ssh tunnel arguments", () => {
  assert.deepEqual(sshArgs({ target: "robin@box", local: 5173, remote: 5173 }).slice(-4), ["-L", "127.0.0.1:5173:127.0.0.1:5173", "--", "robin@box"]);
  assert.ok(sshArgs({ target: "box", local: 3001, remote: 3000, host: "::1" }).includes("127.0.0.1:3001:[::1]:3000"));
  assert.ok(sshArgs({ target: "box", local: 1, remote: 1 }).includes("BatchMode=yes"));
  assert.match(terminalName(65535), /^[a-z0-9_-]{1,32}$/);
});

test("local port choice keeps the number when free", () => {
  assert.equal(pickLocalPort(5173, new Set()), 5173);
  assert.equal(pickLocalPort(3000, new Set([3000, 3001])), 3002);
  assert.equal(pickLocalPort(65535, new Set([65535])), null);
});

test("finds forwards among terminals by label", () => {
  const terminals = [
    { address: "t1", state: "live", labels: { [LABEL.forward]: "workstation:5173", [LABEL.local]: "5173" } },
    { address: "t2", state: "finished", labels: { [LABEL.forward]: "a:b:3000", [LABEL.local]: "3001" } },
    { address: "t3", state: "live", labels: { "herdr.space": "sp1" } },
    { address: "t4", labels: { [LABEL.forward]: "broken", [LABEL.local]: "x" } },
  ];
  assert.deepEqual(forwardsFrom(terminals), [
    { address: "t1", machine: "workstation", remote: 5173, local: 5173, live: true },
    { address: "t2", machine: "a:b", remote: 3000, local: 3001, live: false },
  ]);
});

test("lsof listen parsing", () => {
  assert.deepEqual([...parseLsofListen("p123\nf4\nn127.0.0.1:5173\nn*:22\nn[::1]:3000\n")].sort((a, b) => a - b), [22, 3000, 5173]);
});

test("posix paths", () => {
  assert.equal(join("/home/r", "app", "../x", "y.js"), "/home/r/x/y.js");
  assert.equal(normalize("a//b/./c/"), "a/b/c");
  assert.equal(normalize("/../a"), "/a");
  assert.equal(basename("/a/b/c.md"), "c.md");
  assert.equal(dirname("/a/b/c.md"), "/a/b");
  assert.equal(dirname("/a"), "/");
  assert.equal(relative("/a/b", "/a/b/c/d.js"), "c/d.js");
  assert.equal(relative("/a/b", "/a/bc/d.js"), null);
  assert.equal(relative("/", "/etc/x"), "etc/x");
  assert.equal(extension("README.MD"), "md");
  assert.equal(extension(".gitignore"), "");
});

test("auto-forward plan", async () => {
  const { planForwards } = await import("../lib/forward.js");
  const port = (n, extra = {}) => ({ port: n, hosts: ["127.0.0.1"], direct: false, forwardHost: "127.0.0.1", terminal: "t1", pid: 1, process: "node", cmd: "", app: "Vite", internal: false, ...extra });
  const listening = new Map([["box", [port(5173), port(3000), port(41609, { internal: true }), port(6006)]]]);
  const forwards = [
    { address: "t9", machine: "box", remote: 3000, local: 3001, live: true },
    { address: "t8", machine: "box", remote: 8080, local: 8080, live: true },   // its server is gone
    { address: "t7", machine: "other", remote: 9000, local: 9000, live: true }, // another machine: untouched
  ];
  const stopped = new Set(["box:6006", "box:4000", "gone:22"]);
  const machines = new Set(["box", "other"]);
  // t8's server has been missing for 3 scans; t7's machine "other" wasn't scanned now.
  const missing = new Map([["box:8080", 3]]);
  const plan = planForwards({ listening, forwards, stopped, auto: true, pending: new Set(), machines, missing });
  assert.deepEqual(plan.start.map((s) => s.port.port), [5173]);
  assert.deepEqual(plan.stop.map((f) => f.address), ["t8"]);
  assert.deepEqual(plan.remove, []);
  assert.deepEqual(plan.forget, ["gone:22"], "a stopped server stays stopped; only gone machines are forgotten");
  // Missing once (a restart): the tunnel stays.
  assert.deepEqual(planForwards({ listening, forwards, stopped, auto: true, machines, missing: new Map([["box:8080", 1]]) }).stop, []);
  // A tunnel whose ssh ended is removed and its server forwarded again.
  const dead = forwards.map((f) => (f.address === "t9" ? { ...f, live: false } : f));
  const again = planForwards({ listening, forwards: dead, stopped, auto: true, machines, missing });
  assert.deepEqual(again.remove.map((f) => f.address), ["t9"]);
  assert.deepEqual(again.start.map((s) => s.port.port).sort(), [3000, 5173]);
  // A machine with no spaces left: its tunnels stop.
  assert.deepEqual(planForwards({ listening, forwards, stopped, auto: true, machines: new Set(["box"]), missing: new Map() }).stop.map((f) => f.address), ["t7"]);
  assert.deepEqual(planForwards({ listening, forwards, stopped, auto: false, machines }).start, []);
  assert.deepEqual(planForwards({ listening, forwards, stopped, auto: true, pending: new Set(["box:5173"]) }).start, []);
});

test("ssh targets with a port, and the missing-scan count", async () => {
  const { sshArgs, splitTarget, countMissing } = await import("../lib/forward.js");
  assert.deepEqual(splitTarget("robin@robin-pc"), { dest: "robin@robin-pc", port: null });
  assert.deepEqual(splitTarget("can@10.0.0.7:2222"), { dest: "can@10.0.0.7", port: "2222" });
  assert.deepEqual(splitTarget("u@[fd7a::1]:2200"), { dest: "u@fd7a::1", port: "2200" });
  assert.deepEqual(splitTarget("fd7a::1"), { dest: "fd7a::1", port: null });
  const args = sshArgs({ target: "can@10.0.0.7:2222", local: 3000, remote: 3000 });
  assert.deepEqual(args.slice(-4), ["-L", "127.0.0.1:3000:127.0.0.1:3000", "--", "can@10.0.0.7"]);
  assert.ok(args.includes("-p") && args[args.indexOf("-p") + 1] === "2222");
  assert.ok(args.includes("ConnectTimeout=10"));
  assert.deepEqual(args.slice(-2), ["--", "can@10.0.0.7"]);
  const missing = new Map();
  const fwd = [{ address: "t1", machine: "box", remote: 3000, local: 3000, live: true }];
  countMissing(missing, new Map([["box", []]]), fwd);
  countMissing(missing, new Map([["box", []]]), fwd);
  assert.equal(missing.get("box:3000"), 2);
  countMissing(missing, new Map([["box", [{ port: 3000 }]]]), fwd);
  assert.equal(missing.has("box:3000"), false);
});
