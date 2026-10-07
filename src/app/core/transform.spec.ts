import { Transform } from './models';
import {
  clipSize,
  fitTransform,
  MIN_LAYER_PX,
  RESIZE_HANDLES,
  resizeLayer,
  sourceSize,
  withSize,
} from './transform';

const identity: Transform = { x: 0, y: 0, scale: 1, scaleX: 1, scaleY: 1, rotation: 0 };
const handle = (name: string) => RESIZE_HANDLES.find((h) => h.name === name)!;

describe('transform helpers', () => {
  const frame = { width: 1920, height: 1080 };
  const square = { width: 1000, height: 1000 };

  it('falls back to the frame size for sources without dimensions', () => {
    expect(sourceSize(undefined, frame)).toEqual(frame);
    expect(clipSize({ ...identity, scale: 0.5, scaleX: 2 }, square)).toEqual({
      width: 1000,
      height: 500,
    });
  });

  it('fits, fills, stretches and restores proportions', () => {
    const moved = { ...identity, x: 100, y: 50, rotation: 15 };
    expect(fitTransform('fit', moved, square, frame)).toEqual({
      ...identity,
      scale: 1.08,
      rotation: 15,
    });
    expect(fitTransform('fill', moved, square, frame)).toEqual({
      ...identity,
      scale: 1.92,
      rotation: 15,
    });
    const stretched = fitTransform('stretch', moved, square, frame);
    expect(stretched).toEqual({ ...identity, scaleX: 1.92, scaleY: 1.08, rotation: 15 });
    expect(clipSize(stretched, square)).toEqual(frame);
    // Original keeps the position and the current width.
    expect(
      fitTransform('original', { ...moved, scale: 0.5, scaleX: 2, scaleY: 0.3 }, square, frame),
    ).toEqual({ ...moved, scale: 1, scaleX: 1, scaleY: 1 });
  });

  it('resizes to an exact size in sequence pixels', () => {
    const t = withSize({ ...identity, scale: 0.5 }, square, 800, 200);
    expect(clipSize(t, square)).toEqual({ width: 800, height: 200 });
  });

  it('keeps proportions on corner handles and anchors the opposite corner', () => {
    const r = resizeLayer(handle('se'), identity, 200, 100, 100, 50, 0.5);
    expect([r.width, r.height]).toEqual([300, 150]);
    expect([r.shiftX, r.shiftY]).toEqual([50, 25]);
    // Screen shift is converted to sequence pixels (÷ 0.5).
    expect(r.transform).toEqual({ ...identity, x: 100, y: 50, scale: 1.5 });
  });

  it('stretches one axis on edge handles and freely on Shift + corner', () => {
    const edge = resizeLayer(handle('w'), identity, 200, 100, -50, 30, 1);
    expect([edge.width, edge.height]).toEqual([250, 100]);
    expect(edge.transform).toEqual({ ...identity, x: -25, scaleX: 1.25 });

    const free = resizeLayer(handle('ne'), identity, 200, 100, 100, 0, 1, true);
    expect([free.width, free.height]).toEqual([300, 100]);
    expect(free.transform.scaleX).toBe(1.5);
    expect(free.transform.scaleY).toBe(1);
  });

  it('follows the layer rotation', () => {
    // Rotated 90°: dragging the right edge handle down widens the layer.
    const r = resizeLayer(handle('e'), { ...identity, rotation: 90 }, 200, 100, 0, 40, 1);
    expect(r.width).toBeCloseTo(240);
    expect(r.shiftX).toBeCloseTo(0);
    expect(r.shiftY).toBeCloseTo(20);
  });

  it('never shrinks below the minimum size', () => {
    const corner = resizeLayer(handle('se'), identity, 200, 100, -1000, -1000, 1);
    expect(corner.height).toBeCloseTo(MIN_LAYER_PX);
    expect(corner.transform.scale).toBeGreaterThan(0);
    const edge = resizeLayer(handle('s'), identity, 200, 100, 0, -1000, 1);
    expect(edge.height).toBe(MIN_LAYER_PX);
  });
});
