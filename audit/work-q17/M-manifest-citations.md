# Audit shard: M-manifest-citations (SPEC_MANIFEST.md citation verification)

## Scope
- Spec section(s) / source under audit: SPEC_MANIFEST.md (970 lines, all 33 sections), mechanical verification of every `file.c:line` citation against tmux source.
- tmux source of truth: /Users/bmf/code/tmux_tmux — confirmed `git rev-parse HEAD` = `5c30b145df51009a1908f6c3ab78b217e67fa693`, `git describe` = `3.6a-205-g5c30b145`, exactly the `next-3.7` / commit `5c30b145` the manifest header claims.
- Man page: source-repo `/Users/bmf/code/tmux_tmux/tmux.1` (8234 lines). NOTE: the manifest's `tmux.1:NNNN` citations are against the **source-repo** tmux.1, NOT the installed `/opt/homebrew/share/man/man1/tmux.1` (whose line numbers differ wildly — homebrew line 7960 is in GETTING STARTED, not control mode). All man-page verification below uses the source-repo tmux.1.
- Audit axis: M (manifest citations), with a few protocol-fact (A) crossovers.

## Coverage notes

Citation density: the manifest carries roughly 150 distinct `file:line` citations across 33 sections. Verification method:

- **Individually verified (opened the cited range and confirmed content):** every citation in §1, §2, §2.1, §3, §4 (incl. Invariant 4.1), §6 (all ~25 notification format-string + man citations), §8, §9, §10 (all flag value + dispatch-line citations), §11, §12, §13, §14, §16, §17, §18, §21, §23, §24, §25, §26, plus the §29 behavioral-difference citations spot-listed below. Method: `grep -n` the cited symbol/format-string in the target file to get its true line, then `sed -n` the cited range to confirm content.
- **Grep-sampled (symbol located, range not line-by-line read):** §19/§20/§30/§31 data-structure and helper-function citations (e.g. `control_block` `control.c:44-51`, `control_state` `control.c:115-128`, `control_discard_pane` `control.c:210-231`) — confirmed each named symbol exists in the cited file near the cited line via grep, did not re-read every body. §22 (identifier prefixes) is prose with no file citations. §32/§33 cross-checked against the source-repo tmux.1 anchors enumerated below.
- **Not separately re-examined:** §3.1, §3.2, §9.1, §26.1 — these are self-labeled "(library)" sub-sections that describe `src/` behavior and cite into `src/protocol/*.ts` / `src/client.ts`, explicitly cross-referenced to SPEC.md. They are deliberately-placed library-content-in-manifest, already marked as such and tied protocol→library; treated as in-bounds per the framing, not flagged.

Man-page anchor table established (source-repo tmux.1, `.It` lines): `%client-detached` 7906, `%client-session-changed` 7908, `%config-error` 7913, `%continue` 7915, `%exit` 7921, `%extended-output` 7929, `%layout-change` 7941, `%message` 7956, `%output` 7960, `%pane-mode-changed` 7964, `%paste-buffer-changed` 7968, `%paste-buffer-deleted` 7972, `%pause` 7976, `%session-changed` 7980, `%session-renamed` 7985, `%session-window-changed` 7988, `%sessions-changed` 7993, `%subscription-changed` 7995, `%unlinked-window-add` 8015, `%unlinked-window-close` 8019, `%unlinked-window-renamed` 8023, `%window-add` 8027, `%window-close` 8031, `%window-pane-changed` 8035, `%window-renamed` 8040; "too far behind" 7723; "A notification will never occur inside an output block." 7902; `client_control_mode` 6270.

## Findings

### F1 — `-CC` raw-mode terminal config cited to `tmux.c` but actually lives in `client.c`
- Severity: P1
- Category: manifest-citation-error
- Axis: M
- Spec location: SPEC_MANIFEST.md:50 (§2) and SPEC_MANIFEST.md:65-66 (§2.1)
- Source location: cited `tmux.c:343-362`; true location `client.c:344-360`
- Claim under audit:
  > `-CC` terminal raw mode configuration (`tmux.c:343-362`): when `CLIENT_CONTROLCONTROL` is set, the terminal is configured with: `c_iflag = ICRNL|IXANY` ...
  and (§2.1) > tmux first calls `tcgetattr(stdin)` (`tmux.c:343-362`) to capture the current terminal attributes
