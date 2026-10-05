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
import { computeClipDrag, LANE_HEIGHT } from './timeline-geometry';

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
      ? Math.max(...sequence.tracks.flatMap((t) => t.clips.map((c) => c.start + c.duration)), 0)
      : 0;
    return (duration / TICKS_PER_SECOND + 30) * this.store.pixelsPerSecond();
  });

  protected readonly rulerMarks = computed(() => {
    const pps = this.store.pixelsPerSecond();
    const step = pps >= 60 ? 1 : pps >= 20 ? 5 : 10;
    const seconds = this.contentWidth() / pps;
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
        this.cancelDrag = null;
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
        this.cancelDrag = null;
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

  ngOnDestroy(): void {
    this.cancelDrag?.();
  }
}
