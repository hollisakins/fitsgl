/**
 * Region renderer (issue #16) — the WebGL2 side-effect layer for regions. Owns
 * three programs sharing the viewer's oriented view uniforms:
 *   - rect: instanced (one quad, N per-instance rects), fill+stroke+dash in one
 *     fragment (the thousands-of-shutters path);
 *   - polygon fill: one `gl.TRIANGLES` pass over all footprints' triangulations;
 *   - polygon stroke: one pass over all footprints' expanded edge quads.
 *
 * Like `OverlayRenderer`, this is pure GL plumbing — all geometry math lives in the
 * pure modules (`regions`, `region-pack`, `polygon`). Same state contract: it binds
 * its own program/VAO per pass and relies on the viewer's global blend
 * (`SRC_ALPHA, ONE_MINUS_SRC_ALPHA`) with DEPTH_TEST/CULL_FACE off. Regions are
 * drawn before markers (footprints sit under point glyphs).
 */

import { createProgram } from '../renderer/gl-util.js';
import { getViewUniforms, setViewUniforms, type OverlayView, type ViewUniforms } from './overlay-renderer.js';
import { REGION_RECT_VERT } from './shaders/region-rect.vert.js';
import { REGION_RECT_FRAG } from './shaders/region-rect.frag.js';
import { REGION_POLY_FILL_VERT } from './shaders/region-poly-fill.vert.js';
import { REGION_POLY_FILL_FRAG } from './shaders/region-poly-fill.frag.js';
import { REGION_POLY_STROKE_VERT } from './shaders/region-poly-stroke.vert.js';
import { REGION_POLY_STROKE_FRAG } from './shaders/region-poly-stroke.frag.js';
import {
  REGION_INSTANCE_FLOATS,
  REGION_INSTANCE_STRIDE_BYTES,
  R_OFFSET_CENTER,
  R_OFFSET_HALF,
  R_OFFSET_AXISU,
  R_OFFSET_AXISV,
  R_OFFSET_FILL,
  R_OFFSET_STROKE,
  R_OFFSET_STYLE,
} from './region-pack.js';
import {
  FILL_VERTEX_FLOATS,
  FILL_OFFSET_POS,
  FILL_OFFSET_COLOR,
  STROKE_VERTEX_FLOATS,
  STROKE_OFFSET_A,
  STROKE_OFFSET_B,
  STROKE_OFFSET_PARAM,
  STROKE_OFFSET_ARC,
  STROKE_OFFSET_COLOR,
  STROKE_OFFSET_STYLE,
} from './polygon.js';

const QUAD = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
const F = 4; // bytes per float

export class RegionRenderer {
  private readonly gl: WebGL2RenderingContext;

  private readonly rectProgram: WebGLProgram;
  private readonly rectVao: WebGLVertexArrayObject;
  private readonly rectQuad: WebGLBuffer;
  private readonly rectInstances: WebGLBuffer;
  private readonly rectU: ViewUniforms;
  private rectCount = 0;

  private readonly fillProgram: WebGLProgram;
  private readonly fillVao: WebGLVertexArrayObject;
  private readonly fillBuffer: WebGLBuffer;
  private readonly fillU: ViewUniforms;
  private fillCount = 0;

  private readonly strokeProgram: WebGLProgram;
  private readonly strokeVao: WebGLVertexArrayObject;
  private readonly strokeBuffer: WebGLBuffer;
  private readonly strokeU: ViewUniforms;
  private strokeCount = 0;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;

