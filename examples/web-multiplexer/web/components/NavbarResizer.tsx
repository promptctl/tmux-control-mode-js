// examples/web-multiplexer/web/components/NavbarResizer.tsx
// A draggable vertical handle sitting on the right edge of the navbar.
// Writes the new width to the UI store while the user drags.

import { useEffect, useRef } from "react";
import type { UiStore } from "../ui-store.ts";

interface Props {
  readonly uiStore: UiStore;
}

export function NavbarResizer({ uiStore }: Props) {
  if (uiStore.navbarCollapsed) {
    return null;
  }

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
