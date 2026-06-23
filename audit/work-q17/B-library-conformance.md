# Audit shard: B-library-conformance

## Scope
- Spec section(s) / source under audit: SPEC.md §4, §5, §7, §10, §11, §14, §15, §23 are the source of truth; audited artifacts are `src/protocol/parser.ts`, `src/protocol/types.ts`, `src/protocol/decode.ts`, `src/protocol/byte-codec.ts`, `src/protocol/encoder.ts`, `src/client.ts`, `src/commands/index.ts`.
- tmux source of truth: /Users/bmf/code/tmux_tmux (next-3.7 == tmux 3.7) + man page /opt/homebrew/share/man/man1/tmux.1
- Audit axis: B (library-vs-spec)

## Coverage notes
- Read end-to-end: `src/protocol/parser.ts`, `src/protocol/types.ts`, `src/protocol/decode.ts`, `src/protocol/byte-codec.ts`, `src/protocol/encoder.ts`, `src/commands/index.ts`, `src/client.ts`. SPEC.md §5, §6, §7 (all notification subsections), §10/§10.1, §11, §14, §15, §23.
- Cross-checked against tmux C source for every wire format: `control.c` (`control_append_data`, `control_check_subs_*`), `cmd-queue.c` (`cmdq_guard`), `control-notify.c` (window/session/client notifies), `cmd-refresh-client.c` (`-B`/`-A`/`-C`/`-r` arg parsing), `cmd-send-keys.c` (`-H` hex parsing), `cmd-display-message.c`, `cfg.c`.
- Grep-sampled only: `tests/integration/client.test.ts` (grep for assertion keywords) — to check for a "green for the wrong reason" gate; none found.
- Not examined (out of protocol-core scope): topology-router.ts, emitter.ts, connection-state.ts, transport/*, connectors/* — these are ergonomic/added-capability layers, not protocol parsing/encoding.

## Findings

No conformance bugs found. Every protocol behavior SPEC.md describes is implemented by the library exactly as the tmux wire format requires, confirmed field-by-field against the tmux 3.7 C source. See "Sections with no findings" for the verified-correct conformance evidence.

## Sections with no findings

### Guard block framing (§5 / §23) — `parseGuard`, `client.ts` correlation — CORRECT
- SPEC §5.1: `%<guard> <timestamp> <command-number> <flags>`. tmux `cmd-queue.c:832` emits `"%%%s %ld %u %d", guard, t, number, flags` — exactly 3 args after the guard word.
- `parser.ts:47-59` `parseGuard` reads `parts[0]`=timestamp, `parts[1]`=commandNumber, `parts[2]`=flags, rejecting `< 3` parts. Field order and count match.
- §5 / §6 block-purity invariant ("a notification will never occur inside a response block"): `parser.ts:351-417` routes by *position* — any non-terminator line while `activeCommandNumber !== -1` is command output (even a leading-`%` line like `%5`), and only `%end`/`%error` close the block. `client.ts:202-234` correlates via a FIFO `pending` queue + single `inflight` slot; `%begin` shifts the queue, `%end` resolves, `%error` rejects. Matches the protocol guarantee.

### `%output` / `%extended-output` (§7.1, §10, §23) — `parseOutput`, `parseExtendedOutput`, `decode.ts` — CORRECT
- tmux `control.c:625` emits `"%%output %%%u "` then data; `control.c:621-623` emits `"%%extended-output %%%u %llu : "` (id, age, literal ` : `). `parseOutput` (`parser.ts:61-71`) splits on first space → paneId + decoded value. `parseExtendedOutput` (`parser.ts:73-87`) splits on `" : "`, takes `parts[0]`=paneId, `parts[1]`=age — matching tmux's exact ` : ` separator and current zero reserved fields, while tolerating future reserved fields (extra head parts ignored).
- Octal encoding (§10): tmux `control.c:631-642` escapes bytes `< ' '` or `\` as `\%03o`, all others as-is. `decode.ts:36-79` inverts this exactly (3-octal-digit `\NNN` → byte; literal `< 0x20` dropped as transport noise; malformed escape → `?`). The §10.1 recovery rules are implemented as documented.

### `%pause` / `%continue` / `%pane-mode-changed` (§7.2-7.3) — `parsePaneIdOnly` — CORRECT
- tmux `control.c:369/383` and `control-notify.c:38` each emit `<type> %<id>` (single pane id). `parsePaneIdOnly` (`parser.ts:89-97`) takes `split(" ")[0]`. Matches.

### Window events (§7.4, §23) — `parseWindowIdOnly`, `parseWindowRenamed`, `parseWindowPaneChanged` — CORRECT
- `%window-add`/`-close` and unlinked variants emit `@<id>` only (`control-notify.c:118-120,100-102`); `parseWindowIdOnly` reads one window id. `%window-renamed`/`%unlinked-window-renamed` emit `@<id> <name>` (`control-notify.c:136,139`); `parseWindowRenamed` splits on first space keeping the rest as name (so names with spaces survive). `%window-pane-changed` emits `@<wid> %<pid>` (`control-notify.c:83`); `parseWindowPaneChanged` reads windowId=`parts[0]`, paneId=`parts[1]` — order matches.

### Session/client events (§7.6-7.7, §23) — CORRECT
- `%session-changed`/`%session-renamed` emit `$<sid> <name>` (`control-notify.c:160,189`); `parseSessionWithName` (`parser.ts:149-161`) reads sessionId then rest-as-name. `%session-window-changed` emits `$<sid> @<wid>` (`control-notify.c:228`); parser reads `parts[0]`,`parts[1]` in that order. `%client-session-changed` emits `<clientName> $<sid> <name>` (`control-notify.c:163`); `parseClientSessionChanged` (`parser.ts:177-189`) reads clientName, then sessionId, then rest-as-name — three-field order matches. `%client-detached` emits `<clientName>` (`control-notify.c:176`); parser reads first token. `%sessions-changed` takes no args; `parseSessionsChanged` returns the bare variant.

### `%subscription-changed` field order (§7.9, §14, §23) — `parseSubscriptionChanged` — CORRECT
- tmux `control.c:862/909/989` emit `%subscription-changed <name> $<sid> @<wid> <idx> %<pid> : <value>` with `-` placeholders for inapplicable fields. `parseSubscriptionChanged` (`parser.ts:207-224`) splits the head on `" : "`, then reads `parts[0]`=name, `[1]`=sessionId, `[2]`=windowId, `[3]`=windowIndex, `[4]`=paneId (each via `parseOptionalId`/`parseOptionalInt` mapping `-` → -1), `value`=tail. Argument order, count, and the `-`-as-(-1) sentinel all match the wire format and SPEC §7.9's per-type table.

### `%message` / `%config-error` / `%exit` (§7.10-7.12, §23) — CORRECT
- `%message <msg>` (`cmd-display-message.c:151`), `%config-error <error>` (`cfg.c:229,253`): parsers take the whole arg string as the field. `%exit [<reason>]`: `parseExit` (`parser.ts:234-239`) maps empty args → `reason: undefined`, else the string — matching the optional-reason wire form.

### Outbound encoding (§11, §13, §14, §15) — `encoder.ts` — CORRECT
- `refresh-client -C <w>x<h>` (§11): `refreshClientSize` emits `refresh-client -C ${w}x${h}`, matching tmux's `sscanf(size, "%ux%u")` path (`cmd-refresh-client.c:117-118`).
- `refresh-client -A %<id>:<action>` (§13): `refreshClientPaneAction` quotes the whole `%N:action` token; tmux `cmd_refresh_client_update_offset` splits the dequoted value on `:` (`cmd-refresh-client.c:143`). Quoting the `:`-bearing token is required and correct.
- `refresh-client -B <name>:<what>:<format>` (§14): tmux `cmd_refresh_client_update_subscription` splits the single dequoted value on the first two literal `:` (`cmd-refresh-client.c:54-63`). The encoder's per-piece `tmuxEscape` produces `'name':'what':'format'` whose colons sit outside the quotes, so after dequoting tmux sees `name:what:format` and splits correctly. Name-only unsubscribe (`refresh-client -B name`) maps to tmux's `strchr == NULL → control_remove_sub` path.
- `refresh-client -r %<id>:<report>` (§15): `refreshClientReport` quotes the `%N:report` token; tmux `cmd_refresh_report` requires leading `%` and splits on `:` (`cmd-refresh-client.c:174-177`). Matches.
- `send-keys -H -t <target> <hex...>`: tmux `cmd-send-keys.c:116-122` parses each `-H` arg as one hex byte (`strtol base 16`, `0..0xff`). `encoder.ts:49-65` emits space-separated 2-digit hex of the UTF-8 bytes, one arg per byte. Matches exactly.

### `requestReport` version gating (§15.1) — `commands/index.ts:151-165` — CORRECT
- SPEC §15.1: `-r` needs tmux 3.5+; the library probes the live version and rejects 3.2–3.4 with a typed error rather than leaking tmux's raw `%error`. Implementation probes via `queryTmuxVersion` (`display-message -p "#{version}"`) and throws `UnsupportedTmuxVersionError` when below `REQUEST_REPORT_MIN_VERSION`. Matches the spec'd behavior.

### byte-codec (§10 latin1 round-trip) — CORRECT
- `bytesToLatin1`/`latin1ToBytes` (`byte-codec.ts`) are a genuine 1:1 byte↔code-unit bijection (manual `charCodeAt`/`fromCharCode`), deliberately avoiding `TextDecoder('latin1')`'s windows-1252 remap — consistent with the transport's `setEncoding("latin1")` byte-faithful contract that the octal decoder relies on.

### Integration gate (`tests/integration/client.test.ts`) — no "green for the wrong reason"
- Sampled assertions check structural shapes (`typeof paneId === "number"`, event firing) and live round-trips; none assert a parser behavior that contradicts the verified tmux wire formats. The conformance gate passes for the right reason.
