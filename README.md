# Corral

Files, source control, pull requests, ports and agent usage for the [Herdr app](https://herdr.dev), built for a setup where agents run on one machine and you drive them from another.

> Corral: where the herd gathers. A set of mods for [Herdr](https://herdr.dev).

## What's inside

| Mod | What it does |
| --- | --- |
| `corral-panel` | The right panel's tab strip: Files, Changes, PR, Ports |
| `corral-files` | File tree of the space's folder on its machine, git marks, find by name or content |
| `corral-git` | Changes: stage, unstage, discard, commit, pull, push; diffs open in the viewer |
| `corral-ports` | Dev servers on every machine; remote ones auto-forwarded to localhost over ssh |
| `corral-view` | Viewer pane beside the terminal: code, rendered markdown, diffs; safe saving |
| `corral-status` | Status bar: machine, branch, agents, live port forwards |
| `corral` layout | Herdr's main layout with the panel and status bar |

## Develop

```sh
npm install          # TypeScript, for type checking only
npm run verify       # build, unit tests, type check, herdr-app check
npm run link         # run the mods straight from this repo in Herdr
```

Shared code lives in `lib/`. Herdr only lets a mod import from its own folder, so
`npm run build` copies `lib/` into each `mods/corral-*/lib/`. Edit `lib/`, never a copy.

## Rules the code follows

- Every command runs on the machine the space lives on (`on: machine`).
- Saving never overwrites a file an agent changed meanwhile.
- `render()` only reads prepared data; long lists draw only the rows on screen.
- Tokens stay on the machine they live on; only results travel.
