# Testing Corral by hand

Everything below has unit tests and was seen in a private Herdr window on
robin-pc. What's left needs real clicks, typing, a second computer, or acts on
GitHub. Work through it in order; note anything that feels off.

Setup on the Mac (the computer you drive from):

```sh
git clone https://github.com/parvezrob/corral.git ~/corral && ~/corral/install.sh
```

Then open a space that lives on robin-pc. Use the `wb-test` space, or one of
yours; nothing here changes your repos unless the step says so.

## 1. Files and the viewer

- [ ] Files tab shows the repo on robin-pc with git marks; folders open and close.
- [ ] Find by name (type `forw`), then by content (switch to Contents, press Enter).
- [ ] Click a file: it opens **beside the terminal**, not in the panel. A second file reuses that pane.
- [ ] Ctrl/⌘-click a file: it opens in a new tab.
- [ ] A markdown file shows Rendered; Source switches; links open.
- [ ] Edit a file, ⌘S saves. Edit it again, have an agent change the same file, save:
      you get "changed on disk" with Reload theirs / Overwrite with mine.

## 2. Changes

- [ ] Change a file in a scratch repo: it shows under Changes with a count on the tab.
- [ ] Click it: the diff opens beside the terminal. "Edit file" turns it into the editor.
- [ ] Stage, unstage, discard (needs a second click), commit, push.

## 3. Pull request (use a throwaway branch and PR for the write steps)

- [ ] On a branch without a PR: the form is filled from the commits. Create a **draft**.
- [ ] Overview: steps, checks, reviewers, the "Blocked: …" line in plain words.
- [ ] A failing check: View log opens the job log beside the terminal at the failed step;
      Full log switches; Re-run failed; Send to Claude pastes the prompt into your agent.
- [ ] Files tab: open a file, ‹ › through the files, tick Viewed (check it on GitHub).
- [ ] Click a line number in the PR diff, comment; it appears on GitHub.
- [ ] Leave yourself a review comment with a ```` ```suggestion ```` block on GitHub;
      Apply suggestion writes it into the working copy (then commit and push).
- [ ] Reply to and resolve a thread, from the Threads tab and from the PR diff.
- [ ] Merge (two clicks), or turn on "Merge automatically when ready".
- [ ] Toasts: checks finishing, a review arriving, the merge. Clicking one opens the PR tab.

## 4. Ports (the Mac part)

- [ ] On robin-pc in a Herdr terminal: `python3 -m http.server 8765 --bind 127.0.0.1`.
- [ ] Within a few seconds a toast says it's ready; clicking it opens `http://localhost:8765` on the Mac.
- [ ] Ports tab: the card says where it runs (space › tab), Open / Copy URL / Stop work.
- [ ] Stop it, then start the server again: it isn't re-forwarded (you stopped it). Forward brings it back.
- [ ] Something already on 8765 on the Mac: the tunnel takes the next port and says so.
- [ ] Turn auto-forward off: new servers show under "Not forwarded" with a Forward button.
- [ ] Ctrl-C the server: its tunnel goes away by itself.

## 5. Usage

- [ ] Status bar shows `Claude 42% wk  Codex 33% wk` (your numbers), read on robin-pc.
- [ ] Click a chip: the popover, Detailed and Compact, ↻ refreshes, "Updated … ago".
- [ ] Compare with `claude /usage` and Codex's `/status`.

## 6. Status bar and panel

- [ ] Machine name, branch, PR chip (`PR #n · …`) and agents are right for the shown space.
- [ ] Switching spaces (local ↔ robin-pc) updates every tab and the status bar.

## Known gaps

- Reviews post comments one by one; there's no pending "Start a review" batch yet.
- Very large PR files show their first 1,500 lines; the rest is a GitHub link.
- Ports needs `ss` (Linux) on the machine running the servers.
