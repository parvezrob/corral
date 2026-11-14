# Corral

Files, source control, pull requests, ports and agent usage for the [Herdr app](https://herdr.dev), built for a setup where agents run on one machine and you drive them from another.

> Corral: where the herd gathers.

Everything follows the space you're looking at. If that space lives on another
machine, Corral reads its files, runs its git and `gh`, finds its dev servers and
reads its agents' limits **on that machine**, and shows the results here.

## What's inside

| Mod | What it does |
| --- | --- |
| `corral-panel` | The right panel's tab strip: Files, Changes, PR, Ports, with live counts |
| `corral-files` | File tree of the space's folder on its machine, git marks, find by name or content |
| `corral-git` | Changes: stage, unstage, discard, commit, pull, push; diffs open in the viewer |
| `corral-pr` | The branch's pull request: checks (a failing one opens its log beside the terminal), reviews, threads to reply to, resolve or hand to your agent, merge; or a form to open one. Files opens each file's PR diff in the viewer with its threads inline: comment on any line, apply suggested changes to your working copy, mark files viewed |
| `corral-ports` | Dev servers on every machine; remote ones auto-forwarded to localhost over ssh |
| `corral-view` | Viewer pane beside the terminal: code, rendered markdown, diffs, CI logs, PR review; safe saving |
| `corral-status` | Status bar: machine, branch, PR, agents, port forwards, Claude and Codex usage |
| `corral-usage` | The usage popover: every Claude and Codex limit, its pace and when it resets |
| `corral` layout | Herdr's main layout with the panel and status bar |

## Install

On the computer you drive Herdr from:

```sh
git clone https://github.com/parvezrob/corral.git ~/corral
~/corral/install.sh          # links the mods and layout into Herdr, switches to it
```

`git pull` updates it; `install.sh --remove` takes it out again (switch layouts first).
Machines you only reach through Herdr need nothing from Corral, just the tools below.

## Needs

- [Herdr app](https://herdr.dev) 0.1.15 or newer
- On every machine with spaces: `git`; `gh`, signed in, for the PR tab
- For Ports: Linux with `ss` on the machine running the servers, and plain `ssh`
  to it from here (the machine added to Herdr with an ssh target)
- For Usage: Claude Code and/or Codex signed in on the machine your agents run on

## What it touches

Corral is plain Herdr mods; this is everything it does outside its own folder.

- **Runs commands** (`exec`, on the space's machine): `git`, `gh`, `sh`, `ss`, `rg`/`grep`,
  `find`, `curl`, `codex app-server`, and `ssh -L` for port forwards (as Herdr terminals
  you can see and stop). Tunnels use `BatchMode=yes` and `StrictHostKeyChecking=accept-new`:
  a host seen for the first time is trusted, a changed host key is refused.
- **Reads files**: the space's folder (Files, viewer), `/proc/<pid>/environ` of listening
  processes to tie a port to its Herdr terminal, and `~/.claude/.credentials.json`
  (or the macOS Keychain item Claude Code uses) for the usage read.
- **Writes files**: only files you save in the viewer or a suggestion you apply, and
  CI logs you send to an agent (under `.git/corral/`). Saving a file on another machine
  goes through a private temp folder here (`mktemp -d`), removed right after.
- **Layout**: at app start the status bar shows the Ports and PR tabs for a moment if they
  haven't run yet (Herdr starts a panel tab only once it's shown), then restores the panel.
- **Network**: GitHub through `gh`; `api.anthropic.com/api/oauth/usage` (read-only, the
  token goes to curl on stdin, it is never refreshed or sent anywhere else); Codex's own
  app server for its limits.
- **Your agents**: "Send to Claude" pastes a prompt into the agent in your tab with
  `hc send`, which waits if you're typing there.

## Develop

```sh
npm install          # TypeScript, for type checking only
npm run verify       # build, unit tests, type check, herdr-app check
npm run link         # run the mods straight from this repo in Herdr
scripts/test-window.sh   # a private Herdr window on Xvfb, for screenshots
```

Shared code lives in `lib/`. Herdr only lets a mod import from its own folder, so
`npm run build` copies `lib/` into each `mods/corral-*/lib/`. Edit `lib/`, never a copy.

## Rules the code follows

- Every command runs on the machine the space lives on (`on: machine`).
- Saving never overwrites a file an agent changed meanwhile.
- `render()` only reads prepared data; long lists draw only the rows on screen.
- Tokens stay on the machine they live on; only results travel.
