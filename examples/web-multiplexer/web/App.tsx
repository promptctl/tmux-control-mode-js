// examples/web-multiplexer/web/App.tsx
// Top-level component. Two MobX stores:
//   - DemoStore: tmux model (sessions, windows, panes, events)
//   - UiStore:   UI preferences (navbar width, aside collapsed, filters)
// UiStore auto-persists to sessionStorage.

import { useEffect, useMemo } from "react";
import { observer } from "mobx-react-lite";
import {
  AppShell,
  Group,
  Title,
  Badge,
  Text,
  Stack,
  Tabs,
  ActionIcon,
  Tooltip,
  Modal,
  Button,
} from "@mantine/core";
import type { TmuxBridge } from "./bridge.ts";
import { DemoStore } from "./store.ts";
import { UiStore, isAppMode } from "./ui-store.ts";
import { InspectorStore } from "./inspector-store.ts";
import { HeatmapStore } from "./heatmap-store.ts";
import { SearchStore } from "./search-store.ts";
import { RegexMatcherStore } from "./regex-matcher-store.ts";
import { ImageExtractorStore } from "./image-extractor-store.ts";
import { EscapePlaygroundStore } from "./escape-playground-store.ts";
import { SessionRecorderStore } from "./session-recorder-store.ts";
import { ByteAttributionStore } from "./byte-attribution-store.ts";
import { ScrollbackTimeMachineStore } from "./scrollback-store.ts";
import { MomentDiffStore } from "./moment-diff-store.ts";
import { BisectStore } from "./bisect-store.ts";
import { BroadcastStore } from "./broadcast-store.ts";
import { SyncScrollStore } from "./sync-store.ts";
import { MirrorStore } from "./mirror-store.ts";
import { DataSnifferStore } from "./data-sniff-store.ts";
import { ConsoleStore } from "./console-store.ts";
import { SessionList } from "./components/SessionList.tsx";
import { SocketBadge } from "./components/SocketBadge.tsx";
import { WindowTabs } from "./components/WindowTabs.tsx";
import { PaneView } from "./components/PaneView.tsx";
import { DebugPanel } from "./components/DebugPanel.tsx";
import { ErrorPanel } from "./components/ErrorPanel.tsx";
import { NavbarResizer } from "./components/NavbarResizer.tsx";
import { InspectorView } from "./components/InspectorView.tsx";
import { HeatmapView } from "./components/HeatmapView.tsx";
import { SearchView } from "./components/SearchView.tsx";
import { RegexMatcherView } from "./components/RegexMatcherView.tsx";
import { ImageExtractorView } from "./components/ImageExtractorView.tsx";
import { EscapePlaygroundView } from "./components/EscapePlaygroundView.tsx";
import { SessionRecorderView } from "./components/SessionRecorderView.tsx";
import { ByteAttributionView } from "./components/ByteAttributionView.tsx";
import { ScrollbackTimeMachineView } from "./components/ScrollbackTimeMachineView.tsx";
import { MomentDiffView } from "./components/MomentDiffView.tsx";
import { BisectView } from "./components/BisectView.tsx";
import { BroadcastView } from "./components/BroadcastView.tsx";
import { SyncScrollView } from "./components/SyncScrollView.tsx";
import { MirrorView } from "./components/MirrorView.tsx";
import { DataSnifferView } from "./components/DataSnifferView.tsx";
import { ConsoleView } from "./components/ConsoleView.tsx";
import { SegmentedControl } from "@mantine/core";

export interface AppProps {
  /**
   * The transport-agnostic bridge the renderer talks to. Constructed at
   * module scope by the entry point — App does not own its lifecycle
   * across React StrictMode remounts; it just calls connect/disconnect.
   * Both WebSocketBridge and ElectronBridge tolerate multiple
   * connect/disconnect cycles, so the StrictMode dev double-mount is
   * benign.
   */
  readonly bridge: TmuxBridge;
  /**
   * URL for transports that dial somewhere (WebSocket). Ignored by
   * transports that are already attached at construction (Electron IPC).
   */
  readonly connectUrl: string;
}

