# Audit shard: A1 — SPEC.md §1–6 (Overview … Notifications intro)

## Scope
- Spec section(s) / source under audit: SPEC.md §1–§6, lines 1–279 (Overview, Entering Control Mode, Identifier Prefixes, Command Input, Command Response Protocol, Notifications intro)
- tmux source of truth: /Users/bmf/code/tmux_tmux (next-3.7, commit 5c30b145 == tmux 3.6a-205) + man page /Users/bmf/code/tmux_tmux/tmux.1 (the in-tree man source the SPEC line citations index into; the installed /opt/homebrew/.../tmux.1 is a 3.6a symlink and does NOT line up)
- Audit axis: A (spec-vs-protocol) + M (manifest/source citations). Primary axis here is M — every `**Source:**` block was resolved against the cited file:line.

## Coverage notes
- Read end-to-end: SPEC.md:1–279 (all of §1–§6 incl. §2.1–2.3, §4.1–4.4, §4.3.1, §5.1–5.4, §6.1–6.3).
- Source verified directly (file:line read, not grepped-and-trusted):
  - control.c:131 (CONTROL_BUFFER_LOW), 522–533 (control_error), 537–543 (control_error_callback), 547–575 (control_read_callback incl. EOL_LF @557, empty-line detach @561–565, CMDQ_STATE_CONTROL @567, cmd_parse_and_append @568), 765–802 (control_start), 806–809 (control_ready), 825–847 (control_stop)
  - cmd-queue.c:494–530 (cmdq_get_command — one item per command), 597–681 (cmdq_fire_command, flags @618, guard callsites @619/677/679), 825–833 (cmdq_guard), 889 (cmdq_print control_write)
  - server-client.c:476 (control_stop callsite), 3526 (control_ready callsite), 3963/3988–4001 (server_client_print control_write)
  - cmd-capture-pane.c:242 (control_write), tmux.c:393–398 (-C/-CC flag handling)
  - tmux.h:1838 (CMDQ_STATE_CONTROL 0x2), 2015–2016 (CLIENT_CONTROL 0x2000 / CLIENT_CONTROLCONTROL 0x4000)
  - control-notify.c:26–27 (CONTROL_SHOULD_NOTIFY_CLIENT macro), 29–258 (all control_notify_* filtering bodies)
  - notify.c:122–160 (notify_callback hook→fn dispatch), all 14 mapping rows in §6.3
  - format.c:1851/2090/2705/1939/2491 (id prefixes %, @, $)
  - tmux.1 (in-tree):7861–7870, 104–110, 7884–7889, 7896–7904, 5671–5674
- Grep-sampled only: none material — every citation was opened.
- Not examined: §7+ (out of shard). DCS/`-CC` framing detail referenced by §2 is cross-referenced to §12 (out of shard) and only its in-§2 claims were checked.

## Findings

### F1 — §3 Identifier Prefixes has no Source citation
- Severity: P3
- Category: under-citation
- Axis: M
- Spec location: SPEC.md:78–89 (§3 heading + prefix table)
- Source location: format.c:2090 `format_cb_pane_id` → `format_printf("%%%u", ...)`; format.c:2705 `format_cb_window_id` → `format_printf("@%u", ...)`; format.c:1939 `format_cb_next_session_id` → `format_printf("$%u", ...)`
- Claim under audit:
  > | `$`    | Session ID | `$1`    |
  > | `@`    | Window ID  | `@0`    |
  > | `%`    | Pane ID    | `%5`    |
  >
  > These are unsigned integers assigned by the server and stable for the lifetime of the object.
- Reality in source of truth: The prefixes are correct — the format callbacks emit exactly `$%u` (session), `@%u` (window), `%%%u` i.e. `%`+u_int (pane). The "unsigned integers" claim matches `u_int` ids. But §3 is the only subsection in §1–6 with **no** `**Source:**` block at all, so the (accurate) claim is unverifiable from the spec itself.
- Fix direction: correct-spec
- Recommendation: Add a `**Source:**` line citing `format.c` (the three `format_cb_*_id` callbacks) and/or the man page identifier discussion, to match the citation discipline of every neighbouring section.
- Test impact: none.

### F2 — §6.1 paraphrases the CONTROL_SHOULD_NOTIFY_CLIENT macro and drops its NULL guard
- Severity: P3
- Category: spec-inaccuracy (incomplete paraphrase)
- Axis: A
- Spec location: SPEC.md:228–229
- Source location: control-notify.c:26–27
- Claim under audit:
  > The macro `CONTROL_SHOULD_NOTIFY_CLIENT(c)` checks `(c)->flags & CLIENT_CONTROL`.
