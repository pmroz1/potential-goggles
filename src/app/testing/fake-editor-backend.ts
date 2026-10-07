import { EditorBackend } from '../core/editor-backend';
import {
  Clip,
  EditOp,
  EditorSnapshot,
  EditResponse,
  Id,
  MediaBackendStatus,
  Project,
  Ticks,
  findClip,
  tracksByZ,
} from '../core/models';
import { secondsToTicks } from '../core/time';

const s = secondsToTicks;
const transform = { x: 0, y: 0, scale: 1, scaleX: 1, scaleY: 1, rotation: 0 };

/** Small fixture mirroring `editor_core::demo::demo_project`. */
export function fixtureProject(): Project {
  return {
    id: 'project',
    name: 'Test Project',
    revision: 0,
    media: [
      {
        id: 'src-video',
        name: 'interview.mp4',
        path: 'media/interview.mp4',
        kind: 'video',
        duration: s(120),
        width: 1920,
        height: 1080,
      },
      {
        id: 'src-logo',
        name: 'logo.png',
        path: 'media/logo.png',
        kind: 'image',
        duration: s(3600),
        width: 1920,
        height: 1080,
      },
    ],
    sequences: [
      {
        id: 'seq-main',
        name: 'Main Edit',
        frameRate: { numerator: 30, denominator: 1 },
        resolution: { width: 1920, height: 1080 },
        tracks: [
          {
            id: 'a1',
            name: 'A1',
            kind: 'audio',
            zIndex: 0,
            blendMode: 'normal',
            visible: true,
            muted: false,
            locked: false,
            clips: [],
          },
          {
            id: 'v1',
            name: 'V1',
            kind: 'video',
            zIndex: 1,
            blendMode: 'normal',
            visible: true,
            muted: false,
            locked: false,
            clips: [
              {
                id: 'clip-a',
                name: 'Interview A',
                source: { sourceId: 'src-video', inPoint: s(5) },
                start: 0,
                duration: s(8),
                transform,
                opacity: 1,
                color: '#4f7cff',
              },
              {
                id: 'clip-b',
                name: 'Interview B',
                source: { sourceId: 'src-video', inPoint: s(40) },
                start: s(8),
                duration: s(6),
                transform,
                opacity: 1,
                color: '#4f7cff',
              },
            ],
          },
          {
            id: 'v2',
            name: 'V2',
            kind: 'video',
            zIndex: 2,
            blendMode: 'normal',
            visible: true,
            muted: false,
            locked: false,
            clips: [
              {
                id: 'logo',
                name: 'Logo',
                source: { sourceId: 'src-logo', inPoint: 0 },
                start: s(2),
                duration: s(12),
                transform: { ...transform, x: 760, y: -400, scale: 0.2 },
                opacity: 1,
                color: '#ff9f43',
              },
            ],
          },
        ],
      },
      {
        id: 'seq-social',
        name: 'Social Cut',
        frameRate: { numerator: 30, denominator: 1 },
        resolution: { width: 1080, height: 1920 },
        tracks: [],
      },
    ],
  };
}

export type BackendCall =
  | { method: 'apply'; op: EditOp }
  | { method: 'copyClips'; sequenceId: Id; clipIds: Id[] }
  | { method: 'pasteClips'; sequenceId: Id; at: Ticks; baseTrackId: Id | null }
  | { method: 'undo' | 'redo' | 'newProject' | 'openProject' | 'cancelExport' }
  | { method: 'exportSequence'; sequenceId: Id; defaultName: string }
  | { method: 'saveProject'; currentPath: string | null }
  | { method: 'chooseMediaFiles' }
  | { method: 'importMedia'; paths: string[] };

/**
 * In-memory backend that records every call. `apply` for `moveClip`,
 * `setClipTransform`, `trimClip` and `splitClips` updates the fixture so the UI can be observed re-rendering.
 */
export class FakeEditorBackend extends EditorBackend {
  readonly calls: BackendCall[] = [];
  failWith: string | null = null;
  private copiedClips: { clip: Clip; trackId: Id; laneOffset: number; timeOffset: Ticks }[] = [];
  private nextPastedId = 0;
  snapshot: EditorSnapshot = {
    project: fixtureProject(),
    canUndo: false,
    canRedo: false,
    clipboard: null,
    path: null,
  };

  async getState(): Promise<EditorSnapshot> {
    return structuredClone(this.snapshot);
  }

