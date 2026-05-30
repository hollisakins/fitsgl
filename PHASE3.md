Build Phase 3 of the FITS mosaic renderer: a WebGL2 viewer with pan,
zoom, and on-the-fly linear stretching. The renderer is compression-
agnostic — it consumes Float32Array tiles from Phase 2b's TilePyramid
regardless of how they were decoded.

## Goal

A standalone WebGL2 viewer that loads tiles from a TilePyramid
(Phase 2b) and renders them to a canvas with mouse pan, scroll zoom,
and adjustable linear stretch (min/max values).

## Project structure

Add to the fits-pyramid package:

  fits-pyramid/
    src/
      renderer/
        index.ts            # public API
        viewer.ts           # main FitsViewer class
        camera.ts           # pure camera math (world<->screen, pan/zoom)
        tile-manager.ts     # tile loading and GPU texture LRU
        gl-util.ts          # shader compile, buffer setup helpers
        shaders/
          tile.vert.ts      # vertex shader as exported string
          tile.frag.ts      # fragment shader as exported string
    test/
      camera.test.ts
      tile-manager.test.ts
  notes/
    phase3.md

## Public API

// src/renderer/index.ts
export class FitsViewer {
  constructor(canvas: HTMLCanvasElement, pyramid: TilePyramid);
  setStretch(min: number, max: number): void;
  setCenter(x: number, y: number): void;
  setZoom(zoom: number): void;
  fitToImage(): void;
  destroy(): void;
}

The viewer attaches its own mouse and wheel handlers in the constructor
and removes them on destroy().

## Coordinate system

"World coordinates" = native-resolution image pixels, (0, 0) at top-left.

Camera state:
- center: {x, y} in world coords
- zoom: screen pixels per world pixel (1.0 = native res)

Tile (level, tile_x, tile_y) covers a world-coord square of
256 * 2^level pixels per side, starting at
(tile_x * 256 * 2^level, tile_y * 256 * 2^level).

Camera math implemented as pure functions in camera.ts for unit testing.

## WebGL setup

- WebGL2 only. Throw clear error if context creation fails.
- R32F internal format for tile textures (core WebGL2; no extension
  required).
- NEAREST filtering for MVP. Note in notes/phase3.md that LINEAR
  would require OES_texture_float_linear; deferred.

## Tile manager logic

Each render frame:

1. Pick target level z such that 2^z ≈ 1 / camera.zoom (one tile pixel
   maps to about one screen pixel). Clamp to [0, n_levels-1].
2. Compute set of (tile_x, tile_y) at level z that intersect viewport.
3. For each visible tile not yet on GPU:
   - Request from pyramid.getTile(z, tile_x, tile_y)
   - On resolution, upload as R32F texture
4. Render visible tiles using bound shader program.
5. While target-level tile is loading, render that region from a
   coarser (higher-z) loaded tile if available — progressive refinement.
6. Tiles not visible for >60 frames are deleted from GPU.

GPU texture budget: 200 tiles (configurable). LRU by last visible frame.

## Fragment shader (GLSL ES 3.00)

  uniform sampler2D u_tile;
  uniform float u_min;
  uniform float u_max;
  in vec2 v_uv;
  out vec4 outColor;

  void main() {
    float v = texture(u_tile, v_uv).r;
    if (isnan(v)) {
      outColor = vec4(0.0, 0.0, 0.0, 0.0);
      return;
    }
    float s = clamp((v - u_min) / (u_max - u_min), 0.0, 1.0);
    outColor = vec4(s, s, s, 1.0);
  }

Linear stretch only. asinh/log deferred.

## Interaction

- Left mouse drag: pan
- Scroll wheel: zoom anchored on cursor's world position
- Zoom limits: out to "whole mosaic visible", in to 16x native

## Tests (Vitest)

camera.test.ts:
- screenToWorld and worldToScreen are inverses
- Zooming centered on a screen point keeps that point's world coord
  fixed
- Panning correctly translates world

tile-manager.test.ts:
- Correct target level at various zoom values
- Correct visible tile set for given viewport
- LRU eviction order correct
- Coarser-level fallback selection works

## Anti-patterns to avoid

- No three.js, regl, twgl, deck.gl, gl-matrix, or any framework.
  Raw WebGL2. ~500 lines in renderer/.
- No RGB compositing this phase. Single band only.
- No RA/Dec coordinate display.
- Simple "load visible, drop invisible" tile heuristics.
- Stretch values are shader uniforms; do not bake into textures.

## Stop and ask if

- WebGL2 isn't available.
- Tile loading produces flicker that the coarse-level fallback
  doesn't fix.

## Notes file

notes/phase3.md: architecture, tile selection math, artifacts,
performance.