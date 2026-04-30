// src/terminal/index.ts
// Public API for the `./terminal` subpath export.
// [LAW:one-source-of-truth] Consumer-facing exports declared here only.

export { measureCell, pixelsToGrid, gridToPixels } from "./dimensions.js";
export type {
  FontSpec,
  CellMetrics,
  PixelSize,
  GridSize,
} from "./dimensions.js";
