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

import { EditorStore } from '../core/editor-store';
import { BlendMode, Clip, MediaSource, Sequence, Ticks, Track, tracksByZ } from '../core/models';
import { startPointerDrag } from '../core/pointer-drag';
import { formatTimecode } from '../core/time';
import { DRAG_THRESHOLD } from '../timeline/timeline-geometry';

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
 * Program monitor. Until FFmpeg decoding is wired up, each layer is drawn as a
 * placeholder box positioned by the clip transform.
 */
@Component({
  selector: 'app-viewport',
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

  protected readonly layers = computed(() => {
    const sequence = this.store.activeSequence();
    const project = this.store.project();
    return sequence && project
      ? compositeLayers(sequence, project.media, this.store.playhead())
      : [];
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
    const sequence = this.store.activeSequence();
    const t = layer.clip.transform;
    const srcW = layer.source?.width ?? sequence?.resolution.width ?? 0;
    const srcH = layer.source?.height ?? sequence?.resolution.height ?? 0;
    return {
      left: width / 2 + t.x * scale,
      top: height / 2 + t.y * scale,
      width: srcW * t.scale * scale,
      height: srcH * t.scale * scale,
    };
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
        element.classList.add('dragging');
        element.style.translate = `${x - originX}px ${y - originY}px`;
      },
      onEnd: async (x, y, cancelled) => {
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

  protected onLayerKeyDown(event: KeyboardEvent, layer: ViewportLayer): void {
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
