/**
 * Overlay renderer (M3) — the thin WebGL2 side-effect layer for markers. Owns a
 * dedicated program, an instanced VAO, a dynamic instance buffer, and a static
 * `[-1,1]` quad buffer. All math is in the pure modules (`markers`, `pack`,
 * `view-transform`); this file is just GL plumbing, mirroring `gl-util.ts` style.
 *
 * State contract with the viewer's tile pass: the marker pass runs after the tile
 * loop in the same frame. It binds its own program + VAO (it assumes nothing was
 * cleaned up) and leaves them bound; the next frame's tile pass re-binds the tile
 * program/VAO at the top of `draw`, so no explicit unbind is needed. It depends
 * on the viewer's global blend state (`SRC_ALPHA, ONE_MINUS_SRC_ALPHA`) and on
 * DEPTH_TEST/CULL_FACE staying off — markers paint over tiles in submission order.
 */

import { createProgram } from '../renderer/gl-util.js';
import type { Mat2 } from '../renderer/view-transform.js';
import { MARKER_VERT } from './shaders/marker.vert.js';
import { MARKER_FRAG } from './shaders/marker.frag.js';
import { INSTANCE_FLOATS, INSTANCE_STRIDE_BYTES, OFFSET_CENTER, OFFSET_STYLE, OFFSET_COLOR } from './pack.js';

/** Per-frame view state the marker shader needs (the viewer supplies it). */
export interface OverlayView {
  centerX: number;
  centerY: number;
  zoom: number;
  viewportWidth: number;
  viewportHeight: number;
  /** Row-major orientation `[m00, m01, m10, m11]` (the viewer's `currentOrientation`). */
  orient: Mat2;
  /** devicePixelRatio: CSS-px sizes -> buffer px in the shader. */
  pixelRatio: number;
}

const QUAD = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
const BYTES_PER_FLOAT = 4;

export class OverlayRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly quadBuffer: WebGLBuffer;
  private readonly instanceBuffer: WebGLBuffer;
  private count = 0;

  private readonly uCenter: WebGLUniformLocation | null;
  private readonly uZoom: WebGLUniformLocation | null;
  private readonly uViewport: WebGLUniformLocation | null;
  private readonly uOrient: WebGLUniformLocation | null;
  private readonly uPixelRatio: WebGLUniformLocation | null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = createProgram(gl, MARKER_VERT, MARKER_FRAG);

    const vao = gl.createVertexArray();
    if (vao === null) throw new Error('OverlayRenderer: createVertexArray returned null');
    this.vao = vao;
    const quadBuffer = gl.createBuffer();
    const instanceBuffer = gl.createBuffer();
    if (quadBuffer === null || instanceBuffer === null) {
      throw new Error('OverlayRenderer: createBuffer returned null');
    }
    this.quadBuffer = quadBuffer;
    this.instanceBuffer = instanceBuffer;

    gl.bindVertexArray(vao);

    // location 0: the static [-1,1] quad, one vertex per quad corner (divisor 0).
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(0, 0);

    // locations 1..3: interleaved per-instance data (divisor 1). Offsets must
    // match pack.ts (the byte-layout source of truth, pinned by pack.test.ts).
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, 0, gl.DYNAMIC_DRAW); // allocate empty; sized on setInstances
    const stride = INSTANCE_STRIDE_BYTES;
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, OFFSET_CENTER * BYTES_PER_FLOAT);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, stride, OFFSET_STYLE * BYTES_PER_FLOAT);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, OFFSET_COLOR * BYTES_PER_FLOAT);
    gl.vertexAttribDivisor(3, 1);

    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    this.uCenter = gl.getUniformLocation(this.program, 'u_center');
    this.uZoom = gl.getUniformLocation(this.program, 'u_zoom');
    this.uViewport = gl.getUniformLocation(this.program, 'u_viewport');
    this.uOrient = gl.getUniformLocation(this.program, 'u_orient');
    this.uPixelRatio = gl.getUniformLocation(this.program, 'u_pixelRatio');
  }

  /** Replace the whole instance buffer (add/remove/replace). `data` is `count*9` floats. */
  setInstances(data: Float32Array, count: number): void {
    if (data.length !== count * INSTANCE_FLOATS) {
      throw new Error(
        `OverlayRenderer.setInstances: data length ${data.length} != ${count} * ${INSTANCE_FLOATS}`,
      );
    }
    this.count = count;
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.instanceBuffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, data, this.gl.DYNAMIC_DRAW);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, null);
  }

  /** Rewrite one instance's 9-float slice in place (the O(1) restyle path). */
  updateInstance(index: number, slice: Float32Array): void {
    if (index < 0 || index >= this.count) return;
    if (slice.length !== INSTANCE_FLOATS) {
      throw new Error(`OverlayRenderer.updateInstance: slice length ${slice.length} != ${INSTANCE_FLOATS}`);
    }
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.instanceBuffer);
    this.gl.bufferSubData(this.gl.ARRAY_BUFFER, index * INSTANCE_STRIDE_BYTES, slice);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, null);
  }

  /** Draw all markers under the current view. A no-op when empty. */
  draw(view: OverlayView): void {
    if (this.count === 0) return;
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.uniform2f(this.uCenter, view.centerX, view.centerY);
    gl.uniform1f(this.uZoom, view.zoom);
    gl.uniform2f(this.uViewport, view.viewportWidth, view.viewportHeight);
    gl.uniform4f(this.uOrient, view.orient[0], view.orient[1], view.orient[2], view.orient[3]);
    gl.uniform1f(this.uPixelRatio, view.pixelRatio);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
  }

  destroy(): void {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
    // deleteVertexArray does not free the buffers bound to it.
    gl.deleteBuffer(this.quadBuffer);
    gl.deleteBuffer(this.instanceBuffer);
  }
}