- Reality in source of truth: `tmux.c:343-362` is the top of `getversion()` + `main()`'s variable declarations + `setlocale()` — it contains none of the cited code. `tmux.c` has **no** `ICRNL`/`NOKERNINFO`/`tcgetattr`. The raw-mode block is in `client.c`:
  > `client.c:344` `if (client_flags & CLIENT_CONTROLCONTROL) {`
  > `client.c:345` `tcgetattr(STDIN_FILENO, &saved_tio)`
  > `client.c:351` `tio.c_iflag = ICRNL|IXANY;`
  > `client.c:352` `tio.c_oflag = OPOST|ONLCR;`
  > `client.c:354` `tio.c_lflag = NOKERNINFO;`
  > `client.c:356` `tio.c_cflag = CREAD|CS8|HUPCL;`
  > `client.c:357` `tio.c_cc[VMIN] = 1;`
  The *flag values* the manifest lists are all correct; only the file:line is wrong (and wrong in both §2 and §2.1).
- Fix direction: correct-spec
- Recommendation: change `tmux.c:343-362` to `client.c:344-360` in both §2 and §2.1.
- Test impact: none directly, but §2.1 is the protocol foundation for the library's `spawnTmux` `-CC`-refusal rationale; a remediation agent following the citation would land in `main()` and find nothing.

### F2 — Invariant 4.1 upstream citation: wrong man line AND misquoted wording ("response block" vs "output block")
- Severity: P1
- Category: manifest-citation-error
- Axis: M / A
- Spec location: SPEC_MANIFEST.md:164-165 (§4, Invariant 4.1 "Upstream citation")
- Source location: cited `tmux.1:7896-7897`; true location `tmux.1:7902`
- Claim under audit:
  > Upstream citation: `tmux.1:7896-7897` — "a notification will never occur inside a response block"
- Reality in source of truth: the man text is at line 7902 and reads:
  > `tmux.1:7902` `A notification will never occur inside an output block.`
  The manifest both cites the wrong line and paraphrases "output block" as "response block" inside quotation marks (presented as a verbatim upstream quote).
- Fix direction: correct-spec
- Recommendation: change citation to `tmux.1:7902` and quote the exact words "inside an output block" (or drop the quote marks if intentionally rephrasing).
- Test impact: Invariant 4.1 is the named justification for the parser's block-purity branch (`src/protocol/parser.ts`, `[LAW:one-source-of-truth]`) and is the spec-conformance gate's core assumption; the cited upstream evidence must resolve.

### F3 — §14 fg/bg control-client functions transposed in window.c citation
- Severity: P1
- Category: manifest-citation-error
- Axis: M
- Spec location: SPEC_MANIFEST.md:535-537 (§14)
- Source location: cited "`window_pane_get_fg_control_client()` and `window_pane_get_bg_control_client()` — `window.c:1840-1852, 1881-1893`"; true: bg at `window.c:1840`, fg at `window.c:1881`
- Claim under audit:
  > Color values queried via `window_pane_get_fg_control_client()` and `window_pane_get_bg_control_client()` — `window.c:1840-1852, 1881-1893`
- Reality in source of truth: reading the order, the manifest pairs fg→1840 and bg→1881, but the source is reversed:
  > `window.c:1840` `window_pane_get_bg_control_client(struct window_pane *wp)`
  > `window.c:1881` `window_pane_get_fg_control_client(struct window_pane *wp)`
- Fix direction: correct-spec
- Recommendation: swap the line ranges — bg is 1840-1852, fg is 1881-1893.
- Test impact: none.

### F4 — §14 claims `input_osc_11()` queries bg-control-client at input.c:2999; it does not
- Severity: P1
- Category: manifest-citation-error / spec-inaccuracy
- Axis: M / A
- Spec location: SPEC_MANIFEST.md:540-543 (§14)
- Source location: cited `input.c:2955` (fg), `input.c:2999` (bg)
- Claim under audit:
  > Used by `input_osc_10()` and `input_osc_11()` in `input.c` when handling OSC 10/11 `?` queries to provide foreground/background color from control clients — `input.c:2955` (fg), `input.c:2999` (bg)
