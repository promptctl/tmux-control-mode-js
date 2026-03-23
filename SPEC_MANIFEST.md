# tmux Control Mode - Complete Manifest

Everything related to tmux control mode, with source citations from the tmux
repository (version next-3.7, commit 5c30b145).

---

## 1. Entry Points and Initialization

- **`-C` flag** enables control mode (`CLIENT_CONTROL`); given twice (`-CC`)
  also sets `CLIENT_CONTROLCONTROL` which disables echo and uses a single
  bidirectional socket
  - `tmux.c:393-398` (flag parsing)
  - `tmux.1:104-110` (man page)

- **`control_start()`** initializes control mode for a client: allocates
  `control_state`, sets up `bufferevent` for read/write, sets write watermark,
  writes DCS `\033P1000p` for `-CC` mode
  - `control.c:765-802`

- **`control_ready()`** enables `EV_READ` on the read event to start accepting
  commands
  - `control.c:806-809`
  - Called from `server-client.c:3525-3526` when client is attached and in
    control mode

- **`control_stop()`** tears down control mode: frees bufferevents,
  subscriptions, timer, blocks, resets offsets
  - `control.c:825-845`
  - Called from `server-client.c:475-476` during client cleanup

- **`control_discard()`** discards all pending output and disables reading
  (called during exit)
  - `control.c:813-821`

- **`control_all_done()`** checks if all pending output has been flushed:
  returns true when `all_blocks` queue is empty AND write event output buffer is
  empty
  - `control.c:578-586`

---

## 2. DCS Wrapping (`-CC` Mode)

- On startup: writes `\033P1000p` (7 bytes) before any protocol output
  - `control.c:799`
- `-CC` mode closes `out_fd` and uses a single `bufferevent` for both read and
  write (stdin/stdout share a socket)
  - `control.c:769-771, 787-788`
- `-CC` terminal raw mode configuration (`tmux.c:343-362`): when
  `CLIENT_CONTROLCONTROL` is set, the terminal is configured with:
  - `c_iflag = ICRNL|IXANY`
  - `c_oflag = OPOST|ONLCR`
  - `c_lflag = NOKERNINFO` (if available)
  - `c_cflag = CREAD|CS8|HUPCL`
  - `c_cc[VMIN] = 1`, `c_cc[VTIME] = 0`
  - Baud rates preserved from saved settings
- On exit: writes DCS terminator `\033\\` and restores terminal settings with
  `tcsetattr()`
  - `client.c:438-441`

---

## 3. Command Input Protocol

- Client sends tmux commands as newline-terminated lines on stdin
  - `control.c:547-575` (`control_read_callback`)
- Lines are read with `EVBUFFER_EOL_LF`
  - `control.c:557`
- An **empty line** causes the client to detach (`CLIENT_EXIT`)
  - `control.c:561-564`
- Commands are parsed with `cmd_parse_and_append()` using `CMDQ_STATE_CONTROL`
  flag
  - `control.c:567-570`
- Parse errors generate a `control_error` callback that writes a begin/error
  block containing `parse error: <message>`
  - `control.c:522-533`
- `CMDQ_STATE_CONTROL` is defined as `0x2`
  - `tmux.h:1838`
- Multiple commands may be separated by `;` on a single line, following normal
  tmux command-line syntax
  - `tmux.1:7870`

---

## 4. Command Response Protocol (`%begin` / `%end` / `%error`)

- Each command produces exactly one response block
- Format: `%<guard> <timestamp> <command-number> <flags>`
  - `<guard>` is `begin`, `end`, or `error`
  - `<timestamp>` is `long` (seconds since epoch, `item->time`)
  - `<command-number>` is `u_int` (`item->number`), monotonically increasing
  - `<flags>` is `int`: 1 if `CMDQ_STATE_CONTROL`, 0 otherwise
  - `cmd-queue.c:825-833` (`cmdq_guard()`)
- `cmdq_guard()` is called at:
  - `cmd-queue.c:619` (begin, before command execution)
  - `cmd-queue.c:677` (error, on command failure)
  - `cmd-queue.c:679` (end, on command success)
- A notification will never occur inside a response block
  - `tmux.1:7896-7897`
- Command output (lines between `%begin` and `%end`/`%error`) is written via
  `control_write()` from multiple callsites:
  - `server_client_print()` writes command output; sanitizes non-UTF8 if needed
    - `server-client.c:3988-4001`
  - `cmdq_print()` writes command output/messages within response blocks
    - `cmd-queue.c:881-891`
  - `cmd_capture_pane_exec()` writes captured pane output for `capture-pane -p`
    - `cmd-capture-pane.c:241-242`
  - `control_error()` writes parse error messages
    - `control.c:527-529`

