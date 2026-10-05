import { FrameRate, Ticks } from './models';

/** Must match `editor_core::TICKS_PER_SECOND`. */
export const TICKS_PER_SECOND = 705_600_000;

export function secondsToTicks(seconds: number): Ticks {
  return Math.round(seconds * TICKS_PER_SECOND);
}

export function frameDuration(rate: FrameRate): Ticks {
  return (TICKS_PER_SECOND * rate.denominator) / rate.numerator;
}

/** Rounds to the nearest frame boundary. */
export function snapToFrame(time: number, rate: FrameRate): Ticks {
  const frame = frameDuration(rate);
  return Math.round(Math.round(time / frame) * frame);
}

/** `HH:MM:SS:FF` timecode (non-drop-frame). */
export function formatTimecode(time: Ticks, rate: FrameRate): string {
  const fps = Math.round(rate.numerator / rate.denominator);
  const totalFrames = Math.floor(time / frameDuration(rate) + 1e-9);
  const frames = totalFrames % fps;
  const totalSeconds = Math.floor(totalFrames / fps);
  const pad = (n: number) => String(n).padStart(2, '0');
  return [
    Math.floor(totalSeconds / 3600),
    Math.floor(totalSeconds / 60) % 60,
    totalSeconds % 60,
    frames,
  ]
    .map(pad)
    .join(':');
}