    // ---- rect (instanced) ----
    this.rectProgram = createProgram(gl, REGION_RECT_VERT, REGION_RECT_FRAG);
    this.rectVao = mustVao(gl);
    this.rectQuad = mustBuffer(gl);
    this.rectInstances = mustBuffer(gl);
    gl.bindVertexArray(this.rectVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.rectQuad);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.rectInstances);
    gl.bufferData(gl.ARRAY_BUFFER, 0, gl.DYNAMIC_DRAW);
    const stride = REGION_INSTANCE_STRIDE_BYTES;
    instanceAttrib(gl, 1, 2, stride, R_OFFSET_CENTER);
    instanceAttrib(gl, 2, 2, stride, R_OFFSET_HALF);
    instanceAttrib(gl, 3, 2, stride, R_OFFSET_AXISU);
    instanceAttrib(gl, 4, 2, stride, R_OFFSET_AXISV);
    instanceAttrib(gl, 5, 4, stride, R_OFFSET_FILL);
    instanceAttrib(gl, 6, 4, stride, R_OFFSET_STROKE);
    instanceAttrib(gl, 7, 3, stride, R_OFFSET_STYLE);
    this.rectU = getViewUniforms(gl, this.rectProgram);

    // ---- polygon fill ----
    this.fillProgram = createProgram(gl, REGION_POLY_FILL_VERT, REGION_POLY_FILL_FRAG);
    this.fillVao = mustVao(gl);
    this.fillBuffer = mustBuffer(gl);
    gl.bindVertexArray(this.fillVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fillBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, 0, gl.DYNAMIC_DRAW);
    const fStride = FILL_VERTEX_FLOATS * F;
    vertexAttrib(gl, 0, 2, fStride, FILL_OFFSET_POS);
    vertexAttrib(gl, 1, 4, fStride, FILL_OFFSET_COLOR);
    this.fillU = getViewUniforms(gl, this.fillProgram);

    // ---- polygon stroke ----
    this.strokeProgram = createProgram(gl, REGION_POLY_STROKE_VERT, REGION_POLY_STROKE_FRAG);
    this.strokeVao = mustVao(gl);
    this.strokeBuffer = mustBuffer(gl);
    gl.bindVertexArray(this.strokeVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.strokeBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, 0, gl.DYNAMIC_DRAW);
    const sStride = STROKE_VERTEX_FLOATS * F;
    vertexAttrib(gl, 0, 2, sStride, STROKE_OFFSET_A);
    vertexAttrib(gl, 1, 2, sStride, STROKE_OFFSET_B);
    vertexAttrib(gl, 2, 2, sStride, STROKE_OFFSET_PARAM);
    vertexAttrib(gl, 3, 2, sStride, STROKE_OFFSET_ARC);
    vertexAttrib(gl, 4, 4, sStride, STROKE_OFFSET_COLOR);
    vertexAttrib(gl, 5, 3, sStride, STROKE_OFFSET_STYLE);
    this.strokeU = getViewUniforms(gl, this.strokeProgram);

    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  /** Replace the rect instance buffer (`data` is `count * REGION_INSTANCE_FLOATS`). */
  setRects(data: Float32Array, count: number): void {
    if (data.length !== count * REGION_INSTANCE_FLOATS) {
      throw new Error(`RegionRenderer.setRects: ${data.length} != ${count} * ${REGION_INSTANCE_FLOATS}`);
    }
    this.rectCount = count;
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.rectInstances);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, data, this.gl.DYNAMIC_DRAW);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, null);
  }

  /** Rewrite one rect instance's slice in place (the O(1) restyle path). */
  updateRect(instanceIndex: number, slice: Float32Array): void {
    if (instanceIndex < 0 || instanceIndex >= this.rectCount) return;
    if (slice.length !== REGION_INSTANCE_FLOATS) {
      throw new Error(`RegionRenderer.updateRect: slice ${slice.length} != ${REGION_INSTANCE_FLOATS}`);
    }
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.rectInstances);
    this.gl.bufferSubData(this.gl.ARRAY_BUFFER, instanceIndex * REGION_INSTANCE_STRIDE_BYTES, slice);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, null);
  }

  /** Replace both polygon buffers. Vertex counts are floats.length / stride-floats. */
  setPolygons(fill: Float32Array, stroke: Float32Array): void {
    this.fillCount = Math.floor(fill.length / FILL_VERTEX_FLOATS);
    this.strokeCount = Math.floor(stroke.length / STROKE_VERTEX_FLOATS);
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fillBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, fill, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.strokeBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, stroke, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  /** Draw all regions under the current view: rects, then polygon fills, then strokes. */
  draw(view: OverlayView): void {
    if (this.rectCount === 0 && this.fillCount === 0 && this.strokeCount === 0) return;
    const gl = this.gl;

    if (this.rectCount > 0) {
      gl.useProgram(this.rectProgram);
      setViewUniforms(this.gl, this.rectU, view);
      gl.bindVertexArray(this.rectVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.rectCount);
    }
    if (this.fillCount > 0) {
      gl.useProgram(this.fillProgram);
      setViewUniforms(this.gl, this.fillU, view);
      gl.bindVertexArray(this.fillVao);
      gl.drawArrays(gl.TRIANGLES, 0, this.fillCount);
    }
    if (this.strokeCount > 0) {
      gl.useProgram(this.strokeProgram);
      setViewUniforms(this.gl, this.strokeU, view);
      gl.bindVertexArray(this.strokeVao);
      gl.drawArrays(gl.TRIANGLES, 0, this.strokeCount);
    }
  }

  destroy(): void {
    const gl = this.gl;
    gl.deleteProgram(this.rectProgram);
    gl.deleteProgram(this.fillProgram);
    gl.deleteProgram(this.strokeProgram);
    gl.deleteVertexArray(this.rectVao);
    gl.deleteVertexArray(this.fillVao);
    gl.deleteVertexArray(this.strokeVao);
    gl.deleteBuffer(this.rectQuad);
    gl.deleteBuffer(this.rectInstances);
    gl.deleteBuffer(this.fillBuffer);
    gl.deleteBuffer(this.strokeBuffer);
  }
}

function mustVao(gl: WebGL2RenderingContext): WebGLVertexArrayObject {
  const v = gl.createVertexArray();
  if (v === null) throw new Error('RegionRenderer: createVertexArray returned null');
  return v;
}

function mustBuffer(gl: WebGL2RenderingContext): WebGLBuffer {
  const b = gl.createBuffer();
  if (b === null) throw new Error('RegionRenderer: createBuffer returned null');
  return b;
}

/** A per-instance float attribute (divisor 1) at float offset `off`. */
function instanceAttrib(
  gl: WebGL2RenderingContext,
  loc: number,
  size: number,
  strideBytes: number,
  floatOffset: number,
): void {
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, size, gl.FLOAT, false, strideBytes, floatOffset * F);
  gl.vertexAttribDivisor(loc, 1);
}

/** A per-vertex float attribute (divisor 0) at float offset `off`. */
function vertexAttrib(
  gl: WebGL2RenderingContext,
  loc: number,
  size: number,
  strideBytes: number,
  floatOffset: number,
): void {
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, size, gl.FLOAT, false, strideBytes, floatOffset * F);
  gl.vertexAttribDivisor(loc, 0);
}
