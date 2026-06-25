// examples/web-multiplexer/web/webgl-grid-renderer.ts
//
// The GL effect boundary: a WebGL2 renderer that paints a whole frame of
// terminal cells — across many panes — in ONE instanced draw against a shared
// glyph atlas. All arithmetic (atlas layout, cell packing) lives in the pure
// webgl-atlas-engine; this module does only what must touch the GPU: compile
// shaders, rasterize the atlas once, upload the per-frame instance buffer, draw.
// [LAW:effects-at-boundaries] [LAW:single-enforcer] the sole owner of GL state.
//
// A missing WebGL2 context is a represented failure: the constructor throws and
// the view surfaces it — never a silent fall back to a slower canvas2d path
// that would quietly invalidate the throughput numbers. [LAW:no-silent-failure]

import {
  ATLAS_CHARS,
  INSTANCE_STRIDE,
  buildAtlasLayout,
  packFrame,
  type AtlasLayout,
  type RGB,
  type Tile,
} from "./webgl-atlas-engine.ts";

const VERT_SRC = `#version 300 es
layout(location=0) in vec2 aCorner;
layout(location=1) in vec2 aPos;
layout(location=2) in vec2 aGlyph;
layout(location=3) in vec3 aFg;
layout(location=4) in vec3 aBg;
uniform vec2 uResolution;
uniform vec2 uCellPx;
uniform vec2 uGlyphUV;
out vec2 vUv;
out vec3 vFg;
out vec3 vBg;
void main() {
  vec2 px = aPos + aCorner * uCellPx;
  vec2 clip = (px / uResolution) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  vUv = aGlyph + aCorner * uGlyphUV;
  vFg = aFg;
  vBg = aBg;
}`;

const FRAG_SRC = `#version 300 es
precision mediump float;
in vec2 vUv;
in vec3 vFg;
in vec3 vBg;
uniform sampler2D uAtlas;
out vec4 outColor;
void main() {
  float a = texture(uAtlas, vUv).a;
  outColor = vec4(mix(vBg, vFg, a), 1.0);
}`;

const FONT_FAMILY = '"JetBrains Mono", Menlo, Consolas, monospace';

export interface WebGLGridRendererOptions {
  readonly cellPxW?: number;
  readonly cellPxH?: number;
  readonly fg?: RGB;
  readonly bg?: RGB;
}

/** What one `draw` actually pushed — fed to the FPS/throughput HUD. */
export interface DrawStats {
  readonly cellCount: number;
  readonly drawCalls: number;
}

