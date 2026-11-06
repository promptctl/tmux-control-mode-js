// examples/web-multiplexer/web/mount-root.ts
// [LAW:single-enforcer] The one place every entry point's `#root` precondition
// is checked; each page's index.html must provide the element.

import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";

/** Render `node` into the page's `#root`, failing loudly if it is missing. */
export function mountRoot(node: ReactNode): void {
  const root = document.getElementById("root");
  if (root === null) throw new Error("index.html is missing #root");
  createRoot(root).render(node);
}
