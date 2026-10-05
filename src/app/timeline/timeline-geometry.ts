import { Clip, FrameRate, Ticks, Track, TrackKind } from '../core/models';
import { snapToFrame } from '../core/time';

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
