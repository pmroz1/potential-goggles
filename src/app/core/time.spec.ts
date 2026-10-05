import {
  formatTimecode,
  frameDuration,
  secondsToTicks,
  snapToFrame,
  TICKS_PER_SECOND,
} from './time';

describe('time', () => {
  const fps30 = { numerator: 30, denominator: 1 };
  const ntsc = { numerator: 30000, denominator: 1001 };

  it('uses integer frame durations for common rates', () => {
    expect(frameDuration(fps30)).toBe(TICKS_PER_SECOND / 30);
    expect(Number.isInteger(frameDuration(ntsc))).toBe(true);
  });

  it('snaps to the nearest frame', () => {
    const frame = frameDuration(fps30);
    expect(snapToFrame(frame * 2.4, fps30)).toBe(frame * 2);
    expect(snapToFrame(frame * 2.6, fps30)).toBe(frame * 3);
  });

  it('formats timecode', () => {
    expect(formatTimecode(0, fps30)).toBe('00:00:00:00');
    expect(formatTimecode(secondsToTicks(3661) + frameDuration(fps30) * 5, fps30)).toBe(
      '01:01:01:05',
    );
  });
});