---

## 5. Notifications Overview

- Notifications are asynchronous, single-line messages beginning with `%`
- They are dispatched through the notify system: `notify.c:122-156`
  (`notify_callback`) maps hook names to `control_notify_*` functions
- All notifications also correspond to hooks (except `%exit`)
  - `tmux.1:5671-5674`
- The macro `CONTROL_SHOULD_NOTIFY_CLIENT(c)` checks `(c)->flags & CLIENT_CONTROL`
  - `control-notify.c:26-27`

---

## 6. All Notification Types

### Pane Output

- **`%output <pane-id> <value>`** - pane produced output (without `pause-after`)
  - `control.c:625` (format string)
  - `tmux.1:7964-7967`
- **`%extended-output <pane-id> <age> ... : <value>`** - pane output with age
  (with `pause-after`); arguments between `<age>` and `:` are reserved
  - `control.c:621-623` (format string)
  - `tmux.1:7935-7944`

### Pane Flow Control

- **`%pause <pane-id>`** - pane paused
  - `control.c:383` (explicit pause), `control.c:455` (age-triggered pause)
  - `tmux.1:7973-7975`
- **`%continue <pane-id>`** - pane resumed
  - `control.c:369`
  - `tmux.1:7914-7918`

### Pane Mode

- **`%pane-mode-changed <pane-id>`** - pane entered/exited a mode (e.g. copy
  mode)
  - Sent to ALL control clients (no session filter)
  - `control-notify.c:34-39`
  - `tmux.1:7969-7971`

### Window Events

- **`%window-add <window-id>`** - window linked to current session
  - `control-notify.c:118`
  - `tmux.1:8027-8029`
- **`%window-close <window-id>`** - window closed (unlinked from current
  session)
  - `control-notify.c:100`
  - `tmux.1:8031-8033`
- **`%window-renamed <window-id> <name>`** - window in current session renamed
  - `control-notify.c:136-137`
  - `tmux.1:8039-8042`
- **`%window-pane-changed <window-id> <pane-id>`** - active pane in window
  changed
  - Sent to ALL control clients (no session filter)
  - `control-notify.c:79-86`
  - `tmux.1:8035-8038`
- **`%unlinked-window-add <window-id>`** - window created but not linked to
  current session
  - `control-notify.c:120`
  - `tmux.1:8013-8015`
- **`%unlinked-window-close <window-id>`** - unlinked window closed
  - `control-notify.c:102`
  - `tmux.1:8017-8020`
- **`%unlinked-window-renamed <window-id> <name>`** - unlinked window renamed
  (code sends window ID and name)
  - `control-notify.c:139-140`
  - `tmux.1:8022-8025`

### Layout Events

- **`%layout-change <window-id> <layout> <visible-layout> <flags>`** - window
  layout changed; generated via `format_single()` expansion of the template
  `%layout-change #{window_id} #{window_layout} #{window_visible_layout} #{window_raw_flags}`
  - `control-notify.c:51-52, 62, 69`
  - `tmux.1:7946-7956`
- Not sent if the window has no `layout_root` (i.e. when the last pane in a
  window is being closed - the window will go away soon anyway)
  - `control-notify.c:58-61`
- Only sent to control clients whose session contains the affected window
  (`winlink_find_by_window_id`)
  - `control-notify.c:64-70`

### Session Events

- **`%session-changed <session-id> <name>`** - this client's attached session
  changed (sent to the client itself)
  - `control-notify.c:160-161`
  - `tmux.1:7977-7980`
- **`%client-session-changed <client-name> <session-id> <name>`** - another
  client changed its session (sent to other control clients)
  - `control-notify.c:163-164`
  - `tmux.1:7907-7911`
- **`%session-renamed <session-id> <name>`** - session renamed (NOTE: man page
  says just `<name>` but code sends `$%u %s`)
  - `control-notify.c:189`
  - `tmux.1:7982-7983`
- **`%sessions-changed`** - a session was created or destroyed (no arguments)
  - `control-notify.c:202, 215`
  - `tmux.1:7989-7990`
- **`%session-window-changed <session-id> <window-id>`** - active window in
  session changed
  - `control-notify.c:228-229`
  - `tmux.1:7985-7988`

### Client Events

- **`%client-detached <client-name>`** - a client has detached
  - `control-notify.c:176`
  - `tmux.1:7905-7906`

### Paste Buffer Events

- **`%paste-buffer-changed <name>`** - paste buffer created or modified
  - `control-notify.c:242`
  - `tmux.1:7969-7971`
