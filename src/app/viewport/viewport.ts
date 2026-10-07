import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  Injector,
  signal,
  viewChild,
} from '@angular/core';

import { EditorStore, PreviewState } from '../core/editor-store';
import { BlendMode, Clip, MediaSource, Sequence, Ticks, Track, tracksByZ } from '../core/models';
import { startPointerDrag } from '../core/pointer-drag';
import { formatTimecode, TICKS_PER_SECOND } from '../core/time';
import { clipSize, RESIZE_HANDLES, ResizeHandle, resizeLayer, sourceSize } from '../core/transform';
import { DRAG_THRESHOLD } from '../timeline/timeline-geometry';
import { PreviewVideo } from './preview-video';

export interface ViewportLayer {
  track: Track;
  clip: Clip;
  source: MediaSource | undefined;
  /** Time inside the source media shown at the playhead. */
  sourceTime: Ticks;
}

/** Visual clips at `time`, bottom → top, following explicit track z-order. */
export function compositeLayers(
  sequence: Sequence,
  media: MediaSource[],
  time: Ticks,
): ViewportLayer[] {
  return tracksByZ(sequence)
    .filter((track) => track.kind === 'video' && track.visible)
    .flatMap((track) => {
      const clip = track.clips.find((c) => time >= c.start && time < c.start + c.duration);
      if (!clip) {
        return [];
      }
      const source = media.find((m) => m.id === clip.source.sourceId);
      return [{ track, clip, source, sourceTime: clip.source.inPoint + (time - clip.start) }];
    });
}

const BLEND_MODES: Record<BlendMode, string> = {
  normal: 'normal',
  add: 'plus-lighter',
  multiply: 'multiply',
  screen: 'screen',
};

/**
 * Program monitor. Each layer shows its video or image (converted by FFmpeg
 * when the web view cannot play the original), positioned by the clip
 * transform, with a placeholder while the media loads or when it is missing.
 * The selected layer gets handles: corners resize keeping the proportions
 * (Shift: freely), edges stretch one axis.
 */
