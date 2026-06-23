# Audit shard: A3 — SPEC.md §8–§16 (Exit Handling … Backpressure)

## Scope
- Spec section(s) under audit: SPEC.md §8 Exit Handling, §9 Client Flags, §10 Data Encoding (+§10.1), §11 Client Size Control (+§11.1), §12 DCS Wrapping `-CC` (+§12.1), §13 Pane Control, §14 Subscriptions, §15 Reports (+§15.1), §16 Backpressure and Flow Control — SPEC.md:679–954.
- tmux source of truth: /Users/bmf/code/tmux_tmux (next-3.7 == tmux 3.7, HEAD 5c30b145) + man page /opt/homebrew/share/man/man1/tmux.1
- Audit axis: A (spec-vs-protocol), C (library-content-in-spec), M (citation resolution)

## Coverage notes
- Read end-to-end: client.c exit/raw-mode (340–445), tmux.c main (340–365), control.c (335–385 pane fns, 456–465 age, 579–595 all_done, 609–660 append_data/write_data, 795–805 DCS init, 813–820 discard, 849–1168 sub fns/timer/add/remove), server-client.c (3102–3148 check_exit, 3786–3850 flag parsing), cmd-refresh-client.c (1–300, all flag handling), tmux.h (1265–1270, 2013–2041, 2135–2148), window.c (1800–1893), input.c (2950–3050 OSC 10/11), man page tmux.1 (1041, 1367–1494, 7494–7500, 7720–7726).
- Grep-sampled only: integration test assertions (`extended-output|too far behind|%pause|setSize|requestReport|refresh-client -[rCAB]|%exit|pause-after`) to confirm no P0.
- Not examined: tmux 3.4 source (cannot verify §15.1's "rejected by tmux 3.4" claim against 3.4; only relevant to a relocation finding).

## Findings

### F1 — §10.1 is library content living in the protocol spec
- Severity: P3
- Category: library-content-in-spec
- Axis: C
- Spec location: SPEC.md:740–761 (§10.1 "Decoder behavior (library)")
- Source location: src/protocol/decode.ts (`decodeOctalEscapes`)
- Claim under audit: > The library's decoder (`src/protocol/decode.ts`, `decodeOctalEscapes`) applies three additional recovery rules so it stays byte-faithful to the canonical iTerm2 reference … These rules resolve audit finding SPEC.md F11
- Reality in source of truth: This describes recovery behavior of the library decoder (literal-control-byte drop, mid-escape `\r` skip, malformed-escape → `?`). It is not part of the tmux wire protocol — tmux's encoder (`control.c:631–642`) only ever emits clean streams; the recovery rules are explicitly noted as "not derivable from the encoding rule alone."
- Fix direction: relocate-to-IMPL/JSDoc
- Recommendation: Move §10.1 into IMPL.md (or `decodeOctalEscapes` JSDoc). §10 proper (the encoding rule) is the protocol floor and stays. (Known `(library)` incursion, flagged per assignment.)
- Test impact: none.

### F2 — §11.1 is library content living in the protocol spec
- Severity: P3
- Category: library-content-in-spec
- Axis: C
- Spec location: SPEC.md:781–787 (§11.1 "Library mapping (library)")
- Source location: src/protocol/encoder.ts (`refreshClientSize`), TmuxClient.setSize
- Claim under audit: > Form 1 (`-C <width>x<height>`) is wrapped as `TmuxClient.setSize(cols, rows)` … Forms 2 and 3 … have no typed wrapper
- Reality in source of truth: This is a description of the library's TS API surface, not the tmux protocol. The protocol-side `-C` forms are covered correctly in §11 proper.
- Fix direction: relocate-to-IMPL/JSDoc
- Recommendation: Relocate to IMPL.md / `setSize` JSDoc. (Known `(library)` incursion, flagged per assignment.)
- Test impact: none.

### F3 — §12.1 is library content living in the protocol spec
- Severity: P3
- Category: library-content-in-spec
- Axis: C
- Spec location: SPEC.md:811–829 (§12.1 "spawnTmux refusal (library)")
- Source location: src/transport/spawn.ts (`spawnTmux`)
- Claim under audit: > The library's default transport `spawnTmux` … uses `child_process.spawn`, which supplies pipe stdio … `spawnTmux` therefore emits `-C` only and exposes no option to request `-CC` … This resolves audit finding SPEC.md F4.
- Reality in source of truth: This documents a library transport decision, not the wire protocol. The protocol behavior of `-CC` is covered in §12 proper.
- Fix direction: relocate-to-IMPL/JSDoc
- Recommendation: Relocate to IMPL.md / `spawnTmux` JSDoc. (Known `(library)` incursion, flagged per assignment.) Note: §12.1's own embedded source cite `tmux.c:343-362` is wrong — see F5.
- Test impact: none.

### F4 — §15.1 is library content living in the protocol spec
- Severity: P3
- Category: library-content-in-spec
- Axis: C
- Spec location: SPEC.md:909–922 (§15.1 "Library note (library)")
- Source location: src/tmux-compat.ts:27 (`REQUEST_REPORT_MIN_VERSION = { major: 3, minor: 5 }`)
- Claim under audit: > `requestReport()` requires tmux 3.5+ … The minimum version is encoded in `src/tmux-compat.ts` as `REQUEST_REPORT_MIN_VERSION = { major: 3, minor: 5 }`.
- Reality in source of truth: Verified accurate to the library (`src/tmux-compat.ts:27`), but it describes `requestReport()`'s in-protocol version gate / typed `UnsupportedTmuxVersionError`, which is library behavior, not the tmux protocol. The protocol fact ("`-r` exists, behaves as described") is §15 proper. The `-r` flag IS present in the tmux 3.7 arg table (`cmd-refresh-client.c:38`, `"A:B:cC:Df:r:F:lLRSt:U"`).
- Fix direction: relocate-to-IMPL/JSDoc
- Recommendation: Relocate to IMPL.md / `requestReport` JSDoc. (Known `(library)` incursion, flagged per assignment.)
- Test impact: none.

### F5 — §12 and §12.1 cite `tmux.c:343-362` for `-CC` raw-mode config; the code is in `client.c`
- Severity: P1
- Category: spec-inaccuracy / manifest-citation-error
- Axis: A / M
- Spec location: SPEC.md:807 (§12) and SPEC.md:815–816 (§12.1)
- Source location: client.c:343–361 (actual); tmux.c:343–362 (cited — wrong)
- Claim under audit: > In `-CC` mode, the terminal is configured in raw mode (`tmux.c:343-362`): `c_iflag = ICRNL|IXANY` … (SPEC.md:807); and > tmux calls `tcgetattr(stdin)` at startup (`tmux.c:343-362`) … (SPEC.md:815)
- Reality in source of truth: The raw-mode block is in **client.c**, not tmux.c. `client.c:344`: `if (client_flags & CLIENT_CONTROLCONTROL) {`; `client.c:345`: `if (tcgetattr(STDIN_FILENO, &saved_tio) != 0)`; `client.c:351-358`: `tio.c_iflag = ICRNL|IXANY; tio.c_oflag = OPOST|ONLCR; … tio.c_cflag = CREAD|CS8|HUPCL; tio.c_cc[VMIN] = 1; tio.c_cc[VTIME] = 0;`. tmux.c:343–362 is the start of `getversion()`/`main()` — no terminal config there. Also `tcgetattr` is on `STDIN_FILENO`, so §12.1's parenthetical "`tcgetattr(stdin)`" is right but the file cite is wrong.
- Fix direction: correct-spec
- Recommendation: Change both `tmux.c:343-362` citations to `client.c:343-361`. The flag values themselves are correct.
- Test impact: none.

### F6 — §11 cites `tmux.1:1427-1438` for `-C` size; that man-page range documents `-A` pane control
- Severity: P3
- Category: manifest-citation-error
- Axis: M
- Spec location: SPEC.md:779 (§11 Source)
- Source location: man page tmux.1: `-C` size is at lines 1414–1425; line 1427 is `-A`
- Claim under audit: > **Source:** `cmd-refresh-client.c:82-131`, `tmux.1:1427-1438` (SPEC.md:779)
- Reality in source of truth: tmux.1:1414 `.Fl C` / 1415 "sets the width and height of a control mode client or of a window"; tmux.1:1426 `.Fl A` / 1427 "allows a control mode client to trigger actions on a pane." The cited 1427–1438 is the `-A` (§13) block, not `-C`. The `cmd-refresh-client.c:82-131` cite is correct (`cmd_refresh_client_control_client_size`).
- Fix direction: correct-spec
- Recommendation: Change the man-page cite to `tmux.1:1414-1425`.
- Test impact: none.

### F7 — §15 cites `tmux.1:1490-1494` for `-r`; that man-page range documents `-l` (clipboard)
- Severity: P3
- Category: manifest-citation-error
- Axis: M
- Spec location: SPEC.md:907 (§15 Source)
- Source location: man page tmux.1: `-r` is at lines 1482–1487; line 1489 is `-l`
- Claim under audit: > `tmux.1:1490-1494` (SPEC.md:907)
- Reality in source of truth: tmux.1:1482 `.Fl r` / 1483 "allows a control mode client to provide information about a pane via a report (such as the response to OSC 10)." / 1487 "a colon, then a report escape sequence." tmux.1:1489 `.Fl l` / 1490 "requests the clipboard from the client" — the cited 1490–1494 is the `-l` block, not `-r`.
- Fix direction: correct-spec
- Recommendation: Change the man-page cite to `tmux.1:1482-1487`.
- Test impact: none.

### F8 — §16.1 cites `tmux.1:7723-7725` for "too far behind"; that range documents `%layout-change`
- Severity: P3
- Category: manifest-citation-error
- Axis: M
- Spec location: SPEC.md:934 (§16.1 Source)
- Source location: man page tmux.1: "too far behind" is at lines 7496–7498
- Claim under audit: > **Source:** `control.c:456-461`, `tmux.1:7723-7725` (SPEC.md:934)
- Reality in source of truth: tmux.1:7496 `.It too far behind` / 7497 "The client is in control mode and became unable to keep up with the data from". tmux.1:7720–7725 is the `%layout-change` description ("The layout of a window with ID … changed."). The `control.c:456-461` cite is correct (`age < CONTROL_MAXIMUM_AGE` / `xstrdup("too far behind")`).
- Fix direction: correct-spec
- Recommendation: Change the man-page cite to `tmux.1:7496-7498`.
- Test impact: none.

### F9 — §15 cites `input.c:2999` and says `window_pane_get_bg_control_client()` is queried "by input_osc_11()"; input.c never calls that getter
- Severity: P3
- Category: under-citation / spec-inaccuracy
- Axis: A / M
- Spec location: SPEC.md:896–905 (§15 prose + Source `input.c:2955, 2999`)
- Source location: input.c:2955 (fg call, correct); input.c:2999 (`int c;` declaration, not a call); window.c:1800 + 1840 (bg path)
- Claim under audit: > These are queried via `window_pane_get_fg_control_client()` and `window_pane_get_bg_control_client()` for rendering, specifically by `input_osc_10()` and `input_osc_11()` … **Source:** … `input.c:2955, 2999`
- Reality in source of truth: The fg path is direct and correctly cited: input.c:2955 `c = window_pane_get_fg_control_client(wp);` inside `input_osc_10`. The bg path is **indirect**: `input_osc_11` (input.c:3003) calls `c = window_pane_get_bg(wp);`, and `window_pane_get_bg` (window.c:1805) is what calls `window_pane_get_bg_control_client`. `grep window_pane_get_bg_control_client input.c` returns nothing. Cited input.c:2999 is just `int c;` in `input_osc_11`'s declarations.
- Fix direction: correct-spec
- Recommendation: Either cite the bg path through `window.c:1800` (`window_pane_get_bg` → `window_pane_get_bg_control_client`) or note the asymmetry (fg direct, bg via `window_pane_get_bg`). Replace the `input.c:2999` cite with `window.c:1800` or `input.c:3003` (the `window_pane_get_bg` callsite).
- Test impact: none.

### F10 — §14 sub-cite "(timer, add, remove, check functions)" at `control.c:1032-1168` excludes the check functions (control.c:849–1031)
- Severity: P3
- Category: under-citation
- Axis: M
- Spec location: SPEC.md:879 (§14 Source)
- Source location: control.c:849–1031 (check_subs_* functions) vs cited 1032–1168
- Claim under audit: > `control.c:1032-1168` (timer, add, remove, check functions)
- Reality in source of truth: The cited range 1032–1168 covers `control_check_subs_timer` (1032), `control_add_sub` (1129), `control_remove_sub` (1158). The per-type **check functions** are at control.c:849 (`control_check_subs_session`), 870 (`_pane`), 918 (`_all_panes_one`), 952 (`_window`), 998 (`_all_windows_one`) — all below the cited range. The parenthetical claims "check functions" are in 1032–1168 but they are not.
- Fix direction: correct-spec
- Recommendation: Extend the cite to `control.c:849-1168`, or drop "check functions" from the parenthetical.
- Test impact: none.

## Sections with no findings
- §8 Exit Handling: WAITEXIT block `client.c:429-437` (cited 429-436), DCS+tcsetattr `client.c:438-442` (cited 438-441), `control_all_done` `control.c:579-586` (cited, ✓ "all blocks flushed and write buffer empty" matches `TAILQ_EMPTY(&all_blocks) && EVBUFFER_LENGTH==0`), `server_client_check_exit` `server-client.c:3102-3148` (cited, ✓ calls `control_discard` at 3115 then waits on `control_all_done` at 3116). All accurate.
- §9 Client Flags: all 7 hex values verified exact against tmux.h:2013–2041 (read-only 0x800, ignore-size 0x20000, no-output 0x4000000, active-pane 0x80000000ULL, pause-after 0x100000000ULL, wait-exit 0x200000000ULL, no-detach-on-destroy 0x8000000000ULL). `server_client_control_flags` parses exactly {pause-after, no-output, wait-exit} (`server-client.c:3787-3801`); pause-after `*= 1000` → "stored as ms internally" ✓; no-output → `control_reset_offsets` → "resets offsets when set" ✓. Citations resolve.
- §10 Data Encoding (proper): `control.c:631-642` octal loop verified — `new_data[i] < ' ' || new_data[i] == '\\'` → `\%03o`; else literal. Table correct including 0x7F and 0x80–0xFF sent as-is (both are `>= ' '`).
- §11 Client Size Control (proper): three `-C` forms verified at `cmd-refresh-client.c:82-131` (`@w:XxY` per-window, `@w:` clear via sx/sy=0, `XxY` overall); `~CLIENT_CONTROL → not_control_client` confirms "Requires CLIENT_CONTROL". (Man-page cite issue is F6.)
- §12 DCS Wrapping (proper): `\033P1000p` init at `control.c:799` ✓; `\033\\` terminator at `client.c:439` ✓; `tcsetattr` restore at `client.c:441` ✓. (Raw-mode file cite is F5.)
- §13 Pane Control: all four actions verified at `control.c:335-385` (`control_set_pane_on` clears OFF + resets offset/queued; `control_set_pane_off` sets OFF; `control_pause_pane` sets PAUSED + discard + `%pause`; `control_continue_pane` clears PAUSED + reset + `%continue`); dispatch at `cmd-refresh-client.c:134-164`; CLIENT_CONTROL enforced. Source cites resolve.
- §14 Subscriptions (proper): `what`→enum mapping (%*→ALL_PANES, %id→PANE, @*→ALL_WINDOWS, @id→WINDOW, empty→SESSION) verified at `cmd-refresh-client.c:47-79`; name-only → `control_remove_sub`; 1-second timer (`tv_sec = 1`, `control.c:1041`/`1134`); enum order matches tmux.h:2138–2144. (Check-fn cite breadth is F10.)
- §15 Reports (proper): `-r` does NOT check CLIENT_CONTROL (`cmd-refresh-client.c:265-266`, no guard) ✓; report parsed by `tty_keys_colours` into `wp->control_fg`/`wp->control_bg` (`cmd-refresh-client.c:188-189`); `window_pane_get_{fg,bg}_control_client` at window.c:1840/1881; `control_bg`/`control_fg` fields at tmux.h:1267-1268 ✓. (input.c cite is F9.)
- §16 Backpressure: `CONTROL_MAXIMUM_AGE 300000` ms = 300 s = 5 min, "too far behind" exit (`control.c:457-461`) ✓; pause-after path sets CONTROL_PANE_PAUSED + `control_discard_pane` + `%pause` (`control.c:452-456`) ✓; `%extended-output %id <age-ms> :` format (`control.c:620-623`) ✓; continue resets offsets + `%continue` no-replay (`control.c:358-371`) ✓. control.c cites resolve. (Man-page cite is F8.)