- Reality in source of truth: `input_osc_10` calls the control-client fg function directly:
  > `input.c:2955` `c = window_pane_get_fg_control_client(wp);`
  but `input_osc_11`'s `?` path calls the plain accessor, not the control-client one:
  > `input.c:3005` `c = window_pane_get_bg(wp);`
  `grep` confirms `window_pane_get_bg_control_client` is **never** referenced in input.c. The bg control-client value is reached *indirectly* — `window_pane_get_bg()` (`window.c:1800`) calls `window_pane_get_bg_control_client()` at `window.c:1805`. The two paths are asymmetric: fg is queried directly in input.c, bg is queried inside `window_pane_get_bg`. The manifest's symmetric "2955 fg / 2999 bg" claim is wrong for bg.
- Fix direction: correct-spec
- Recommendation: state that `input_osc_10` calls `window_pane_get_fg_control_client` directly (`input.c:2955`), while the bg value is obtained indirectly via `window_pane_get_bg` (`window.c:1800`) → `window_pane_get_bg_control_client` (`window.c:1805`); `input_osc_11` itself calls `window_pane_get_bg` (`input.c:3005`).
- Test impact: none.

### F5 — §4 `cmdq_print()` cited to `cmd-queue.c:881-891`, which is inside `cmdq_error()`
- Severity: P1
- Category: manifest-citation-error
- Axis: M
- Spec location: SPEC_MANIFEST.md:147-148 (§4)
- Source location: cited `cmd-queue.c:881-891`; true `cmdq_print` is `cmd-queue.c:843-859`
- Claim under audit:
  > `cmdq_print()` writes command output/messages within response blocks — `cmd-queue.c:881-891`
- Reality in source of truth:
  > `cmd-queue.c:844` `cmdq_print(struct cmdq_item *item, const char *fmt, ...)` (body 843-859, delegates to `cmdq_print_data` → `server_client_print`)
  Lines 881-891 are inside `cmdq_error()` (the `else if (c->session == NULL || (c->flags & CLIENT_CONTROL))` branch with `control_write(c, "%s", msg)` at ~889). The cited range points at a different function than named.
- Fix direction: correct-spec
- Recommendation: change to `cmd-queue.c:843-859` for `cmdq_print()`. (Optionally add `cmdq_error()` `cmd-queue.c:881-891` as a separate control-output callsite if intended.)
- Test impact: none.

### F6 — §30 `control_write()` range overshoots into adjacent functions
- Severity: P3
- Category: manifest-citation-error
- Axis: M
- Spec location: SPEC_MANIFEST.md:872-874 (§30)
- Source location: cited `control.c:406-464`; true `control_write` is `control.c:404-429`
- Claim under audit:
  > `control_write()` - formats and queues a notification line ... `control.c:406-464`
- Reality in source of truth: `control_write` def is `control.c:406`, closing brace at `control.c:429`. Lines 430-464 are `control_check_age()` (def at 433). The cited end (464) is well past the function.
- Fix direction: correct-spec
- Recommendation: change to `control.c:404-429`.
- Test impact: none.

### F7 — §6 `%pane-mode-changed` man citation lands on the wrong `.It` entry
- Severity: P3
- Category: manifest-citation-error
- Axis: M
- Spec location: SPEC_MANIFEST.md:222 (§6, Pane Mode)
- Source location: cited `tmux.1:7969-7971`; true `tmux.1:7964`
- Claim under audit:
  > `%pane-mode-changed <pane-id>` ... `tmux.1:7969-7971`
- Reality in source of truth: `.It Ic %pane-mode-changed Ar pane-id` is at `tmux.1:7964`. The cited 7969-7971 falls on `%paste-buffer-changed` (`.It` at 7968) — i.e. the citation points at a different notification's man entry. (The code citations `control-notify.c:34-39` for this notification are correct.)
- Fix direction: correct-spec
- Recommendation: change man citation to `tmux.1:7964-7967`.
- Test impact: none.

### F8 — §6 / §9 control.c output-encoding and pane format-string line ranges drift a few lines
- Severity: P3
- Category: manifest-citation-error
- Axis: M
- Spec location: SPEC_MANIFEST.md:205 (§6, `%extended-output`), :402-403 (§9 octal loop)
- Source location: see below
- Claim under audit:
  > `%extended-output` ... `control.c:621-623` (format string)  /  Encoding loop in `control_append_data()` — `control.c:631-642`