- **`%paste-buffer-deleted <name>`** - paste buffer deleted
  - `control-notify.c:255`
  - `tmux.1:7972-7973`

### Notification Client Filtering

Not all notifications are sent to all control clients. The filtering rules are:

- **All control clients (no session required):**
  `%pane-mode-changed`, `%window-pane-changed`, `%client-detached`,
  `%session-renamed`, `%sessions-changed`, `%session-window-changed`,
  `%paste-buffer-changed`, `%paste-buffer-deleted`

- **Control clients with a session (filter: `c->session != NULL`):**
  `%layout-change` (also checks window is in session),
  `%window-add`/`%window-close` (checks if window is in client's session to
  choose linked vs unlinked variant),
  `%window-renamed`/`%unlinked-window-renamed` (same linked/unlinked check),
  `%unlinked-window-add`/`%unlinked-window-close`,
  `%session-changed`/`%client-session-changed`

- **Window linked vs unlinked logic:**
  `control_notify_window_unlinked`, `control_notify_window_linked`, and
  `control_notify_window_renamed` check if the window is linked to the
  RECEIVING client's session (`winlink_find_by_window_id(&cs->windows, w->id)`),
  not the session that triggered the event. If linked, sends `%window-*`; if
  not, sends `%unlinked-window-*`.
  - `control-notify.c:89-143`

### Subscription Events

- **`%subscription-changed <name> <session-id> <window-id> <window-index> <pane-id> ... : <value>`**
  - Session-level: `$%u - - - : %s` (`control.c:862`)
  - Pane-level: `$%u @%u %u %%%u : %s` (`control.c:909, 944`)
  - Window-level: `$%u @%u %u - : %s` (`control.c:989, 1024`)
  - `tmux.1:7991-8011`

### Messages

- **`%message <message>`** - from `display-message` command to a control client
  - `cmd-display-message.c:151`
  - `tmux.1:7958-7960`

### Configuration Errors

- **`%config-error <error>`** - configuration file parsing error
  - `cfg.c:229, 253`
  - `tmux.1:7912-7913`

### Exit

- **`%exit [<reason>]`** - client is exiting; printed client-side on stdout
  - `client.c:424-427`
  - `tmux.1:7920-7925`

---

## 7. Exit Reasons

- `detached` / `detached (from session <name>)` - `client.c:192-198`
- `detached and SIGHUP` / `detached and SIGHUP (from session <name>)` -
  `client.c:199-205`
- `lost tty` - `client.c:207`
- `terminated` - `client.c:209`
- `server exited unexpectedly` - `client.c:211`
- `exited` - `client.c:213`
- `server exited` - `client.c:215`
- Custom message via `CLIENT_EXIT_MESSAGE_PROVIDED` (e.g. `too far behind`,
  `detach-client -E` message) - `client.c:216-217`
- Enum: `CLIENT_EXIT_NONE` through `CLIENT_EXIT_MESSAGE_PROVIDED`
  - `client.c:40-49`
- Exit message wire format (server -> client via `MSG_EXIT`): `[4-byte retval]`
  followed by optional null-terminated message string. Parsed by
  `client_dispatch_exit_message()`.
  - `client.c:601-625`

---

## 8. Exit Handling

- After `%exit`, if `CLIENT_CONTROL_WAITEXIT` is set, client blocks reading
  stdin until an empty line or EOF
  - `client.c:429-436`
- After wait-exit, if `-CC` mode, writes DCS terminator `\033\\` and restores
  terminal
  - `client.c:438-441`
- Server-side: `server_client_check_exit()` calls `control_discard()` and waits
  for `control_all_done()` before sending exit message
  - `server-client.c:3102-3148`
- `control_all_done()` returns true when both `all_blocks` queue is empty and
  the write event output buffer is empty
  - `control.c:579-586`

---

## 9. Data Encoding (Pane Output)

