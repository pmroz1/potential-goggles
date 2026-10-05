import { FrameScheduler, startPointerDrag } from './pointer-drag';

function pointer(type: string, clientX: number, clientY: number, pointerId = 1): PointerEvent {
  return new PointerEvent(type, { bubbles: true, clientX, clientY, pointerId });
}

describe('startPointerDrag', () => {
  let queued: (() => void)[];
  const scheduler: FrameScheduler = {
    request: (cb) => queued.push(cb),
    cancel: (handle) => (queued[handle - 1] = () => undefined),
  };

  beforeEach(() => (queued = []));

  it('coalesces pointer moves into one update per frame and ends once', () => {
    const el = document.createElement('div');
    const frames: [number, number][] = [];
    const ends: [number, number, boolean][] = [];
    startPointerDrag(
      pointer('pointerdown', 0, 0),
      el,
      {
        onFrame: (x, y) => frames.push([x, y]),
        onEnd: (x, y, cancelled) => ends.push([x, y, cancelled]),
      },
      scheduler,
    );

    for (let i = 1; i <= 10; i++) {
      el.dispatchEvent(pointer('pointermove', i, i));
    }
    expect(queued.length).toBe(1);
    queued.shift()!();
    expect(frames).toEqual([[10, 10]]);

    el.dispatchEvent(pointer('pointermove', 20, 5));
    el.dispatchEvent(pointer('pointerup', 25, 6));
    el.dispatchEvent(pointer('pointerup', 30, 6));
    el.dispatchEvent(pointer('pointermove', 40, 6));
    expect(ends).toEqual([[25, 6, false]]);
    expect(frames.length).toBe(1);
  });

  it('ignores other pointers and reports cancellation', () => {
    const el = document.createElement('div');
    const ends: boolean[] = [];
    startPointerDrag(
      pointer('pointerdown', 0, 0),
      el,
      {
        onFrame: () => undefined,
        onEnd: (_x, _y, cancelled) => ends.push(cancelled),
      },
      scheduler,
    );
    el.dispatchEvent(pointer('pointerup', 5, 5, 2));
    expect(ends).toEqual([]);
    el.dispatchEvent(pointer('pointercancel', 5, 5));
    expect(ends).toEqual([true]);
  });
});
