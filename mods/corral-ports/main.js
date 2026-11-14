// Ports: dev servers running on your machines, reachable here as localhost.
// Finds listening ports on every machine that has spaces (one `ss` call each),
// ties each to the Herdr terminal that started it, and forwards new ones over
// ssh automatically. Tunnels are herdr-core terminals on this computer, so they
// survive app restarts. The engine runs while the panel is hidden too.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, terminals, layout, shared, setShared, notify } from "herdr";
import { colors, alpha, CLEAR } from "./lib/theme.js";
import { sh, openUrl } from "./lib/host.js";
import { panelState } from "./lib/layout.js";
import { PORT_SCAN, parsePortScan } from "./lib/ports.js";
import { forwardsFrom, pickLocalPort, planForwards } from "./lib/forward.js";
import { machineTargets, localBusyPorts, startTunnel, stopTunnel, tunnelOutput } from "./lib/tunnels.js";

const SCAN_SHOWN_MS = 2500;    // while the Ports tab is on screen
const SCAN_HIDDEN_MS = 5000;   // otherwise: still prompt enough for auto-forward
const AUTO_KEY = "corral.ports.auto";
const STOPPED_KEY = "corral.ports.stopped";

/** @typedef {import("./lib/ports.js").Port} Port */
/** @typedef {import("./lib/forward.js").Forward} Forward */
/** @typedef {{ ports: Port[], error: string | null, at: number }} Scan */

export default class Ports extends View {
  /** @param {any} _props @param {any} cx */
  init(_props, cx) {
    /** @type {Map<string, Scan>} machine ("" = this computer) -> last scan */
    this.scans = new Map();
    /** @type {Set<string>} "machine:port" being started */
    this.pending = new Set();
    /** @type {Map<string, string>} "machine:port" -> why its tunnel failed; not retried automatically */
    this.failed = new Map();
    this.scanning = false;
    this.lastScan = 0;
    this.showHidden = false;
    /** @type {Map<string, string | null> | null} */ this.targets = null;
    this.input = InputState.new({ placeholder: "Forward a port, e.g. 8080" });
    this.input.on("submit", (/** @type {any} */ _e, /** @type {any} */ cx) => this.addManual(cx));
    cx.timer.every(1000, (/** @type {any} */ cx) => this.tick(cx));
    this.tick(cx);
  }

  get auto() { return shared(AUTO_KEY) !== false; }

  /** @returns {Set<string>} */
  get stopped() { return new Set(/** @type {string[]} */ (shared(STOPPED_KEY) ?? [])); }

  /** @param {Set<string>} set */
  setStopped(set) { setShared(STOPPED_KEY, [...set].sort()); }

  /** Machines that have spaces: "" for this computer, else the machine name. */
  machines() {
    return [...new Set(spaces().map((s) => s.machine ?? ""))].sort();
  }

  /** @param {any} cx */
  tick(cx) {
    const s = panelState(layout());
    const every = s.open && s.active === "ports" ? SCAN_SHOWN_MS : SCAN_HIDDEN_MS;
    if (!this.scanning && Date.now() - this.lastScan >= every) this.scan(cx);
  }

  /** One `ss` per machine, in parallel; then auto-forward acts on the result. @param {any} cx */
  scan(cx) {
    this.scanning = true;
    this.lastScan = Date.now();
    const list = this.machines();
    cx.spawn(async (/** @type {any} */ cx) => {
      try {
        await Promise.all(list.map(async (m) => {
          try {
            const r = await sh(m || null, PORT_SCAN, [], { timeout: 10000 });
            if (r.code === 3) this.scans.set(m, { ports: [], error: "Port scanning needs `ss` (Linux)", at: Date.now() });
            else this.scans.set(m, { ports: parsePortScan(r.stdout), error: null, at: Date.now() });
          } catch (e) {
            this.scans.set(m, { ports: this.scans.get(m)?.ports ?? [], error: e instanceof Error ? e.message : String(e), at: Date.now() });
          }
        }));
        for (const m of [...this.scans.keys()]) if (!list.includes(m)) this.scans.delete(m);
        await this.autoForward(cx);
      } finally {
        this.scanning = false;
        cx.notify();
      }
    });
  }

