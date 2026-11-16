// src/connectors/electron/sender-registry.ts
// [LAW:decomposition] The pages that talk to main, the proxies on each, and
// each proxy's lifecycle, extracted from createMainBridge. Owns the pages
// Map, each proxy's ProxyPeer, its byte forwarder, event gating, and the event
// fan-out. The wiring shell holds no sender state.
//
// [LAW:one-source-of-truth] One `Peer` per proxy, registered with the shared
// BridgeConnection helper — the proxy is what a renderer opens and closes,
// as a socket is on the WebSocket connector, so subscriptions, size claims
// and outstanding bytes are each proxy's own. A proxy's peer ends when it
// unregisters or when its page ends: its WebContents is destroyed, navigates
// to a new document, or loses its renderer process. `release` is the only
// path that drops a peer — subscription refcount, size claim, outstanding-byte
// accounting and byte forwarder go together, in one place.
//
// [LAW:one-way-deps] This module knows nothing about the invoke pipeline. It
// defines the per-proxy record — including the `pending` set of in-flight
// invoke abort-flags — and flags them on release; the pipeline populates that
// set through `registered`. The dependency runs one way (pipeline → registry),
// and there is exactly one record per proxy, so nothing can drift.

import type { TmuxClient } from "../../client.js";
import type { EmitterMessage } from "../../emitter.js";
import { serverScope } from "../../pane-output.js";
import type { BridgeConnection, Peer } from "../bridge-connection.js";
import {
  IPC,
  PAGE_END_EVENTS,
  parseAckMessage,
  parseProxyId,
  type IpcMainEventLike,
  type ProxyId,
  type WebContentsLike,
  type WebFrameLike,
} from "./types.js";

/**
 * The abort channel for one in-flight invoke. The invoke pipeline creates it,
 * adds it to the calling proxy's `pending` set, and reads `aborted` after its
 * dispatch await resolves. `SenderRegistry` flips it when the proxy's peer is
 * released mid-flight, so the pipeline returns a BRIDGE_ABORTED envelope
 * instead of delivering a result to a proxy that is gone.
 */
export interface PendingDispatch {
  aborted: boolean;
}

/**
 * Main's side of one renderer proxy. Subscription ownership, refcount and
 * outstanding-byte accounting live inside the BridgeConnection helper, keyed
 * by `peer`; this record carries only what is electron-specific.
 */
export interface ProxyPeer {
  /** The WebContents showing the proxy's page. */
  readonly wc: WebContentsLike;
  /** The proxy's address; every message main sends it names this. */
  readonly id: ProxyId;
  /** Token returned by BridgeConnection.registerPeer. */
  readonly peer: Peer;
  /** In-flight invoke dispatches the proxy made. The pipeline adds/removes
   *  entries; release flags them all aborted. */
  readonly pending: Set<PendingDispatch>;
  /** Disposer for the proxy's byte forwarder, attached with its peer. */
  readonly detachBytes: () => void;
}

/** A page a WebContents shows, and the proxies on it. */
interface PageState {
  /**
   * The exact listeners registered on the WebContents: `onPageEnd` with
   * `once` for every PAGE_END_EVENTS entry, `onLoadFailed` with `on` for
   * `did-fail-load`. Stored so `teardown` can call `wc.removeListener` for
   * the ones still attached — otherwise a listener stays on a still-alive
   * emitter and tears down the NEXT page when it fires.
   */
  readonly onPageEnd: () => void;
  readonly onLoadFailed: () => void;
  readonly proxies: Map<ProxyId, ProxyPeer>;
}

export interface SenderRegistryDeps {
  readonly bridge: Pick<
    BridgeConnection,
    | "registerPeer"
    | "removePeer"
    | "accountOutput"
    | "ackOutput"
    | "routeEvent"
    | "deliversTo"
  >;
  readonly client: Pick<TmuxClient, "attachBytesSink" | "connectionState">;
}

/**
 * Whether `frame` hosts the page `wc` shows now.
 *
 * A destroyed WebContents and a crashed renderer show no page, though their
 * `mainFrame` may still name the last host (before Electron 34, reading a
 * crashed one throws), so both are ruled out before `mainFrame` is read.
 * `isCrashed` turns false once a reload commits a new document.
 */
function showsFrame(wc: WebContentsLike, frame: WebFrameLike): boolean {
  return (
    !wc.isDestroyed() &&
    !wc.isCrashed() &&
    wc.mainFrame.processId === frame.processId &&
    wc.mainFrame.routingId === frame.routingId
  );
}

/** The frame host that sent `event`. */
function senderFrame(event: IpcMainEventLike): WebFrameLike {
  return { processId: event.processId, routingId: event.frameId };
}

