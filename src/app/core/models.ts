/**
 * TypeScript mirror of the Rust `editor-core` model (serialized as camelCase).
 * The Rust core is the source of truth; the UI only renders snapshots and
 * sends edit operations back.
 */

/** UUID string. */
export type Id = string;

/** Integer timeline time in ticks (see `TICKS_PER_SECOND`). */
export type Ticks = number;

export interface FrameRate {
  numerator: number;
  denominator: number;
}

export interface Resolution {
  width: number;
  height: number;
}

export type MediaKind = 'video' | 'audio' | 'image';
export type TrackKind = 'video' | 'audio';
export type BlendMode = 'normal' | 'add' | 'multiply' | 'screen';

export interface MediaSource {
  id: Id;
  name: string;
  path: string;
  kind: MediaKind;
  duration: Ticks;
  width: number | null;
  height: number | null;
}

export interface Transform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
}

export interface SourceRef {
  sourceId: Id;
  inPoint: Ticks;
}

export interface Clip {
  id: Id;
  name: string;
  source: SourceRef;
  start: Ticks;
  duration: Ticks;
  transform: Transform;
  opacity: number;
  color: string;
}

export interface Track {
  id: Id;
  name: string;
  kind: TrackKind;
  /** Explicit compositing order: higher values are drawn on top. */
  zIndex: number;
  blendMode: BlendMode;
  visible: boolean;
  muted: boolean;
  locked: boolean;
  /** Non-overlapping, sorted by start. */
  clips: Clip[];
}

export interface Sequence {
  id: Id;
  name: string;
  frameRate: FrameRate;
  resolution: Resolution;
  tracks: Track[];
}

export interface Project {
  id: Id;
  name: string;
  revision: number;
  media: MediaSource[];
  sequences: Sequence[];
}

export interface ClipboardSummary {
  clipCount: number;
  sourceSequenceId: Id;
}

export interface EditorSnapshot {
  project: Project;
  canUndo: boolean;
  canRedo: boolean;
  clipboard: ClipboardSummary | null;
  /** File the project was last opened from or saved to. */
  path: string | null;
}

export interface EditOutcome {
  revision: number;
  createdClipIds: Id[];
  createdSequenceId: Id | null;
  createdSourceId?: Id | null;
}

export interface EditResponse {
  snapshot: EditorSnapshot;
  outcome: EditOutcome;
}

/** Edit operations accepted by the `apply_edit` command (`EditOp` in Rust). */
export type EditOp =
  | { type: 'moveClip'; sequenceId: Id; clipId: Id; trackId: Id; start: Ticks }
  | { type: 'setClipTransform'; sequenceId: Id; clipId: Id; transform: Transform }
  | { type: 'deleteClips'; sequenceId: Id; clipIds: Id[] }
  | { type: 'importMedia'; source: MediaSource }
  | {
      type: 'addClip';
      sequenceId: Id;
      trackId: Id;
      sourceId: Id;
      start: Ticks;
      duration: Ticks | null;
    }
  | { type: 'renameProject'; name: string }
  | { type: 'addSequence'; name: string; frameRate: FrameRate; resolution: Resolution };

export interface MediaBackendStatus {
  name: string;
  available: boolean;
  canDecode: boolean;
  canExport: boolean;
  detail: string;
}

/** Tracks ordered bottom → top by compositing order (stable for ties). */
export function tracksByZ(sequence: Sequence): Track[] {
  return sequence.tracks
    .map((track, index) => ({ track, index }))
    .sort((a, b) => a.track.zIndex - b.track.zIndex || a.index - b.index)
    .map(({ track }) => track);
}

export function findClip(sequence: Sequence, clipId: Id): { track: Track; clip: Clip } | null {
  for (const track of sequence.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) {
      return { track, clip };
    }
  }
  return null;
}
