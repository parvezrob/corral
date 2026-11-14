// Agent plan usage: Claude and Codex limits, read on the machine whose logins
// they are. Read-only: the Claude token is passed to curl on stdin (never in
// argv) and never refreshed; Codex answers through its own app server, which
// holds its login. Pure: the script, parsing and wording.

/** Sent as the User-Agent so Anthropic can tell what's asking. */
export const USER_AGENT = "corral-herdr-mod/0.1 (usage read)";

/**
 * `sh -c USAGE_SCRIPT corral <user agent>`: the Claude part, \x1e, the Codex part.
 * Claude: "<plan>\x1f<body>\n<http code>", or "!nologin" / "!expired" / "!nocurl".
 * Codex: the JSON-RPC reply line, or "!missing" / "!noreply".
 */
export const USAGE_SCRIPT = `claude() {
  f="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json"
  creds=
  if [ -r "$f" ]; then creds=$(tr -d '\\n' < "$f")
  elif command -v security >/dev/null 2>&1; then creds=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null)
  fi
  tok=$(printf '%s' "$creds" | sed -n 's/.*"accessToken" *: *"\\([^"]*\\)".*/\\1/p')
  [ -n "$tok" ] || { printf '!nologin'; return; }
  exp=$(printf '%s' "$creds" | sed -n 's/.*"expiresAt" *: *\\([0-9]*\\).*/\\1/p')
  now=$(date +%s)
  [ -n "$exp" ] && [ "$exp" -lt "\${now}000" ] && { printf '!expired'; return; }
  command -v curl >/dev/null 2>&1 || { printf '!nocurl'; return; }
  printf '%s\\037' "$(printf '%s' "$creds" | sed -n 's/.*"subscriptionType" *: *"\\([^"]*\\)".*/\\1/p')"
  printf 'Authorization: Bearer %s\\n' "$tok" | curl -sS --max-time 15 -H @- -H 'anthropic-beta: oauth-2025-04-20' -A "$1" \\
    -w '\\n%{http_code}' https://api.anthropic.com/api/oauth/usage 2>&1
}
codex() {
  command -v codex >/dev/null 2>&1 || { printf '!missing'; return; }
  d=$(mktemp -d) || return
  mkfifo "$d/in" "$d/out" || { rm -rf "$d"; return; }
  timeout 15 codex app-server < "$d/in" > "$d/out" 2>/dev/null &
  pid=$!
  exec 3>"$d/in" 4<"$d/out"
  printf '%s\\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"corral","title":"Corral for Herdr","version":"0.1.0"}}}' \\
    '{"jsonrpc":"2.0","method":"initialized"}' '{"jsonrpc":"2.0","id":2,"method":"account/rateLimits/read"}' >&3
  found=
  while IFS= read -r line <&4; do
    case $line in *'"id":2,'*|*'"id":2}'*) printf '%s' "$line"; found=1; break ;; esac
  done
  exec 3>&- 4<&-
  kill "$pid" 2>/dev/null
  rm -rf "$d"
  [ -n "$found" ] || printf '!noreply'
}
claude "$1"
printf '\\036'
codex`;

/**
 * @typedef {object} Limit
 * @property {string} label     "Current session", "Weekly · all models"
 * @property {string} short     "5h", "wk", "Fable wk": for the status bar
 * @property {number} percent   0–100
 * @property {number | null} resetsAt  ms
 * @property {number} windowMs  the window's length, for pace
 *
 * @typedef {object} Provider
 * @property {"claude" | "codex"} id
 * @property {string} name
 * @property {string} plan        "Max", "Pro", or ""
 * @property {Limit[]} limits
 * @property {string[]} extras    "Extra usage $0.00 of $10.00", "Credits 2,102"
 * @property {string | null} error  why there are no numbers
 *
 * @typedef {{ claude: Provider, codex: Provider }} Usage
 */

const HOUR = 3600e3;
const DAY = 24 * HOUR;

/** @param {string} stdout USAGE_SCRIPT's output @returns {Usage} */
export function parseUsage(stdout) {
  const at = stdout.indexOf("\x1e");
  const claudePart = at < 0 ? stdout : stdout.slice(0, at);
  const codexPart = at < 0 ? "" : stdout.slice(at + 1);
  return { claude: parseClaude(claudePart.trim()), codex: parseCodex(codexPart.trim()) };
}

/** @param {"claude" | "codex"} id @param {string} name @returns {Provider} */
function empty(id, name) {
  return { id, name, plan: "", limits: [], extras: [], error: null };
}