/**
 * Whether `event` was sent by the page its WebContents shows now.
 *
 * [LAW:single-enforcer] The one test every renderer message passes before it
 * touches a page. A page that has ended can still have messages in flight:
 * an invoke the old page queued may land after `did-navigate` tore its page
 * down. When the navigation reused the frame host, Chromium delivers the old
 * document's IPC before the commit that fires `did-navigate`, so it reached
 * the old page; when it swapped hosts, the old host's ids no longer match
 * `mainFrame`. The new document's first IPC arrives after `did-navigate`, so
 * it opens a fresh page. (`WebFrameMain` object identity is no test: before
 * Electron 34 one object follows the frame across host swaps.) Messages from
 * subframes fail too — `wc.send` reaches only the main frame's document.
 */
function sentByLivePage(event: IpcMainEventLike): boolean {
  return showsFrame(event.sender, senderFrame(event));
}

export class SenderRegistry {
  private readonly pages = new Map<WebContentsLike, PageState>();

  constructor(private readonly deps: SenderRegistryDeps) {}

  /**
   * The ProxyPeer the page that sent `event` registered as `proxy`.
   *
   * [LAW:types-are-the-program] [LAW:no-silent-failure] Returns `undefined`
   * when the sending page has ended (see sentByLivePage) — its peers were
   * released with it — or never registered `proxy`. A proxy registers in its
   * constructor, and Electron delivers a frame's `send` and `invoke` in the
   * order it made them, so a live proxy's invoke always finds its peer.
   * Callers abort instead of minting a peer: one is created only by the
   * register that opens it, never by whatever a renderer names.
   */
  registered(event: IpcMainEventLike, proxy: ProxyId): ProxyPeer | undefined {
    if (!sentByLivePage(event)) return undefined;
    return this.pages.get(event.sender)?.proxies.get(proxy);
  }

  private openPage(event: IpcMainEventLike): PageState {
    const wc = event.sender;
    const frame = senderFrame(event);
    // [LAW:single-enforcer] One set of page listeners per page, stored on it
    // so `teardown` can detach the ones still attached.
    const onPageEnd = (): void => this.teardown(wc);
    // A failed main-frame load that commits an error page moves the main
    // frame to another host (Chromium isolates main-frame error pages); a
    // subframe's failure leaves the page shown. Comparing hosts asks the
    // question directly instead of reading `did-fail-load`'s arguments.
    const onLoadFailed = (): void => {
      if (!showsFrame(wc, frame)) this.teardown(wc);
    };
    const page: PageState = { onPageEnd, onLoadFailed, proxies: new Map() };
    this.pages.set(wc, page);
    for (const e of PAGE_END_EVENTS) wc.once(e, onPageEnd);
    wc.on("did-fail-load", onLoadFailed);
    return page;
  }

  /**
   * Handle a proxy's IPC.register: open its peer — registered with the
   * bridge, with its byte forwarder attached — and send it the current
   * connection-state snapshot so a late-joining proxy has the lifecycle state
   * immediately. A repeated register keeps the peer it has.
   */
  register(event: IpcMainEventLike, rawProxy: unknown): void {
    const proxy = parseProxyId(rawProxy);
    // [LAW:no-silent-failure] exception: a register naming no proxy has no
    // one to answer, and neither has one not sent by the page shown (it has
    // ended, or a subframe sent it) — `wc.send` reaches only the main frame's
    // document.
    if (proxy === null || !sentByLivePage(event)) return;
    const wc = event.sender;
    const page = this.pages.get(wc) ?? this.openPage(event);
    const state = page.proxies.get(proxy) ?? this.openPeer(wc, proxy);
    page.proxies.set(proxy, state);
    // [LAW:dataflow-not-control-flow] Late-joining proxies need the current
    // lifecycle state immediately, not just when the next transition happens.
    // The snapshot rides the same IPC.event channel the live transitions use —
    // the proxy treats it identically — addressed to this proxy alone, so the
    // proxies already on the page hear no repeat of a state they have.
    wc.send(IPC.event, {
      to: proxy,
      msg: {
        type: "connection-state",
        state: this.deps.client.connectionState,
      },
    });
  }

  private openPeer(wc: WebContentsLike, to: ProxyId): ProxyPeer {
    const peer = this.deps.bridge.registerPeer();
    // [LAW:dataflow-not-control-flow] One forwarder per proxy: the substrate's
    // SinkRegistry fans each chunk out to every proxy's sink; no per-chunk
    // broadcast loop exists in the bridge.
    const detachBytes = this.deps.client.attachBytesSink(
      {
        write: (chunk): void => {
          // [LAW:no-defensive-null-guards] Trust-boundary guard: never bill
          // or send to a WebContents Electron has already destroyed (a stray
          // account could pause a pane that never acks; a send would throw).
          if (wc.isDestroyed()) return;
          // Account BEFORE the send so a synchronous ack during dispatch
          // subtracts from the right baseline.
          this.deps.bridge.accountOutput(
            peer,
            chunk.paneId,
            chunk.data.byteLength,
          );
          wc.send(IPC.event, {
            to,
            msg: { type: "output", paneId: chunk.paneId, data: chunk.data },
          });
        },
        end: (): void => {
          // No wire-level pane-end frame: pane lifecycle reaches the proxy as
          // tmux notifications on the same channel.
        },
      },
      { scope: serverScope },
    );
    return { wc, id: to, peer, pending: new Set(), detachBytes };
  }

