import { ChangeDetectionStrategy, Component, inject, OnInit } from '@angular/core';

import { EditorStore } from './core/editor-store';
import { Inspector } from './inspector/inspector';
import { Timeline } from './timeline/timeline';
import { Viewport } from './viewport/viewport';

@Component({
  selector: 'app-root',
  imports: [Viewport, Timeline, Inspector],
  templateUrl: './app.html',
  styleUrl: './app.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:keydown)': 'onKeyDown($event)',
  },
})
export class App implements OnInit {
  protected readonly store = inject(EditorStore);

  ngOnInit(): void {
    void this.store.load();
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
    if (mod && key === 'c') {
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
