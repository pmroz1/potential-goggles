import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  OnDestroy,
  viewChild,
} from '@angular/core';

import { EditorStore } from '../core/editor-store';
import { Clip, Track, tracksByZ } from '../core/models';
import { startPointerDrag } from '../core/pointer-drag';
import { formatTimecode, snapToFrame, TICKS_PER_SECOND } from '../core/time';
import { computeClipDrag, computeClipTrim, LANE_HEIGHT, TrimEdge } from './timeline-geometry';

@Component({
  selector: 'app-timeline',
  templateUrl: './timeline.html',
  styleUrl: './timeline.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Timeline implements OnDestroy {
  protected readonly store = inject(EditorStore);
  private readonly injector = inject(Injector);
  private readonly lanesRef = viewChild.required<ElementRef<HTMLElement>>('lanes');
  private readonly rulerRef = viewChild.required<ElementRef<HTMLElement>>('ruler');
  /** Cancels the most recent drag; a no-op once that drag has finished. */
  private cancelDrag: (() => void) | null = null;

  protected readonly laneHeight = LANE_HEIGHT;

  /** Tracks top → bottom: highest z-index (drawn on top) is shown first. */
  protected readonly displayTracks = computed(() => {
    const sequence = this.store.activeSequence();
    return sequence ? tracksByZ(sequence).reverse() : [];
  });

  protected readonly contentWidth = computed(() => {
    const sequence = this.store.activeSequence();
    const duration = sequence
      ? sequence.tracks.reduce(
          (max, track) =>
            track.clips.reduce((end, clip) => Math.max(end, clip.start + clip.duration), max),
          0,
        )
      : 0;
    return (duration / TICKS_PER_SECOND + 30) * this.store.pixelsPerSecond();
  });

  protected readonly rulerMarks = computed(() => {
    const pps = this.store.pixelsPerSecond();
    const seconds = this.contentWidth() / pps;
    // Keep labels ≥ ~60 px apart and bound the number of DOM nodes.
    const step =
      [1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find((s) => s * pps >= 60 && seconds / s <= 500) ??
      600;
    const marks: { x: number; label: string }[] = [];
    for (let s = 0; s <= seconds; s += step) {
      marks.push({ x: s * pps, label: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` });
    }
    return marks;
  });

  protected readonly playheadX = computed(() => this.store.playhead() * this.store.pixelsPerTick());

  protected clipX(clip: Clip): number {
    return clip.start * this.store.pixelsPerTick();
  }

  protected clipWidth(clip: Clip): number {
    return Math.max(2, clip.duration * this.store.pixelsPerTick());
  }

  protected isImage(clip: Clip): boolean {
    return this.store.media().find((m) => m.id === clip.source.sourceId)?.kind === 'image';
  }

  protected timecode(ticks: number): string {
    const sequence = this.store.activeSequence();
    return sequence ? formatTimecode(ticks, sequence.frameRate) : '';
  }

  protected onLanePointerDown(event: PointerEvent, track: Track): void {
    if (event.button === 0) {
      this.store.clearSelection();
      this.store.setTargetTrack(track.id);
    }
  }

  protected onRulerPointerDown(event: PointerEvent): void {
    const sequence = this.store.activeSequence();
    if (event.button !== 0 || !sequence) {
      return;
    }
    const left = this.rulerRef().nativeElement.getBoundingClientRect().left;
    const pixelsPerTick = this.store.pixelsPerTick();
    const scrub = (clientX: number) =>
      this.store.setPlayhead(snapToFrame((clientX - left) / pixelsPerTick, sequence.frameRate));
    scrub(event.clientX);
    this.cancelDrag?.();
    this.cancelDrag = startPointerDrag(event, event.currentTarget as HTMLElement, {
      onFrame: (x) => scrub(x),
      onEnd: (x, _y, cancelled) => {
        if (!cancelled) {
          scrub(x);
        }
      },
    });
  }

  protected onClipPointerDown(event: PointerEvent, track: Track, clip: Clip): void {
    if (event.button !== 0) {
      return;
    }

    event.stopPropagation();
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    this.store.selectClip(clip.id, additive);
    this.store.setTargetTrack(track.id);
    const sequence = this.store.activeSequence();
    if (additive || track.locked || !sequence) {
      return;
    }

    const element = event.currentTarget as HTMLElement;
    const lanes = this.displayTracks();
    const ctx = {
      clip,
      clipKind: track.kind,
      originLane: lanes.indexOf(track),
      originClientX: event.clientX,
      originClientY: event.clientY,
      lanesTop: this.lanesRef().nativeElement.getBoundingClientRect().top,
      lanes,
      pixelsPerTick: this.store.pixelsPerTick(),
      frameRate: sequence.frameRate,
    };

    this.cancelDrag?.();
    this.cancelDrag = startPointerDrag(event, element, {
      // Runs at most once per animation frame; touches only this element's style.
      onFrame: (x, y) => {
        const result = computeClipDrag(ctx, x, y);
        if (!result.moved) {
          return;
        }
        element.classList.add('dragging');
        element.classList.toggle('invalid', !result.valid);
        element.style.translate = `${result.offsetX}px ${result.offsetY}px`;
      },
      onEnd: async (x, y, cancelled) => {
        const result = computeClipDrag(ctx, x, y);
        const changed = result.start !== clip.start || result.track.id !== track.id;
        element.classList.remove('dragging', 'invalid');
        if (!cancelled && result.moved && changed) {
          element.style.translate = `${result.offsetX}px ${result.offsetY}px`;
          if (await this.store.moveClip(clip.id, result.track.id, result.start)) {
            // Clear the visual offset once the committed snapshot has rendered,
            // so the clip doesn't flash back to its old position.
            afterNextRender(() => (element.style.translate = ''), { injector: this.injector });
            return;
          }
        }
        element.style.translate = '';
      },
    });
  }

  /** Drags a clip edge: trims (or, for images, stretches) the clip and commits one `trimClip`. */
  protected onTrimPointerDown(event: PointerEvent, track: Track, clip: Clip, edge: TrimEdge): void {
    if (event.button !== 0) {
      return;
    }
    event.stopPropagation();
    this.store.selectClip(clip.id, false);
    this.store.setTargetTrack(track.id);
    const sequence = this.store.activeSequence();
    if (track.locked || !sequence) {
      return;
    }

    const handle = event.currentTarget as HTMLElement;
    const element = handle.closest<HTMLElement>('.clip');
    if (!element) {
      return;
    }
    const source = this.store.media().find((m) => m.id === clip.source.sourceId);
    const snapPoints = sequence.tracks
      .flatMap((t) => t.clips)
      .filter((c) => c.id !== clip.id)
      .flatMap((c) => [c.start, c.start + c.duration]);
    snapPoints.push(this.store.playhead());
    const ctx = {
      clip,
      edge,
      originClientX: event.clientX,
      pixelsPerTick: this.store.pixelsPerTick(),
      frameRate: sequence.frameRate,
      sourceDuration: !source || source.kind === 'image' ? null : source.duration,
      neighbours: track.clips.filter((c) => c.id !== clip.id),
      snapPoints,
    };
    const { left, width } = element.style;
    const restore = () => {
      element.classList.remove('trimming');
      element.style.left = left;
      element.style.width = width;
    };

    this.cancelDrag?.();
    this.cancelDrag = startPointerDrag(event, handle, {
      onFrame: (x) => {
        const result = computeClipTrim(ctx, x);
        element.classList.add('trimming');
        element.style.left = `${result.left}px`;
        element.style.width = `${result.width}px`;
      },
      onEnd: async (x, _y, cancelled) => {
        const result = computeClipTrim(ctx, x);
        if (
          cancelled ||
          !result.changed ||
          !(await this.store.trimClip(clip.id, result.start, result.inPoint, result.duration))
        ) {
          restore();
        }
        element.classList.remove('trimming');
      },
    });
  }

  protected onClipKeyDown(event: KeyboardEvent, track: Track, clip: Clip): void {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }
    event.preventDefault();
    this.store.selectClip(clip.id, event.shiftKey || event.ctrlKey || event.metaKey);
    this.store.setTargetTrack(track.id);
  }

  ngOnDestroy(): void {
    this.cancelDrag?.();
  }
}