  /**
   * Handle a proxy's IPC.ack: validate at the trust boundary and forward the
   * released byte count to the bridge's backpressure accounting for that
   * proxy's peer.
   */
  ack(event: IpcMainEventLike, rawProxy: unknown, rawAck: unknown): void {
    // An ack from a page that has ended releases nothing: its bytes were
    // released with its peers.
    const proxy = parseProxyId(rawProxy);
    const state = proxy === null ? undefined : this.registered(event, proxy);
    if (state === undefined) return;
    // [LAW:single-enforcer] Validation happens at the IPC trust boundary.
    // Bad acks from a compromised renderer are dropped silently — they can
    // only starve the proxy named, never reach tmux.
    const ack = (() => {
      try {
        return parseAckMessage(rawAck);
      } catch {
        return null;
      }
    })();
    if (ack === null) return;
    this.deps.bridge.ackOutput(state.peer, ack.paneId, ack.bytes);
  }

  /**
   * Handle a proxy's IPC.unregister: release its peer — its subscriptions,
   * size claims, outstanding bytes and in-flight invokes — and leave the
   * page's other proxies theirs. The page's last proxy takes the page with
   * it. An unregister from a page that has ended must not touch the page
   * shown now.
   */
  unregister(event: IpcMainEventLike, rawProxy: unknown): void {
    if (!sentByLivePage(event)) return;
    const proxy = parseProxyId(rawProxy);
    if (proxy === null) return;
    const page = this.pages.get(event.sender);
    const state = page?.proxies.get(proxy);
    if (page === undefined || state === undefined) return;
    page.proxies.delete(proxy);
    this.release(state);
    if (page.proxies.size === 0) this.teardown(event.sender);
  }

  /**
   * End a page: release every proxy's peer on it and detach its listeners.
   * Idempotent: a noop when the page is already gone, so a double-firing
   * page-end event cannot release a peer twice.
   */
  teardown(wc: WebContentsLike): void {
    const page = this.pages.get(wc);
    if (page === undefined) return;
    this.pages.delete(wc);
    // A page-end listener that fired has already been removed by `once`; the
    // rest would otherwise fire later against the next page — see
    // PageState.onPageEnd.
    for (const e of PAGE_END_EVENTS) wc.removeListener(e, page.onPageEnd);
    wc.removeListener("did-fail-load", page.onLoadFailed);
    for (const state of page.proxies.values()) this.release(state);
  }

  /** End every page (dispose path). */
  teardownAll(): void {
    for (const wc of [...this.pages.keys()]) this.teardown(wc);
  }

  /** The one path that drops a proxy's peer. */
  private release(state: ProxyPeer): void {
    // (1) Flag the proxy's in-flight invokes aborted. The TmuxClient FIFO
    //     stays intact — the underlying %begin/%end still resolves the pending
    //     entry in order — but the invoke pipeline observes the abort and
    //     returns a BRIDGE_ABORTED envelope instead of replying to a proxy
    //     that is gone.
    for (const p of state.pending) p.aborted = true;
    // (2) Detach the proxy's byte forwarder.
    state.detachBytes();
    // (3) Drop helper-side accounting + subscription refcounts in one call.
    //     bridge.removePeer fires setPaneAction(Continue) for any pane this
    //     peer's outstanding bytes were keeping paused, and unsubscribes from
    //     tmux for any subscription this peer was the last owner of.
    this.deps.bridge.removePeer(state.peer);
  }

  // -------------------------------------------------------------------------
  // Event fan-out.
  //
  // The mechanism: send a message to every proxy on IPC.event.
  // The forwarding *policy* (which messages reach which peer) is the
  // bridge's routeEvent/deliversTo; this method only fans out on its verdict.
  // [LAW:dataflow-not-control-flow]
  // -------------------------------------------------------------------------

  broadcast(msg: EmitterMessage): void {
    // Snapshot before iterating: teardown below deletes from `pages`.
    const snapshot = [...this.pages];
    // [LAW:single-enforcer] The bridge decides which events reach which peer;
    // the message is classified once, then checked per peer.
    const route = this.deps.bridge.routeEvent(msg);
    for (const [wc, page] of snapshot) {
      // [LAW:no-defensive-null-guards] isDestroyed is a trust-boundary check:
      // Electron may fire "destroyed" asynchronously, so a send could race a
      // teardown. Guarding here avoids a native crash inside wc.send.
      if (wc.isDestroyed()) {
        this.teardown(wc);
        continue;
      }
      for (const state of page.proxies.values()) {
        if (!this.deps.bridge.deliversTo(state.peer, route)) continue;
        wc.send(IPC.event, { to: state.id, msg });
      }
    }
  }
}
