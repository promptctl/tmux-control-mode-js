// examples/web-multiplexer/web/components/NavbarResizer.tsx
// A draggable vertical handle sitting on the right edge of the navbar.
// Writes the new width to the UI store while the user drags.

import { useEffect, useRef } from "react";
import type { UiStore } from "../ui-store.ts";

interface Props {
  readonly uiStore: UiStore;
}

export function NavbarResizer({ uiStore }: Props) {
  // [LAW:dataflow-not-control-flow] Window drag-listeners live exactly as long
  // as a drag does — attached on pointer-down, detached on pointer-up — so
  // there are no idle global listeners in any state (collapsed or expanded).
  // The ref holds the active drag's teardown so an unmount mid-drag can't leak
  // listeners. This hook runs unconditionally before the early return below:
  // gating it on `navbarCollapsed` would change the hook count between renders
  // and corrupt React's positional hook state.
  const endDragRef = useRef<(() => void) | null>(null);
  useEffect(() => () => endDragRef.current?.(), []);

  if (uiStore.navbarCollapsed) {
    return null;
  }

  return (
    <div
      onPointerDown={(e) => {
        const startX = e.clientX;
        const startW = uiStore.navbarWidth;
        const onMove = (ev: PointerEvent): void =>
          uiStore.setNavbarWidth(startW + (ev.clientX - startX));
        const end = (): void => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", end);
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
          endDragRef.current = null;
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", end);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        endDragRef.current = end;
      }}
      title="Drag to resize"
      style={{
        position: "absolute",
        top: 0,
        right: -3,
        bottom: 0,
        width: 6,
        cursor: "col-resize",
        zIndex: 100,
      }}
    />
  );
}
