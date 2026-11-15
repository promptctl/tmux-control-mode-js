// tests/helpers/layout.ts
//
// Build tmux layout strings for tests: the body as tmux writes it, prefixed
// with the checksum tmux computes for it (`layout_checksum` in layout-custom.c).

export function layoutString(body: string): string {
  let csum = 0;
  for (let i = 0; i < body.length; i++) {
    csum = ((csum >> 1) + ((csum & 1) << 15) + body.charCodeAt(i)) & 0xffff;
  }
  return `${csum.toString(16).padStart(4, "0")},${body}`;
}

/** Two panes side by side in an 80×24 window: %0 at 0,0 (40 wide), %1 at 41,0. */
export const TWO_PANES = layoutString("80x24,0,0{40x24,0,0,0,39x24,41,0,1}");
/** %0 alone at the whole window, as `#{window_visible_layout}` reads zoomed onto %0. */
export const ZOOMED_0 = layoutString("80x24,0,0,0");
/** Three panes: %0 left, %1 top right, %2 bottom right. */
export const THREE_PANES = layoutString(
  "80x24,0,0{40x24,0,0,0,39x24,41,0[39x12,41,0,1,39x11,41,13,2]}",
);
/** %0 alone. */
export const ONE_PANE = layoutString("80x24,0,0,0");
