# Audit shard: A2 — SPEC.md §7 Notification Reference

## Scope
- Spec section(s) / source under audit: SPEC.md §7 "Notification Reference" (lines 280–678), every notification entry.
- tmux source of truth: /Users/bmf/code/tmux_tmux (next-3.7 == tmux 3.7) + man page. NOTE: the spec's `tmux.1:NNNN` citations resolve against the **source-tree** man page `/Users/bmf/code/tmux_tmux/tmux.1` (8234 lines), NOT the installed `/opt/homebrew/share/man/man1/tmux.1` (8007 lines, an older tmux release). All man-page line verification below is against `/Users/bmf/code/tmux_tmux/tmux.1`.
- Audit axis: A (spec-vs-protocol) primarily; M (manifest/source citations) for the `**Source:**` lines.

## Coverage notes
- Read end-to-end: SPEC.md §7 (280–678); control-notify.c (all 258 lines, every emit site); control.c emit sites for `%output`/`%extended-output` (607–645), `%pause`/`%continue` (358–464), and all six `%subscription-changed` sites + timer (845–1125); cmd-display-message.c:135–160 (`%message`); cfg.c:229,253 (`%config-error`); client.c:180–220 (`client_exit_message`) + 418–433 (`%exit` print); tmux.1:7861–8045 (entire CONTROL MODE notification list).
- Cross-checked the complete `control_write(c, "%%...")` notification set via `grep -rhoE 'control_write\(c, "%%[a-z-]+' *.c` → 19 strings, all present in §7. `%output`, `%extended-output`, `%subscription-changed`, `%layout-change`, `%message`, `%exit` are emitted by other paths (evbuffer/printf/format template) and are also all covered. No notification omitted.
- Grep-sampled only: none material.
- Not examined: §8+ (out of shard).

## Findings

### F1 — Multiple `tmux.1` citations point at the WRONG notification entry
- Severity: P3 (under-cited / wrong-citation; wire formats themselves are correct — see F2)
- Category: under-citation / manifest-citation-error
- Axis: M
- Spec location: SPEC.md §7, the `**Source:**` lines listed below.
- Source location: /Users/bmf/code/tmux_tmux/tmux.1 (verified entry start lines in parentheses).
- Claim under audit: the spec attaches these `tmux.1` ranges to these notifications:
  > `%output` ... **Source:** `control.c:625`, `tmux.1:7964-7967` (SPEC.md:296)
  > `%pause` ... **Source:** `control.c:383` (explicit), `control.c:455` (age-triggered), `tmux.1:7973-7975` (SPEC.md:336-337)
  > `%pane-mode-changed` ... **Source:** `control-notify.c:34-39`, `tmux.1:7969-7971` (SPEC.md:363)
  > `%unlinked-window-add` ... **Source:** `control-notify.c:120`, `tmux.1:8013-8015` (SPEC.md:418)
  > `%session-changed` ... **Source:** `control-notify.c:160-161`, `tmux.1:7977-7980` (SPEC.md:482)
  > `%session-renamed` ... **Source:** `control-notify.c:189`, `tmux.1:7982-7983` (SPEC.md:507)
  > `%sessions-changed` ... **Source:** `control-notify.c:202, 215`, `tmux.1:7989-7990` (SPEC.md:517)
  > `%session-window-changed` ... **Source:** `control-notify.c:228-229`, `tmux.1:7985-7988` (SPEC.md:527)
- Reality in source of truth: the cited `tmux.1` ranges document a *different* notification than the one they are attached to:
  - `tmux.1:7964-7967` is `%pane-mode-changed` (`.It Ic %pane-mode-changed Ar pane-id`, tmux.1:7964). `%output` is at tmux.1:7960 (`.It Ic %output Ar pane-id Ar value`).
  - `tmux.1:7973-7975` is `%paste-buffer-deleted` (tmux.1:7972). `%pause` is at tmux.1:7976 (`.It Ic %pause Ar pane-id`).
  - `tmux.1:7969-7971` is `%paste-buffer-changed` (tmux.1:7968). `%pane-mode-changed` is at tmux.1:7964 — and the SAME range 7969-7971 is *correctly* cited for `%paste-buffer-changed` at SPEC.md:555, so two entries cite the same lines for different notifications.
  - `tmux.1:8013-8015` is inside `%subscription-changed` (tmux.1:7995–8014). `%unlinked-window-add` is at tmux.1:8015 (`.It Ic %unlinked-window-add Ar window-id`).
  - `tmux.1:7977-7980` is `%pause` (tmux.1:7976). `%session-changed` is at tmux.1:7980 (`.It Ic %session-changed Ar session-id Ar name`).
  - `tmux.1:7982-7983` is inside `%session-changed`. `%session-renamed` is at tmux.1:7985 (`.It Ic %session-renamed Ar name`).
  - `tmux.1:7989-7990` is `%session-window-changed` (tmux.1:7988). `%sessions-changed` is at tmux.1:7993 (`.It Ic %sessions-changed`).
  - `tmux.1:7985-7988` is `%session-renamed` (tmux.1:7985). `%session-window-changed` is at tmux.1:7988 (`.It Ic %session-window-changed Ar session-id Ar window-id`).
