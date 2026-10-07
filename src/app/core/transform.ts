import { MediaSource, Resolution, Transform } from './models';

/** Size of a clip's source in sequence pixels (falls back to the frame size). */
export function sourceSize(source: MediaSource | undefined, frame: Resolution): Resolution {
  return { width: source?.width ?? frame.width, height: source?.height ?? frame.height };
}

/** Displayed size of a clip in sequence pixels. */
export function clipSize(transform: Transform, source: Resolution): Resolution {
  return {
    width: source.width * transform.scale * transform.scaleX,
    height: source.height * transform.scale * transform.scaleY,
  };
}

export type FitMode = 'fit' | 'fill' | 'stretch' | 'original';

/**
 * Positions a clip in the frame: `fit` shows the whole clip (letterboxed),
 * `fill` covers the frame (cropping), `stretch` covers it exactly by changing
 * the proportions and `original` restores the source proportions at the
 * current width. Rotation is kept.
 */
export function fitTransform(
  mode: FitMode,
  current: Transform,
  source: Resolution,
  frame: Resolution,
): Transform {
  const base = { ...current, scaleX: 1, scaleY: 1 };
  const ratioX = frame.width / source.width;
  const ratioY = frame.height / source.height;
  switch (mode) {
    case 'fit':
      return { ...base, x: 0, y: 0, scale: positive(Math.min(ratioX, ratioY)) };
    case 'fill':
      return { ...base, x: 0, y: 0, scale: positive(Math.max(ratioX, ratioY)) };
    case 'stretch':
      return { ...base, x: 0, y: 0, scale: 1, scaleX: positive(ratioX), scaleY: positive(ratioY) };
    case 'original':
      return { ...base, scale: positive(current.scale * current.scaleX) };
  }
}

/** Returns `current` resized to `width` × `height` sequence pixels. */
export function withSize(
  current: Transform,
  source: Resolution,
  width: number,
  height: number,
): Transform {
  return {
    ...current,
    scaleX: positive(width / (source.width * current.scale)),
    scaleY: positive(height / (source.height * current.scale)),
  };
}

/** Resize handle: the edges/corners it moves, as -1 (left/top), 0 or 1 (right/bottom). */
export interface ResizeHandle {
  name: string;
  dx: -1 | 0 | 1;
  dy: -1 | 0 | 1;
}

export const RESIZE_HANDLES: readonly ResizeHandle[] = [
  { name: 'nw', dx: -1, dy: -1 },
  { name: 'n', dx: 0, dy: -1 },
  { name: 'ne', dx: 1, dy: -1 },
  { name: 'e', dx: 1, dy: 0 },
  { name: 'se', dx: 1, dy: 1 },
  { name: 's', dx: 0, dy: 1 },
  { name: 'sw', dx: -1, dy: 1 },
  { name: 'w', dx: -1, dy: 0 },
];

export interface ResizeResult {
  /** New box size in screen pixels. */
  width: number;
  height: number;
  /** Movement of the box centre in screen pixels (keeps the opposite side in place). */
  shiftX: number;
  shiftY: number;
  /** Committed transform (positions converted to sequence pixels). */
  transform: Transform;
}

/** Smallest on-screen size a layer can be resized to. */
export const MIN_LAYER_PX = 8;

/**
 * Resizes a layer box of `width` × `height` screen pixels by dragging `handle`
 * by (`deltaX`, `deltaY`) screen pixels. Corner handles keep the proportions
 * unless `free` is set; edge handles stretch one axis (changing proportions).
 * `pixelScale` converts sequence pixels to screen pixels.
 */
export function resizeLayer(
  handle: ResizeHandle,
  transform: Transform,
  width: number,
  height: number,
  deltaX: number,
  deltaY: number,
  pixelScale: number,
  free = false,
): ResizeResult {
  const angle = (transform.rotation * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // Pointer movement in the layer's own (rotated) axes.
  const localX = cos * deltaX + sin * deltaY;
  const localY = -sin * deltaX + cos * deltaY;
  const corner = handle.dx !== 0 && handle.dy !== 0;

  let newWidth = width;
  let newHeight = height;
  if (corner && !free) {
    const along =
      (handle.dx * localX * width + handle.dy * localY * height) / (width ** 2 + height ** 2);
    const factor = Math.max(MIN_LAYER_PX / Math.min(width, height), 1 + along);
    newWidth = width * factor;
    newHeight = height * factor;
  } else {
    newWidth = Math.max(MIN_LAYER_PX, width + handle.dx * localX);
    newHeight = Math.max(MIN_LAYER_PX, height + handle.dy * localY);
  }

  // Keep the opposite edge/corner fixed: move the centre by half the growth.
  const centreX = (handle.dx * (newWidth - width)) / 2;
  const centreY = (handle.dy * (newHeight - height)) / 2;
  const shiftX = cos * centreX - sin * centreY;
  const shiftY = sin * centreX + cos * centreY;

  const uniform = corner && !free;
  const factor = newWidth / width;
  return {
    width: newWidth,
    height: newHeight,
    shiftX,
    shiftY,
    transform: {
      ...transform,
      x: Math.round((transform.x + shiftX / pixelScale) * 100) / 100,
      y: Math.round((transform.y + shiftY / pixelScale) * 100) / 100,
      scale: uniform ? positive(transform.scale * factor) : transform.scale,
      scaleX: uniform ? transform.scaleX : positive(transform.scaleX * (newWidth / width)),
      scaleY: uniform ? transform.scaleY : positive(transform.scaleY * (newHeight / height)),
    },
  };
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** Rounds a scale factor, never reaching zero (the core rejects non-positive scales). */
function positive(value: number): number {
  return Math.max(0.0001, round(value));
}