export const App = observer(function App({ bridge, connectUrl }: AppProps) {
  const uiStore = useMemo(() => new UiStore(), []);
  // Demo-side policy hooks: the library's keymap emits `choose-session`
  // for C-b s, but the demo handles it by popping the sidebar open rather
  // than firing tmux's `choose-tree` (which renders inside a pane and
  // doesn't translate well to the browser UX).
  const demoStore = useMemo(
    () =>
      new DemoStore(bridge, {
        onChooseSession: () => uiStore.expandNavbar(),
      }),
    [bridge, uiStore],
  );
  // [LAW:one-source-of-truth] InspectorStore subscribes to the SAME
  // TmuxBridge as DemoStore. Both stores are pure projections of the
  // wire — InspectorStore sees everything, DemoStore sees only events.
  const inspectorStore = useMemo(
    () => new InspectorStore(demoStore.client),
    [demoStore],
  );
  const heatmapStore = useMemo(
    () => new HeatmapStore(demoStore.client),
    [demoStore],
  );
  const searchStore = useMemo(
    () => new SearchStore(demoStore.client),
    [demoStore],
  );
  // [LAW:one-source-of-truth] RegexMatcherStore drives the SAME bridge as the
  // rest of the app, sourcing the cross-terminal regex feed exclusively from
  // the dedicated firehose channel (never the attached %output the terminals
  // render). The store outlives the view so the feed survives tab switches.
  const regexStore = useMemo(
    () => new RegexMatcherStore(demoStore.client),
    [demoStore],
  );
  // [LAW:one-source-of-truth] ImageExtractorStore drives the SAME bridge as the
  // rest of the app, sourcing image escape sequences exclusively from the
  // dedicated firehose channel — tmux strips graphics sequences from the
  // attached %output the terminals render, so the firehose is the only place
  // they survive. The store outlives the view so the gallery survives tab
  // switches.
  const imageStore = useMemo(
    () => new ImageExtractorStore(demoStore.client),
    [demoStore],
  );
  // [LAW:one-source-of-truth] EscapePlaygroundStore drives the SAME bridge as
  // the rest of the app. Unlike the read-only demos it exercises the OUTBOUND
  // path: it spawns one scratch pane and sends user-composed bytes to it via
  // `sendKeys`. Its lifecycle (spawn/kill) is owned by the appMode effect below.
  const playgroundStore = useMemo(
    () => new EscapePlaygroundStore(demoStore.client),
    [demoStore],
  );
  // [LAW:one-source-of-truth] SessionRecorderStore drives the SAME bridge as the
  // rest of the app, capturing the dedicated firehose channel (raw pty bytes of
  // every pane, view-independent) into a timestamped log. The store outlives the
  // view so a finished recording survives tab switches.
  const recorderStore = useMemo(
    () => new SessionRecorderStore(demoStore.client),
    [demoStore],
  );
  // [LAW:one-source-of-truth] ByteAttributionStore drives the SAME bridge as the
  // rest of the app, sourcing the dedicated firehose channel (raw pty bytes of
  // every pane). It reconstructs the pane's grid from the very bytes it
  // attributes, so a cell and its provenance can never disagree. The store
  // outlives the view so the captured window survives tab switches.
  const attributionStore = useMemo(
    () => new ByteAttributionStore(demoStore.client),
    [demoStore],
  );
  // [LAW:one-source-of-truth] ScrollbackTimeMachineStore drives the SAME bridge,
  // seeding each pane's pre-record scrollback via capture-pane and recording the
  // forward firehose. The store outlives the view so a captured timeline survives
  // tab switches.
  const timeMachineStore = useMemo(
    () => new ScrollbackTimeMachineStore(demoStore.client),
    [demoStore],
  );
  // [LAW:one-source-of-truth] MomentDiffStore drives the SAME bridge, seeding
  // each pane and recording the forward firehose like the time machine, then
  // diffing two reconstructed moments cell-by-cell. The store outlives the view
  // so a captured recording survives tab switches.
  const momentDiffStore = useMemo(
    () => new MomentDiffStore(demoStore.client),
    [demoStore],
  );
  // [LAW:one-source-of-truth] BisectStore drives the SAME bridge, seeding each
  // pane and recording the forward firehose like the moment diff, then
  // git-bisecting the recorded byte stream to pin the offending escape sequence.
  // The store outlives the view so a captured recording survives tab switches.
  const bisectStore = useMemo(
    () => new BisectStore(demoStore.client),
    [demoStore],
  );
  // [LAW:one-source-of-truth] BroadcastStore reads the LIVE pane model off the
  // same DemoStore (built-in `${pane}`/`${title}` bindings derive from it, never
  // a snapshot) and fans resolved bytes over the SAME `sendKeys` boundary the
  // rest of the app writes through. It owns no tmux resource, so unlike the
  // recording stores it needs no lifecycle effect and no dispose.
  const broadcastStore = useMemo(
    () => new BroadcastStore(demoStore.client, demoStore),
    [demoStore],
  );
  // [LAW:one-source-of-truth] SyncScrollStore drives the SAME bridge, seeding each
  // pane and recording the forward firehose like the time machine, then scrubbing
  // N linked panes in lockstep on the one shared recorded-time axis. The store
  // outlives the view so a captured recording survives tab switches.
  const syncStore = useMemo(
    () => new SyncScrollStore(demoStore.client),
    [demoStore],
  );
  // The Pane Mirror tab holds only the operator's pane SELECTION. The live
  // mirror connection (the IO) is owned by the read-only `MirrorViewerBridge`
  // the view mounts — a separate `/mirror` endpoint that never touches this
  // bridge — so this store needs no tmux client and no dispose. [LAW:decomposition]
  const mirrorStore = useMemo(() => new MirrorStore(), []);
  // [LAW:one-source-of-truth] DataSnifferStore drives the SAME bridge as the
  // rest of the app, sourcing the dedicated firehose channel (raw pty bytes of
  // every pane). It only observes — a `pipe-pane` tap injects nothing — so it
  // sits between the user and the terminal without disturbing it. The store
  // outlives the view so the block feed survives tab switches.
  const snifferStore = useMemo(
    () => new DataSnifferStore(demoStore.client),
    [demoStore],
  );
  // [LAW:one-source-of-truth] ConsoleStore drives the SAME bridge as the
  // rest of the app and reads its persisted slice from UiStore. The store
  // outlives the view so an in-flight command resolves across tab switches.
  const consoleStore = useMemo(
    () => new ConsoleStore(demoStore.client, uiStore),
    [demoStore, uiStore],
  );

  useEffect(() => {
    demoStore.connect(connectUrl);
    return () => {
      consoleStore.dispose();
      snifferStore.dispose();
      syncStore.dispose();
      bisectStore.dispose();
      momentDiffStore.dispose();
      timeMachineStore.dispose();
      attributionStore.dispose();
      recorderStore.dispose();
      playgroundStore.dispose();
      imageStore.dispose();
      regexStore.dispose();
      searchStore.dispose();
      heatmapStore.dispose();
      inspectorStore.dispose();
      demoStore.disconnect();
    };
  }, [
    demoStore,
    heatmapStore,
    inspectorStore,
    searchStore,
    regexStore,
    imageStore,
    playgroundStore,
    recorderStore,
    attributionStore,
    timeMachineStore,
    momentDiffStore,
    bisectStore,
    syncStore,
    snifferStore,
    consoleStore,
    connectUrl,
  ]);

  // Lazily seed the full-scrollback index the first time search mode opens —
  // capturing every pane's history on app load would be wasteful when the
  // user may never search. The live `%output` tail keeps the index warm
  // regardless; this one-shot adds the pre-connection history.
  useEffect(() => {
    if (uiStore.appMode === "search") void searchStore.ensureBackfilled();
  }, [uiStore.appMode, searchStore]);

  // Open the cross-terminal firehose only while regex mode is active — taps on
  // every pane cost server-side resources, so idle modes pay nothing. Leaving
  // the mode (or unmounting) closes the taps. [LAW:no-ambient-temporal-coupling]
  // the lifecycle has one owner: this effect, keyed on appMode.
  useEffect(() => {
    if (uiStore.appMode === "regex") {
      regexStore.start();
      return () => regexStore.stop();
    }
    return undefined;
  }, [uiStore.appMode, regexStore]);

  // Same firehose-only lifecycle for the inline image extractor: taps open while
  // image mode is active and close on leave. [LAW:no-ambient-temporal-coupling]
  // one owner per effect, both keyed on appMode.
  // Same firehose-only lifecycle for the structured data sniffer: taps open
  // while sniffer mode is active and close on leave. [LAW:no-ambient-temporal-
  // coupling] one owner: this effect, keyed on appMode.
  useEffect(() => {
    if (uiStore.appMode === "sniffer") {
      snifferStore.start();
      return () => snifferStore.stop();
    }
    return undefined;
  }, [uiStore.appMode, snifferStore]);

  useEffect(() => {
    if (uiStore.appMode === "image") {
      imageStore.start();
      return () => imageStore.stop();
    }
    return undefined;
  }, [uiStore.appMode, imageStore]);

  // Same firehose-only lifecycle for the session recorder: taps open while
  // record mode is active and close on leave. The recorder captures the firehose
  // (raw pty bytes of every pane) with timing; nothing is recorded until the
  // user hits Record. [LAW:no-ambient-temporal-coupling] one owner, keyed on
  // appMode — leaving the mode freezes any in-progress recording and closes taps.
  useEffect(() => {
    if (uiStore.appMode === "record") {
      recorderStore.start();
      return () => recorderStore.stop();
    }
    return undefined;
  }, [uiStore.appMode, recorderStore]);

  // Same firehose-only lifecycle for byte attribution: taps open while the mode
  // is active and close on leave. The store reconstructs the selected pane's
  // grid from the captured bytes so each cell can be traced to its source byte.
  // [LAW:no-ambient-temporal-coupling] one owner, keyed on appMode.
  useEffect(() => {
    if (uiStore.appMode === "attribution") {
      attributionStore.start();
      return () => attributionStore.stop();
    }
    return undefined;
  }, [uiStore.appMode, attributionStore]);

  // Same firehose-only lifecycle for the scrollback time machine: taps open
  // while the mode is active and close on leave. The store also takes a one-shot
  // capture-pane seed of every pane at record-start.
  // [LAW:no-ambient-temporal-coupling] one owner, keyed on appMode.
  useEffect(() => {
    if (uiStore.appMode === "timemachine") {
      timeMachineStore.start();
      return () => timeMachineStore.stop();
    }
    return undefined;
  }, [uiStore.appMode, timeMachineStore]);

  // Same firehose-only lifecycle for the moment diff: taps open while the mode
  // is active and close on leave. Like the time machine it also seeds every pane
  // at record-start. [LAW:no-ambient-temporal-coupling] one owner, keyed on appMode.
  useEffect(() => {
    if (uiStore.appMode === "momentdiff") {
      momentDiffStore.start();
      return () => momentDiffStore.stop();
    }
    return undefined;
  }, [uiStore.appMode, momentDiffStore]);

  // Same firehose-only lifecycle for the bisect demo: taps open while the mode
  // is active and close on leave. Like the moment diff it seeds every pane at
  // record-start. [LAW:no-ambient-temporal-coupling] one owner, keyed on appMode.
  useEffect(() => {
    if (uiStore.appMode === "bisect") {
      bisectStore.start();
      return () => bisectStore.stop();
    }
    return undefined;
  }, [uiStore.appMode, bisectStore]);

  // Same firehose-only lifecycle for synchronized scrollback: taps open while the
  // mode is active and close on leave. Like the time machine it seeds every pane
  // at record-start. [LAW:no-ambient-temporal-coupling] one owner, keyed on appMode.
  useEffect(() => {
    if (uiStore.appMode === "syncscroll") {
      syncStore.start();
      return () => syncStore.stop();
    }
    return undefined;
  }, [uiStore.appMode, syncStore]);

  // The playground owns a scratch tmux pane only while its mode is active:
  // entering spawns the byte-mirror pane, leaving (or unmounting) kills it so
  // no scratch window litters the user's session. [LAW:no-ambient-temporal-
  // coupling] one owner per effect, keyed on appMode.
  useEffect(() => {
    if (uiStore.appMode === "playground") {
      playgroundStore.start();
      return () => playgroundStore.stop();
    }
    return undefined;
  }, [uiStore.appMode, playgroundStore]);

  // Document-level keymap routing.
  //
  // Why this lives at window scope (and not on xterm's attachCustomKey-
  // EventHandler): tmux-style shortcuts should keep working even when the
  // focus drifts off the terminal — e.g. after C-b n unmounts the old
  // xterm and the new one hasn't grabbed focus yet, or when the user
  // clicked a UI control. Attaching per-xterm would make the keymap deaf
  // in exactly those moments.
  //
  // Capture phase (useCapture: true) runs this listener BEFORE xterm's
  // own keydown handler on its textarea, so consumed chords can be
  // preventDefault'd before xterm translates them into pane bytes.
  //
  // Text-input exclusion: when the user is typing into a real form
  // input (filter boxes, inspector search) we must NOT interpret those
  // keystrokes as tmux commands. The xterm helper textarea is an
  // exception — that's where the keymap SHOULD fire.
  useEffect(() => {
    function isRegularTextInput(el: Element | null): boolean {
      if (el === null) return false;
      // xterm's invisible textarea is how xterm captures input. Treat it
      // as "not a text input" so the keymap handles C-b there.
      if (el.classList.contains("xterm-helper-textarea")) return false;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return true;
      if ((el as HTMLElement).isContentEditable) return true;
      return false;
    }
    function onKeyDown(ev: KeyboardEvent): void {
      if (isRegularTextInput(document.activeElement)) return;
      // When a confirm/action modal is open, let it handle keys itself.
      // Otherwise our capture-phase listener would swallow Enter/Escape
      // before the Modal's button could react.
      if (demoStore.pendingConfirm !== null) return;
      const consumed = demoStore.handleKeyEvent({
        key: ev.key,
        ctrl: ev.ctrlKey,
        alt: ev.altKey,
        shift: ev.shiftKey,
        meta: ev.metaKey,
      });
      if (consumed) {
        ev.preventDefault();
        ev.stopPropagation();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [demoStore]);

  const { currentSession, currentWindow, connState, sessions, events, errors } =
    demoStore;

  return (
    <AppShell
      header={{ height: 56 }}
      navbar={{
        width: uiStore.navbarWidth,
        breakpoint: 0,
        collapsed: {
          desktop: uiStore.navbarCollapsed,
          mobile: uiStore.navbarCollapsed,
        },
      }}
      aside={{
        width: 420,
        breakpoint: 0,
        collapsed: {
          desktop: uiStore.asideCollapsed,
          mobile: uiStore.asideCollapsed,
        },
      }}
      padding="md"
    >
      <AppShell.Header p="sm">
        <Group justify="space-between" h="100%" wrap="nowrap">
          <Group
            gap="sm"
            wrap="nowrap"
            style={{ minWidth: 0, overflow: "hidden" }}
          >
            <Tooltip
              label={
                uiStore.navbarCollapsed
                  ? "Show session sidebar"
                  : "Hide session sidebar"
              }
            >
              <ActionIcon
                variant="subtle"
                onClick={() => uiStore.toggleNavbar()}
                aria-label="toggle session sidebar"
              >
                {uiStore.navbarCollapsed ? "▶" : "◀"}
              </ActionIcon>
            </Tooltip>
            <Title order={4}>tmux-control-mode-js</Title>
            <Text c="dimmed" size="sm" truncate="end">
              Web Multiplexer Demo
            </Text>
            <SegmentedControl
              size="xs"
              value={uiStore.appMode}
              onChange={(v) =>
                uiStore.setAppMode(isAppMode(v) ? v : "multiplexer")
              }
              data={[
                { label: "Multiplexer", value: "multiplexer" },
                { label: "Console", value: "console" },
                { label: "Protocol Inspector", value: "inspector" },
                { label: "Activity Heatmap", value: "heatmap" },
                { label: "Scrollback Search", value: "search" },
                { label: "Regex Matcher", value: "regex" },
                { label: "Image Extractor", value: "image" },
                { label: "Escape Playground", value: "playground" },
                { label: "Session Recorder", value: "record" },
                { label: "Byte Attribution", value: "attribution" },
                { label: "Time Machine", value: "timemachine" },
                { label: "Moment Diff", value: "momentdiff" },
                { label: "Bug Bisect", value: "bisect" },
                { label: "Smart Broadcast", value: "broadcast" },
                { label: "Sync Scrollback", value: "syncscroll" },
                { label: "Pane Mirror", value: "mirror" },
                { label: "Data Sniffer", value: "sniffer" },
              ]}
            />
          </Group>
          <Group gap="xs" wrap="nowrap">
            {/* Prefix-active indicator. Only rendered when the keymap
                engine is in prefix mode; occupies no space otherwise so
                the header layout doesn't jitter. */}
            {demoStore.prefixActive && (
              <Badge color="yellow" variant="filled">
                prefix: C-b
              </Badge>
            )}
            <Text size="xs" c="dimmed">
              {sessions.length} sessions
            </Text>
            {/* Connection-status badge. On the Electron target this is
                also the entry point to the socket picker (click → menu of
                live tmux sockets). On the web target it falls back to a
                plain reconnect button. See components/SocketBadge.tsx. */}
            <SocketBadge demoStore={demoStore} connectUrl={connectUrl} />
            <Tooltip
              label={
                uiStore.asideCollapsed ? "Show debug panel" : "Hide debug panel"
              }
            >
              <ActionIcon
                variant="subtle"
                onClick={() => uiStore.toggleAside()}
                aria-label="toggle debug panel"
              >
                {uiStore.asideCollapsed ? "◀" : "▶"}
              </ActionIcon>
            </Tooltip>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="sm">
        {/* Wrap the navbar content in a relative-positioned full-size box
            so the absolutely-positioned resizer handle anchors to it.
            DO NOT set position: relative on AppShell.Navbar itself —
            that overrides Mantine's intended fixed positioning and
            collapses the entire AppShell layout. */}
        <div style={{ position: "relative", height: "100%", width: "100%" }}>
          <SessionList store={demoStore} />
          <NavbarResizer uiStore={uiStore} />
        </div>
      </AppShell.Navbar>

      <AppShell.Main
        style={{
          display: "flex",
          flexDirection: "column",
          // 100vh because Mantine AppShell's grid cell uses `min-height`,
          // so `height: 100%` on Main never resolves. Mantine automatically
          // adds `padding-top: var(--app-shell-header-offset)` to Main, so
          // the content area (box minus padding-top) is viewport minus the
          // header — which is exactly what we want.
          height: "100vh",
        }}
      >
        {uiStore.appMode === "console" ? (
          <ConsoleView store={consoleStore} demoStore={demoStore} />
        ) : uiStore.appMode === "inspector" ? (
          <InspectorView store={inspectorStore} demoStore={demoStore} />
        ) : uiStore.appMode === "heatmap" ? (
          <HeatmapView
            demoStore={demoStore}
            heatmapStore={heatmapStore}
            uiStore={uiStore}
          />
        ) : uiStore.appMode === "search" ? (
          <SearchView
            demoStore={demoStore}
            searchStore={searchStore}
            uiStore={uiStore}
          />
        ) : uiStore.appMode === "regex" ? (
          <RegexMatcherView
            demoStore={demoStore}
            regexStore={regexStore}
            uiStore={uiStore}
          />
        ) : uiStore.appMode === "image" ? (
          <ImageExtractorView
            demoStore={demoStore}
            imageStore={imageStore}
            uiStore={uiStore}
          />
        ) : uiStore.appMode === "playground" ? (
          <EscapePlaygroundView
            demoStore={demoStore}
            store={playgroundStore}
            uiStore={uiStore}
          />
        ) : uiStore.appMode === "record" ? (
          <SessionRecorderView
            demoStore={demoStore}
            store={recorderStore}
            uiStore={uiStore}
          />
        ) : uiStore.appMode === "attribution" ? (
          <ByteAttributionView
            demoStore={demoStore}
            store={attributionStore}
            uiStore={uiStore}
          />
        ) : uiStore.appMode === "timemachine" ? (
          <ScrollbackTimeMachineView
            demoStore={demoStore}
            store={timeMachineStore}
            uiStore={uiStore}
          />
        ) : uiStore.appMode === "momentdiff" ? (
          <MomentDiffView
            demoStore={demoStore}
            store={momentDiffStore}
            uiStore={uiStore}
          />
        ) : uiStore.appMode === "bisect" ? (
          <BisectView
            demoStore={demoStore}
            store={bisectStore}
            uiStore={uiStore}
          />
        ) : uiStore.appMode === "broadcast" ? (
          <BroadcastView store={broadcastStore} />
        ) : uiStore.appMode === "syncscroll" ? (
          <SyncScrollView
            demoStore={demoStore}
            store={syncStore}
            uiStore={uiStore}
          />
        ) : uiStore.appMode === "mirror" ? (
          <MirrorView
            demoStore={demoStore}
            store={mirrorStore}
            uiStore={uiStore}
          />
        ) : uiStore.appMode === "sniffer" ? (
          <DataSnifferView
            demoStore={demoStore}
            store={snifferStore}
            uiStore={uiStore}
          />
        ) : currentSession === null ? (
          <Text c="dimmed">
            {connState === "ready"
              ? sessions.length === 0
                ? "No sessions visible — tmux returned an empty list."
                : "Pick a session from the sidebar."
              : `Connecting to bridge (${connState})…`}
          </Text>
        ) : (
          <Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
            <WindowTabs store={demoStore} />
            {currentWindow !== null && (
              <PaneView store={demoStore} uiStore={uiStore} />
            )}
          </Stack>
        )}
      </AppShell.Main>

      <AppShell.Aside p="sm">
        <Tabs
          value={uiStore.activeAsideTab}
          onChange={(v) => v !== null && uiStore.setActiveAsideTab(v)}
        >
          <Tabs.List>
            <Tabs.Tab value="debug">Debug ({events.length})</Tabs.Tab>
            <Tabs.Tab
              value="errors"
              color={errors.length > 0 ? "red" : undefined}
            >
              Errors ({errors.length})
            </Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="debug" pt="xs">
            <DebugPanel demoStore={demoStore} uiStore={uiStore} key="debug" />
          </Tabs.Panel>
          <Tabs.Panel value="errors" pt="xs">
            <ErrorPanel demoStore={demoStore} />
          </Tabs.Panel>
        </Tabs>
      </AppShell.Aside>

      {/* Confirm modal for destructive keymap actions (C-b x, C-b &).
          The demo intercepts kill-pane / kill-window in DemoStore and
          shows this prompt before dispatching — matching tmux's own
          `confirm-before` UX without forcing that policy into the
          library layer. */}
      <Modal
        opened={demoStore.pendingConfirm !== null}
        onClose={() => demoStore.cancelPendingAction()}
        title="Confirm"
        centered
        size="sm"
      >
        <Stack gap="md">
          <Text>{demoStore.pendingConfirm?.prompt ?? ""}</Text>
          <Group justify="flex-end" gap="xs">
            <Button
              variant="default"
              onClick={() => demoStore.cancelPendingAction()}
            >
              Cancel
            </Button>
            <Button
              color="red"
              onClick={() => demoStore.confirmPendingAction()}
              // Mantine's focus trap uses `data-autofocus` — React's
              // `autoFocus` prop is ignored by the trap because Modal runs
              // its own focus management after mount. Wrap the attr in a
              // truthy value so Mantine picks this as the initial target.
              data-autofocus
            >
              Kill
            </Button>
          </Group>
        </Stack>
      </Modal>
    </AppShell>
  );
});
