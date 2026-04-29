# tmux Control Mode Protocol Specification

Derived from tmux source code (version next-3.7, commit 5c30b145) and the
tmux(1) man page. All citations reference files in the tmux source tree.

---

## 1. Overview

tmux control mode is a text-based protocol that allows applications to
communicate with a tmux server over stdin/stdout. The client sends tmux
commands as newline-terminated strings on stdin and receives structured
responses and asynchronous notifications on stdout.

All protocol messages are line-oriented (terminated by `\n`). All protocol
lines from the server begin with `%`.

**Source:** `tmux.1:7861-7870`

---

## 2. Entering Control Mode

Control mode is entered by passing `-C` to `tmux`:

```
tmux -C new-session
tmux -C attach-session -t mysession
```

**Source:** `tmux.1:104-110`, `tmux.c:393-398`

### 2.1 Variants

| Flag  | Behavior |
|-------|----------|
| `-C`  | Control mode. Sets `CLIENT_CONTROL` (`0x2000`). Stdin and stdout are separate file descriptors. |
| `-CC` | Control mode with echo disabled. Additionally sets `CLIENT_CONTROLCONTROL` (`0x4000`). Stdin and stdout share a single bidirectional socket. A DCS escape sequence is used to frame the session (see Section 12). |

**Source:** `tmux.c:393-398`, `tmux.h:2015-2016`

### 2.2 Initialization Sequence

1. `control_start()` is called:
   - For `-CC`: closes `out_fd`, uses single `bufferevent` for read and write
   - For `-C`: sets `out_fd` non-blocking, creates separate read and write
     `bufferevent`s
   - Sets both `fd` (stdin) to non-blocking
   - Sets write watermark at `CONTROL_BUFFER_LOW` (512 bytes)
   - For `-CC`: writes DCS sequence `\033P1000p` (7 bytes) and enables write
     event
2. `control_ready()` enables `EV_READ` on the read event (called from
   `server-client.c:3525-3526` when client is attached)

**Source:** `control.c:765-809`

### 2.3 Teardown

- `control_stop()` frees bufferevents, subscriptions, timer, blocks, and resets
  offsets. Called from `server-client.c:475-476` during client cleanup.