  async apply(op: EditOp): Promise<EditResponse> {
    this.calls.push({ method: 'apply', op });
    this.throwIfFailing();
    const project = this.snapshot.project;
    if (op.type === 'moveClip' || op.type === 'setClipTransform') {
      const sequence = project.sequences.find((q) => q.id === op.sequenceId)!;
      const from = sequence.tracks.find((t) => t.clips.some((c) => c.id === op.clipId))!;
      const clip = from.clips.find((c) => c.id === op.clipId)!;
      if (op.type === 'moveClip') {
        from.clips = from.clips.filter((c) => c !== clip);
        const to = sequence.tracks.find((t) => t.id === op.trackId)!;
        to.clips = [...to.clips, { ...clip, start: op.start }].sort((a, b) => a.start - b.start);
      } else {
        clip.transform = op.transform;
      }
    }
    let createdClipIds: Id[] = [];
    if (op.type === 'trimClip') {
      const sequence = project.sequences.find((q) => q.id === op.sequenceId)!;
      const { clip } = findClip(sequence, op.clipId)!;
      clip.start = op.start;
      clip.source = { ...clip.source, inPoint: op.inPoint };
      clip.duration = op.duration;
    }
    if (op.type === 'splitClips') {
      const sequence = project.sequences.find((q) => q.id === op.sequenceId)!;
      createdClipIds = op.clipIds.map((id) => {
        const { track, clip } = findClip(sequence, id)!;
        const offset = op.at - clip.start;
        const right: Clip = {
          ...structuredClone(clip),
          id: `${clip.id}-split-${project.revision}`,
          start: op.at,
          duration: clip.duration - offset,
          source: { ...clip.source, inPoint: clip.source.inPoint + offset },
        };
        clip.duration = offset;
        track.clips = [...track.clips, right].sort((a, b) => a.start - b.start);
        return right.id;
      });
    }
    if (op.type === 'renameProject') {
      project.name = op.name;
    }
    let createdTrackId: Id | null = null;
    if (
      op.type === 'addTrack' ||
      op.type === 'removeTrack' ||
      op.type === 'setSequenceResolution'
    ) {
      const sequence = project.sequences.find((q) => q.id === op.sequenceId)!;
      if (op.type === 'setSequenceResolution') {
        sequence.resolution = op.resolution;
      } else if (op.type === 'removeTrack') {
        sequence.tracks = sequence.tracks.filter((t) => t.id !== op.trackId);
      } else {
        const zs = sequence.tracks.map((t) => t.zIndex);
        const count = sequence.tracks.filter((t) => t.kind === op.kind).length;
        createdTrackId = `track-${project.revision}`;
        sequence.tracks.push({
          id: createdTrackId,
          name: op.name ?? `${op.kind === 'video' ? 'V' : 'A'}${count + 1}`,
          kind: op.kind,
          zIndex: op.kind === 'video' ? Math.max(0, ...zs) + 1 : Math.min(0, ...zs) - 1,
          blendMode: 'normal',
          visible: true,
          muted: false,
          locked: false,
          clips: [],
        });
      }
    }
    if (op.type === 'addClip') {
      const track = project.sequences
        .find((q) => q.id === op.sequenceId)!
        .tracks.find((t) => t.id === op.trackId)!;
      const source = project.media.find((m) => m.id === op.sourceId)!;
      track.clips.push({
        id: `added-${project.revision}`,
        name: source.name,
        source: { sourceId: source.id, inPoint: 0 },
        start: op.start,
        duration: op.duration ?? source.duration,
        transform,
        opacity: 1,
        color: '#4f7cff',
      });
      track.clips.sort((a, b) => a.start - b.start);
    }
    project.revision += 1;
    this.snapshot = { ...this.snapshot, canUndo: true };
    return {
      snapshot: structuredClone(this.snapshot),
      outcome: {
        revision: project.revision,
        createdClipIds,
        createdSequenceId: null,
        createdTrackId,
      },
    };
  }

  async undo(): Promise<EditorSnapshot> {
    this.calls.push({ method: 'undo' });
    return structuredClone(this.snapshot);
  }

  async redo(): Promise<EditorSnapshot> {
    this.calls.push({ method: 'redo' });
    return structuredClone(this.snapshot);
  }

  async copyClips(sequenceId: Id, clipIds: Id[]): Promise<EditorSnapshot> {
    this.calls.push({ method: 'copyClips', sequenceId, clipIds });
    this.throwIfFailing();
    const sequence = this.snapshot.project.sequences.find((q) => q.id === sequenceId)!;
    const stack = tracksByZ(sequence);
    const clips = clipIds.map((id) => findClip(sequence, id)!);
    const firstLane = Math.min(...clips.map(({ track }) => stack.indexOf(track)));
    const firstStart = Math.min(...clips.map(({ clip }) => clip.start));
    this.copiedClips = clips.map(({ track, clip }) => ({
      clip: structuredClone(clip),
      trackId: track.id,
      laneOffset: stack.indexOf(track) - firstLane,
      timeOffset: clip.start - firstStart,
    }));
    this.snapshot = {
      ...this.snapshot,
      clipboard: { clipCount: clipIds.length, sourceSequenceId: sequenceId },
    };
    return structuredClone(this.snapshot);
  }

