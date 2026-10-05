import { TestBed } from '@angular/core/testing';

import { FakeEditorBackend } from '../testing/fake-editor-backend';
import { EditorBackend } from './editor-backend';
import { EditorStore } from './editor-store';
import { secondsToTicks } from './time';

describe('EditorStore', () => {
  let backend: FakeEditorBackend;
  let store: EditorStore;

  beforeEach(async () => {
    backend = new FakeEditorBackend();
    TestBed.configureTestingModule({ providers: [{ provide: EditorBackend, useValue: backend }] });
    store = TestBed.inject(EditorStore);
    await store.load();
  });

  it('loads the project with multiple sequences', () => {
    expect(store.sequences().map((s) => s.name)).toEqual(['Main Edit', 'Social Cut']);
    expect(store.activeSequence()?.id).toBe('seq-main');
    expect(store.mediaStatus()?.available).toBe(false);
  });

  it('commits a move as a single edit operation', async () => {
    expect(await store.moveClip('clip-b', 'v2', secondsToTicks(20))).toBe(true);
    expect(backend.calls).toEqual([
      {
        method: 'apply',
        op: {
          type: 'moveClip',
          sequenceId: 'seq-main',
          clipId: 'clip-b',
          trackId: 'v2',
          start: secondsToTicks(20),
        },
      },
    ]);
    expect(store.project()?.revision).toBe(1);
  });

  it('copies the selection and pastes at the playhead onto the target track', async () => {
    store.selectClip('logo', false);
    store.selectClip('clip-b', true);
    await store.copySelection();
    expect(backend.calls[0]).toEqual({
      method: 'copyClips',
      sequenceId: 'seq-main',
      clipIds: ['logo', 'clip-b'],
    });
    expect(store.snapshot()?.clipboard?.clipCount).toBe(2);

    store.setPlayhead(secondsToTicks(30));
    store.setTargetTrack('v1');
    await store.paste();
    expect(backend.calls[1]).toEqual({
      method: 'pasteClips',
      sequenceId: 'seq-main',
      at: secondsToTicks(30),
      baseTrackId: 'v1',
    });
    const ids = [...store.selection()];
    expect(ids).toHaveLength(2);
    expect(ids).not.toContain('logo');
    expect(ids).not.toContain('clip-b');
    expect(store.activeSequence()?.tracks.flatMap((t) => t.clips).filter((c) => ids.includes(c.id))).toHaveLength(2);
    expect(store.status()).toBe('Pasted 2 clips');
  });

  it('waits for an in-flight copy before checking the clipboard', async () => {
    store.selectClip('logo', false);
    const originalCopy = backend.copyClips.bind(backend);
    let finishCopy!: () => void;
    backend.copyClips = async (sequenceId, clipIds) => {
      await new Promise<void>((resolve) => (finishCopy = resolve));
      return originalCopy(sequenceId, clipIds);
    };
    const copying = store.copySelection();
    const pasting = store.paste();
    await Promise.resolve();
    expect(backend.calls).toEqual([]);
    finishCopy();
    await Promise.all([copying, pasting]);
    expect(backend.calls.map((call) => call.method)).toEqual(['copyClips', 'pasteClips']);
    expect(store.selection()).toEqual(new Set(['pasted-1']));
    expect(store.status()).toBe('Pasted 1 clip');
  });

  it('does not call the backend when nothing is selected or the clipboard is empty', async () => {
    await store.copySelection();
    await store.paste();
    expect(backend.calls).toEqual([]);
  });

  it('surfaces backend errors', async () => {
    backend.failWith = 'clip would overlap clip clip-a';
    expect(await store.moveClip('clip-b', 'v1', 0)).toBe(false);
    expect(store.error()).toBe('clip would overlap clip clip-a');
  });

  it('switching sequences resets selection', () => {
    store.selectClip('logo', false);
    store.selectSequence('seq-social');
    expect(store.activeSequence()?.name).toBe('Social Cut');
    expect(store.selection().size).toBe(0);
  });
});
