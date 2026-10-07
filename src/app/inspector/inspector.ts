import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { EditorStore } from '../core/editor-store';
import { Id, Resolution } from '../core/models';
import { formatTimecode } from '../core/time';
import { clipSize, FitMode, sourceSize } from '../core/transform';

/** Common frame sizes offered for sequences. */
export const FRAME_PRESETS: readonly { label: string; width: number; height: number }[] = [
  { label: '16:9 · 1080p', width: 1920, height: 1080 },
  { label: '16:9 · 720p', width: 1280, height: 720 },
  { label: '16:9 · 4K UHD', width: 3840, height: 2160 },
  { label: '9:16 · Vertical', width: 1080, height: 1920 },
  { label: '1:1 · Square', width: 1080, height: 1080 },
  { label: '4:5 · Portrait', width: 1080, height: 1350 },
  { label: '4:3 · Classic', width: 1440, height: 1080 },
  { label: '21:9 · Ultrawide', width: 2560, height: 1080 },
];

const FIT_MODES: readonly { mode: FitMode; label: string; title: string }[] = [
  { mode: 'fit', label: 'Fit', title: 'Show the whole clip inside the frame' },
  { mode: 'fill', label: 'Fill', title: 'Cover the frame, cropping the clip' },
  { mode: 'stretch', label: 'Stretch', title: 'Cover the frame exactly (changes proportions)' },
  { mode: 'original', label: 'Original', title: 'Restore the source proportions' },
];

/** Selected clip properties (size and proportions are editable) and the sequence frame size. */
@Component({
  selector: 'app-inspector',
  template: `
    <h2>Inspector</h2>
    @if (details(); as d) {
      <dl>
        <dt>Clip</dt>
        <dd>{{ d.clip.name }}</dd>
        <dt>Track</dt>
        <dd>{{ d.track.name }} (z {{ d.track.zIndex }}, {{ d.track.blendMode }})</dd>
        <dt>Source</dt>
        <dd [title]="d.sourcePath">{{ d.sourceName }}</dd>
        <dt>Source in</dt>
        <dd>{{ d.inPoint }}</dd>
        <dt>Start</dt>
        <dd>{{ d.start }}</dd>
        <dt>Duration</dt>
        <dd>{{ d.duration }}</dd>
        <dt>Position</dt>
        <dd>{{ d.clip.transform.x }}, {{ d.clip.transform.y }}</dd>
        <dt>Scale / Rot.</dt>
        <dd>{{ d.clip.transform.scale }} / {{ d.clip.transform.rotation }}°</dd>
        <dt>Stretch</dt>
        <dd>{{ d.clip.transform.scaleX }} × {{ d.clip.transform.scaleY }}</dd>
        <dt>Opacity</dt>
        <dd>{{ d.clip.opacity }}</dd>
        @if (d.visual) {
          <dt><label [for]="'clip-width'">Size</label></dt>
          <dd class="size">
            <input
              id="clip-width"
              type="number"
              min="1"
              aria-label="Width in pixels"
              [value]="d.width"
              [disabled]="d.track.locked"
              (change)="onSize($event, d.clip.id, 'width', d.width, d.height)"
            />
            ×
            <input
              type="number"
              min="1"
              aria-label="Height in pixels"
              [value]="d.height"
              [disabled]="d.track.locked"
              (change)="onSize($event, d.clip.id, 'height', d.width, d.height)"
            />
          </dd>
        }
      </dl>
      @if (d.visual) {
        <div class="fit" role="group" aria-label="Fit to frame">
          @for (fit of fitModes; track fit.mode) {
            <button
              type="button"
              class="small"
              [title]="fit.title"
              [disabled]="d.track.locked"
              (click)="store.fitClip(d.clip.id, fit.mode)"
            >
              {{ fit.label }}
            </button>
          }
        </div>
        <p class="hint small">
          Drag the corner handles in the viewport to resize, the edge handles (or Shift + corner) to
          change proportions.
        </p>
      }
    } @else {
      <p class="hint">
        {{
          store.selection().size > 1 ? store.selection().size + ' clips selected' : 'Select a clip'
        }}
      </p>
    }

    @if (store.activeSequence(); as sequence) {
      <h2 class="section">Sequence</h2>
      <dl>
        <dt><label for="sequence-frame">Frame</label></dt>
        <dd>
          <select
            id="sequence-frame"
            [value]="frameKey(sequence.resolution)"
            (change)="onFrame($event)"
          >
            @if (!isPreset(sequence.resolution)) {
              <option [value]="frameKey(sequence.resolution)">
                Custom · {{ sequence.resolution.width }}×{{ sequence.resolution.height }}
              </option>
            }
            @for (preset of presets; track preset.label) {
              <option [value]="frameKey(preset)">
                {{ preset.label }} ({{ preset.width }}×{{ preset.height }})
              </option>
            }
          </select>
        </dd>
      </dl>
    }
  `,
  styles: `
    :host {
      display: block;
      padding: 10px 12px;
      overflow: auto;
      background: var(--panel);
      font-size: 12px;
    }
    h2 {
      margin: 0 0 8px;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
    }
    dl {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 4px 10px;
      margin: 0;
    }
    dt {
      color: var(--muted);
    }
    dd {
      margin: 0;
      font-family: var(--mono);
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .hint {
      color: var(--muted);
    }
    .hint.small {
      font-size: 11px;
    }
    h2.section {
      margin-top: 16px;
    }
    dd.size {
      display: flex;
      align-items: center;
      gap: 4px;
      overflow: visible;
    }
    dd.size input {
      width: 64px;
      font-family: var(--mono);
    }
    select {
      max-width: 100%;
    }
    .fit {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 8px;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Inspector {
  protected readonly store = inject(EditorStore);
  protected readonly presets = FRAME_PRESETS;
  protected readonly fitModes = FIT_MODES;

  protected frameKey(resolution: Resolution): string {
    return `${resolution.width}x${resolution.height}`;
  }

  protected isPreset(resolution: Resolution): boolean {
    return this.presets.some((p) => p.width === resolution.width && p.height === resolution.height);
  }

  protected onFrame(event: Event): void {
    const [width, height] = (event.target as HTMLSelectElement).value.split('x').map(Number);
    void this.store.setSequenceResolution({ width, height });
  }

  /** Commits a width or height edit; resets the field when it is rejected. */
  protected onSize(
    event: Event,
    clipId: Id,
    axis: 'width' | 'height',
    width: number,
    height: number,
  ): void {
    const input = event.target as HTMLInputElement;
    const value = input.valueAsNumber;
    const previous = axis === 'width' ? width : height;
    const next = axis === 'width' ? { width: value, height } : { width, height: value };
    void this.store.setClipSize(clipId, next.width, next.height).then((ok) => {
      if (!ok) {
        input.value = String(previous);
      }
    });
  }

  protected readonly details = computed(() => {
    const selected = this.store.selectedClips();
    const sequence = this.store.activeSequence();
    if (selected.length !== 1 || !sequence) {
      return null;
    }
    const { clip, track } = selected[0];
    const source = this.store.project()?.media.find((m) => m.id === clip.source.sourceId);
    const tc = (t: number) => formatTimecode(t, sequence.frameRate);
    const size = clipSize(clip.transform, sourceSize(source, sequence.resolution));
    return {
      clip,
      track,
      visual: track.kind === 'video',
      width: Math.round(size.width),
      height: Math.round(size.height),
      sourceName: source?.name ?? 'missing source',
      sourcePath: source?.path ?? '',
      inPoint: tc(clip.source.inPoint),
      start: tc(clip.start),
      duration: tc(clip.duration),
    };
  });
}