- Reality in source of truth: `%extended-output` printf is `control.c:621-623` (✓ exact); `%output` printf is `control.c:625` (✓ exact). The octal encoding loop, however, is `control.c:632-647` (`for (i...)` at 632, `evbuffer_add_printf(message, "\\%03o"...)` at 635, loop body to 647) — manifest's `631-642` starts one line early and ends 5 short. The encoding rule described (escape `< ' '` or `== '\\'` as `\NNN`, pass-through 0x20-0x5B/0x5D-0xFF) is correct.
- Fix direction: correct-spec
- Recommendation: change §9 loop citation to `control.c:632-647`.
- Test impact: none — §9 backs `decodeOctalEscapes` conformance, but the encoding rule itself is accurately described.

### F9 — §6 cluster of man-page notification citations drift by a few lines (whole control-mode section shifted)
- Severity: P3
- Category: manifest-citation-error
- Axis: M
- Spec location: SPEC_MANIFEST.md §6 / §13 / §32 man citations
- Source location: see anchor table in Coverage notes
- Claim under audit (representative):
  > `%output` ... `tmux.1:7964-7967` ; `%extended-output` ... `tmux.1:7935-7944` ; `%session-renamed` ... `tmux.1:7982-7983` ; `%sessions-changed` ... `tmux.1:7989-7990` ; `%layout-change` ... `tmux.1:7946-7956` ; `%subscription-changed` ... `tmux.1:7991-8011`
- Reality in source of truth (true `.It` lines): `%output` 7960 (cited 7964-7967, off by 4 — note this is where the §6 `%pane-mode-changed` mis-cite at 7969-7971 originates, the whole block is shifted); `%extended-output` 7929 (cited 7935-7944); `%session-renamed` 7985 (cited 7982-7983); `%sessions-changed` 7993 (cited 7989-7990); `%layout-change` 7941 (cited 7946-7956); `%subscription-changed` 7995 (cited 7991-8011). Each is within ~2-6 lines of the true anchor; the citations clearly point at the right notification but the man section the manifest was written against was a few lines earlier than the current source-repo tmux.1. (`%window-*`, `%client-detached`, `%continue`, `%exit`, `%config-error`, "too far behind", `client_control_mode` all resolve exactly — see Coverage table.)
- Fix direction: correct-spec
- Recommendation: refresh the §6/§13/§32 `tmux.1` line numbers against the current source-repo tmux.1 (anchor table provided). Low urgency — directionally correct.
- Test impact: none.

## Sections with no findings

The following citation clusters were verified individually and resolve correctly (content matches at or within ±1 line of the cited range):

