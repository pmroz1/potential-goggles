import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { EditorStore } from '../core/editor-store';
import { formatTimecode } from '../core/time';

/** Read-only view of the selected clip's properties. */
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
        <dt>Opacity</dt>
        <dd>{{ d.clip.opacity }}</dd>
      </dl>
    } @else {
      <p class="hint">
        {{
          store.selection().size > 1 ? store.selection().size + ' clips selected' : 'Select a clip'
        }}
      </p>
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
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Inspector {
  protected readonly store = inject(EditorStore);

  protected readonly details = computed(() => {
    const selected = this.store.selectedClips();
    const sequence = this.store.activeSequence();
    if (selected.length !== 1 || !sequence) {
      return null;
    }
    const { clip, track } = selected[0];
    const source = this.store.project()?.media.find((m) => m.id === clip.source.sourceId);
    const tc = (t: number) => formatTimecode(t, sequence.frameRate);
    return {
      clip,
      track,
      sourceName: source?.name ?? 'missing source',
      sourcePath: source?.path ?? '',
      inPoint: tc(clip.source.inPoint),
      start: tc(clip.start),
      duration: tc(clip.duration),
    };
  });
}
