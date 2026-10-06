import { ChangeDetectionStrategy, Component, DestroyRef, inject, OnInit } from '@angular/core';

import { EditorBackend } from './core/editor-backend';
import { EditorStore } from './core/editor-store';
import { MediaBin } from './media-bin/media-bin';
import { Inspector } from './inspector/inspector';
import { Timeline } from './timeline/timeline';
import { Viewport } from './viewport/viewport';

@Component({
  selector: 'app-root',
  imports: [Viewport, Timeline, Inspector, MediaBin],
  templateUrl: './app.html',
  styleUrl: './app.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:keydown)': 'onKeyDown($event)',
  },
})
export class App implements OnInit {
  protected readonly store = inject(EditorStore);

  private readonly backend = inject(EditorBackend);
  private readonly destroyRef = inject(DestroyRef);

  ngOnInit(): void {
    void this.store.load();
    let destroyed = false;
    let unlisten: (() => void) | undefined;
    this.destroyRef.onDestroy(() => {
      destroyed = true;
      unlisten?.();
    });
    this.backend
      .onFilesDropped(
        (paths) => void this.store.importMedia(paths),
        (active) => this.store.dropActive.set(active),
      )
      .then((fn) => (destroyed ? fn() : (unlisten = fn)))
      .catch(() => undefined);
  }

  protected onProjectName(event: Event): void {
    const input = event.target as HTMLInputElement;
    void this.store.renameProject(input.value).then(() => {
      input.value = this.store.project()?.name ?? input.value;
    });
  }

  protected onKeyDown(event: KeyboardEvent): void {
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest('input, textarea, select, [contenteditable="true"]')
    ) {
      return;
    }
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    let handled = true;
    if (!mod && event.key === ' ') {
      // Space activates focused buttons/clips itself; only toggle playback elsewhere.
      if (target instanceof Element && target.closest('button, [role="button"]')) {
        return;
      }
      this.store.togglePlayback();
    } else if (mod && key === 'e') {
      void this.store.exportSequence();
    } else if (mod && key === 's') {
      void this.store.saveProject(event.shiftKey);
    } else if (mod && key === 'o') {
      void this.store.openProject();
    } else if (mod && key === 'n') {
      void this.store.newProject();
    } else if (mod && key === 'i') {
      void this.store.importMedia();
    } else if (mod && key === 'c') {
      void this.store.copySelection();
    } else if (mod && key === 'v') {
      void this.store.paste();
    } else if (mod && ((key === 'z' && event.shiftKey) || key === 'y')) {
      void this.store.redo();
    } else if (mod && key === 'z') {
      void this.store.undo();
    } else if (
      !mod &&
      (event.key === 'Delete' || event.key === 'Backspace') &&
      this.store.selection().size > 0
    ) {
      void this.store.deleteSelection();
    } else {
      handled = false;
    }
    if (handled) {
      event.preventDefault();
    }
  }
}