/** @param {string} plan */
function planName(plan) {
  const p = plan.trim();
  return p ? p[0].toUpperCase() + p.slice(1) : "";
}

/** @param {string} part @returns {Provider} */
export function parseClaude(part) {
  const p = empty("claude", "Claude");
  if (part === "!nologin") { p.error = "Not signed in to Claude Code on this machine."; return p; }
  if (part === "!expired") { p.error = "Claude's login has expired. It renews the next time Claude Code runs here."; return p; }
  if (part === "!nocurl") { p.error = "curl isn't installed on this machine."; return p; }
  const cut = part.indexOf("\x1f");
  const plan = cut < 0 ? "" : part.slice(0, cut);
  const rest = cut < 0 ? part : part.slice(cut + 1);
  const nl = rest.lastIndexOf("\n");
  const body = nl < 0 ? rest : rest.slice(0, nl);
  const code = nl < 0 ? "" : rest.slice(nl + 1).trim();
  p.plan = planName(plan);
  if (code === "401") { p.error = "Claude's login has expired. It renews the next time Claude Code runs here."; return p; }
  if (code !== "200") { p.error = code ? `Claude's usage service answered ${code}.` : body.split("\n")[0] || "No answer from Claude."; return p; }
  /** @type {any} */
  let d;
  try { d = JSON.parse(body); } catch { p.error = "Claude's usage service sent something unexpected."; return p; }
  for (const l of d.limits ?? []) {
    const model = l.scope?.model?.display_name ?? null;
    const weekly = l.group === "weekly" || /week|seven/.test(l.kind ?? "");
    const session = !weekly && /session|five|hour/.test(`${l.group} ${l.kind}`);
    p.limits.push({
      label: weekly ? `Weekly · ${model ?? "all models"}` : session ? "Current session" : humanize(l.kind ?? "limit"),
      short: weekly ? (model ? `${model} wk` : "wk") : session ? "5h" : humanize(l.kind ?? "").toLowerCase(),
      percent: clamp(l.percent),
      resetsAt: time(l.resets_at),
      windowMs: weekly ? 7 * DAY : 5 * HOUR,
    });
  }
  if (!p.limits.length) {
    if (d.five_hour) p.limits.push({ label: "Current session", short: "5h", percent: clamp(d.five_hour.utilization), resetsAt: time(d.five_hour.resets_at), windowMs: 5 * HOUR });
    if (d.seven_day) p.limits.push({ label: "Weekly · all models", short: "wk", percent: clamp(d.seven_day.utilization), resetsAt: time(d.seven_day.resets_at), windowMs: 7 * DAY });
  }
  // Sessions first, then weekly, as Claude shows them.
  p.limits.sort((a, b) => a.windowMs - b.windowMs);
  const spend = d.spend;
  if (spend?.enabled && spend.limit) p.extras.push(`Extra usage ${money(spend.used)} of ${money(spend.limit)}`);
  return p;
}

/** @param {string} part @returns {Provider} */
export function parseCodex(part) {
  const p = empty("codex", "Codex");
  if (part === "!missing" || part === "") { p.error = "Codex isn't installed on this machine."; return p; }
  if (part === "!noreply") { p.error = "Codex didn't answer. Is it signed in here?"; return p; }
  /** @type {any} */
  let d;
  try { d = JSON.parse(part); } catch { p.error = "Codex sent something unexpected."; return p; }
  if (d.error) { p.error = d.error.message ?? "Codex couldn't read its limits."; return p; }
  const r = d.result ?? {};
  const all = r.rateLimitsByLimitId ? Object.values(r.rateLimitsByLimitId) : r.rateLimits ? [r.rateLimits] : [];
  for (const set of /** @type {any[]} */ (all)) {
    const name = set.limitName ?? (set.limitId && set.limitId !== "codex" ? humanize(set.limitId) : "");
    for (const w of [set.primary, set.secondary]) {
      if (!w) continue;
      const mins = Number(w.windowDurationMins) || 0;
      const base = mins === 300 ? "5-hour window" : mins === 10080 ? "Weekly" : mins ? `${Math.round(mins / 60)}-hour window` : "Limit";
      const short = mins === 300 ? "5h" : mins === 10080 ? "wk" : mins ? `${Math.round(mins / 60)}h` : "";
      p.limits.push({
        label: name ? `${base} · ${name}` : base,
        short: name ? `${name} ${short}` : short,
        percent: clamp(w.usedPercent),
        resetsAt: w.resetsAt ? Number(w.resetsAt) * 1000 : null,
        windowMs: (mins || 10080) * 60e3,
      });
    }
    if (!p.plan && set.planType) p.plan = planName(String(set.planType));
  }
  p.limits.sort((a, b) => a.windowMs - b.windowMs);
  const credits = r.rateLimits?.credits;
  if (credits?.unlimited) p.extras.push("Unlimited credits");
  else if (credits?.hasCredits && credits.balance !== undefined) p.extras.push(`Credits ${thousands(Math.floor(Number(credits.balance)))}`);
  const resets = r.rateLimitResetCredits?.availableCount ?? 0;
  if (resets > 0) p.extras.push(`${resets} free ${resets === 1 ? "reset" : "resets"} available`);
  return p;
}