- Used in `%output` and `%extended-output` value fields
- Bytes < 0x20 (space): encoded as `\` + 3-digit octal (e.g., `\012`)
- Backslash (`\`, 0x5C): encoded as `\134`
- All other bytes (0x20-0x5B, 0x5D-0xFF): sent as-is
- Encoding loop in `control_append_data()`
  - `control.c:631-642`

---

## 10. Client Flags

Set via `attach-session -f`, `new-session -f`, or `refresh-client -f` (or `-F`
alias). Comma-separated; prefix `!` to disable.

- **`active-pane`** - independent active pane (`CLIENT_ACTIVEPANE`,
  `0x80000000ULL`)
  - `server-client.c:3826-3827`, `tmux.h:2033`
  - `tmux.1:1073-1074`
- **`ignore-size`** - does not affect other clients' sizes
  (`CLIENT_IGNORESIZE`, `0x20000`)
  - `server-client.c:3824-3825`, `tmux.h:2019`
  - `tmux.1:1075-1076`
- **`no-detach-on-destroy`** - don't detach when session destroyed
  (`CLIENT_NO_DETACH_ON_DESTROY`, `0x8000000000ULL`)
  - `server-client.c:3828-3829`, `tmux.h:2041`
  - `tmux.1:1077-1079`
- **`no-output`** - suppress pane output (`CLIENT_CONTROL_NOOUTPUT`,
  `0x4000000`); resets offsets when set
  - `server-client.c:3797-3798, 3840-3841`, `tmux.h:2028`
  - `tmux.1:1080-1081`
- **`pause-after[=<seconds>]`** - pause panes when buffered output exceeds age;
  `pause_age` stored in milliseconds (input is seconds * 1000); switches output
  to `%extended-output` (`CLIENT_CONTROL_PAUSEAFTER`, `0x100000000ULL`)
  - `server-client.c:3789-3795`, `tmux.h:2034`
  - `tmux.1:1082-1085`
- **`read-only`** - client is read-only (`CLIENT_READONLY`, `0x800`)
  - `server-client.c:3822-3823`, `tmux.h:2013`
  - `tmux.1:1086-1087`
- **`wait-exit`** - wait for empty line on stdin before exiting
  (`CLIENT_CONTROL_WAITEXIT`, `0x200000000ULL`)
  - `server-client.c:3799-3800`, `tmux.h:2035`
  - `tmux.1:1088-1089`

Flag parsing: `server_client_set_flags()` (`server-client.c:3806-3845`)
dispatches to `server_client_control_flags()` (`server-client.c:3786-3802`)
for control-mode-specific flags.

---

## 11. Client Size Control (`refresh-client -C`)

- Format: `<width>x<height>` for overall client size, or
  `@<window-id>:<width>x<height>` for per-window size
- `@<window-id>:` (no size) clears per-window size override
- `cmd-refresh-client.c:82-131` (`cmd_refresh_client_control_client_size`)
- `tmux.1:1427-1438`

---

## 12. Pane Control (`refresh-client -A`)

- Format: `%<pane-id>:<action>`; may be specified multiple times
- Requires `CLIENT_CONTROL` (`cmd-refresh-client.c:269-270`)
- Actions:
  - `on` - enable output (`control_set_pane_on`, `control.c:335-346`)
  - `off` - disable output; stops reading if all clients have it off
    (`control_set_pane_off`, `control.c:349-356`)
  - `pause` - pause pane; sends `%pause` (`control_pause_pane`,
    `control.c:374-385`)
  - `continue` - resume paused pane; sends `%continue`; output resumes from
    current position (`control_continue_pane`, `control.c:359-371`)
- Parsing: `cmd_refresh_client_update_offset()` (`cmd-refresh-client.c:134-164`)
- `tmux.1:1439-1461`

---

## 13. Subscriptions (`refresh-client -B`)

- Format: `<name>:<what>:<format>` to add, `<name>` alone to remove
- Requires `CLIENT_CONTROL` (`cmd-refresh-client.c:279-280`)
- `<what>` values:
  - *(empty)* - session only (`CONTROL_SUB_SESSION`)
  - `%<pane-id>` - specific pane (`CONTROL_SUB_PANE`)
  - `%*` - all panes in session (`CONTROL_SUB_ALL_PANES`)
  - `@<window-id>` - specific window (`CONTROL_SUB_WINDOW`)
  - `@*` - all windows in session (`CONTROL_SUB_ALL_WINDOWS`)
- Changes reported via `%subscription-changed` at most once per second
  (1-second timer)
  - `control.c:1041` (timer interval)
- Subscription management:
  - `control_add_sub()` - `control.c:1129-1154`
  - `control_remove_sub()` - `control.c:1158-1168`
  - `control_check_subs_timer()` - `control.c:1032-1125`
- Change detection: each subscription stores last-seen value(s) and only fires
  when the format expansion result differs
  - Per-session: single `last` string (`control.c:857-865`)
  - Per-pane: RB tree of `control_sub_pane` keyed by (pane_id, winlink_idx)
    (`control.c:893-912`)
  - Per-window: RB tree of `control_sub_window` keyed by (window_id,
    winlink_idx) (`control.c:973-992`)
- Parsing: `cmd_refresh_client_update_subscription()` (`cmd-refresh-client.c:47-79`)
- `tmux.1:1463-1486`
- Subscription types enum: `tmux.h:2138-2144`
- Timer is started on first subscription addition and stopped when last
  subscription is removed (`control.c:1150-1153, 1166-1167`)

---

## 14. Reports (`refresh-client -r`)

- Format: `%<pane-id>:<report>` - provides terminal reports (e.g. OSC 10/11
  color responses) on behalf of a pane
- Parses color values and sets `wp->control_fg` and `wp->control_bg`
  - `cmd-refresh-client.c:167-192` (`cmd_refresh_report`)
  - `tmux.h:1267-1268`
- Color values queried via `window_pane_get_fg_control_client()` and
  `window_pane_get_bg_control_client()`
  - `window.c:1840-1852, 1881-1893`
- Initialized to `-1` (no color)
  - `window.c:955-956`
- Used by `input_osc_10()` and `input_osc_11()` in `input.c` when handling
  OSC 10/11 `?` queries to provide foreground/background color from control
  clients
  - `input.c:2955` (fg), `input.c:2999` (bg)
- `tmux.1:1490-1494`

---

## 15. Clipboard Query (`refresh-client -l`)

- Requests the clipboard contents via xterm OSC 52 escape sequence
- Calls `tty_clipboard_query()` which writes the query escape to the tty
  - `cmd-refresh-client.c:256-258`
  - `tty.c:3021` (`tty_clipboard_query`)
- `tmux.1:1496-1499`

---

## 16. Backpressure and Flow Control

### Without `pause-after`

- If buffered output age exceeds `CONTROL_MAXIMUM_AGE` (300000 ms = 5 minutes),
  client is forcibly disconnected with exit message `too far behind`
  - `control.c:456-461`
  - `tmux.1:7723-7725`

### With `pause-after=N`

- Uses `%extended-output` instead of `%output` (includes `age` field in ms)
- When age exceeds `pause_age` (N * 1000 ms), pane is paused:
  - `CONTROL_PANE_PAUSED` flag set
  - Queued output for that pane is discarded (`control_discard_pane`)
  - `%pause` notification sent
  - `control.c:450-455`
- Client resumes with `refresh-client -A %<pane>:continue`
- On continue: offsets reset to current, `%continue` sent, output resumes from
  current position (no replay of missed data)
  - `control.c:365-369`

---

## 17. Internal Buffering and Write Queue

### Constants

- `CONTROL_BUFFER_LOW` = 512 bytes (low watermark) - `control.c:131`
- `CONTROL_BUFFER_HIGH` = 8192 bytes (high watermark) - `control.c:132`
- `CONTROL_WRITE_MINIMUM` = 32 bytes (minimum per pane per flush) -
  `control.c:135`
- `CONTROL_MAXIMUM_AGE` = 300000 ms (max age without pause-after) -
  `control.c:138`

### Queue Architecture

- Each client has an `all_blocks` queue (all output in order) and each pane has
  its own `blocks` queue
  - `control.c:29-43` (design comment)
- Output blocks (`control_block`) are added to both queues
- Non-output blocks (notifications) are added only to the client queue
- A pane's output block holds up subsequent non-output blocks until fully
  written, enforcing ordering
  - `control.c:37-42`
- Write callback (`control_write_callback`, `control.c:728-761`) flushes
  non-output blocks, then distributes output fairly across pending panes

### Pending List

- Panes with queued output are tracked in `pending_list` with `pending_count`
- Fair write limit: `(CONTROL_BUFFER_HIGH - current_buffer_size) /
  pending_count / 3` per pane (divided by 3 to account for worst-case
  `\xxx` octal encoding), minimum `CONTROL_WRITE_MINIMUM`
  - `control.c:739-747`

### CONTROL_IGNORE_FLAGS

- `CLIENT_CONTROL_NOOUTPUT | CLIENT_UNATTACHEDFLAGS` - when set, pane output is
  discarded rather than queued
  - `control.c:141-143`
- `CLIENT_UNATTACHEDFLAGS` = `CLIENT_DEAD | CLIENT_SUSPENDED | CLIENT_EXIT`
  - `tmux.h:2050-2053`

---

## 18. Pane State Flags

- `CONTROL_PANE_OFF` (0x1) - pane output disabled for this control client
  - `control.c:66`
- `CONTROL_PANE_PAUSED` (0x2) - pane temporarily paused
  - `control.c:67`
- Tracked per-client per-pane in `control_pane` struct
  - `control.c:54-75`

---

## 19. Data Structures

### `control_block` - output block

- `size_t size` - bytes of pane data (0 for notification lines)
- `char *line` - notification text (NULL for output blocks)
- `uint64_t t` - timestamp when queued
- Dual-linked: `entry` (pane queue), `all_entry` (client queue)
- `control.c:44-51`

### `control_pane` - per-client pane tracking

- `u_int pane` - pane ID
- `window_pane_offset offset` - data written position
- `window_pane_offset queued` - data queued position
- `int flags` - `CONTROL_PANE_OFF`, `CONTROL_PANE_PAUSED`
- `int pending_flag` - whether this pane is on the pending list
- `TAILQ blocks` - pane's output block queue
- Stored in red-black tree keyed by pane ID
- `control.c:54-76`

### `control_sub` - subscription entry

- `char *name` - subscription name
- `char *format` - format string
- `enum control_sub_type type` - session/pane/all-panes/window/all-windows
- `u_int id` - pane or window ID (for specific subscriptions)
- `char *last` - last value (for change detection)
- Contains RB trees of `control_sub_pane` and `control_sub_window` for tracking
  per-entity last values
- `control.c:99-112`

### `control_sub_pane` / `control_sub_window` - subscription entity tracking

- Track last-seen format values per pane/window for change detection
- Keyed by (entity_id, winlink_idx) pairs
- `control.c:78-96`

### `control_state` - per-client control mode state

- `control_panes panes` - RB tree of all panes
- `pending_list` / `pending_count` - panes with pending output
- `all_blocks` - all queued blocks
- `read_event` / `write_event` - bufferevent handles
- `subs` - RB tree of subscriptions
- `subs_timer` - 1-second timer for checking subscriptions
- `control.c:115-128`

### `window_pane_offset` - buffer position

- `size_t used` - bytes consumed
- `tmux.h:1157-1159`

---

## 20. Client Struct Fields for Control Mode

- `struct control_state *control_state` - `tmux.h:1956`
- `u_int pause_age` - pause-after threshold in milliseconds - `tmux.h:1957`
- `char *exit_message` - custom exit message - `tmux.h:2070`
- `uint64_t flags` - contains all `CLIENT_CONTROL*` flags - `tmux.h:2061`

---

## 21. CLIENT_CONTROL* Flag Values

- `CLIENT_CONTROL` = `0x2000` - `tmux.h:2015`
- `CLIENT_CONTROLCONTROL` = `0x4000` - `tmux.h:2016`
- `CLIENT_CONTROL_NOOUTPUT` = `0x4000000` - `tmux.h:2028`
- `CLIENT_CONTROL_PAUSEAFTER` = `0x100000000ULL` - `tmux.h:2034`
- `CLIENT_CONTROL_WAITEXIT` = `0x200000000ULL` - `tmux.h:2035`

---

## 22. Identifier Prefixes

- `$` = session ID (unsigned int)
- `@` = window ID (unsigned int)
- `%` = pane ID (unsigned int)
- Used consistently across all notification format strings

---

## 23. Format Variables

- `client_control_mode` - returns `"1"` if client is in control mode
  - `format.c:1422-1424, 3079-3080`
  - `tmux.1:6270`

---

## 24. Hooks / Notification Dispatch

- All control mode notifications (except `%exit`) correspond to hooks
  - `tmux.1:5671-5674`
- Notifications are dispatched through `notify_callback()` in `notify.c:122-156`
  which maps hook names to `control_notify_*` functions
- Hook names that trigger control notifications:
  - `pane-mode-changed` -> `control_notify_pane_mode_changed`
  - `window-layout-changed` -> `control_notify_window_layout_changed`
  - `window-pane-changed` -> `control_notify_window_pane_changed`
  - `window-unlinked` -> `control_notify_window_unlinked`
  - `window-linked` -> `control_notify_window_linked`
  - `window-renamed` -> `control_notify_window_renamed`
  - `client-session-changed` -> `control_notify_client_session_changed`
  - `client-detached` -> `control_notify_client_detached`
  - `session-renamed` -> `control_notify_session_renamed`
  - `session-created` -> `control_notify_session_created`
  - `session-closed` -> `control_notify_session_closed`
  - `session-window-changed` -> `control_notify_session_window_changed`
  - `paste-buffer-changed` -> `control_notify_paste_buffer_changed`
  - `paste-buffer-deleted` -> `control_notify_paste_buffer_deleted`
  - `notify.c:129-156`

---

## 25. Pane Output Integration

- When a pane has new data, `window_pane_read_callback()` iterates all control
  clients and calls `control_write_output()` for each
  - `window.c:1044-1047`
- `server_client_check_pane_buffer()` calculates minimum used offset across all
  clients (including control clients via `control_pane_offset()`) to drain the
  shared pane buffer
  - `server-client.c:2865-2910`
- `control_pane_offset()` returns `NULL` (with off flag) when pane is off,
  paused, or client has `CLIENT_CONTROL_NOOUTPUT`
  - `control.c:310-332`
- Output is only sent if the pane's window is linked to the client's session
  - `control.c:475-476`

---

## 26. Control Mode Commands (via `refresh-client`)

- **`refresh-client -A <pane>:<state>`** - pane output control (requires
  `CLIENT_CONTROL`)
  - `cmd-refresh-client.c:268-277`
- **`refresh-client -B <name>[:<what>:<format>]`** - subscriptions (requires
  `CLIENT_CONTROL`)
  - `cmd-refresh-client.c:278-287`
- **`refresh-client -C <size>`** - client/window size (requires
  `CLIENT_CONTROL`)
  - `cmd-refresh-client.c:288-292`
- **`refresh-client -f <flags>`** - set client flags (does NOT require
  `CLIENT_CONTROL`; applies to all clients)
  - `cmd-refresh-client.c:263-264`
- **`refresh-client -F <flags>`** - alias for `-f`
  - `cmd-refresh-client.c:261-262`
- **`refresh-client -r <pane>:<report>`** - provide terminal reports (does NOT
  require `CLIENT_CONTROL`)
  - `cmd-refresh-client.c:265-266`
- **`refresh-client -l`** - request clipboard via xterm escape (does NOT require
  `CLIENT_CONTROL`)
  - `cmd-refresh-client.c:256-258`, `tmux.1:1496-1499`

---

## 27. `detach-client -E`

- Replaces the client with a shell command; the exit message is the custom
  message provided
  - `tmux.1:1138-1163`

---

## 28. Server-Side Exit Handling

- `server_client_check_exit()` handles client exit:
  - Calls `control_discard()` to stop queuing
  - Waits for `control_all_done()` before sending exit message
  - Sends `MSG_EXIT` with optional `exit_message`
  - `server-client.c:3102-3148`
- Client exit types: `CLIENT_EXIT_RETURN`, `CLIENT_EXIT_SHUTDOWN`,
  `CLIENT_EXIT_DETACH`
  - `tmux.h:2063-2067`

---

## 29. Control Mode Behavioral Differences

- **Session sizing:** Control clients do not affect session sizes until they
  issue `refresh-client -C`; when creating a session, the creating control
  client is excluded from size calculations and `default-size` is used instead
  - `resize.c:91-94, 305-306`
  - `cmd-new-session.c:158-159, 240` (uses `default-size` when `is_control`)
- **No MSG_READY:** Control clients do not receive `MSG_READY` on attach/new-session
  - `cmd-attach-session.c:155-156`
  - `cmd-new-session.c:328-329`
- **No screen locking:** Control clients are not locked
  (`server_lock_client()` returns immediately)
  - `server-fn.c:163-164`
- **No visual alerts:** Control clients do not receive visual
  bell/activity/silence alerts
  - `alerts.c:310`
- **No status line:** Control clients do not have a status line
  - `status.c:246, 259`
- **No tty rendering:** Control clients skip all tty redraw callbacks
  (`server_client_check_redraw` etc.)
  - `server-client.c:2972-2973, 3169-3170, 3196-3197`
- **No MSG_RESIZE:** Control clients ignore `MSG_RESIZE` messages
  - `server-client.c:3421-3422`
- **File I/O disabled:** Control clients cannot use stdout/stdin for direct file
  I/O (pipes to `-` fail with EBADF)
  - `file.c:188, 310, 384`
- **No verbose source-file:** `source-file -v` verbose output is suppressed for
  control clients
  - `cmd-source-file.c:195`
- **select-pane redraw:** Control clients are skipped during `select-pane`
  redraw operations
  - `cmd-select-pane.c:69`
- **show-buffer:** Control clients can receive `show-buffer` output through the
  command response protocol (same as attached clients)
  - `cmd-save-buffer.c:99`
- **Bufferevent error:** If the bufferevent encounters an error, `CLIENT_EXIT`
  is set via `control_error_callback()`
  - `control.c:537-543`

---

## 30. Internal Helper Functions

- **`control_write()`** - formats and queues a notification line for a control
  client; creates a `control_block` with `size=0`, appends to `all_blocks`; if
  no pending output, writes directly to write event buffer, otherwise queues
  - `control.c:406-464`
- **`control_window_pane()`** - looks up a pane by ID and validates it's in the
  client's session window list; returns NULL if not found or not in session
  - `control.c:144-157`
- **`control_get_pane()`** - retrieves the per-client pane tracking structure
  from the red-black tree by pane ID
  - `control.c:160-168`
- **`control_add_pane()`** - creates a new per-client pane tracking entry with
  initialized offsets if one doesn't exist, returns existing one otherwise
  - `control.c:171-196`
- **`control_free_block()`** - frees a `control_block`: removes it from
  `all_blocks` queue, frees the line string, frees the struct
  - `control.c:199-207`
- **`control_discard_pane()`** - discards all queued output for a single pane:
  removes all blocks from both pane and client queues, removes from pending list
  - `control.c:210-231`
- **`control_reset_offsets()`** - resets all pane offsets to the current
  position; called during `control_stop()` and when `no-output` flag changes
  - `control.c:234-260`
- **`control_pane_offset()`** - returns the offset for a pane, or NULL if the
  pane is off/paused/no-output; used by `server_client_check_pane_buffer()`
  - `control.c:310-332`
- **`control_check_age()`** - checks if buffered output is too old; triggers
  pause (with `pause-after`) or disconnect (without `pause-after`)
  - `control.c:389-461`
- **`control_flush_all_blocks()`** - writes all non-output blocks at the head
  of `all_blocks` queue to the write buffer (stops when an output block is
  found)
  - `control.c:589-605`
- **`control_append_data()`** - appends pane data to an evbuffer with octal
  encoding; creates the `%output`/`%extended-output` header on first call
  - `control.c:608-644`
- **`control_write_data()`** - writes a completed evbuffer message to the write
  event (appends newline)
  - `control.c:648-659`
- **`control_write_pending()`** - writes pending pane output up to a byte
  limit; handles pane cleanup if pane is dead
  - `control.c:662-724`
- **`control_free_sub()`** - frees a subscription entry and all its per-entity
  tracking data
  - `control.c` (internal)

---

## 31. Source Files

| File | Role |
|------|------|
| `control.c` | Core protocol: init, read/write, output encoding, backpressure, subscriptions |
| `control-notify.c` | All event notification functions |
| `cmd-queue.c` | `%begin`/`%end`/`%error` guard generation |
| `cmd-refresh-client.c` | `-A`, `-B`, `-C`, `-f`/`-F`, `-r`, `-l` flag handling |
| `cmd-display-message.c` | `%message` notification |
| `cfg.c` | `%config-error` notification |
| `client.c` | Client-side `%exit` output, wait-exit, DCS terminator |
| `tmux.c` | `-C`/`-CC` flag parsing |
| `tmux.h` | All `CLIENT_CONTROL*` defines, `control_sub_type` enum, function prototypes |
| `server-client.c` | Flag parsing, exit handling, pane buffer management, MSG_READY suppression |
| `notify.c` | Dispatches hooks to `control_notify_*` functions |
| `window.c` | Pane output -> `control_write_output()` integration, control fg/bg colors |
| `input.c` | OSC 10/11 color queries using control fg/bg, `since_ground` buffer |
| `resize.c` | Control client size exclusion |
| `alerts.c` | Control client alert exclusion |
| `status.c` | Control client status line exclusion |
| `file.c` | Control client file I/O exclusion |
| `server-fn.c` | Control client lock exclusion |
| `cmd-new-session.c` | Control client sizing and MSG_READY behavior |
| `cmd-attach-session.c` | MSG_READY suppression for control clients |
| `cmd-capture-pane.c` | Captured pane output delivery to control clients |
| `cmd-select-pane.c` | Control client redraw exclusion |
| `cmd-save-buffer.c` | show-buffer output delivery to control clients |
| `cmd-source-file.c` | Verbose output suppression for control clients |

---

## 32. Man Page Sections

| Section | Location |
|---------|----------|
| `-C` flag | `tmux.1:104-110` |
| CONTROL MODE section | `tmux.1:7861-8045` |
| `refresh-client` command | `tmux.1:1391-1532` |
| `attach-session` client flags | `tmux.1:1040-1110` |
| `new-session -f` | `tmux.1:1268-1313` |
| `detach-client -E` | `tmux.1:1138-1163` |
| `client_control_mode` format | `tmux.1:6270` |
| "too far behind" exit reason | `tmux.1:7723-7725` |
| Hooks = notifications note | `tmux.1:5671-5674` |

---

## 33. Man Page vs Code Discrepancies

- **`%session-renamed`**: man page (`tmux.1:7982-7983`) documents format as
  `%session-renamed <name>` but code (`control-notify.c:189`) sends
  `%%session-renamed $%u %s` (includes session ID)