export class WebGLGridRenderer {
  readonly cellPxW: number;
  readonly cellPxH: number;

  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly instanceBuffer: WebGLBuffer;
  private readonly atlas: AtlasLayout;
  private readonly fg: RGB;
  private readonly bg: RGB;
  private readonly uResolution: WebGLUniformLocation;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement, opts: WebGLGridRendererOptions = {}) {
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: false,
    });
    if (gl === null) {
      throw new Error("WebGL2 is not available in this browser/context.");
    }
    this.gl = gl;
    this.cellPxW = opts.cellPxW ?? 9;
    this.cellPxH = opts.cellPxH ?? 18;
    this.fg = opts.fg ?? [0.86, 0.86, 0.86];
    this.bg = opts.bg ?? [0.04, 0.05, 0.07];

    this.program = linkProgram(gl, VERT_SRC, FRAG_SRC);
    this.atlas = buildAtlasLayout(ATLAS_CHARS, this.cellPxW, this.cellPxH);

    const atlasTex = rasterizeAtlas(gl, this.atlas);
    gl.useProgram(this.program);
    gl.uniform1i(uniform(gl, this.program, "uAtlas"), 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, atlasTex);
    gl.uniform2f(uniform(gl, this.program, "uCellPx"), this.cellPxW, this.cellPxH);
    gl.uniform2f(
      uniform(gl, this.program, "uGlyphUV"),
      this.atlas.glyphUvW,
      this.atlas.glyphUvH,
    );
    this.uResolution = uniform(gl, this.program, "uResolution");

    const vao = gl.createVertexArray();
    if (vao === null) throw new Error("Failed to allocate a vertex array.");
    this.vao = vao;
    gl.bindVertexArray(this.vao);

    // Static unit quad (TRIANGLE_STRIP), per-vertex corner, divisor 0.
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // Per-instance interleaved buffer, divisor 1.
    this.instanceBuffer = mustBuffer(gl);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    const stride = INSTANCE_STRIDE * 4;
    const f = Float32Array.BYTES_PER_ELEMENT;
    bindInstanceAttr(gl, 1, 2, stride, 0 * f);
    bindInstanceAttr(gl, 2, 2, stride, 2 * f);
    bindInstanceAttr(gl, 3, 3, stride, 4 * f);
    bindInstanceAttr(gl, 4, 3, stride, 7 * f);
    gl.bindVertexArray(null);
  }

  /** Set the drawing-buffer size (device pixels) and GL viewport. */
  resize(deviceWidth: number, deviceHeight: number): void {
    const gl = this.gl;
    gl.canvas.width = Math.max(1, Math.floor(deviceWidth));
    gl.canvas.height = Math.max(1, Math.floor(deviceHeight));
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.useProgram(this.program);
    gl.uniform2f(this.uResolution, gl.canvas.width, gl.canvas.height);
  }

  /** Pack every tile's cells and paint them in one instanced draw. */
  draw(tiles: readonly Tile[]): DrawStats {
    const gl = this.gl;
    gl.clearColor(this.bg[0], this.bg[1], this.bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (this.disposed || tiles.length === 0) {
      return { cellCount: 0, drawCalls: 0 };
    }
    const packed = packFrame(
      tiles,
      this.atlas,
      this.cellPxW,
      this.cellPxH,
      this.fg,
      this.bg,
    );
    if (packed.cellCount === 0) return { cellCount: 0, drawCalls: 0 };

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, packed.data, gl.DYNAMIC_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, packed.cellCount);
    gl.bindVertexArray(null);
    return { cellCount: packed.cellCount, drawCalls: 1 };
  }

  dispose(): void {
    this.disposed = true;
  }
}

// --- GL helpers (kept local; this is the only GL in the demo) ---------------

function mustBuffer(gl: WebGL2RenderingContext): WebGLBuffer {
  const b = gl.createBuffer();
  if (b === null) throw new Error("Failed to allocate a WebGL buffer.");
  return b;
}

function bindInstanceAttr(
  gl: WebGL2RenderingContext,
  loc: number,
  size: number,
  stride: number,
  offset: number,
): void {
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
  gl.vertexAttribDivisor(loc, 1);
}

function uniform(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  name: string,
): WebGLUniformLocation {
  const loc = gl.getUniformLocation(program, name);
  if (loc === null) throw new Error(`Uniform '${name}' not found in program.`);
  return loc;
}

function compile(
  gl: WebGL2RenderingContext,
  type: number,
  src: string,
): WebGLShader {
  const sh = gl.createShader(type);
  if (sh === null) throw new Error("Failed to create a WebGL shader.");
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    throw new Error(`Shader compile failed: ${log ?? "unknown"}`);
  }
  return sh;
}

function linkProgram(
  gl: WebGL2RenderingContext,
  vert: string,
  frag: string,
): WebGLProgram {
  const program = gl.createProgram();
  if (program === null) throw new Error("Failed to create a WebGL program.");
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vert));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, frag));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    throw new Error(`Program link failed: ${log ?? "unknown"}`);
  }
  return program;
}

/** Draw the glyph set into a 2D canvas in the SAME index order the atlas layout
 *  assigns, then upload it as the shared texture. The layout's `uvFor` and this
 *  raster are one source of truth for where each glyph lives. */
function rasterizeAtlas(
  gl: WebGL2RenderingContext,
  atlas: AtlasLayout,
): WebGLTexture {
  const canvas = document.createElement("canvas");
  canvas.width = atlas.widthPx;
  canvas.height = atlas.heightPx;
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("Failed to get a 2D context for the atlas.");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "top";
  ctx.font = `${Math.floor(atlas.cellPxH * 0.82)}px ${FONT_FAMILY}`;
  for (let i = 0; i < atlas.chars.length; i += 1) {
    const gx = i % atlas.gridCols;
    const gy = Math.floor(i / atlas.gridCols);
    ctx.fillText(
      atlas.chars[i],
      gx * atlas.cellPxW + 1,
      gy * atlas.cellPxH + 1,
    );
  }
  const tex = gl.createTexture();
  if (tex === null) throw new Error("Failed to allocate the atlas texture.");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    canvas,
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}
