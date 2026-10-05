import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { EditorStore } from '../core/editor-store';
import { TICKS_PER_SECOND } from '../core/time';

@Component({
  selector: 'app-media-bin',
  templateUrl: './media-bin.html',
  styleUrl: './media-bin.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MediaBin {
  protected readonly store = inject(EditorStore);

  protected seconds(ticks: number): string {
    return `${(ticks / TICKS_PER_SECOND).toFixed(1)} s`;
  }
}
