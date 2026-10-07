import { Clip, FrameRate, Ticks, Track, TrackKind } from '../core/models';
import { frameDuration, snapToFrame } from '../core/time';

/** Height of a track lane in CSS pixels (keep in sync with timeline.css). */
export const LANE_HEIGHT = 56;
/** Pointer travel (px) before a press on a clip becomes a drag. */
export const DRAG_THRESHOLD = 3;

/** Captured once at pointer-down; no layout reads happen during the drag. */
export interface ClipDragContext {
  clip: Clip;
  clipKind: TrackKind;
  originLane: number;
  originClientX: number;
  originClientY: number;
  /** Viewport Y coordinate of the top of the first lane. */
  lanesTop: number;
  /** Tracks in display order (top → bottom). */
  lanes: Track[];
  pixelsPerTick: number;
  frameRate: FrameRate;
}

export interface ClipDragResult {
  start: Ticks;
  lane: number;
  track: Track;
  /** Visual offset to apply to the clip element. */
  offsetX: number;
  offsetY: number;
  /** Whether the pointer moved far enough to count as a drag. */
  moved: boolean;
  /** Local pre-validation (the Rust core still validates on commit). */
  valid: boolean;
}

export function computeClipDrag(
  ctx: ClipDragContext,
  clientX: number,
  clientY: number,
): ClipDragResult {
  const dx = clientX - ctx.originClientX;
  const dy = clientY - ctx.originClientY;
  const start = Math.max(0, snapToFrame(ctx.clip.start + dx / ctx.pixelsPerTick, ctx.frameRate));
  const lane = clamp(Math.floor((clientY - ctx.lanesTop) / LANE_HEIGHT), 0, ctx.lanes.length - 1);
  const track = ctx.lanes[lane];
  return {
    start,
    lane,
    track,
    offsetX: (start - ctx.clip.start) * ctx.pixelsPerTick,
    offsetY: (lane - ctx.originLane) * LANE_HEIGHT,
    moved: Math.hypot(dx, dy) >= DRAG_THRESHOLD,
    valid: canPlace(track, ctx.clipKind, ctx.clip.id, start, ctx.clip.duration),
  };
}

/** Mirrors the placement rules enforced by `editor_core::ops`. */
export function canPlace(
  track: Track,
  kind: TrackKind,
  clipId: string,
  start: Ticks,
  duration: Ticks,
): boolean {
  if (track.locked || track.kind !== kind || start < 0) {
    return false;
  }
  const end = start + duration;
  return !track.clips.some((c) => c.id !== clipId && start < c.start + c.duration && c.start < end);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Pointer distance (px) within which a trimmed edge snaps to a snap point. */
export const SNAP_DISTANCE = 8;

export type TrimEdge = 'start' | 'end';

/** Captured once at pointer-down on a clip's trim handle. */
export interface ClipTrimContext {
  clip: Clip;
  edge: TrimEdge;
  originClientX: number;
  pixelsPerTick: number;
  frameRate: FrameRate;
  /** Source length, or `null` for still images (which can be stretched freely). */
  sourceDuration: Ticks | null;
  /** Other clips on the same track (the trimmed edge stops at them). */
  neighbours: readonly Clip[];
  /** Times the trimmed edge snaps to (other clip edges, playhead). */
  snapPoints: readonly Ticks[];
}

export interface ClipTrimResult {
  start: Ticks;
  inPoint: Ticks;
  duration: Ticks;
  /** Whether the result differs from the clip. */
  changed: boolean;
  /** Clip element position and width in CSS pixels. */
  left: number;
  width: number;
}

/**
 * Trims the start or the end of a clip by the pointer travel. The edge snaps
 * to frames and nearby snap points, and is clamped so the result is always
 * placeable: at least one frame long, inside the source media (except for
 * images), not before 0 and not overlapping neighbouring clips.
 */
export function computeClipTrim(ctx: ClipTrimContext, clientX: number): ClipTrimResult {
  const { clip, pixelsPerTick } = ctx;
  const end = clip.start + clip.duration;
  const minLength = Math.min(frameDuration(ctx.frameRate), clip.duration);
  const raw =
    (ctx.edge === 'start' ? clip.start : end) + (clientX - ctx.originClientX) / pixelsPerTick;
  const snapped = snapTime(raw, ctx);

  let start = clip.start;
  let duration = clip.duration;
  let inPoint = clip.source.inPoint;
  if (ctx.edge === 'start') {
    const previousEnd = ctx.neighbours
      .filter((c) => c.start + c.duration <= clip.start)
      .reduce((max, c) => Math.max(max, c.start + c.duration), 0);
    const sourceMin = ctx.sourceDuration === null ? 0 : clip.start - clip.source.inPoint;
    start = clamp(snapped, Math.max(previousEnd, sourceMin), end - minLength);
    duration = end - start;
    inPoint = Math.max(0, clip.source.inPoint + start - clip.start);
  } else {
    const nextStart = ctx.neighbours
      .filter((c) => c.start >= end)
      .reduce((min, c) => Math.min(min, c.start), Infinity);
    const sourceMax =
      ctx.sourceDuration === null
        ? Infinity
        : clip.start + ctx.sourceDuration - clip.source.inPoint;
    duration = clamp(snapped, clip.start + minLength, Math.min(nextStart, sourceMax)) - clip.start;
  }
  return {
    start,
    inPoint,
    duration,
    changed: start !== clip.start || duration !== clip.duration || inPoint !== clip.source.inPoint,
    left: start * pixelsPerTick,
    width: Math.max(2, duration * pixelsPerTick),
  };
}

/** Snaps to the nearest snap point within `SNAP_DISTANCE`, else to a frame. */
function snapTime(time: number, ctx: ClipTrimContext): Ticks {
  let best: Ticks | null = null;
  let bestDistance = SNAP_DISTANCE / ctx.pixelsPerTick;
  for (const point of ctx.snapPoints) {
    const distance = Math.abs(point - time);
    if (distance <= bestDistance) {
      best = point;
      bestDistance = distance;
    }
  }
  return best ?? snapToFrame(time, ctx.frameRate);
}
