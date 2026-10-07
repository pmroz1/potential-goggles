import { TestBed } from '@angular/core/testing';

import { App } from './app';
import { EditorBackend } from './core/editor-backend';
import { secondsToTicks } from './core/time';
import { FakeEditorBackend } from './testing/fake-editor-backend';
import { LANE_HEIGHT } from './timeline/timeline-geometry';

function pointer(type: string, clientX: number, clientY: number): PointerEvent {
  return new PointerEvent(type, { bubbles: true, button: 0, clientX, clientY, pointerId: 1 });
}

describe('App', () => {
  let backend: FakeEditorBackend;
  let frames: FrameRequestCallback[];

  beforeEach(async () => {
    frames = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    backend = new FakeEditorBackend();
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [{ provide: EditorBackend, useValue: backend }],
    }).compileComponents();
  });

  afterEach(() => vi.unstubAllGlobals());

  async function render() {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  it('renders sequences, tracks in z-order and clips', async () => {
    const { el } = await render();
    const tabs = [...el.querySelectorAll('.tab')].map((t) => t.textContent?.trim());
    expect(tabs).toEqual(['Main Edit', 'Social Cut', '+']);
    const headers = [...el.querySelectorAll('.track-name')].map((t) => t.textContent);
    expect(headers).toEqual(['V2', 'V1', 'A1']);
    expect(el.querySelectorAll('.clip').length).toBe(3);
  });

  it('composites viewport layers bottom → top by track z-index', async () => {
    const { fixture, el } = await render();
    const store = fixture.componentInstance['store'];
    store.setPlayhead(secondsToTicks(3));
    await fixture.whenStable();
    const layers = [...el.querySelectorAll<HTMLElement>('.layer')];
    expect(layers.map((l) => l.querySelector('.layer-name')?.textContent)).toEqual([
      'Interview A',
      'Logo',
    ]);
    expect(layers.map((l) => l.style.zIndex)).toEqual(['1', '2']);
  });

  it('drags a clip locally and commits exactly one move on release', async () => {
    const { fixture, el } = await render();
    const clip = el.querySelector<HTMLElement>('[data-clip-id="clip-b"]')!;
    // jsdom has no layout: lanes start at y = 0. V1 is the second lane.
    const y = LANE_HEIGHT * 1.5;
    clip.dispatchEvent(pointer('pointerdown', 100, y));
    for (let x = 110; x <= 260; x += 10) {
      clip.dispatchEvent(pointer('pointermove', x, y));
    }
    // Moves are coalesced into animation frames; no backend calls during the drag.
    frames.splice(0).forEach((frame) => frame(0));
    expect(clip.style.translate).toBe('160px 0px');
    expect(clip.classList.contains('dragging')).toBe(true);
    expect(backend.calls).toEqual([]);

    clip.dispatchEvent(pointer('pointerup', 260, y));
    await fixture.whenStable();
    // 160 px at the default 80 px/s is 2 s.
    expect(backend.calls).toEqual([
      {
        method: 'apply',
        op: {
          type: 'moveClip',
          sequenceId: 'seq-main',
          clipId: 'clip-b',
          trackId: 'v1',
          start: secondsToTicks(10),
        },
      },
    ]);
    const moved = el.querySelector<HTMLElement>('[data-clip-id="clip-b"]')!;
    expect(moved.style.left).toBe('800px');
    expect(moved.style.translate).toBe('');
  });

  it('trims a clip edge locally and commits exactly one trim on release', async () => {
    const { fixture, el } = await render();
    const clip = el.querySelector<HTMLElement>('[data-clip-id="logo"]')!;
    const handle = clip.querySelector<HTMLElement>('.trim-handle.end')!;
    handle.dispatchEvent(pointer('pointerdown', 1120, 10));
    handle.dispatchEvent(pointer('pointermove', 1280, 10));
    frames.splice(0).forEach((frame) => frame(0));
    // The image is stretched visually; nothing is committed during the drag.
    expect(clip.style.width).toBe('1120px');
    expect(clip.classList.contains('trimming')).toBe(true);
    expect(backend.calls).toEqual([]);

    handle.dispatchEvent(pointer('pointerup', 1440, 10));
    await fixture.whenStable();
    // +320 px at 80 px/s stretches the 12 s logo to 16 s.
    expect(backend.calls).toEqual([
      {
        method: 'apply',
        op: {
          type: 'trimClip',
          sequenceId: 'seq-main',
          clipId: 'logo',
          start: secondsToTicks(2),
          inPoint: 0,
          duration: secondsToTicks(16),
        },
      },
    ]);
    expect(el.querySelector<HTMLElement>('[data-clip-id="logo"]')!.style.width).toBe('1280px');
  });

  it('splits clips at the playhead with the S key', async () => {
    const { fixture, el } = await render();
    fixture.componentInstance['store'].setPlayhead(secondsToTicks(4));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', bubbles: true }));
    await fixture.whenStable();
    expect(backend.calls).toEqual([
      {
        method: 'apply',
        op: {
          type: 'splitClips',
          sequenceId: 'seq-main',
          clipIds: ['clip-a', 'logo'],
          at: secondsToTicks(4),
        },
      },
    ]);
    expect(el.querySelectorAll('.clip').length).toBe(5);
  });

  it('copies and pastes the selection via keyboard shortcuts', async () => {
    const { fixture, el } = await render();
    el.querySelector<HTMLElement>('[data-clip-id="logo"]')!.dispatchEvent(
      pointer('pointerdown', 0, 0),
    );
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true }));
    await fixture.whenStable();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true }));
    await fixture.whenStable();
    expect(backend.calls.map((c) => c.method)).toEqual(['copyClips', 'pasteClips']);
    expect(el.querySelector('.status')?.textContent).toContain('Clipboard: 1 clip');
    const pasted = el.querySelector<HTMLElement>('[data-clip-id="pasted-1"]');
    expect(pasted).not.toBeNull();
    expect(pasted?.classList.contains('selected')).toBe(true);
  });

  it('selects timeline clips from the keyboard for copy and delete', async () => {
    const { fixture, el } = await render();
    const clip = el.querySelector<HTMLElement>('.clip[data-clip-id="logo"]')!;
    clip.focus();
    clip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await fixture.whenStable();
    expect(clip.classList.contains('selected')).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true }));
    await fixture.whenStable();
    expect(backend.calls[0]).toEqual({
      method: 'copyClips',
      sequenceId: 'seq-main',
      clipIds: ['logo'],
    });
  });

  it('selects and nudges viewport layers with the keyboard', async () => {
    const { fixture, el } = await render();
    fixture.componentInstance['store'].setPlayhead(secondsToTicks(3));
    await fixture.whenStable();
    const layer = el.querySelector<HTMLElement>('.layer[data-clip-id="logo"]')!;
    layer.focus();
    layer.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    await fixture.whenStable();
    expect(layer.classList.contains('selected')).toBe(true);
    layer.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }),
    );
    await fixture.whenStable();
    expect(backend.calls).toEqual([
      {
        method: 'apply',
        op: {
          type: 'setClipTransform',
          sequenceId: 'seq-main',
          clipId: 'logo',
          transform: { x: 770, y: -400, scale: 0.2, scaleX: 1, scaleY: 1, rotation: 0 },
        },
      },
    ]);
  });

  it('adds and removes tracks from the timeline headers', async () => {
    const { fixture, el } = await render();
    const button = (label: string) =>
      [...el.querySelectorAll<HTMLButtonElement>('.track-add button')].find((b) =>
        b.textContent?.includes(label),
      )!;
    button('Video').click();
    await fixture.whenStable();
    button('Audio').click();
    await fixture.whenStable();
    const names = () => [...el.querySelectorAll('.track-name')].map((t) => t.textContent);
    expect(names()).toEqual(['V3', 'V2', 'V1', 'A1', 'A2']);

    el.querySelector<HTMLButtonElement>('.track-remove')!.click();
    await fixture.whenStable();
    expect(names()).toEqual(['V2', 'V1', 'A1', 'A2']);
    expect(backend.calls.map((c) => c.method === 'apply' && c.op.type)).toEqual([
      'addTrack',
      'addTrack',
      'removeTrack',
    ]);
  });

  it('renders video and image previews for the layers', async () => {
    const { fixture, el } = await render();
    fixture.componentInstance['store'].setPlayhead(secondsToTicks(3));
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(el.querySelector('.layer[data-clip-id="clip-a"] video')?.getAttribute('src')).toBe(
        'asset://src-video',
      );
    });
    expect(el.querySelector('.layer[data-clip-id="logo"] img')?.getAttribute('src')).toBe(
      'asset://src-logo',
    );
  });

  it('resizes the selected layer with a handle and commits one transform', async () => {
    const { fixture, el } = await render();
    fixture.componentInstance['store'].setPlayhead(secondsToTicks(3));
    await fixture.whenStable();
    const layer = el.querySelector<HTMLElement>('.layer[data-clip-id="logo"]')!;
    layer.focus();
    layer.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    await fixture.whenStable();
    const width = parseFloat(layer.style.width);
    const height = parseFloat(layer.style.height);
    const handle = el.querySelector<HTMLElement>('.handle[data-handle="se"]')!;

    handle.dispatchEvent(pointer('pointerdown', 0, 0));
    handle.dispatchEvent(pointer('pointermove', width / 2, height / 2));
    frames.splice(0).forEach((frame) => frame(0));
    expect(layer.style.scale).toBe('1.5 1.5');
    expect(backend.calls).toEqual([]);

    handle.dispatchEvent(pointer('pointerup', width / 2, height / 2));
    await fixture.whenStable();
    expect(backend.calls.length).toBe(1);
    const call = backend.calls[0];
    if (call.method !== 'apply' || call.op.type !== 'setClipTransform') {
      throw new Error('expected setClipTransform');
    }
    // The top-left corner stays put: the centre moves by a quarter of the old size.
    expect(call.op.transform.scale).toBeCloseTo(0.3);
    expect(call.op.transform.x).toBeCloseTo(760 + (1920 * 0.2) / 4, 1);
    expect(call.op.transform.y).toBeCloseTo(-400 + (1080 * 0.2) / 4, 1);
    expect([call.op.transform.scaleX, call.op.transform.scaleY]).toEqual([1, 1]);
  });

  it('shows import progress in the media bin and status bar', async () => {
    const { fixture, el } = await render();
    let release!: () => void;
    backend.importGate = new Promise((resolve) => (release = resolve));
    backend.chosenFiles = ['/clips/holiday.mkv'];
    fixture.componentInstance['store'].importMedia();
    await vi.waitFor(async () => {
      await new Promise((r) => setTimeout(r));
      fixture.detectChanges();
      expect(el.querySelector('.item.importing')?.textContent).toContain('holiday.mkv');
    });
    expect(el.querySelector('.status .activity')?.textContent).toContain('Importing holiday.mkv');
    release();
    await fixture.whenStable();
    expect(el.querySelector('.item.importing')).toBeNull();
    expect(el.querySelector('.status .activity')).toBeNull();
  });
});
