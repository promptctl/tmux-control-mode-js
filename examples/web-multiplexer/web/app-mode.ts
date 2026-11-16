// examples/web-multiplexer/web/app-mode.ts
//
// The showcase's app modes: which view fills the main area, and the label
// the header's mode control shows for it.
//
// [LAW:one-source-of-truth] This table is the only list of modes. The
//   `AppMode` type is derived from it, the header control renders it, and
//   `parseAppMode` reads it — adding a mode is one row here.

export const APP_MODES = [
  { value: "multiplexer", label: "Multiplexer" },
  { value: "console", label: "Console" },
  { value: "inspector", label: "Protocol Inspector" },
  { value: "heatmap", label: "Activity Heatmap" },
  { value: "search", label: "Scrollback Search" },
  { value: "regex", label: "Regex Matcher" },
  { value: "image", label: "Image Extractor" },
  { value: "playground", label: "Escape Playground" },
  { value: "record", label: "Session Recorder" },
  { value: "attribution", label: "Byte Attribution" },
  { value: "timemachine", label: "Time Machine" },
  { value: "momentdiff", label: "Moment Diff" },
  { value: "bisect", label: "Bug Bisect" },
  { value: "broadcast", label: "Smart Broadcast" },
  { value: "syncscroll", label: "Sync Scrollback" },
  { value: "mirror", label: "Pane Mirror" },
  { value: "collaborate", label: "Collaborative Pane" },
  { value: "sniffer", label: "Data Sniffer" },
  { value: "hyperlinks", label: "Hyperlink Sidebar" },
  { value: "commands", label: "Command Palette" },
  { value: "copilot", label: "AI Co-pilot" },
  { value: "reader", label: "Terminal Reader" },
  { value: "webgl", label: "WebGL Grid" },
  { value: "tutorial", label: "Protocol Tutorial" },
  { value: "conformance", label: "Conformance" },
] as const;

export type AppMode = (typeof APP_MODES)[number]["value"];

/**
 * The mode a string names, or `null` when it names none.
 * [LAW:parse-dont-validate] The result is an `AppMode`, so nothing past this
 * point asks again; each caller decides what an unknown name means to it.
 */
export function parseAppMode(v: string): AppMode | null {
  return APP_MODES.find((m) => m.value === v)?.value ?? null;
}
