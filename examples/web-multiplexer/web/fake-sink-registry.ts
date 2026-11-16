// examples/web-multiplexer/web/fake-sink-registry.ts
//
// Test double for the sink registry (`attachBytesSink`): it records each
// sink attached to it, with its options, so a test can write chunks into
// the sink and see whether it was detached.

import type {
  AttachOptions,
  BytesSink,
  TmuxConnection,
} from "@promptctl/tmux-control-mode-js/browser";

export interface AttachedSink {
  readonly sink: BytesSink;
  readonly options: AttachOptions | undefined;
  detached: boolean;
}

export function fakeSinkRegistry(): {
  registry: Pick<TmuxConnection, "attachBytesSink">;
  attached: AttachedSink[];
} {
  const attached: AttachedSink[] = [];
  return {
    attached,
    registry: {
      attachBytesSink(sink, options) {
        const entry: AttachedSink = { sink, options, detached: false };
        attached.push(entry);
        return () => {
          entry.detached = true;
        };
      },
    },
  };
}
