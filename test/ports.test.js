import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { parseSs, parsePortScan, scopeOf, forwardHostFor, appName, PORT_SCAN, SECTION } from "../lib/ports.js";

const SS = [
  'LISTEN 0      511        127.0.0.1:5173       0.0.0.0:*    users:(("node",pid=4242,fd=23))',
  'LISTEN 0      511            [::1]:5173          [::]:*    users:(("node",pid=4242,fd=24))',
  'LISTEN 0      4096       127.0.0.1:41609      0.0.0.0:*    users:(("claude",pid=95610,fd=24))',
  'LISTEN 0      128          0.0.0.0:3000       0.0.0.0:*    users:(("next-server (v1",pid=5000,fd=20))',
  "LISTEN 0      4096 100.118.42.48%tailscale0:443 0.0.0.0:*",
  'LISTEN 0      128          0.0.0.0:6006       0.0.0.0:*    users:(("node",pid=6000,fd=20))',
].join("\n");

test("scope of an address", () => {
  assert.equal(scopeOf("127.0.0.1"), "loopback");
  assert.equal(scopeOf("::1"), "loopback");
  assert.equal(scopeOf("0.0.0.0"), "all");
  assert.equal(scopeOf("*"), "all");
  assert.equal(scopeOf("100.118.42.48"), "tailnet");
  assert.equal(scopeOf("100.12.0.1"), "other");
  assert.equal(scopeOf("192.168.1.4"), "other");
});

test("parses ss lines: IPv6 brackets, interfaces, missing process", () => {
  const s = parseSs(SS);
  assert.equal(s.length, 6);
  assert.deepEqual(s[1], { port: 5173, host: "::1", scope: "loopback", processes: [{ name: "node", pid: 4242 }] });
  assert.deepEqual(s[4], { port: 443, host: "100.118.42.48", scope: "tailnet", processes: [] });
  assert.equal(s[3].processes[0].name, "next-server (v1");
});

test("joins sockets with their Herdr terminals and names the app", () => {
  const procs = [
    "4242\tt7\tnode /home/r/app/node_modules/.bin/vite",
    "95610\tt3\tclaude",
    "5000\tt9\tnext-server (v15.1.0)",
    "6000\t\tnode /x/storybook dev -p 6006",
  ].join("\n");
  const ports = parsePortScan(`${SS}\n${SECTION}\n${procs}\n`);
  assert.deepEqual(ports.map((p) => p.port), [443, 3000, 5173, 6006, 41609]);
  const byPort = Object.fromEntries(ports.map((p) => [p.port, p]));

  assert.equal(byPort[5173].app, "Vite");
  assert.equal(byPort[5173].terminal, "t7");
  assert.deepEqual(byPort[5173].hosts, ["127.0.0.1", "::1"]);
  assert.equal(byPort[5173].direct, false);
  assert.equal(byPort[5173].forwardHost, "127.0.0.1");
  assert.equal(byPort[5173].internal, false);

  assert.equal(byPort[3000].app, "Next.js");
  assert.equal(byPort[3000].direct, true);

  assert.equal(byPort[41609].internal, true, "an agent's own socket is internal");
  assert.equal(byPort[6006].internal, true, "not started from a Herdr terminal");
  assert.equal(byPort[443].internal, true, "no visible process");
});

test("forward host prefers IPv4 loopback, falls back to ::1", () => {
  assert.equal(forwardHostFor(["::1"]), "::1");
  assert.equal(forwardHostFor(["::1", "127.0.0.1"]), "127.0.0.1");
  assert.equal(forwardHostFor(["0.0.0.0"]), "127.0.0.1");
});

test("app names", () => {
  assert.equal(appName("python3 -m http.server 8000"), "Python http.server");
  assert.equal(appName("python manage.py runserver"), "Django");
  assert.equal(appName("/usr/bin/some-tool --serve", "some-tool"), "some-tool");
  assert.equal(appName("", "beam.smp"), "beam.smp");
});

test("the scan script runs on this machine and parses", (t) => {
  if (process.platform !== "linux") { t.skip("PORT_SCAN is Linux-only"); return; }
  let out;
  try { out = execFileSync("sh", ["-c", PORT_SCAN], { encoding: "utf8" }); }
  catch (e) { if (e.status === 3) { t.skip("no ss here"); return; } throw e; }
  const ports = parsePortScan(out);
  assert.ok(Array.isArray(ports));
  for (const p of ports) assert.ok(Number.isInteger(p.port) && p.port > 0);
});