- Reality in source of truth:
  > `#define CONTROL_SHOULD_NOTIFY_CLIENT(c) \`
  > `	((c) != NULL && ((c)->flags & CLIENT_CONTROL))`
  > The macro is a conjunction: a non-NULL check **and** the flag test. SPEC quotes only the second conjunct.
- Fix direction: correct-spec
- Recommendation: Quote the full macro (`(c) != NULL && ((c)->flags & CLIENT_CONTROL)`) or reword to "checks the client is non-NULL and has `CLIENT_CONTROL`". Minor, but it is presented as a verbatim render of the macro and is not one.
- Test impact: none.

### F3 — §5.1 flags semantics are correct but the man page it cites for the example calls the field "currently not used"
- Severity: P3
- Category: under-citation / stale-upstream note
- Axis: A
- Spec location: SPEC.md:170 (flags row) and SPEC.md:186 (§5.2 cites `tmux.1:7884-7889`)
- Source location: cmd-queue.c:618 `flags = !!(state->flags & CMDQ_STATE_CONTROL);` (authoritative) vs. tmux.1:7885–7886
- Claim under audit:
  > | `flags`          | int            | 1 if `CMDQ_STATE_CONTROL`, 0 otherwise |
- Reality in source of truth: The C source confirms the SPEC: `flags = !!(state->flags & CMDQ_STATE_CONTROL)` — 1 for control-state commands, else 0, exactly as §5.1 states (correct, no fix needed to the claim). However the man page that §5.2's example is sourced from disagrees with reality:
  > tmux.1:7885–7886: "an integer time (as seconds from epoch), command number and flags **(currently not used)**."
  The man page is stale; the field IS used (the cited example even shows `1`). SPEC correctly follows the C source over the man page.
- Fix direction: correct-spec (additive)
- Recommendation: No change to the §5.1 claim — it is right. Optionally add a one-line note that the man-page wording "currently not used" is stale and the C source (`cmd-queue.c:618`) is authoritative, so a future auditor reading only tmux.1 isn't misled into "fixing" the spec backwards.
- Test impact: none.

### F4 — Several `**Source:**` line ranges are slightly under-inclusive (off by a few lines)
- Severity: P3
- Category: under-citation (citation drift; all resolve to supporting code, just clipped)
- Axis: M
- Spec location / Source location (claim vs. actual span):
  - SPEC.md:65 cites `control.c:765-809` for `control_start`; the function body actually spans control.c:765–802 (the cited 809 lands inside `control_ready`, which is a *different* function the §2.2 step 2 then attributes correctly). Harmless overshoot, but the range bleeds past `control_start`.
  - SPEC.md:74 cites `control.c:825-845` for `control_stop`; function spans 825–847. The two trailing lines (`control_reset_offsets`, `free(cs)`) fall just outside the cited range.
  - SPEC.md:112 (§4.1) cites `control.c:561-564` for empty-line detach; the block is 561–565 (the `break;` is at 565).
  - SPEC.md:210 (§5.4) cites `control.c:527-529` for the parse-error `control_write`; the actual `control_write(c, "parse error: %s", error)` is the single line 528 (528 is within range, fine).
- Claim under audit:
  > **Source:** `control.c:765-809`  … **Source:** `control.c:825-845`  … **Source:** `control.c:561-564`
- Reality in source of truth: control_start = control.c:765–802; control_stop = control.c:825–847; empty-line detach block = control.c:561–565 (verified by reading those lines).
- Fix direction: correct-spec
- Recommendation: Tighten the ranges (e.g. `765-802`, `825-847`, `561-565`). These are cosmetic citation drift, not protocol errors — every cited line genuinely supports its claim; the ranges just clip or overrun by 1–7 lines.
- Test impact: none.

## Sections with no findings
- §1 Overview — line-oriented, `%`-prefixed server lines, stdin/stdout split. Verified against tmux.1:7861–7870 (CONTROL MODE section opener). Accurate.
- §2 Entering Control Mode (intro + §2.1 Variants) — `-C` sets CLIENT_CONTROL 0x2000, `-CC` additionally sets CLIENT_CONTROLCONTROL 0x4000, single bidirectional socket, DCS framing. Verified: tmux.c:393–398 (`case 'C':` doubling logic), tmux.h:2015–2016 (flag values), tmux.1:104–110 ("Given twice (-CC) disables echo"). Accurate.
- §2.2 Initialization Sequence — control_start out_fd/bufferevent handling per mode, CONTROL_BUFFER_LOW=512 watermark, `\033P1000p` (7 bytes) DCS for -CC, control_ready enabling EV_READ. Verified control.c:765–809 (incl. 131 for the 512 constant, 799 for the DCS write) and server-client.c:3526 callsite. Accurate.
- §2.3 Teardown — control_stop frees bufferevents/subs/timer/blocks/offsets; write_event freed separately only when NOT -CC. Verified control.c:825–847 (`if (~c->flags & CLIENT_CONTROLCONTROL) bufferevent_free(cs->write_event)`) and server-client.c:476 callsite. Accurate (range clip noted in F4).
- §4 Command Input (intro) — newline-terminated commands, `;`-separation following normal tmux syntax. Verified control_read_callback control.c:547–575 reads one line per `evbuffer_readln`, and cmd-queue.c:494–530 confirms each `;`-separated command becomes its own cmdq_item (so §5's "each command → one response block" is consistent with multi-command lines). Accurate.
- §4.1 Empty Line — empty line sets CLIENT_EXIT (detach). Verified control.c:561–565. Accurate (range clip noted in F4).
- §4.2 Command Parsing — `cmd_parse_and_append` with CMDQ_STATE_CONTROL (0x2). Verified control.c:567–568 and tmux.h:1838. Accurate.
- §4.3 Line Reading — `EVBUFFER_EOL_LF`, no CR stripping. Verified control.c:557. Accurate.
- §4.3.1 Library parser note (CRLF tolerance) — explicitly labeled a library-side note (parser.ts output side), correctly scoped as library content with a `(library)`-style disclaimer; out of protocol-audit scope and properly demarcated. No protocol claim to refute.
- §4.4 Bufferevent Error — I/O error → control_error_callback sets CLIENT_EXIT → disconnect. Verified control.c:537–543. Accurate.
- §5 Command Response Protocol (intro) — exactly one `%begin` / output / `%end`|`%error` block per command. Verified cmdq_fire_command cmd-queue.c:597–681 (begin@619, error@677, end@679, one per item). Accurate.
- §5.1 Format — `%<guard> <timestamp:long> <command-number:uint> <flags:int>`, shared values across begin/end. Verified cmdq_guard cmd-queue.c:825–833 (`control_write(c, "%%%s %ld %u %d", guard, t, number, flags)` where t=item->time, number=item->number) and flags=618. Accurate (flags-row note F3 is additive only).
- §5.2 Example — `%begin 1363006971 2 1` … `%end 1363006971 2 1`. Verified tmux.1:7884–7889 verbatim. Accurate.
- §5.3 Parse Errors — `%begin` / `parse error: ...` / `%error` block. Verified control_error control.c:522–533 (`cmdq_guard begin`, `control_write "parse error: %s"`, `cmdq_guard error`). Accurate.
- §5.4 Command Output Delivery — control_write callsite table (server_client_print, cmdq_print, cmd_capture_pane_exec, control_error). Verified server-client.c:3991/3996 (in 3988–4001), cmd-queue.c:889 (in 881–891), cmd-capture-pane.c:242 (241–242), control.c:528 (527–529). All four callers resolve. Accurate.
- §6 Notifications (intro) — async, single `%`-prefixed line, never inside a response block, all-but-%exit correspond to hooks. Verified tmux.1:7896–7904 ("A notification will never occur inside an output block") and tmux.1:5671–5674 ("all … are hooks … except %exit"). Accurate. (The parser's reliance on "never inside a block" is the documented invariant in CLAUDE.md / SPEC_MANIFEST §4 — consistent.)
- §6.1 Notification Dispatch — notify_callback maps hook names → control_notify_* fns; CONTROL_SHOULD_NOTIFY_CLIENT gates on CLIENT_CONTROL. Verified notify.c:122–156, control-notify.c:26–27. Accurate apart from the macro-paraphrase NULL-drop (F2).
- §6.2 Notification Client Filtering — the three buckets (no-session-required / session-required / linked-vs-unlinked logic). Cross-checked EVERY function in control-notify.c:29–258: the 8 "all clients" notifications (pane-mode-changed, window-pane-changed, client-detached, session-renamed, sessions-changed [created+closed], session-window-changed, paste-buffer-changed, paste-buffer-deleted) gate ONLY on the macro; the session-required set (layout-change, window-add/close/renamed + unlinked variants, session-changed/client-session-changed) ALL additionally test `c->session == NULL`. The "linked vs unlinked checks the RECEIVING client's session via winlink_find_by_window_id(&cs->windows, ...)" claim is verified exactly in window_unlinked/linked/renamed. Fully accurate — a strong section.
- §6.3 Hook-to-Notification Mapping — all 14 rows. Verified row-for-row against notify.c:128–156. Hook name, control_notify_* fn, and emitted notification(s) all match, including the dual-output rows (window-unlinked→%window-close|%unlinked-window-close, window-linked→%window-add|%unlinked-window-add, window-renamed→…, client-session-changed→%session-changed|%client-session-changed). Accurate.
