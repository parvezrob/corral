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
  assert.deepEqual(sshArgs({ target: "robin@box", local: 5173, remote: 5173 }).slice(-3), ["-L", "127.0.0.1:5173:127.0.0.1:5173", "robin@box"]);
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
  const stopped = new Set(["box:6006", "box:4000"]);
  const plan = planForwards({ listening, forwards, stopped, auto: true, pending: new Set() });
  assert.deepEqual(plan.start.map((s) => s.port.port), [5173]);
  assert.deepEqual(plan.stop.map((f) => f.address), ["t8"]);
  assert.deepEqual(plan.forget, ["box:4000"]);
  assert.deepEqual(planForwards({ listening, forwards, stopped, auto: false }).start, []);
  assert.deepEqual(planForwards({ listening, forwards, stopped, auto: true, pending: new Set(["box:5173"]) }).start, []);
});