- Fix direction: correct-spec (citation only).
- Recommendation: re-derive the `tmux.1` ranges against /Users/bmf/code/tmux_tmux/tmux.1. The whole CONTROL MODE list appears shifted: nearly every man-page range in §7 is low by ~2–5 lines (see F3), and for the eight entries above the drift is large enough that the range lands squarely on the neighbouring notification. The C-source halves of these `**Source:**` lines are all correct — only the `tmux.1` halves are wrong.
- Test impact: none (citation-only; no assertion depends on man-page line numbers).

### F2 — (Confirmation, not a defect) every wire format, argument order/count, trigger, and gating in §7 is correct
- Severity: n/a (recorded so the no-finding set is explicit)
- This is not a finding; it documents that the substantive content of §7 verified clean against the C source. See "Sections with no findings" for the per-notification evidence. The only defects in §7 are the man-page citation offsets (F1, F3).

### F3 — Systematic ~2–5 line low-drift in the remaining `tmux.1` citations
- Severity: P3 (under-cited / cosmetic)
- Category: under-citation
- Axis: M
- Spec location: SPEC.md §7, the `tmux.1` half of the `**Source:**` lines NOT already named in F1.
- Source location: /Users/bmf/code/tmux_tmux/tmux.1.
- Claim under audit (representative):
  > `%client-detached` ... **Source:** `control-notify.c:176`, `tmux.1:7905-7906` (SPEC.md:541)
  > `%message` ... **Source:** `cmd-display-message.c:151`, `tmux.1:7958-7960` (SPEC.md:620)
  > `%config-error` ... **Source:** `cfg.c:229, 253`, `tmux.1:7912-7913` (SPEC.md:634)
- Reality in source of truth: `%client-detached` is at tmux.1:7906 (cited 7905); `%message` is at tmux.1:7956 (cited 7958); `%config-error` is at tmux.1:7913 (cited 7912). The same 1–3 line low-drift recurs across `%extended-output` (entry 7929, cited 7935-7944), `%continue` (7915, cited 7914-7918), `%window-renamed` (8040, cited 8039-8042), `%unlinked-window-close` (8019, cited 8017-8020), `%unlinked-window-renamed` (8023, cited 8022-8025), `%layout-change` (7941, cited 7946-7956), `%client-session-changed` (7908, cited 7907-7911), `%exit` (7921, cited 7920-7925), `%subscription-changed` (7995, cited 7991-8011). These are close enough to still overlap the correct entry; F1 lists the cases where the drift crosses into the wrong entry.
- Fix direction: correct-spec (citation only).
- Recommendation: regenerate all §7 `tmux.1` ranges in one pass against the source-tree man page; the drift is uniform and mechanical.
- Test impact: none.

## Sections with no findings
Each notification's NAME, wire format, argument order/count, emission trigger, gating, and **C-source** `**Source:**` citation verified correct against tmux 3.7:

