// examples/web-multiplexer/web/components/NavbarResizer.tsx
// A draggable vertical handle sitting on the right edge of the navbar.
// Writes the new width to the UI store while the user drags.

import { useEffect, useRef } from "react";
import type { UiStore } from "../ui-store.ts";

interface Props {
  readonly uiStore: UiStore;
}

export function NavbarResizer({ uiStore }: Props) {
  // [LAW:dataflow-not-control-flow] Hooks run unconditionally every render —
  // the collapsed/expanded variability lives in the returned value below, not
  // in whether the hooks execute. An early return before these hooks would
  // change the hook count between renders and corrupt React's positional hook
  // state ("Expected static flag was missing").
  const draggingRef = useRef(false);
  const startXRef = useRef(0);
  const startWRef = useRef(0);

  useEffect(() => {
    function onMove(e: PointerEvent): void {
      if (!draggingRef.current) return;
      const dx = e.clientX - startXRef.current;
      uiStore.setNavbarWidth(startWRef.current + dx);
    }
    function onUp(): void {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [uiStore]);

  if (uiStore.navbarCollapsed) {
    return null;
  }

  return (
    <div
      onPointerDown={(e) => {
        draggingRef.current = true;
        startXRef.current = e.clientX;
        startWRef.current = uiStore.navbarWidth;
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
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
