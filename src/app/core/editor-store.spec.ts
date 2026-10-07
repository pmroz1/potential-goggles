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
    expect(store.mediaStatus()?.canExport).toBe(true);
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
    expect(
      store
        .activeSequence()
        ?.tracks.flatMap((t) => t.clips)
        .filter((c) => ids.includes(c.id)),
    ).toHaveLength(2);
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

  it('imports media and places it after existing clips when the playhead is occupied', async () => {
    await store.importMedia(['/media/new.mp4']);
    expect(store.media().map((m) => m.name)).toContain('new.mp4');
    const source = store.media().find((m) => m.name === 'new.mp4')!;
    store.setPlayhead(secondsToTicks(1));
    await store.addToTimeline(source);
    const op = backend.calls.at(-1);
    expect(op).toMatchObject({
      method: 'apply',
      op: { type: 'addClip', trackId: 'v1', sourceId: source.id, start: secondsToTicks(14) },
    });
  });

  it('starts a new project and resets selection and playhead', async () => {
    store.selectClip('clip-a', false);
    store.setPlayhead(secondsToTicks(3));
    await store.newProject();
    expect(store.project()?.name).toBe('Untitled Project');
    expect(store.selection().size).toBe(0);
    expect(store.playhead()).toBe(0);
  });

  it('saves to the known path and records it', async () => {
    await store.saveProject();
    expect(store.snapshot()?.path).toBe('/tmp/test.pgproj');
    await store.saveProject();
    expect(backend.calls.at(-1)).toEqual({
      method: 'saveProject',
      currentPath: '/tmp/test.pgproj',
    });
  });

  describe('playback', () => {
    let frames: FrameRequestCallback[];

    beforeEach(() => {
      frames = [];
      vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
      vi.stubGlobal('cancelAnimationFrame', () => undefined);
    });
    afterEach(() => vi.unstubAllGlobals());

    const runFrame = (now: number) => frames.shift()?.(now);

    it('advances the playhead in real time and stops at the end', () => {
      store.play();
      expect(store.playing()).toBe(true);
      runFrame(1000);
      runFrame(1500);
      expect(store.playhead()).toBe(secondsToTicks(0.5));
      runFrame(2500);
      expect(store.playhead()).toBe(secondsToTicks(1.5));
      runFrame(1_000_000);
      expect(store.playing()).toBe(false);
      expect(store.playhead()).toBe(store.sequenceEnd());
      expect(store.sequenceEnd()).toBe(secondsToTicks(14));
    });

    it('restarts from the beginning when played at the end and toggles with pause', () => {
      store.setPlayhead(store.sequenceEnd());
      store.togglePlayback();
      expect(store.playhead()).toBe(0);
      store.togglePlayback();
      expect(store.playing()).toBe(false);
      store.stop();
      expect(store.playhead()).toBe(0);
    });

    it('does not play an empty sequence', async () => {
      await store.newProject();
      store.play();
      expect(store.playing()).toBe(false);
    });
  });

  describe('export', () => {
    it('reports progress, returns to idle and records the output path', async () => {
      let release!: () => void;
      backend.exportGate = new Promise((resolve) => (release = resolve));
      const done = store.exportSequence();
      await Promise.resolve();
      await Promise.resolve();
      expect(store.exportProgress()).toBe(0.5);
      release();
      await done;
      expect(store.exportProgress()).toBeNull();
      expect(store.status()).toBe('Exported /tmp/out.mp4');
      expect(backend.calls.at(-1)).toEqual({
        method: 'exportSequence',
        sequenceId: 'seq-main',
        defaultName: 'Main Edit',
      });
    });

    it('treats a cancelled save dialog as a no-op and surfaces failures', async () => {
      backend.exportResult = null;
      await store.exportSequence();
      expect(store.status()).not.toContain('Exported');
      expect(store.error()).toBeNull();
      backend.failWith = 'ffmpeg exploded';
      await store.exportSequence();
      expect(store.error()).toBe('ffmpeg exploded');
      expect(store.exportProgress()).toBeNull();
    });

    it('is unavailable without FFmpeg', async () => {
      expect(store.canExport()).toBe(true);
      backend.mediaBackend = { ...backend.mediaBackend, canExport: false };
      await store.load();
      expect(store.canExport()).toBe(false);
    });
  });

  it('adds a track, targets it and removes it again', async () => {
    await store.addTrack('video');
    const added = store.activeSequence()!.tracks.find((t) => t.name === 'V3')!;
    expect(added.zIndex).toBe(3);
    expect(store.targetTrackId()).toBe(added.id);
    await store.removeTrack(added.id);
    expect(store.activeSequence()!.tracks.some((t) => t.id === added.id)).toBe(false);
    expect(store.targetTrackId()).toBeNull();
    expect(backend.calls.map((c) => c.method === 'apply' && c.op.type)).toEqual([
      'addTrack',
      'removeTrack',
    ]);
  });

  it('changes the sequence frame size only when it differs', async () => {
    await store.setSequenceResolution({ width: 1920, height: 1080 });
    expect(backend.calls).toEqual([]);
    await store.setSequenceResolution({ width: 1080, height: 1920 });
    expect(store.activeSequence()!.resolution).toEqual({ width: 1080, height: 1920 });
  });

  it('fits a clip to the frame and resizes it to an exact size', async () => {
    expect(await store.fitClip('logo', 'stretch')).toBe(true);
    expect(await store.setClipSize('logo', 960, 540)).toBe(true);
    expect(await store.setClipSize('logo', 0, 540)).toBe(false);
    const ops = backend.calls.map((c) => (c.method === 'apply' ? c.op : null));
    expect(ops).toEqual([
      expect.objectContaining({ transform: expect.objectContaining({ x: 0, y: 0, scale: 1 }) }),
      expect.objectContaining({
        transform: expect.objectContaining({ scale: 1, scaleX: 0.5, scaleY: 0.5 }),
      }),
    ]);
  });

  it('shows import placeholders and an activity while importing', async () => {
    let release!: () => void;
    backend.importGate = new Promise((resolve) => (release = resolve));
    backend.chosenFiles = ['/clips/a.mkv', 'C:\\clips\\b.txt'];
    const done = store.importMedia();
    await vi.waitFor(() => expect(store.importing().length).toBe(2));
    expect(store.importing().map((i) => i.label)).toEqual(['a.mkv', 'b.txt']);
    expect(store.activity()).toBe('Importing 2 files…');
    release();
    await done;
    expect(store.importing()).toEqual([]);
    expect(store.activity()).toBeNull();
    expect(store.status()).toBe('Imported 1 file (1 unsupported skipped)');
  });

  it('loads previews for sources on the timeline and converts on failure', async () => {
    TestBed.tick();
    await vi.waitFor(() => expect(store.previews().get('src-video')?.status).toBe('ready'));
    expect(backend.previewRequests).toEqual([
      { sourceId: 'src-video', convert: false },
      { sourceId: 'src-logo', convert: false },
    ]);
    expect(backend.calls).toEqual([]);

    store.previewFailed('src-video');
    await vi.waitFor(() =>
      expect(store.previews().get('src-video')).toEqual({
        status: 'ready',
        url: 'asset://converted/src-video',
        converted: true,
      }),
    );
    store.previewFailed('src-video');
    expect(store.previews().get('src-video')?.status).toBe('error');
  });

  it('reports preview errors from the backend', async () => {
    backend.previewError = 'FFmpeg was not found';
    TestBed.tick();
    await vi.waitFor(() =>
      expect(store.previews().get('src-logo')).toEqual({
        status: 'error',
        message: 'FFmpeg was not found',
      }),
    );
  });
});
