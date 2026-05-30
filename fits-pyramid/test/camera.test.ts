import { describe, it, expect } from 'vitest';
import { Camera } from '../src/renderer/camera.js';

describe('Camera transforms', () => {
  it('worldToScreen and screenToWorld are inverses', () => {
    const cam = new Camera(800, 600, 100, 200, 2.5);
    for (const [wx, wy] of [
      [0, 0],
      [100, 200],
      [37.5, -12.25],
      [1024, 768],
    ]) {
      const s = cam.worldToScreen(wx, wy);
      const back = cam.screenToWorld(s.x, s.y);
      expect(back.x).toBeCloseTo(wx, 9);
      expect(back.y).toBeCloseTo(wy, 9);
    }
  });

  it('screenToWorld and worldToScreen are inverses (round-trip from screen)', () => {
    const cam = new Camera(1280, 720, -50, 33, 0.375);
    for (const [sx, sy] of [
      [0, 0],
      [640, 360],
      [1279, 719],
    ]) {
      const w = cam.screenToWorld(sx, sy);
      const back = cam.worldToScreen(w.x, w.y);
      expect(back.x).toBeCloseTo(sx, 9);
      expect(back.y).toBeCloseTo(sy, 9);
    }
  });

  it('the viewport centre maps to the camera centre', () => {
    const cam = new Camera(800, 600, 123, 456, 3);
    const w = cam.screenToWorld(400, 300);
    expect(w.x).toBeCloseTo(123, 9);
    expect(w.y).toBeCloseTo(456, 9);
  });
});

describe('Camera zoom', () => {
  it('zooming centred on a screen point keeps that point world coord fixed', () => {
    const cam = new Camera(800, 600, 100, 200, 2);
    const sx = 612;
    const sy = 137;
    const before = cam.screenToWorld(sx, sy);
    cam.zoomAt(sx, sy, 7.3);
    const after = cam.screenToWorld(sx, sy);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(cam.zoom).toBeCloseTo(7.3, 9);
  });

  it('zooming out keeps the anchor fixed too', () => {
    const cam = new Camera(1024, 768, 500, 500, 8);
    const sx = 0;
    const sy = 768;
    const before = cam.screenToWorld(sx, sy);
    cam.zoomAt(sx, sy, 0.5);
    const after = cam.screenToWorld(sx, sy);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it('respects zoom limits, still keeping the anchor fixed when clamped', () => {
    const cam = new Camera(800, 600, 100, 200, 1);
    cam.setZoomLimits(0.25, 4);
    const before = cam.screenToWorld(700, 50);
    cam.zoomAt(700, 50, 1000); // way past max
    expect(cam.zoom).toBe(4);
    const after = cam.screenToWorld(700, 50);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it('setZoom clamps to the configured limits', () => {
    const cam = new Camera(800, 600);
    cam.setZoomLimits(0.5, 16);
    cam.setZoom(100);
    expect(cam.zoom).toBe(16);
    cam.setZoom(0.001);
    expect(cam.zoom).toBe(0.5);
  });
});

describe('Camera pan', () => {
  it('panning by a screen delta translates world by delta / zoom', () => {
    const cam = new Camera(800, 600, 100, 200, 4);
    const sx = 250;
    const sy = 410;
    const before = cam.screenToWorld(sx, sy);
    cam.panByScreen(40, 20);
    const after = cam.screenToWorld(sx, sy);
    // Dragging content right by 40 screen px moves the world under the cursor
    // left by 40 / zoom world px.
    expect(after.x).toBeCloseTo(before.x - 40 / 4, 9);
    expect(after.y).toBeCloseTo(before.y - 20 / 4, 9);
  });

  it('worldBounds reflects centre, zoom and viewport', () => {
    const cam = new Camera(800, 600, 100, 200, 2);
    const b = cam.worldBounds();
    // half-extent = (viewport / 2) / zoom
    expect(b.x0).toBeCloseTo(100 - 200, 9);
    expect(b.x1).toBeCloseTo(100 + 200, 9);
    expect(b.y0).toBeCloseTo(200 - 150, 9);
    expect(b.y1).toBeCloseTo(200 + 150, 9);
  });
});
