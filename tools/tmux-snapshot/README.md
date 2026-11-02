# tmux-snapshot

Saves the full scrollback of every pane on a tmux server, then lets you browse it after the server is gone. Needs Node 22.18+ (runs the `.ts` directly) and no dependencies.

```
node tools/tmux-snapshot/cli.ts snapshot          # capture the running server
node tools/tmux-snapshot/cli.ts list
node tools/tmux-snapshot/cli.ts serve --port 7777 # browse at http://127.0.0.1:7777
node --test tools/tmux-snapshot/tests/snapshot.test.ts
```

Snapshots live in `$TMUX_SNAPSHOT_DIR` (default `~/.tmux-snapshots`): `<id>/manifest.json` plus `<id>/panes/<n>.ansi`. The `.ansi` files are raw `capture-pane -e` output, so `less -R ~/.tmux-snapshots/<id>/panes/499.ansi` works without the viewer.

Things worth knowing:

- Captured with `-J`: soft-wrapped rows are joined, so line counts are lower than tmux's `history_size` (rows). Nothing is dropped.
- Capture is bounded by the server's `history-limit`; output already evicted from a pane's scrollback is gone.
- Panes on the alternate screen (vim, less) only contribute the normal-screen scrollback; the manifest flags them.
- Grouped sessions share windows and panes; each is captured once and listed under every session in the group.
- Exit code 2 means the snapshot was saved but some panes failed to capture (listed on stderr and in the manifest).
