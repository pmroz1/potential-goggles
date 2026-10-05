import { EditorBackend } from '../core/editor-backend';
import {
  EditOp,
  EditorSnapshot,
  EditResponse,
  Id,
  MediaBackendStatus,
  Project,
  Ticks,
} from '../core/models';
import { secondsToTicks } from '../core/time';

const s = secondsToTicks;
const transform = { x: 0, y: 0, scale: 1, rotation: 0 };

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
                transform: { x: 760, y: -400, scale: 0.2, rotation: 0 },
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
  | { method: 'undo' | 'redo' };

/**
 * In-memory backend that records every call. `apply` for `moveClip` and
 * `setClipTransform` updates the fixture so the UI can be observed re-rendering.
 */
export class FakeEditorBackend extends EditorBackend {
  readonly calls: BackendCall[] = [];
  failWith: string | null = null;
  snapshot: EditorSnapshot = {
    project: fixtureProject(),
    canUndo: false,
    canRedo: false,
    clipboard: null,
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
    project.revision += 1;
    this.snapshot = { ...this.snapshot, canUndo: true };
    return {
      snapshot: structuredClone(this.snapshot),
      outcome: { revision: project.revision, createdClipIds: [], createdSequenceId: null },
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
    this.snapshot = {
      ...this.snapshot,
      clipboard: { clipCount: clipIds.length, sourceSequenceId: sequenceId },
    };
    return structuredClone(this.snapshot);
  }

  async pasteClips(sequenceId: Id, at: Ticks, baseTrackId: Id | null): Promise<EditResponse> {
    this.calls.push({ method: 'pasteClips', sequenceId, at, baseTrackId });
    this.throwIfFailing();
    return {
      snapshot: structuredClone(this.snapshot),
      outcome: {
        revision: this.snapshot.project.revision,
        createdClipIds: ['clip-a'],
        createdSequenceId: null,
      },
    };
  }

  async mediaStatus(): Promise<MediaBackendStatus> {
    return {
      name: 'ffmpeg',
      available: false,
      canDecode: false,
      canExport: false,
      detail: 'not linked',
    };
  }

  private throwIfFailing(): void {
    if (this.failWith) {
      throw this.failWith;
    }
  }
}