  /** @param {any} cx */
  async autoForward(cx) {
    /** @type {Map<string, Port[]>} */
    const listening = new Map();
    for (const [m, s] of this.scans) if (m && !s.error) listening.set(m, s.ports);
    const plan = planForwards({
      listening,
      forwards: forwardsFrom(terminals()),
      stopped: this.stopped,
      auto: this.auto,
      pending: new Set([...this.pending, ...this.failed.keys()]),
    });
    // A server that went away clears its failure too: a restart gets a fresh try.
    for (const key of [...this.failed.keys()]) {
      const at = key.lastIndexOf(":");
      const ports = listening.get(key.slice(0, at));
      if (ports && !ports.some((p) => p.port === Number(key.slice(at + 1)))) this.failed.delete(key);
    }
    if (plan.forget.length) { const s = this.stopped; for (const k of plan.forget) s.delete(k); this.setStopped(s); }
    for (const f of plan.stop) await stopTunnel(f.address);
    for (const { machine, port } of plan.start) await this.forward(machine, port, cx, true);
  }

  /**
   * @param {string} machine @param {Port} port @param {any} cx
   * @param {boolean} [announce] post the "is ready" toast
   */
  async forward(machine, port, cx, announce = false) {
    const key = `${machine}:${port.port}`;
    if (this.pending.has(key)) return;
    this.pending.add(key);
    this.failed.delete(key);
    cx.notify();
    try {
      if (!this.targets?.has(machine)) this.targets = await machineTargets();
      const target = this.targets.get(machine);
      if (target === undefined) throw new Error(`${machine} isn't a machine herdr-core knows here`);
      if (target === null) throw new Error(`${machine} is reached through a custom command; forwarding needs plain ssh`);
      const busy = await localBusyPorts();
      for (const f of forwardsFrom(terminals())) busy.add(f.local);
      const local = pickLocalPort(port.port, busy);
      if (local === null) throw new Error(`no free local port near ${port.port}`);
      const address = await startTunnel({ machine, target, local, remote: port.port, host: port.forwardHost });
      // ssh fails fast (auth, a port taken meanwhile): look again in a moment.
      cx.timer.after(2500, (/** @type {any} */ cx) => this.confirm(key, address, local, port, announce, cx));
    } catch (e) {
      this.pending.delete(key);
      this.failed.set(key, e instanceof Error ? e.message : String(e));
      cx.notify();
    }
  }

  /**
   * @param {string} key @param {string} address @param {number} local @param {Port} port
   * @param {boolean} announce @param {any} cx
   */
  confirm(key, address, local, port, announce, cx) {
    cx.spawn(async (/** @type {any} */ cx) => {
      const live = forwardsFrom(terminals()).some((f) => f.address === address && f.live);
      this.pending.delete(key);
      if (!live) {
        this.failed.set(key, (await tunnelOutput(address)) || "ssh exited");
        await stopTunnel(address);
      } else if (announce) {
        const where = this.where(key.slice(0, key.lastIndexOf(":")), port);
        notify({
          title: `${port.app} is ready`,
          body: `${where ? `${where}, ` : ""}on localhost:${local}${local !== port.port ? ` (${port.port} was busy here)` : ""}. Click to open.`,
          level: "success",
          timeout: 8000,
          action: { name: `corral-status.open-${local}` },
        });
      }
      cx.notify();
    });
  }

  /** @param {Forward} f @param {any} cx */
  stop(f, cx) {
    const s = this.stopped;
    s.add(`${f.machine}:${f.remote}`);
    this.setStopped(s);
    cx.spawn(async (/** @type {any} */ cx) => { await stopTunnel(f.address); cx.notify(); });
  }

  /** @param {string} machine @param {Port} port @param {any} cx */
  forwardByHand(machine, port, cx) {
    const s = this.stopped;
    if (s.delete(`${machine}:${port.port}`)) this.setStopped(s);
    cx.spawn(async (/** @type {any} */ cx) => { await this.forward(machine, port, cx, false); });
  }

  /** @param {any} cx */
  addManual(cx) {
    const n = Number(this.input.value().trim());
    const machine = spaces().find((s) => s.active)?.machine;
    if (!Number.isInteger(n) || n < 1 || n > 65535 || !machine) return;
    this.input.set_value("");
    /** @type {Port} */
    const port = { port: n, hosts: ["127.0.0.1"], direct: false, forwardHost: "127.0.0.1", terminal: null, pid: null, process: "", cmd: "", app: `Port ${n}`, internal: false };
    this.forwardByHand(machine, port, cx);
  }

  /** "factory-price › dev" for a port started in a Herdr terminal. @param {string} machine @param {Port} port */
  where(machine, port) {
    if (!port.terminal) return "";
    const address = machine ? `${machine}/${port.terminal}` : port.terminal;
    const term = terminals().find((t) => t.address === address);
    const spaceLabel = term?.labels?.["herdr.space"], tabLabel = term?.labels?.["herdr.tab"];
    if (!spaceLabel) return "";
    const prefix = machine ? `${machine}/` : "";
    const space = spaces().find((s) => s.id === `${prefix}${spaceLabel}` || s.id === spaceLabel);
    const tab = space?.tabs.find((t) => t.id === `${prefix}${tabLabel}` || t.id === tabLabel);
    return [space?.name, tab?.name && tab.named ? tab.name : null].filter(Boolean).join(" › ");
  }