- If not `-CC` mode, the write event bufferevent is freed separately (since it's
  a distinct fd). In `-CC` mode, only the read event is freed (it's shared).

**Source:** `control.c:825-845`

---

## 3. Identifier Prefixes

Throughout the protocol, tmux uses these prefixes for identifiers:

| Prefix | Type       | Example |
|--------|------------|---------|
| `$`    | Session ID | `$1`    |
| `@`    | Window ID  | `@0`    |
| `%`    | Pane ID    | `%5`    |

These are unsigned integers assigned by the server and stable for the lifetime
of the object.

---

## 4. Command Input

The client sends any valid tmux command as a newline-terminated line on stdin.

```
list-windows\n
split-window -h\n
send-keys -t %5 "ls" Enter\n
```

Multiple commands may be separated by `;` on a single line, following normal
tmux command-line syntax.

**Source:** `control.c:547-575` (`control_read_callback`)

### 4.1 Empty Line

An empty line (just `\n`) causes the client to detach (sets `CLIENT_EXIT`).

**Source:** `control.c:561-564`

### 4.2 Command Parsing

Commands are parsed with `cmd_parse_and_append()` using the
`CMDQ_STATE_CONTROL` flag (`0x2`).

**Source:** `control.c:567-570`, `tmux.h:1838`

### 4.3 Line Reading

Lines are read using `EVBUFFER_EOL_LF` (LF-terminated, no CR stripping).

**Source:** `control.c:557`

### 4.4 Bufferevent Error

If the bufferevent encounters an I/O error, `control_error_callback()` sets
`CLIENT_EXIT`, causing the client to disconnect.

**Source:** `control.c:537-543`

---

## 5. Command Response Protocol

Each command produces exactly one response block consisting of:

1. A `%begin` line
2. Zero or more lines of output
3. A `%end` line (success) or `%error` line (failure)

### 5.1 Format

```
%<guard> <timestamp> <command-number> <flags>
```

| Field            | Type           | Description |
|------------------|----------------|-------------|
| `guard`          | string         | `begin`, `end`, or `error` |
| `timestamp`      | long           | Seconds since Unix epoch (`item->time`) |
| `command-number` | unsigned int   | Monotonically increasing sequence number per client (`item->number`) |
| `flags`          | int            | 1 if `CMDQ_STATE_CONTROL`, 0 otherwise |

The `%begin`, `%end`/`%error` lines for a given command share the same
timestamp, command-number, and flags values.

**Source:** `cmd-queue.c:825-833` (`cmdq_guard`), called at `cmd-queue.c:619`
(begin), `cmd-queue.c:677` (error), `cmd-queue.c:679` (end)

### 5.2 Example

```
%begin 1363006971 2 1
0: ksh* (1 panes) [80x24] [layout b25f,80x24,0,0,2] @2 (active)
%end 1363006971 2 1
```

**Source:** `tmux.1:7884-7889`

### 5.3 Parse Errors

If a command cannot be parsed, the response block contains:

```
%begin 1363006971 3 1
parse error: unknown command
%error 1363006971 3 1
```

**Source:** `control.c:522-533` (`control_error`)

### 5.4 Command Output Delivery

Command output (the lines between `%begin` and `%end`/`%error`) is written via
`control_write()` from multiple callsites:

| Caller | Purpose | Source |
|--------|---------|--------|
| `server_client_print()` | Command output; sanitizes non-UTF8 if needed | `server-client.c:3988-4001` |
| `cmdq_print()` | Command output/messages within response blocks | `cmd-queue.c:881-891` |
| `cmd_capture_pane_exec()` | `capture-pane -p` output | `cmd-capture-pane.c:241-242` |
| `control_error()` | Parse error messages | `control.c:527-529` |

---

## 6. Notifications

Notifications are asynchronous messages sent by the server when events occur.
A notification will **never** occur inside a response block.

All notifications are a single line beginning with `%`.

Notifications (except `%exit`) also correspond to tmux hooks.

**Source:** `tmux.1:7896-7904`, `tmux.1:5671-5674`

### 6.1 Notification Dispatch

Notifications are dispatched through `notify_callback()` which maps hook names
to `control_notify_*()` functions. The macro
`CONTROL_SHOULD_NOTIFY_CLIENT(c)` checks `(c)->flags & CLIENT_CONTROL`.

**Source:** `notify.c:122-156`, `control-notify.c:26-27`

### 6.2 Notification Client Filtering

Not all notifications are sent to all control clients. The filtering rules are:

- **All control clients (no session required):**
  `%pane-mode-changed`, `%window-pane-changed`, `%client-detached`,
  `%session-renamed`, `%sessions-changed`, `%session-window-changed`,
  `%paste-buffer-changed`, `%paste-buffer-deleted`

- **Control clients with a session (`c->session != NULL`):**
  `%layout-change` (also checks window is in session),
  `%window-add`/`%window-close`/`%window-renamed` (checks if window is in
  client's session to choose linked vs unlinked variant),
  `%unlinked-window-add`/`%unlinked-window-close`/`%unlinked-window-renamed`,
  `%session-changed`/`%client-session-changed`

- **Window linked vs unlinked logic:**
  The unlink/link/rename functions check if the window is linked to the
  **receiving** client's session (not the session that triggered the event).
  If found in the client's session, sends `%window-*`; otherwise sends
  `%unlinked-window-*`.

**Source:** `control-notify.c:29-258`

### 6.3 Hook-to-Notification Mapping

| Hook Name | Control Notify Function | Notification(s) |
|-----------|------------------------|------------------|
| `pane-mode-changed` | `control_notify_pane_mode_changed` | `%pane-mode-changed` |
| `window-layout-changed` | `control_notify_window_layout_changed` | `%layout-change` |
| `window-pane-changed` | `control_notify_window_pane_changed` | `%window-pane-changed` |
| `window-unlinked` | `control_notify_window_unlinked` | `%window-close` or `%unlinked-window-close` |
| `window-linked` | `control_notify_window_linked` | `%window-add` or `%unlinked-window-add` |
| `window-renamed` | `control_notify_window_renamed` | `%window-renamed` or `%unlinked-window-renamed` |
| `client-session-changed` | `control_notify_client_session_changed` | `%session-changed` or `%client-session-changed` |
| `client-detached` | `control_notify_client_detached` | `%client-detached` |
| `session-renamed` | `control_notify_session_renamed` | `%session-renamed` |
| `session-created` | `control_notify_session_created` | `%sessions-changed` |
| `session-closed` | `control_notify_session_closed` | `%sessions-changed` |
| `session-window-changed` | `control_notify_session_window_changed` | `%session-window-changed` |
| `paste-buffer-changed` | `control_notify_paste_buffer_changed` | `%paste-buffer-changed` |
| `paste-buffer-deleted` | `control_notify_paste_buffer_deleted` | `%paste-buffer-deleted` |

**Source:** `notify.c:129-156`

---

## 7. Notification Reference

### 7.1 Pane Output

#### `%output`

```
%output <pane-id> <value>
```

Sent when a pane produces output. Only sent when `pause-after` flag is **not**
set.

- `<pane-id>`: pane identifier (e.g., `%0`)
- `<value>`: octal-escaped output data (see Section 10)

**Source:** `control.c:625`, `tmux.1:7964-7967`

#### `%extended-output`

```
%extended-output <pane-id> <age> ... : <value>
```

Sent instead of `%output` when `pause-after` flag **is** set.

| Field     | Description |
|-----------|-------------|
| `pane-id` | Pane identifier (e.g., `%0`) |
| `age`     | Time in milliseconds tmux had buffered this output before sending |
| `...`     | Arguments between `age` and `:` are reserved for future use; ignore them |
| `:`       | Literal colon separator (space-delimited) |
| `value`   | Octal-escaped output data (same encoding as `%output`) |

**Source:** `control.c:621-623`, `tmux.1:7935-7944`

---

### 7.2 Pane Flow Control

#### `%pause`

```
%pause <pane-id>
```

The pane has been paused. No further output will be sent for this pane until it
is continued. Sent when:

- The client explicitly pauses the pane via `refresh-client -A <pane-id>:pause`
- The pane's buffered output age exceeds the client's `pause-after` threshold

When a pane is paused, all queued output for that pane is discarded.

**Source:** `control.c:383` (explicit), `control.c:455` (age-triggered),
`tmux.1:7973-7975`

#### `%continue`

```
%continue <pane-id>
```

A previously paused pane has been resumed. Output resumes from the pane's
current position (data produced while paused is not replayed).

**Source:** `control.c:369`, `tmux.1:7914-7918`

---

### 7.3 Pane Mode

#### `%pane-mode-changed`

```
%pane-mode-changed <pane-id>
```

The pane has changed mode (e.g., entered or exited copy mode). Sent to all
control clients regardless of session.

**Source:** `control-notify.c:34-39`, `tmux.1:7969-7971`

---

### 7.4 Window Events

#### `%window-add`

```
%window-add <window-id>
```

A window was linked to the current session.

**Source:** `control-notify.c:118`, `tmux.1:8027-8029`

#### `%window-close`

```
%window-close <window-id>
```

A window was closed (unlinked from the current session).

**Source:** `control-notify.c:100`, `tmux.1:8031-8033`

#### `%window-renamed`

```
%window-renamed <window-id> <name>
```

A window in the current session was renamed.

**Source:** `control-notify.c:136-137`, `tmux.1:8039-8042`

#### `%window-pane-changed`

```
%window-pane-changed <window-id> <pane-id>
```

The active pane in a window changed. Sent to all control clients regardless
of session.

**Source:** `control-notify.c:79-86`, `tmux.1:8035-8038`

#### `%unlinked-window-add`

```
%unlinked-window-add <window-id>
```

A window was created but is not linked to the current session.

**Source:** `control-notify.c:120`, `tmux.1:8013-8015`

#### `%unlinked-window-close`

```
%unlinked-window-close <window-id>
```

A window not linked to the current session was closed.

**Source:** `control-notify.c:102`, `tmux.1:8017-8020`

#### `%unlinked-window-renamed`

```
%unlinked-window-renamed <window-id> <name>
```

A window not linked to the current session was renamed. The code sends both the
window ID and the name (`@%u %s`).

**Source:** `control-notify.c:139-140`, `tmux.1:8022-8025`

---

### 7.5 Layout Events

#### `%layout-change`

```
%layout-change <window-id> <window-layout> <window-visible-layout> <window-flags>
```

The layout of a window changed.

| Field                   | Description |
|-------------------------|-------------|
| `window-id`             | Window identifier (e.g., `@0`) |
| `window-layout`         | Full tmux layout descriptor string |
| `window-visible-layout` | Visible layout string |
| `window-flags`          | Raw window flags string |

Generated via `format_single()` expansion of the template:
`%layout-change #{window_id} #{window_layout} #{window_visible_layout} #{window_raw_flags}`

Layout change notifications are sent only to control clients whose session
contains the affected window. Not sent if the window has no `layout_root`
(i.e., the last pane is being closed and the window will be destroyed).

**Source:** `control-notify.c:51-52, 58-70`, `tmux.1:7946-7956`

---

### 7.6 Session Events

#### `%session-changed`

```
%session-changed <session-id> <name>
```

The client is now attached to a different session. Sent to the client whose
session changed.

**Source:** `control-notify.c:160-161`, `tmux.1:7977-7980`

#### `%client-session-changed`

```
%client-session-changed <client-name> <session-id> <name>
```

Another client changed its attached session. Sent to all other control mode
clients.

**Source:** `control-notify.c:163-164`, `tmux.1:7907-7911`

#### `%session-renamed`

```
%session-renamed <session-id> <name>
```

A session was renamed.

NOTE: The man page (`tmux.1:7982-7983`) documents only `<name>` as the
argument, but the code (`control-notify.c:189`) sends `$%u %s` (session ID
followed by name).

**Source:** `control-notify.c:189`, `tmux.1:7982-7983`

#### `%sessions-changed`

```
%sessions-changed
```

A session was created or destroyed. Takes no arguments.

**Source:** `control-notify.c:202, 215`, `tmux.1:7989-7990`

#### `%session-window-changed`

```
%session-window-changed <session-id> <window-id>
```

The active window in a session changed.

**Source:** `control-notify.c:228-229`, `tmux.1:7985-7988`

---

### 7.7 Client Events

#### `%client-detached`

```
%client-detached <client-name>
```

A client has detached.

**Source:** `control-notify.c:176`, `tmux.1:7905-7906`

---

### 7.8 Paste Buffer Events

#### `%paste-buffer-changed`

```
%paste-buffer-changed <name>
```

A paste buffer was created or modified.

**Source:** `control-notify.c:242`, `tmux.1:7969-7971`

#### `%paste-buffer-deleted`

```
%paste-buffer-deleted <name>
```

A paste buffer was deleted.

**Source:** `control-notify.c:255`, `tmux.1:7972-7973`

---

### 7.9 Subscription Events

#### `%subscription-changed`

```
%subscription-changed <name> <session-id> <window-id> <window-index> <pane-id> ... : <value>
```

A subscribed format value has changed. Arguments between `<pane-id>` and `:`
are reserved for future use and should be ignored.

The fields depend on the subscription type:

| Subscription Type | session-id | window-id | window-index | pane-id |
|-------------------|------------|-----------|--------------|---------|
| Session           | `$N`       | `-`       | `-`          | `-`     |
| Window            | `$N`       | `@N`      | integer      | `-`     |
| Pane              | `$N`       | `@N`      | integer      | `%N`    |

A `-` indicates the field is not applicable for that subscription type.

Change detection: the subscription timer fires every 1 second. For each
subscription, the format string is expanded in the appropriate context and
compared to the last-seen value. Only changed values trigger a notification.

- Per-session subscriptions: a single `last` string is tracked
- Per-pane/all-panes subscriptions: a red-black tree of (pane_id, winlink_idx)
  to last-value pairs
- Per-window/all-windows subscriptions: a red-black tree of (window_id,
  winlink_idx) to last-value pairs

**Source:**
- Session: `control.c:862`
- Pane: `control.c:909, 944`
- Window: `control.c:989, 1024`
- Timer: `control.c:1032-1125`
- `tmux.1:7991-8011`

---

### 7.10 Messages

#### `%message`

```
%message <message>
```

A message sent with the `display-message` command when the target client is a
control mode client.

**Source:** `cmd-display-message.c:151`, `tmux.1:7958-7960`

---

### 7.11 Configuration Errors

#### `%config-error`

```
%config-error <error>
```

An error occurred while parsing a configuration file.

**Source:** `cfg.c:229, 253`, `tmux.1:7912-7913`

---

### 7.12 Exit

#### `%exit`

```
%exit [<reason>]
```

The tmux client is exiting. The optional reason describes why. This message is
printed client-side on stdout (not sent through the protocol from server to
client).

**Source:** `client.c:424-427`, `tmux.1:7920-7925`

#### Exit Reasons

| Reason | Code Location |
|--------|---------------|
| `detached` | `client.c:198` |
| `detached (from session <name>)` | `client.c:194-197` |
| `detached and SIGHUP` | `client.c:205` |
| `detached and SIGHUP (from session <name>)` | `client.c:201-204` |
| `lost tty` | `client.c:207` |
| `terminated` | `client.c:209` |
| `server exited unexpectedly` | `client.c:211` |
| `exited` | `client.c:213` |
| `server exited` | `client.c:215` |
| *(custom message)* | `client.c:217` (`CLIENT_EXIT_MESSAGE_PROVIDED`) |

The `too far behind` message is a custom message set via `exit_message` when
the client's output falls behind (see Section 16.1).

The exit message is delivered from server to client via `MSG_EXIT` with a wire
format of `[4-byte retval][optional null-terminated message]`. Parsed by
`client_dispatch_exit_message()`.

**Source:** `client.c:40-49` (enum), `client.c:185-220` (`client_exit_message`),
`client.c:601-625` (`client_dispatch_exit_message`)

---

## 8. Exit Handling

After `%exit`:

1. If `CLIENT_CONTROL_WAITEXIT` is set: the client blocks reading stdin until
   an empty line or EOF is received before actually exiting.
   - `client.c:429-436`

2. If `-CC` mode: the DCS terminator `\033\\` is written, and terminal
   attributes are restored with `tcsetattr()`.
   - `client.c:438-441`

Server-side: `server_client_check_exit()` calls `control_discard()` to stop
queuing, then waits for `control_all_done()` (all blocks flushed and write
buffer empty) before sending the exit message to the client.

**Source:** `server-client.c:3102-3148`, `control.c:579-586`

---

## 9. Client Flags

Client flags are set via `attach-session -f`, `new-session -f`, or
`refresh-client -f` (or `-F` alias) as a comma-separated list. Prefix with `!`
to disable.

| Flag | Hex Value | Description |
|------|-----------|-------------|
| `active-pane` | `CLIENT_ACTIVEPANE` (`0x80000000ULL`) | Client has an independent active pane |
| `ignore-size` | `CLIENT_IGNORESIZE` (`0x20000`) | Client does not affect the size of other clients |
| `no-detach-on-destroy` | `CLIENT_NO_DETACH_ON_DESTROY` (`0x8000000000ULL`) | Do not detach when the attached session is destroyed (if other sessions exist) |
| `no-output` | `CLIENT_CONTROL_NOOUTPUT` (`0x4000000`) | Suppress all pane output notifications; resets offsets when set |
| `pause-after[=N]` | `CLIENT_CONTROL_PAUSEAFTER` (`0x100000000ULL`) | Pause panes when buffered output is older than N seconds (stored as ms internally); switches to `%extended-output` |
| `read-only` | `CLIENT_READONLY` (`0x800`) | Client is read-only |
| `wait-exit` | `CLIENT_CONTROL_WAITEXIT` (`0x200000000ULL`) | Wait for empty line on stdin before exiting |

The `pause-after`, `no-output`, and `wait-exit` flags are control-mode-specific
and parsed by `server_client_control_flags()`. The others apply to all clients.

**Source:**
- Flag parsing: `server-client.c:3786-3845`
- Flag defines: `tmux.h:2013-2041`
- Man page: `tmux.1:1072-1089`

---

## 10. Data Encoding

Pane output data in `%output` and `%extended-output` uses octal escaping:

| Input Byte | Encoding |
|------------|----------|
| `0x00` - `0x1F` | `\` + 3-digit octal (e.g., `\000`, `\012`, `\033`) |
| `\` (0x5C) | `\134` |
| All other bytes (0x20-0x5B, 0x5D-0xFF) | Sent as-is |

To decode: scan for `\` followed by exactly 3 octal digits, and replace with
the corresponding byte value.

**Source:** `control.c:631-642` (`control_append_data`)

---

## 11. Client Size Control

```
refresh-client -C <width>x<height>
refresh-client -C @<window-id>:<width>x<height>
refresh-client -C @<window-id>:
```

- First form: sets overall client size
- Second form: sets size for a specific window
- Third form: clears per-window size override

Requires `CLIENT_CONTROL`.

**Source:** `cmd-refresh-client.c:82-131`, `tmux.1:1427-1438`

### 11.1 One applySizing Enforcer per Consumer

[LAW:single-enforcer] A consumer rendering tmux panes MUST have exactly one
site that reacts to changes in `(pane.cols, pane.rows, fontSize)` and applies
the result to the renderer (e.g. `xterm.Terminal.resize`). The library
provides `PaneSession.resize(cols, rows)` which mirrors to the renderer
sink; the consumer wires that single mirror to whatever observability primitive
its framework offers (a MobX `reaction`, a React `useEffect`, a Svelte store
subscription, etc.).

The pattern this rule forbids:

- A reaction that calls `terminal.resize(cols, rows)` AND
- A separate `useEffect` or `ResizeObserver` callback that ALSO calls
  `terminal.resize(...)` with a different derivation of cols/rows.

When two sites resize the same renderer, race conditions and "resize loop"
bugs follow. The library cannot ship "the one resize handler" without
coupling to a framework — but the rule that there must be exactly one is
universal.

**Positive example (web-multiplexer demo):** one MobX `reaction` reads
`(pane.width, pane.height, terminalFontSize)`, calls
`paneSession.resize(cols, rows)` plus sets the xterm font; nothing else
in the codebase resizes xterm.

**Negative example:** a `ResizeObserver` synchronously calls
`terminal.resize(...)` based on container pixels, while a separate effect
also calls `terminal.resize(...)` based on `pane.width`. Even when both
agree most of the time, the cases where they don't are exactly the bugs
this rule prevents.

---

## 12. DCS Wrapping (`-CC` Mode)

When started with `-CC` (double control mode):

1. On startup, tmux writes the DCS sequence `\033P1000p` (ESC P 1000 p) before
   any protocol output.
   - `control.c:799`
2. On exit, after the `%exit` message and any `wait-exit` handling, tmux writes
   the DCS string terminator `\033\\` (ESC backslash).
   - `client.c:439`
3. The terminal's original attributes are restored with `tcsetattr()`.
   - `client.c:441`

This wrapping allows terminal emulators to identify and frame the control mode
session within the terminal's own escape sequence protocol.

In `-CC` mode, the terminal is configured in raw mode (`tmux.c:343-362`):
`c_iflag = ICRNL|IXANY`, `c_oflag = OPOST|ONLCR`, `c_lflag = NOKERNINFO`,
`c_cflag = CREAD|CS8|HUPCL`, `c_cc[VMIN] = 1`, `c_cc[VTIME] = 0`.

---

## 13. Pane Control

```
refresh-client -A <pane-id>:<action>
```

Controls output for a specific pane. May be specified multiple times for
different panes. Requires `CLIENT_CONTROL`.

| Action     | Function | Effect |
|------------|----------|--------|
| `on`       | `control_set_pane_on()` | Clear `CONTROL_PANE_OFF`; reset offsets to current pane position |
| `off`      | `control_set_pane_off()` | Set `CONTROL_PANE_OFF`; stops reading from pane if all clients have it off |
| `pause`    | `control_pause_pane()` | Set `CONTROL_PANE_PAUSED`; discard queued output; send `%pause` |
| `continue` | `control_continue_pane()` | Clear `CONTROL_PANE_PAUSED`; reset offsets to current; send `%continue` |

**Source:**
- `control.c:335-385`
- `cmd-refresh-client.c:134-164`
- `tmux.1:1439-1461`

---

## 14. Subscriptions

```
refresh-client -B <name>:<what>:<format>
refresh-client -B <name>
```

Subscribe to changes in a tmux format string. Changes are reported via
`%subscription-changed` at most once per second. The second form (name only)
removes the subscription. Requires `CLIENT_CONTROL`.

| `what` value    | Scope | Enum |
|-----------------|-------|------|
| *(empty)*       | Attached session only | `CONTROL_SUB_SESSION` |
| `%<pane-id>`    | Specific pane | `CONTROL_SUB_PANE` |
| `%*`            | All panes in attached session | `CONTROL_SUB_ALL_PANES` |
| `@<window-id>`  | Specific window | `CONTROL_SUB_WINDOW` |
| `@*`            | All windows in attached session | `CONTROL_SUB_ALL_WINDOWS` |

The subscription timer fires every 1 second to check for changes. It is started
when the first subscription is added and stopped when the last is removed.

**Source:**
- `control.c:1032-1168` (timer, add, remove, check functions)
- `cmd-refresh-client.c:47-79`
- `tmux.h:2138-2144` (enum)
- `tmux.1:1463-1486`

---

## 15. Reports

```
refresh-client -r <pane-id>:<report>
```

Allows a control mode client to provide terminal reports (such as OSC 10/11
color responses) on behalf of a pane. The report is parsed for color values
which are stored as `wp->control_fg` and `wp->control_bg`.

These are queried via `window_pane_get_fg_control_client()` and
`window_pane_get_bg_control_client()` for rendering, specifically by
`input_osc_10()` and `input_osc_11()` when handling OSC 10/11 `?` queries.

Note: `-r` does NOT require `CLIENT_CONTROL` (it operates on the client's tty).

**Source:**
- `cmd-refresh-client.c:167-192`
- `window.c:1840-1893`
- `input.c:2955, 2999`
- `tmux.h:1267-1268`
- `tmux.1:1490-1494`

---

## 16. Backpressure and Flow Control

### 16.1 Without `pause-after`

If pane output data is buffered for more than **300 seconds** (5 minutes,
`CONTROL_MAXIMUM_AGE`) due to a slow client, the client is forcibly
disconnected with the exit message `too far behind`.

**Source:** `control.c:456-461`, `tmux.1:7723-7725`

### 16.2 With `pause-after=N`

When `pause-after` is set to N seconds:

1. Output uses `%extended-output` instead of `%output`, including the `age`
   field (milliseconds).
2. When buffered output for a pane exceeds N seconds of age, the pane is
   paused:
   - `CONTROL_PANE_PAUSED` flag is set
   - All queued output for that pane is discarded (`control_discard_pane`)
   - `%pause <pane-id>` notification is sent
3. The client can resume with `refresh-client -A <pane-id>:continue`.
4. On continue, offsets are reset to the pane's current position, `%continue`
   is sent, and output resumes from the current position (no replay).

**Source:** `control.c:450-455` (age check), `control.c:359-385` (pause/continue)

---

## 17. Internal Buffering

### 17.1 Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `CONTROL_BUFFER_LOW` | 512 B | Low watermark: below this, flush queued data |
| `CONTROL_BUFFER_HIGH` | 8192 B | High watermark: above this, stop writing and queue |
| `CONTROL_WRITE_MINIMUM` | 32 B | Minimum bytes to write per pane per flush cycle |
| `CONTROL_MAXIMUM_AGE` | 300000 ms | Maximum age before forced disconnect (without `pause-after`) |

**Source:** `control.c:131-138`

### 17.2 Queue Architecture

Each client has two queue structures:

- **`all_blocks`**: a TAILQ of all `control_block` entries in order (both pane
  output and notification lines)
- **Per-pane `blocks`**: a TAILQ of `control_block` entries for that pane's
  output only

Output blocks (pane data) are added to both queues. Non-output blocks
(notifications) are added only to the `all_blocks` queue.

A pane's output block holds up any subsequent non-output blocks in the client
queue until it is fully written, enforcing ordering: notifications always
arrive after the output that preceded them.

**Source:** `control.c:29-43` (design comment), `control.c:115-128`
(`control_state`)

### 17.3 Write Callback

The write callback (`control_write_callback`) fires when the write buffer drops
below the low watermark:

1. Flush any non-output blocks at the head of `all_blocks`
2. While output below `CONTROL_BUFFER_HIGH`:
   - Calculate fair limit per pane: `(CONTROL_BUFFER_HIGH - current_size) /
     pending_count / 3` (divided by 3 for worst-case `\xxx` octal encoding;
     minimum `CONTROL_WRITE_MINIMUM`)
   - Iterate pending panes, write output for each up to the limit
   - Remove panes from pending list when fully written
3. Disable write event if output buffer is empty

**Source:** `control.c:728-761`

### 17.4 CONTROL_IGNORE_FLAGS

When `CLIENT_CONTROL_NOOUTPUT | CLIENT_UNATTACHEDFLAGS` flags are set, pane
output is discarded rather than queued.

`CLIENT_UNATTACHEDFLAGS` = `CLIENT_DEAD | CLIENT_SUSPENDED | CLIENT_EXIT`

**Source:** `control.c:141-143, 478-483`, `tmux.h:2050-2053`

---

## 18. Pane Output Integration

When a pane has new data, the read callback in `window_pane_read_callback()`
iterates all control clients and calls `control_write_output()` for each.

**Source:** `window.c:1044-1047`

`control_write_output()` checks:
1. The pane's window must be linked to the client's session
2. If `CONTROL_IGNORE_FLAGS` are set, output is discarded (offsets advanced)
3. If the pane has `CONTROL_PANE_OFF` or `CONTROL_PANE_PAUSED`, output is
   discarded
4. Age is checked for backpressure (see Section 16)
5. Otherwise, a new `control_block` is created and added to both queues

**Source:** `control.c:466-518`

`server_client_check_pane_buffer()` calculates the minimum used offset across
all clients (including control clients via `control_pane_offset()`) to
determine how much of the shared pane buffer can be drained.

**Source:** `server-client.c:2865-2910`

---

## 19. Clipboard Query

```
refresh-client -l
```

Requests the terminal's clipboard contents via xterm OSC 52 escape sequence.
This does NOT require `CLIENT_CONTROL`.

**Source:** `cmd-refresh-client.c:256-258`, `tmux.1:1496-1499`

---

## 20. Data Structures

### `control_block`

```c
struct control_block {
    size_t                       size;       // bytes of pane data (0 for notifications)
    char                        *line;       // notification text (NULL for output blocks)
    uint64_t                     t;          // timestamp when queued
    TAILQ_ENTRY(control_block)   entry;      // pane queue linkage
    TAILQ_ENTRY(control_block)   all_entry;  // client queue linkage
};
```

**Source:** `control.c:44-51`

### `control_pane`

```c
struct control_pane {
    u_int                        pane;       // pane ID
    struct window_pane_offset    offset;     // data written position
    struct window_pane_offset    queued;     // data queued position
    int                          flags;      // CONTROL_PANE_OFF (0x1), CONTROL_PANE_PAUSED (0x2)
    int                          pending_flag;
    TAILQ_ENTRY(control_pane)    pending_entry;
    TAILQ_HEAD(, control_block)  blocks;     // pane's output block queue
    RB_ENTRY(control_pane)       entry;      // red-black tree entry
};
```

**Source:** `control.c:54-75`

### `control_state`

```c
struct control_state {
    struct control_panes             panes;         // RB tree of all panes
    TAILQ_HEAD(, control_pane)       pending_list;  // panes with pending output
    u_int                            pending_count;
    TAILQ_HEAD(, control_block)      all_blocks;    // all queued blocks in order
    struct bufferevent              *read_event;
    struct bufferevent              *write_event;
    struct control_subs              subs;           // RB tree of subscriptions
    struct event                     subs_timer;     // 1-second subscription timer
};
```

**Source:** `control.c:115-128`

### `control_sub`

```c
struct control_sub {
    char                        *name;      // subscription name
    char                        *format;    // format string
    enum control_sub_type        type;      // session/pane/all-panes/window/all-windows
    u_int                        id;        // pane or window ID (for specific subscriptions)
    char                        *last;      // last value (for change detection)
    struct control_sub_panes     panes;     // RB tree of per-pane last values
    struct control_sub_windows   windows;   // RB tree of per-window last values
    RB_ENTRY(control_sub)        entry;
};
```

**Source:** `control.c:99-112`

### `control_sub_pane` / `control_sub_window`

```c
struct control_sub_pane {
    u_int                        pane;      // pane ID
    u_int                        idx;       // winlink index
    char                        *last;      // last format value
    RB_ENTRY(control_sub_pane)   entry;
};

struct control_sub_window {
    u_int                        window;    // window ID
    u_int                        idx;       // winlink index
    char                        *last;      // last format value
    RB_ENTRY(control_sub_window) entry;
};
```

**Source:** `control.c:78-96`

### `window_pane_offset`

```c
struct window_pane_offset {
    size_t  used;   // bytes consumed
};
```

**Source:** `tmux.h:1157-1159`

---

## 21. Format Variables

| Variable | Value | Description |
|----------|-------|-------------|
| `client_control_mode` | `"1"` or `""` | Whether client is in control mode |

**Source:** `format.c:1422-1424, 3079-3080`, `tmux.1:6270`

---

## 22. Control Mode Behavioral Differences

Control clients differ from terminal clients in these ways:

| Behavior | Detail | Source |
|----------|--------|--------|
| Session sizing | Control clients don't affect session sizes until `refresh-client -C`; `default-size` is used for new sessions | `resize.c:91-94, 305-306`, `cmd-new-session.c:158-159, 240` |
| No MSG_READY | Control clients don't receive `MSG_READY` on attach/new-session | `cmd-attach-session.c:155-156`, `cmd-new-session.c:328-329` |
| No screen locking | `server_lock_client()` returns immediately | `server-fn.c:163-164` |
| No visual alerts | Not sent bell/activity/silence alerts | `alerts.c:310` |
| No status line | Status line is not drawn | `status.c:246, 259` |
| No tty rendering | All tty redraw callbacks are skipped | `server-client.c:2972-2973, 3169-3170, 3196-3197` |
| No MSG_RESIZE | MSG_RESIZE messages are ignored | `server-client.c:3421-3422` |
| File I/O disabled | Stdout/stdin pipes to `-` fail with EBADF | `file.c:188, 310, 384` |
| No verbose source-file | `source-file -v` verbose output is suppressed | `cmd-source-file.c:195` |
| select-pane redraw | Skipped for control clients | `cmd-select-pane.c:69` |

---

## 23. Complete Message Reference

### Server-to-Client Messages

| Message | Arguments | Source |
|---------|-----------|--------|
| `%begin` | `<timestamp> <cmd-number> <flags>` | `cmd-queue.c:832` |
| `%end` | `<timestamp> <cmd-number> <flags>` | `cmd-queue.c:832` |
| `%error` | `<timestamp> <cmd-number> <flags>` | `cmd-queue.c:832` |
| `%output` | `<pane-id> <value>` | `control.c:625` |
| `%extended-output` | `<pane-id> <age> ... : <value>` | `control.c:621-623` |
| `%pause` | `<pane-id>` | `control.c:383, 455` |
| `%continue` | `<pane-id>` | `control.c:369` |
| `%pane-mode-changed` | `<pane-id>` | `control-notify.c:38` |
| `%window-add` | `<window-id>` | `control-notify.c:118` |
| `%window-close` | `<window-id>` | `control-notify.c:100` |
| `%window-renamed` | `<window-id> <name>` | `control-notify.c:136` |
| `%window-pane-changed` | `<window-id> <pane-id>` | `control-notify.c:83` |
| `%unlinked-window-add` | `<window-id>` | `control-notify.c:120` |
| `%unlinked-window-close` | `<window-id>` | `control-notify.c:102` |
| `%unlinked-window-renamed` | `<window-id> <name>` | `control-notify.c:139` |
| `%layout-change` | `<window-id> <layout> <visible-layout> <flags>` | `control-notify.c:51, 69` |
| `%session-changed` | `<session-id> <name>` | `control-notify.c:160` |
| `%session-renamed` | `<session-id> <name>` | `control-notify.c:189` |
| `%sessions-changed` | *(none)* | `control-notify.c:202, 215` |
| `%session-window-changed` | `<session-id> <window-id>` | `control-notify.c:228` |
| `%client-session-changed` | `<client-name> <session-id> <name>` | `control-notify.c:163` |
| `%client-detached` | `<client-name>` | `control-notify.c:176` |
| `%paste-buffer-changed` | `<name>` | `control-notify.c:242` |
| `%paste-buffer-deleted` | `<name>` | `control-notify.c:255` |
| `%subscription-changed` | `<name> <session-id> <window-id> <window-index> <pane-id> ... : <value>` | `control.c:862, 909, 989` |
| `%message` | `<message>` | `cmd-display-message.c:151` |
| `%config-error` | `<error>` | `cfg.c:229, 253` |
| `%exit` | `[<reason>]` | `client.c:424-427` |

### Client-to-Server Messages

Any valid tmux command, newline-terminated. An empty line causes detach.

---

## 24. Source File Reference

| File | Role |
|------|------|
| `control.c` | Core protocol: init, teardown, read/write, output encoding, backpressure, subscriptions |
| `control-notify.c` | All event notification functions (14 functions, 17 notification types) |
| `cmd-queue.c` | `%begin`/`%end`/`%error` guard generation via `cmdq_guard()` |
| `cmd-refresh-client.c` | `-A` (pane control), `-B` (subscriptions), `-C` (size), `-f`/`-F` (flags), `-r` (reports), `-l` (clipboard) |
| `cmd-display-message.c` | `%message` notification |
| `cfg.c` | `%config-error` notification |
| `client.c` | Client-side `%exit` output, wait-exit, DCS terminator, exit reasons |
| `tmux.c` | `-C`/`-CC` flag parsing |
| `tmux.h` | `CLIENT_CONTROL*` defines, `control_sub_type` enum, function prototypes, data types |
| `server-client.c` | Flag parsing (`server_client_set_flags`), exit handling, pane buffer management |
| `notify.c` | Dispatches hook events to `control_notify_*` functions |
| `window.c` | Pane output -> `control_write_output()` integration, control fg/bg colors |
| `input.c` | OSC 10/11 color queries using control fg/bg |
| `resize.c` | Control client size exclusion |
| `alerts.c` | Control client alert exclusion |
| `status.c` | Control client status line exclusion |
| `file.c` | Control client file I/O exclusion |
| `server-fn.c` | Control client lock exclusion |
| `cmd-new-session.c` | Control client sizing and MSG_READY suppression |
| `cmd-attach-session.c` | MSG_READY suppression for control clients |
| `cmd-capture-pane.c` | Captured pane output delivery to control clients |
| `cmd-select-pane.c` | Control client redraw exclusion |
| `cmd-save-buffer.c` | show-buffer output delivery to control clients |
| `cmd-source-file.c` | Verbose output suppression for control clients |

---

## 25. Known Man Page vs Code Discrepancies

| Item | Man Page | Code |
|------|----------|------|
| `%session-renamed` args | `<name>` (`tmux.1:7982`) | `<session-id> <name>` (`control-notify.c:189`: `$%u %s`) |
