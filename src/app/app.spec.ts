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
  });
});