- **`%output`** (SPEC.md:284-296): `%%output %%%u ` — control.c:625, in `control_append_data` when `!(c->flags & CLIENT_CONTROL_PAUSEAFTER)`. Spec's "Only sent when `pause-after` flag is **not** set" matches the `else` branch at control.c:624-625. ✓
- **`%extended-output`** (SPEC.md:298-316): `%%extended-output %%%u %llu : ` — control.c:621-623, in the `if (c->flags & CLIENT_CONTROL_PAUSEAFTER)` branch. Args `pane-id age ... :` with no reserved fields currently emitted; spec's reserved-args note matches tmux.1:7938-7940. ✓
- **`%pause`** (SPEC.md:322-337): `%%pause %%%u` — control.c:383 (explicit `control_pause_pane`) and control.c:455 (age-triggered, only when `CLIENT_CONTROL_PAUSEAFTER`). Spec's two triggers + "queued output discarded" (`control_discard_pane` at control.c:382/454) all match. ✓
- **`%continue`** (SPEC.md:339-348): `%%continue %%%u` — control.c:369 in `control_continue_pane`, only when pane is `CONTROL_PANE_PAUSED`. ✓
- **`%pane-mode-changed`** (SPEC.md:354-363): `%%pane-mode-changed %%%u` — control-notify.c:38; gated on `CONTROL_SHOULD_NOTIFY_CLIENT` (`CLIENT_CONTROL`); sent to all clients regardless of session (no `c->session` filter). ✓
- **`%window-add`** (SPEC.md:369-377): `%%window-add @%u` — control-notify.c:118, in the `winlink_find_by_window_id(...) != NULL` branch of `control_notify_window_linked`. ✓
- **`%window-close`** (SPEC.md:379-387): `%%window-close @%u` — control-notify.c:100, linked branch of `control_notify_window_unlinked`. ✓
- **`%window-renamed`** (SPEC.md:389-397): `%%window-renamed @%u %s` (window-id + name) — control-notify.c:136-137. ✓
- **`%window-pane-changed`** (SPEC.md:399-408): `%%window-pane-changed @%u %%%u` (window-id + active pane-id) — control-notify.c:83-84; sent to all control clients (no session filter). ✓
- **`%unlinked-window-add`** (SPEC.md:410-418): `%%unlinked-window-add @%u` — control-notify.c:120, else branch. ✓
- **`%unlinked-window-close`** (SPEC.md:420-428): `%%unlinked-window-close @%u` — control-notify.c:102, else branch. ✓
- **`%unlinked-window-renamed`** (SPEC.md:430-439): `%%unlinked-window-renamed @%u %s` (id + name) — control-notify.c:139-140; spec's "sends both the window ID and the name (`@%u %s`)" matches. ✓
- **`%layout-change`** (SPEC.md:445-467): emitted via `control_write(c, "%s", cp)` (control-notify.c:69) where `cp = format_single(...)` of template `%layout-change #{window_id} #{window_layout} #{window_visible_layout} #{window_raw_flags}` (control-notify.c:51-52). Four-field order matches. Suppression "no `layout_root` → return" matches control-notify.c:60-61; session-scoped delivery matches the `winlink_find_by_window_id` filter at control-notify.c:68. ✓
- **`%session-changed`** (SPEC.md:473-482): `%%session-changed $%u %s` (session-id + name) — control-notify.c:160-161, sent only to the changed client (`cc == c` branch). ✓
- **`%client-session-changed`** (SPEC.md:484-493): `%%client-session-changed %s $%u %s` (client-name + session-id + name) — control-notify.c:163-164, the `else` (other-clients) branch. ✓
- **`%session-renamed`** (SPEC.md:495-507): `%%session-renamed $%u %s` (session-id + name) — control-notify.c:189. Spec's NOTE that the man page documents only `<name>` (tmux.1:7985 `.It Ic %session-renamed Ar name`) while the code sends `$%u %s` is accurate. ✓
- **`%sessions-changed`** (SPEC.md:509-517): `%%sessions-changed` (no args) — control-notify.c:202 (`control_notify_session_created`) and 215 (`control_notify_session_closed`). ✓
- **`%session-window-changed`** (SPEC.md:519-527): `%%session-window-changed $%u @%u` (session-id + window-id) — control-notify.c:228-229 (`s->id`, `s->curw->window->id`). ✓
- **`%client-detached`** (SPEC.md:533-541): `%%client-detached %s` (client-name) — control-notify.c:176. ✓
- **`%paste-buffer-changed`** (SPEC.md:547-555): `%%paste-buffer-changed %s` (name) — control-notify.c:242. ✓
- **`%paste-buffer-deleted`** (SPEC.md:557-565): `%%paste-buffer-deleted %s` (name) — control-notify.c:255. ✓
- **`%subscription-changed`** (SPEC.md:571-605): `%%subscription-changed %s $%u <win> <idx> <pane> : %s`. Session form `$%u - - - :` (control.c:861-863), pane form `$%u @%u %u %%%u :` (control.c:908-910, 943-945), window form `$%u @%u %u - :` (control.c:988-990, 1023-1025). Spec's per-type field table (`-` for N/A) matches exactly. 1-second timer confirmed at control.c:1041 (`.tv_sec = 1`) / re-armed control.c:1046; change-detection via `strcmp` against `last`/RB-tree `csp->last`/`csw->last` matches control.c:857,904,939,984,1019. All six emit-site citations + timer range correct. ✓
- **`%message`** (SPEC.md:611-620): `%%message %s` — cmd-display-message.c:151, gated on `tc->flags & CLIENT_CONTROL` (cmd-display-message.c:147). ✓
- **`%config-error`** (SPEC.md:626-634): `%%config-error %s` — cfg.c:229 and cfg.c:253. ✓
- **`%exit`** (SPEC.md:640-675): `%%exit %s` (optional reason) / `%%exit` — printed client-side via `printf` at client.c:425/427, gated on `client_flags & CLIENT_CONTROL` (client.c:423). Spec's "printed client-side on stdout (not sent through the protocol)" is correct (it is `printf`, not `control_write`). The entire Exit-Reasons table (SPEC.md:654-665) matches `client_exit_message` at client.c:189-217 line-for-line (detached 198 / from-session 194-197; SIGHUP 205 / 201-204; lost tty 207; terminated 209; server exited unexpectedly 211; exited 213; server exited 215; custom `CLIENT_EXIT_MESSAGE_PROVIDED` 217). ✓
- **Notification-vs-block invariant** ("A notification will never occur inside an output block", tmux.1:7902) — consistent with §7's framing; not re-audited here as it belongs to §4.
- **Completeness**: the full `control_write(c, "%%...")` set (19 strings) plus the six non-`control_write` emitters are all present in §7. No tmux 3.7 notification is omitted (no P2 finding).