- **§1** Entry points: `tmux.c:393-398` (-C parse ✓), `control_start` `control.c:765-802` ✓ (body 769-802), `control_ready` `control.c:806-809` ✓ + callsite `server-client.c:3525-3526` ✓ (call at 3526), `control_stop` `control.c:825-845` ✓ + callsite `server-client.c:475-476` ✓ (call at 476), `control_discard` `control.c:813-821` ✓, `control_all_done` `control.c:578-586` ✓.
- **§3** Command input: `control_read_callback` `control.c:547-575` ✓, `EVBUFFER_EOL_LF` `control.c:557` ✓, empty-line detach `control.c:561-564` ✓, `cmd_parse_and_append` `control.c:567-570` ✓, parse-error `control.c:522-533` ✓.
- **§4** Guards: `cmdq_guard()` `cmd-queue.c:825-833` ✓ (format `%%%s %ld %u %d` confirms wire shape), begin `:619` ✓, error `:677` ✓, end `:679` ✓, `server_client_print()` `server-client.c:3988-4001` ✓, `cmd_capture_pane_exec` `cmd-capture-pane.c:241-242` ✓, `control_error()` `control.c:527-529` ✓.
- **§6** Code citations (all exact): `%output` `control.c:625`, `%extended-output` `control.c:621-623`, `%pause` `control.c:383,455`, `%continue` `control.c:369`, `%pane-mode-changed` `control-notify.c:34-39`, `%window-add` `:118`, `%window-close` `:100`, `%window-renamed` `:136-137`, `%window-pane-changed` `:79-86`, `%unlinked-window-add` `:120`, `%unlinked-window-close` `:102`, `%unlinked-window-renamed` `:139-140`, `%session-changed` `:160-161`, `%client-session-changed` `:163-164`, `%session-renamed` `:189` (`$%u %s` ✓), `%sessions-changed` `:202,215`, `%session-window-changed` `:228-229`, `%client-detached` `:176`, `%paste-buffer-changed` `:242`, `%paste-buffer-deleted` `:255`, `%message` `cmd-display-message.c:151`, `%config-error` `cfg.c:229,253` (grep-sampled), `%exit` `client.c:424-427`. Filtering rules (§6 "Notification Client Filtering", `control-notify.c:89-143`) ✓.
- **§5** `CONTROL_SHOULD_NOTIFY_CLIENT` `control-notify.c:26-27` ✓.
- **§7/§8** Exit: `%exit`/wait-exit `client.c:424-441` ✓, `server_client_check_exit` `server-client.c:3102-3148` ✓ (control_discard@3115, control_all_done@3116, MSG_EXIT@3136), `control_all_done` `control.c:579-586` ✓.
- **§10** Client flags — all value/line citations exact: `active-pane` `server-client.c:3826-3827`+`tmux.h:2033`, `ignore-size` `3824-3825`+`tmux.h:2019`, `no-detach-on-destroy` `3828-3829`+`tmux.h:2041`, `no-output` `3797-3798,3840-3841`+`tmux.h:2028`, `pause-after` `3789-3795`+`tmux.h:2034`, `read-only` `3822-3823`+`tmux.h:2013`, `wait-exit` `3799-3800`+`tmux.h:2035`; `server_client_set_flags` `3806-3845` ✓, `server_client_control_flags` `3786-3802` ✓.
- **§11-§13, §26** cmd-refresh-client.c: `82-131`, `134-164`, `47-79`, `167-192`, `256-258`, `268-277`, `278-287`, `288-292`, `261-262`, `263-264`, `265-266`, CLIENT_CONTROL guards `269-270`/`279-280` — all ✓.
- **§13** Subscription format strings: session `control.c:862`, pane `control.c:909,944`, window `control.c:989,1024`, `control_check_subs_timer` `control.c:1032`, `control_add_sub` `control.c:1129`, `control_remove_sub`/timer start-stop — all ✓.
- **§16/§17/§18** Backpressure & constants: `too far behind` `control.c:459`+`tmux.1:7723` ✓, pause/disconnect `control.c:451-461` ✓, `CONTROL_BUFFER_LOW=512` `:131`, `CONTROL_BUFFER_HIGH=8192` `:132`, `CONTROL_WRITE_MINIMUM=32` `:135`, `CONTROL_MAXIMUM_AGE=300000` `:138`, `CONTROL_IGNORE_FLAGS` `:141`, `CONTROL_PANE_OFF=0x1` `:66`, `CONTROL_PANE_PAUSED=0x2` `:67` — all exact.
- **§21** Flag values (all exact in tmux.h): `CLIENT_CONTROL=0x2000` `:2015`, `CLIENT_CONTROLCONTROL=0x4000` `:2016`, `CLIENT_CONTROL_NOOUTPUT=0x4000000` `:2028`, `CLIENT_CONTROL_PAUSEAFTER=0x100000000ULL` `:2034`, `CLIENT_CONTROL_WAITEXIT=0x200000000ULL` `:2035`; `CLIENT_UNATTACHEDFLAGS` `:2050-2053` ✓.
- **§23** `client_control_mode` `format.c:1422-1424,3079-3080` ✓ + `tmux.1:6270` ✓.
- **§24** `notify_callback` `notify.c:122-156` ✓.
- **§25** `control_write_output` callsite `window.c:1044-1047` ✓ (call@1046), control fg/bg init `-1` `window.c:955-956` ✓.
- **§29** Behavioral differences (spot-verified, CLIENT_CONTROL guard present at each): `resize.c:91` ✓, `alerts.c:310` ✓, `status.c:246,259` ✓, `server-fn.c:163` ✓. (Remaining §29 file:line citations grep-sampled, not individually opened.)
- **§19/§20/§30/§31** Data-structure / helper-function / source-file citations: grep-sampled — each named symbol present in the cited file near the cited line.
