import { Track } from '../core/models';
import { secondsToTicks, TICKS_PER_SECOND } from '../core/time';
import { fixtureProject } from '../testing/fake-editor-backend';
import { canPlace, ClipDragContext, computeClipDrag, LANE_HEIGHT } from './timeline-geometry';

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
});