  /** @param {any} cx */
  render(cx) {
    const t = colors();
    const forwards = forwardsFrom(terminals());
    const auto = this.auto;
    const machines = this.machines().filter((m) => this.scans.has(m));
    return v_flex().id("corral-ports").size_full().min_h(0).text_color(t.foreground).text_size(13)
      .child(h_flex().flex_none().px(12).py(10).gap(10).items_center().border_b(1).border_color(t.border)
        .child(v_flex().flex_1().min_w(0)
          .child(div().child("Auto-forward new servers"))
          .child(div().text_size(11.5).text_color(t.dim).child("Ports opened from Herdr terminals")))
        .child(div().id("corral-auto").w(36).h(20).flex_none().relative().rounded(10).cursor_pointer().bg(auto ? t.done : t.input)
          .on_click(() => setShared(AUTO_KEY, !auto))
          .child(div().absolute().top(2).left(auto ? 18 : 2).size(16).rounded(8).bg(t.solid_foreground === t.background ? t.foreground : "#ffffff"))))
      .child(v_flex().id("corral-ports-list").flex_1().min_h(0).overflow_y_scrollbar().px(8).pb(8)
        .when(!machines.length, (el) => el.child(div().p(8).text_size(12).text_color(t.dim).child("Looking for servers…")))
        .children(machines.map((m) => this.machineSection(t, cx, m, forwards))))
      .child(h_flex().flex_none().px(10).py(8).gap(8).items_center().border_t(1).border_color(t.border)
        .child(div().id("corral-port-input").flex_1().min_w(0).h(30).px(10).flex().items_center().rounded(8).border_1().border_color(t.input).bg(t.chrome)
          .on_mouse_down("left", (/** @type {any} */ _e, /** @type {any} */ cx) => cx.stop_propagation())
          .child(Input.new(this.input).w_full().text_size(12.5)))
        .child(div().id("corral-port-add").h(30).px(12).flex().items_center().rounded(8).bg(t.raised).cursor_pointer().text_size(12)
          .on_click(() => this.addManual(cx)).child("Forward")));
  }

  /** @param {Record<string, any>} t @param {any} cx @param {string} m @param {Forward[]} forwards */
  machineSection(t, cx, m, forwards) {
    const scan = this.scans.get(m);
    const ports = scan?.ports ?? [];
    const remote = m !== "";
    const mine = forwards.filter((f) => f.machine === m);
    const servers = ports.filter((p) => !p.internal);
    const hidden = ports.filter((p) => p.internal);
    const forwardedPorts = new Set(mine.map((f) => f.remote));
    const idle = remote ? servers.filter((p) => !forwardedPorts.has(p.port)) : [];
    /** @param {string} text */
    const heading = (text) => div().px(4).pt(12).pb(6).text_size(11).font_semibold().text_color(t.dim).child(text);
    return v_flex()
      .child(h_flex().px(4).pt(10).gap(8).items_center()
        .child(div().font_semibold().child(remote ? m : "This computer"))
        .child(div().text_size(11.5).text_color(t.dim).child(remote ? "→ this computer" : "already local"))
        .child(div().flex_1())
        .when(Boolean(scan?.error), (el) => el.child(div().text_size(11.5).text_color(t.ansi1).truncate().child(scan?.error ?? ""))))
      .when(remote && mine.length > 0, (el) => el.child(heading(`FORWARDED · ${mine.length}`))
        .children(mine.map((f) => this.forwardCard(t, cx, m, f, ports.find((p) => p.port === f.remote) ?? null))))
      .when(idle.length > 0, (el) => el.child(heading(`NOT FORWARDED · ${idle.length}`))
        .children(idle.map((p) => this.idleRow(t, cx, m, p))))
      .when(!remote && servers.length > 0, (el) => el.child(heading(`SERVERS · ${servers.length}`))
        .children(servers.map((p) => this.localRow(t, m, p))))
      .when(!servers.length && !mine.length, (el) => el.child(div().px(4).py(6).text_size(12).text_color(t.dim).child("No servers running in Herdr terminals")))
      .when(hidden.length > 0, (el) => el.child(div().id(`corral-hidden-${m}`).px(4).pt(8).text_size(11.5).text_color(t.dim).cursor_pointer()
        .on_click(() => { this.showHidden = !this.showHidden; cx.notify(); })
        .child(`${this.showHidden ? "▾" : "▸"} ${hidden.length} hidden: agent and system ports`)))
      .when(this.showHidden, (el) => el.children(hidden.map((p) => h_flex().px(4).h(24).gap(8).items_center().text_size(12).text_color(t.dim)
        .child(div().w(52).font_family("JetBrains Mono").child(`:${p.port}`)).child(div().truncate().child(p.process || "unknown")))));
  }