  async pasteClips(sequenceId: Id, at: Ticks, baseTrackId: Id | null): Promise<EditResponse> {
    this.calls.push({ method: 'pasteClips', sequenceId, at, baseTrackId });
    this.throwIfFailing();
    const sequence = this.snapshot.project.sequences.find((q) => q.id === sequenceId)!;
    const stack = tracksByZ(sequence);
    const baseLane = stack.findIndex((track) => track.id === baseTrackId);
    const createdClipIds: Id[] = [];
    for (const entry of this.copiedClips) {
      const track =
        baseLane >= 0
          ? stack[baseLane + entry.laneOffset]
          : sequence.tracks.find((t) => t.id === entry.trackId)!;
      const id = `pasted-${++this.nextPastedId}`;
      track.clips.push({ ...structuredClone(entry.clip), id, start: at + entry.timeOffset });
      track.clips.sort((a, b) => a.start - b.start);
      createdClipIds.push(id);
    }
    this.snapshot.project.revision += 1;
    this.snapshot.canUndo = true;
    return {
      snapshot: structuredClone(this.snapshot),
      outcome: {
        revision: this.snapshot.project.revision,
        createdClipIds,
        createdSequenceId: null,
      },
    };
  }

  async newProject(): Promise<EditorSnapshot> {
    this.calls.push({ method: 'newProject' });
    this.snapshot = {
      project: { id: 'new', name: 'Untitled Project', revision: 0, media: [], sequences: [] },
      canUndo: false,
      canRedo: false,
      clipboard: null,
      path: null,
    };
    return structuredClone(this.snapshot);
  }

  async openProject(): Promise<EditorSnapshot | null> {
    this.calls.push({ method: 'openProject' });
    return null;
  }

  async saveProject(currentPath: string | null): Promise<EditorSnapshot | null> {
    this.calls.push({ method: 'saveProject', currentPath });
    this.throwIfFailing();
    this.snapshot = { ...this.snapshot, path: currentPath ?? '/tmp/test.pgproj' };
    return structuredClone(this.snapshot);
  }

  chosenFiles: string[] | null = null;

  async chooseMediaFiles(): Promise<string[] | null> {
    this.calls.push({ method: 'chooseMediaFiles' });
    return this.chosenFiles;
  }

  /** Resolves when released; lets tests observe the in-progress state. */
  importGate: Promise<void> | null = null;

  async importMedia(paths: string[]): Promise<EditorSnapshot> {
    this.calls.push({ method: 'importMedia', paths });
    await this.importGate;
    this.throwIfFailing();
    for (const path of paths.filter((p) => !p.endsWith('.txt'))) {
      this.snapshot.project.media.push({
        id: `imported-${this.snapshot.project.media.length}`,
        name: path.split('/').pop()!,
        path,
        kind: 'video',
        duration: s(10),
        width: 1920,
        height: 1080,
      });
    }
    return structuredClone(this.snapshot);
  }

  /** Preview requests (kept apart from `calls`, which tracks edits). */
  readonly previewRequests: { sourceId: Id; convert: boolean }[] = [];
  previewError: string | null = null;

  async previewUrl(sourceId: Id, convert: boolean): Promise<string> {
    this.previewRequests.push({ sourceId, convert });
    if (this.previewError) {
      throw this.previewError;
    }
    return `asset://${convert ? 'converted/' : ''}${sourceId}`;
  }

  exportResult: string | null = '/tmp/out.mp4';
  exportGate: Promise<void> | null = null;

  async exportSequence(
    sequenceId: Id,
    defaultName: string,
    onProgress: (fraction: number) => void,
  ): Promise<string | null> {
    this.calls.push({ method: 'exportSequence', sequenceId, defaultName });
    this.throwIfFailing();
    onProgress(0.5);
    await this.exportGate;
    return this.exportResult;
  }

  async cancelExport(): Promise<void> {
    this.calls.push({ method: 'cancelExport' });
  }

  async onFilesDropped(): Promise<() => void> {
    return () => undefined;
  }

  mediaBackend: MediaBackendStatus = {
    name: 'ffmpeg',
    available: true,
    canDecode: false,
    canExport: true,
    detail: 'ffmpeg test',
  };

  async mediaStatus(): Promise<MediaBackendStatus> {
    return this.mediaBackend;
  }

  private throwIfFailing(): void {
    if (this.failWith) {
      throw this.failWith;
    }
  }
}