@Component({
  selector: 'app-viewport',
  imports: [PreviewVideo],
  templateUrl: './viewport.html',
  styleUrl: './viewport.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Viewport {
  protected readonly store = inject(EditorStore);
  private readonly injector = inject(Injector);
  private readonly container = viewChild.required<ElementRef<HTMLElement>>('container');
  private readonly containerSize = signal({ width: 640, height: 360 });
  private cancelDrag: (() => void) | null = null;

  protected readonly handles = RESIZE_HANDLES;
  /** True while a layer is being moved or resized (hides the selection handles). */
  protected readonly dragging = signal(false);

  protected readonly hasClips = computed(
    () => this.store.activeSequence()?.tracks.some((t) => t.clips.length > 0) ?? false,
  );

  protected readonly layers = computed(() => {
    const sequence = this.store.activeSequence();
    const project = this.store.project();
    return sequence && project
      ? compositeLayers(sequence, project.media, this.store.playhead())
      : [];
  });

  /** The single selected layer at the playhead, which gets resize handles. */
  protected readonly selectedLayer = computed(() => {
    const selection = this.store.selection();
    return selection.size === 1
      ? (this.layers().find((l) => selection.has(l.clip.id)) ?? null)
      : null;
  });

  /** Stage size in CSS px, fitted to the container with the sequence aspect ratio. */
  protected readonly stage = computed(() => {
    const sequence = this.store.activeSequence();
    const { width, height } = this.containerSize();
    if (!sequence) {
      return { width: 0, height: 0, scale: 1 };
    }
    const { width: seqW, height: seqH } = sequence.resolution;
    const scale = Math.max(0.01, Math.min((width - 16) / seqW, (height - 16) / seqH));
    return { width: seqW * scale, height: seqH * scale, scale };
  });

  constructor() {
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      if (typeof ResizeObserver === 'undefined') {
        return;
      }
      const observer = new ResizeObserver(([entry]) => {
        this.containerSize.set({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      });
      observer.observe(this.container().nativeElement);
      destroyRef.onDestroy(() => observer.disconnect());
    });
    destroyRef.onDestroy(() => this.cancelDrag?.());
  }

  protected layerBox(layer: ViewportLayer) {
    const { width, height, scale } = this.stage();
    const frame = this.store.activeSequence()?.resolution ?? { width: 0, height: 0 };
    const t = layer.clip.transform;
    const size = clipSize(t, sourceSize(layer.source, frame));
    return {
      left: width / 2 + t.x * scale,
      top: height / 2 + t.y * scale,
      width: size.width * scale,
      height: size.height * scale,
    };
  }

  protected previewState(layer: ViewportLayer): PreviewState | null {
    return this.store.previews().get(layer.clip.source.sourceId) ?? null;
  }

  /** URL of a ready preview, or `null`. */
  protected previewUrl(layer: ViewportLayer): string | null {
    const preview = this.previewState(layer);
    return preview?.status === 'ready' ? preview.url : null;
  }

  protected sourceSeconds(layer: ViewportLayer): number {
    return layer.sourceTime / TICKS_PER_SECOND;
  }

  protected onPreviewFailed(layer: ViewportLayer): void {
    this.store.previewFailed(layer.clip.source.sourceId);
  }

  protected blendMode(mode: BlendMode): string {
    return BLEND_MODES[mode];
  }

  protected timecode(ticks: Ticks): string {
    const sequence = this.store.activeSequence();
    return sequence ? formatTimecode(ticks, sequence.frameRate) : '';
  }

  protected fps(sequence: Sequence): string {
    return (sequence.frameRate.numerator / sequence.frameRate.denominator)
      .toFixed(2)
      .replace(/\.00$/, '');
  }

  protected onLayerPointerDown(event: PointerEvent, layer: ViewportLayer): void {
    if (event.button !== 0) {
      return;
    }
    event.stopPropagation();
    this.store.selectClip(layer.clip.id, event.shiftKey || event.ctrlKey || event.metaKey);
    if (layer.track.locked) {
      return;
    }
    const element = event.currentTarget as HTMLElement;
    const originX = event.clientX;
    const originY = event.clientY;
    const scale = this.stage().scale;
    const origin = layer.clip.transform;

    this.cancelDrag?.();
    this.cancelDrag = startPointerDrag(event, element, {
      onFrame: (x, y) => {
        this.dragging.set(true);
        element.classList.add('dragging');
        element.style.translate = `${x - originX}px ${y - originY}px`;
      },
      onEnd: async (x, y, cancelled) => {
        this.dragging.set(false);
        element.classList.remove('dragging');
        const dx = (x - originX) / scale;
        const dy = (y - originY) / scale;
        if (!cancelled && Math.hypot(x - originX, y - originY) >= DRAG_THRESHOLD) {
          const round = (v: number) => Math.round(v * 100) / 100;
          const transform = { ...origin, x: round(origin.x + dx), y: round(origin.y + dy) };
          if (await this.store.setClipTransform(layer.clip.id, transform)) {
            afterNextRender(() => (element.style.translate = ''), { injector: this.injector });
            return;
          }
        }
        element.style.translate = '';
      },
    });
  }

  protected onHandlePointerDown(
    event: PointerEvent,
    layer: ViewportLayer,
    handle: ResizeHandle,
  ): void {
    if (event.button !== 0 || layer.track.locked) {
      return;
    }
    event.stopPropagation();
    event.preventDefault();
    const element = [
      ...this.container().nativeElement.querySelectorAll<HTMLElement>('.layer'),
    ].find((e) => e.dataset['clipId'] === layer.clip.id);
    if (!element) {
      return;
    }
    const box = this.layerBox(layer);
    const scale = this.stage().scale;
    const origin = layer.clip.transform;
    const originX = event.clientX;
    const originY = event.clientY;
    // Shift resizes corners freely; track it while the pointer is captured.
    let free = event.shiftKey;
    const onKey = (e: KeyboardEvent) => (free = e.shiftKey);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    const resize = (x: number, y: number) =>
      resizeLayer(handle, origin, box.width, box.height, x - originX, y - originY, scale, free);
    const reset = () => {
      element.style.scale = '';
      element.style.translate = '';
    };

    this.cancelDrag?.();
    this.cancelDrag = startPointerDrag(event, event.currentTarget as HTMLElement, {
      onFrame: (x, y) => {
        const result = resize(x, y);
        this.dragging.set(true);
        element.classList.add('resizing');
        element.style.scale = `${result.width / box.width} ${result.height / box.height}`;
        element.style.translate = `${result.shiftX}px ${result.shiftY}px`;
      },
      onEnd: async (x, y, cancelled) => {
        window.removeEventListener('keydown', onKey);
        window.removeEventListener('keyup', onKey);
        this.dragging.set(false);
        element.classList.remove('resizing');
        if (!cancelled && Math.hypot(x - originX, y - originY) >= DRAG_THRESHOLD) {
          if (await this.store.setClipTransform(layer.clip.id, resize(x, y).transform)) {
            afterNextRender(reset, { injector: this.injector });
            return;
          }
        }
        reset();
      },
    });
  }

  protected onLayerKeyDown(event: KeyboardEvent, layer: ViewportLayer): void {
    if (!layer.track.locked && (event.key === '+' || event.key === '=' || event.key === '-')) {
      event.preventDefault();
      const transform = layer.clip.transform;
      const factor = event.key === '-' ? 1 / 1.1 : 1.1;
      void this.store.setClipTransform(layer.clip.id, {
        ...transform,
        scale: Math.max(0.0001, Math.round(transform.scale * factor * 10_000) / 10_000),
      });
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.store.selectClip(layer.clip.id, event.shiftKey || event.ctrlKey || event.metaKey);
      return;
    }
    const direction: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const delta = direction[event.key];
    if (!delta) {
      return;
    }
    event.preventDefault();
    this.store.selectClip(layer.clip.id, false);
    if (!layer.track.locked) {
      const step = event.shiftKey ? 10 : 1;
      const transform = layer.clip.transform;
      void this.store.setClipTransform(layer.clip.id, {
        ...transform,
        x: transform.x + delta[0] * step,
        y: transform.y + delta[1] * step,
      });
    }
  }
}