/** Providers worth showing: numbers, or a problem other than "not installed". @param {{ claude: Provider, codex: Provider } | null} u */
export function shownProviders(u) {
  return u ? [u.claude, u.codex].filter((p) => p.limits.length || (p.error && !/isn't installed/.test(p.error))) : [];
}

/**
 * The popover's height for what it will show, so it can open right above the
 * chip at its real size. Measured from the drawn popover; it scrolls if short.
 * @param {{ claude: Provider, codex: Provider } | null} u @param {boolean} compact
 */
export function popoverHeight(u, compact) {
  const shown = shownProviders(u);
  const chrome = 56 + 46;   // header and footer, with padding
  if (!shown.length) return chrome + 24;
  if (compact) {
    const rows = shown.reduce((n, p) => n + Math.max(1, p.limits.length), 0);
    return chrome + rows * 20 + (rows - 1) * 7 + 4;
  }
  const cards = shown.map((p) => 51 + p.limits.length * 65 + (p.extras.length ? 25 : 0) + (p.error ? 26 : 0));
  return chrome + cards.reduce((a, b) => a + b, 0) + (cards.length - 1) * 13 + 4;
}

/** The limit closest to running out, for the status bar. @param {Provider} p */
export function worst(p) {
  return p.limits.reduce((/** @type {Limit | null} */ w, l) => (!w || l.percent > w.percent ? l : w), null);
}

/** "38% wk". @param {Provider} p */
export function chipText(p) {
  const w = worst(p);
  return w ? `${Math.round(w.percent)}%${w.short ? ` ${w.short}` : ""}` : "";
}

/** "normal" under 75%, "warn" to 90%, "high" beyond. @param {number} percent */
export function level(percent) {
  return percent >= 90 ? "high" : percent >= 75 ? "warn" : "normal";
}

/**
 * Where this window is heading, from how much of it has passed.
 * @param {Limit} l @param {number} [now]
 */
export function pace(l, now = Date.now()) {
  if (l.percent >= 100) return "Limit reached";
  if (!l.resetsAt) return "";
  const left = l.resetsAt - now;
  if (left <= 0) return "Resetting now";
  const elapsed = Math.min(1, Math.max(0, 1 - left / l.windowMs));
  if (elapsed < 0.05) return l.percent < 10 ? "Light pace" : "";
  const projected = l.percent / elapsed;
  if (projected >= 100) {
    const runsOutIn = (elapsed * l.windowMs) * (100 - l.percent) / l.percent;
    return runsOutIn < left ? `At this pace it runs out in ${until(now + runsOutIn, now)}` : "Will reset before you run out";
  }
  if (elapsed > 0.85) return "Will reset before you run out";
  if (projected < 40) return "Light pace";
  return `On pace for ~${Math.round(projected / 5) * 5}% at reset`;
}

/** "2h 14m", "3d 19h", "45m". @param {number | null} at ms @param {number} [now] */
export function until(at, now = Date.now()) {
  if (!at) return "";
  const s = Math.max(0, Math.round((at - now) / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${Math.max(1, m)}m`;
}

/** "2,102": toLocaleString has no grouping in every JS engine. @param {number} n */
export function thousands(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** @param {any} v */
function clamp(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
}

/** @param {any} iso */
function time(iso) {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) ? t : null;
}

/** @param {{ amount_minor: number, currency?: string, exponent?: number } | null | undefined} m */
function money(m) {
  if (!m) return "";
  const value = m.amount_minor / 10 ** (m.exponent ?? 2);
  const sign = m.currency === "USD" || !m.currency ? "$" : `${m.currency} `;
  return `${sign}${value.toFixed(m.exponent ?? 2)}`;
}

/** "weekly_scoped" -> "Weekly scoped". @param {string} s */
function humanize(s) {
  const t = s.replace(/[_-]+/g, " ").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}