  /** @param {Record<string, any>} t @param {any} cx @param {string} m @param {Forward} f @param {Port | null} p */
  forwardCard(t, cx, m, f, p) {
    const key = `${m}:${f.remote}`;
    const url = `http://localhost:${f.local}`;
    const where = p ? this.where(m, p) : "";
    /** @param {string} id @param {string} label @param {boolean} primary @param {(e: any, cx: any) => void} click */
    const button = (id, label, primary, click) => div().id(`${id}-${key}`).h(26).px(10).flex().items_center().rounded(7).cursor_pointer().text_size(12)
      .when(primary, (el) => el.bg(t.solid).text_color(t.solid_foreground))
      .when(!primary, (el) => el.border_1().border_color(t.input).hover((s) => s.bg(t.hover)))
      .on_click(click).child(label);
    return v_flex().mb(6).p(10).gap(7).rounded(10).border_1().border_color(t.border).bg(t.surface)
      .child(h_flex().gap(8).items_center()
        .child(div().font_family("JetBrains Mono").font_semibold().child(`:${f.remote}`))
        .child(div().font_medium().child(p?.app ?? "Server"))
        .child(div().flex_1())
        .child(h_flex().gap(5).items_center().text_size(11.5).text_color(f.live ? t.done : t.ansi1)
          .child(div().size(6).rounded(3).bg(f.live ? t.done : t.ansi1)).child(f.live ? (p ? "live" : "server stopped") : "tunnel down")))
      .when(Boolean(where), (el) => el.child(div().text_size(12).text_color(t.muted).truncate().child(where)))
      .child(h_flex().gap(8).items_center().text_size(12)
        .child(div().font_family("JetBrains Mono").text_color(t.accent).child(`localhost:${f.local}`))
        .when(f.local !== f.remote, (el) => el.child(div().text_color(t.blocked).child(`:${f.remote} busy here`))))
      .child(h_flex().gap(6)
        .child(button("corral-open", "Open", true, () => openUrl(url)))
        .child(button("corral-copy", "Copy URL", false, (/** @type {any} */ _e, /** @type {any} */ cx) => cx.write_to_clipboard(url)))
        .child(div().flex_1())
        .child(button("corral-stop", "Stop", false, () => this.stop(f, cx))));
  }

  /** @param {Record<string, any>} t @param {any} cx @param {string} m @param {Port} p */
  idleRow(t, cx, m, p) {
    const key = `${m}:${p.port}`;
    const busy = this.pending.has(key);
    const failure = this.failed.get(key);
    const stopped = this.stopped.has(key);
    return v_flex().px(4).py(6).gap(3)
      .child(h_flex().gap(10).items_center()
        .child(div().w(52).flex_none().font_family("JetBrains Mono").font_medium().child(`:${p.port}`))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().child(p.app))
          .child(div().truncate().text_size(12).text_color(t.dim).child([this.where(m, p), stopped ? "stopped by you" : ""].filter(Boolean).join(" · "))))
        .child(div().id(`corral-fwd-${key}`).h(26).px(10).flex().items_center().rounded(7).text_size(12)
          .bg(busy ? t.raised : t.selected).text_color(busy ? t.dim : t.foreground).when(!busy, (el) => el.cursor_pointer())
          .on_click(() => { if (!busy) this.forwardByHand(m, p, cx); })
          .child(busy ? "Forwarding…" : failure ? "Retry" : "Forward")))
      .when(Boolean(failure), (el) => el.child(div().pl(62).text_size(11.5).text_color(t.ansi1).child(failure ?? "")));
  }

  /** @param {Record<string, any>} t @param {string} m @param {Port} p */
  localRow(t, m, p) {
    const url = `http://localhost:${p.port}`;
    return h_flex().id(`corral-local-${p.port}`).px(4).py(6).gap(10).items_center()
      .child(div().w(52).flex_none().font_family("JetBrains Mono").font_medium().child(`:${p.port}`))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().child(p.app))
        .child(div().truncate().text_size(12).text_color(t.dim).child(this.where(m, p))))
      .child(div().id(`corral-local-open-${p.port}`).h(26).px(10).flex().items_center().rounded(7).bg(t.solid).text_color(t.solid_foreground).cursor_pointer().text_size(12)
        .on_click(() => openUrl(url)).child("Open"));
  }
}
