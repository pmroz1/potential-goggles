import { Track } from '../core/models';
import { secondsToTicks, TICKS_PER_SECOND } from '../core/time';
import { fixtureProject } from '../testing/fake-editor-backend';
import {
  canPlace,
  ClipDragContext,
  ClipTrimContext,
  computeClipDrag,
  computeClipTrim,
  LANE_HEIGHT,
} from './timeline-geometry';

describe('timeline geometry', () => {
  const sequence = fixtureProject().sequences[0];
  const [a1, v1, v2] = sequence.tracks;
  const lanes: Track[] = [v2, v1, a1];
  const clipB = v1.clips[1];

  const ctx: ClipDragContext = {
    clip: clipB,
    clipKind: 'video',
    originLane: 1,
    originClientX: 500,
    originClientY: 100 + LANE_HEIGHT * 1.5,
    lanesTop: 100,
    lanes,
    pixelsPerTick: 100 / TICKS_PER_SECOND,
    frameRate: sequence.frameRate,
  };

  it('treats tiny movements as a click', () => {
    const result = computeClipDrag(ctx, 501, ctx.originClientY + 1);
    expect(result.moved).toBe(false);
    expect(result.start).toBe(clipB.start);
  });

  it('snaps horizontal movement to frames and computes the visual offset', () => {
    const result = computeClipDrag(ctx, 500 + 251.3, ctx.originClientY);
    // 2.513 s → nearest frame at 30 fps is 2.5 s (75 frames)
    expect(result.start).toBe(clipB.start + secondsToTicks(2.5));
    expect(result.offsetX).toBeCloseTo(250);
    expect(result.track).toBe(v1);
    expect(result.valid).toBe(true);
  });

  it('maps vertical movement to lanes and clamps to the timeline start', () => {
    const result = computeClipDrag(ctx, -10_000, 100 + 5);
    expect(result.start).toBe(0);
    expect(result.lane).toBe(0);
    expect(result.track).toBe(v2);
    expect(result.offsetY).toBe(-LANE_HEIGHT);
    expect(result.valid).toBe(false); // overlaps the logo on V2
  });

  it('pre-validates kind, lock and overlap', () => {
    expect(canPlace(a1, 'video', 'x', 0, secondsToTicks(1))).toBe(false);
    expect(canPlace({ ...v2, locked: true }, 'video', 'x', secondsToTicks(30), 1)).toBe(false);
    expect(canPlace(v1, 'video', clipB.id, clipB.start + 1, clipB.duration)).toBe(true);
    expect(canPlace(v1, 'video', clipB.id, clipB.start - 1, clipB.duration)).toBe(false);
  });

  describe('trim', () => {
    const s = secondsToTicks;
    // 100 px per second.
    const trim = (clip: typeof clipB, edge: 'start' | 'end', sourceDuration: number | null) =>
      ({
        clip,
        edge,
        originClientX: 500,
        pixelsPerTick: 100 / TICKS_PER_SECOND,
        frameRate: sequence.frameRate,
        sourceDuration,
        neighbours: sequence.tracks
          .find((t) => t.clips.includes(clip))!
          .clips.filter((c) => c !== clip),
        snapPoints: [],
      }) satisfies ClipTrimContext;

    it('shortens the end and keeps the start and in point', () => {
      const result = computeClipTrim(trim(clipB, 'end', s(120)), 500 - 200);
      expect(result).toMatchObject({ start: s(8), inPoint: s(40), duration: s(4), changed: true });
      expect(result.width).toBeCloseTo(400);
    });

    it('trims the start, moving the in point with it', () => {
      const result = computeClipTrim(trim(clipB, 'start', s(120)), 500 + 150);
      expect(result).toMatchObject({ start: s(9.5), inPoint: s(41.5), duration: s(4.5) });
      expect(result.left).toBeCloseTo(950);
    });

    it('stops at neighbouring clips and the end of the source', () => {
      // Clip A ends at 8 s where clip B starts.
      expect(computeClipTrim(trim(clipB, 'start', s(120)), 0).start).toBe(s(8));
      // B: in 40 s of a 45 s source can grow to 5 s at most.
      expect(computeClipTrim(trim(clipB, 'end', s(45)), 5000).duration).toBe(s(5));
      // Never shorter than one frame.
      expect(computeClipTrim(trim(clipB, 'end', s(120)), -5000).duration).toBe(s(1 / 30));
      expect(computeClipTrim(trim(clipB, 'end', s(120)), 500).changed).toBe(false);
    });

    it('stretches images freely and snaps to nearby edges', () => {
      const logo = v2.clips[0];
      const ctx = { ...trim(logo, 'end', null), snapPoints: [s(30)] };
      expect(computeClipTrim(ctx, 500 + 10_000).duration).toBe(s(112));
      // 29.95 s is within the snap distance of 30 s.
      expect(computeClipTrim(ctx, 500 + 1595).duration).toBe(s(28));
      const start = computeClipTrim(trim(logo, 'start', null), 0);
      expect(start).toMatchObject({ start: 0, inPoint: 0, duration: s(14) });
    });
  });
});
