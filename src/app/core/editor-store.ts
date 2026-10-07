import {
  computed,
  effect,
  inject,
  Injectable,
  PendingTasks,
  signal,
  untracked,
} from '@angular/core';

import { EditorBackend } from './editor-backend';
import {
  EditOp,
  EditorSnapshot,
  EditResponse,
  Id,
  MediaBackendStatus,
  MediaSource,
  Resolution,
  Sequence,
  Ticks,
  TrackKind,
  Transform,
  findClip,
  sequenceDuration,
} from './models';
import { TICKS_PER_SECOND } from './time';
import { FitMode, fitTransform, sourceSize, withSize } from './transform';

/** Viewport preview of a video or image source. */
export type PreviewState =
  | { status: 'loading'; converting: boolean }
  | { status: 'ready'; url: string; converted: boolean }
  | { status: 'error'; message: string };

/** A long-running backend task, shown with a loading indicator. */
export interface Activity {
  id: number;
  label: string;
}

let nextActivityId = 0;

function errorMessage(err: unknown): string {
  return typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * UI-side editor state. Holds the latest snapshot received from the Rust core
 * plus purely presentational state (selection, playhead, zoom). Every mutation
 * of the project goes through exactly one backend call.
 */
@Injectable({ providedIn: 'root' })
export class EditorStore {
  private readonly backend = inject(EditorBackend);
  private readonly pendingTasks = inject(PendingTasks);
  private clipboardActions: Promise<void> = Promise.resolve();

  readonly snapshot = signal<EditorSnapshot | null>(null);
  readonly mediaStatus = signal<MediaBackendStatus | null>(null);
  readonly selectedSequenceId = signal<Id | null>(null);
  readonly selection = signal<ReadonlySet<Id>>(new Set());
  /** Track that receives pasted clips (lowest copied lane). */
  readonly targetTrackId = signal<Id | null>(null);
  readonly playhead = signal<Ticks>(0);
  readonly pixelsPerSecond = signal(80);
  readonly status = signal('');
  readonly error = signal<string | null>(null);

  readonly project = computed(() => this.snapshot()?.project ?? null);
  readonly sequences = computed(() => this.project()?.sequences ?? []);
  readonly activeSequence = computed<Sequence | null>(() => {
    const sequences = this.sequences();
    return sequences.find((s) => s.id === this.selectedSequenceId()) ?? sequences[0] ?? null;
  });
  readonly pixelsPerTick = computed(() => this.pixelsPerSecond() / TICKS_PER_SECOND);
  readonly selectedClips = computed(() => {
    const sequence = this.activeSequence();
    if (!sequence) {
      return [];
    }
    return [...this.selection()].flatMap((id) => {
      const found = findClip(sequence, id);
      return found ? [found] : [];
    });
  });

  readonly media = computed(() => this.project()?.media ?? []);
  /** True while a file is being dragged over the window. */
  readonly dropActive = signal(false);

  /** Backend tasks in flight that the user is waiting for. */
  readonly activities = signal<readonly Activity[]>([]);
  /** Label of the most recent task in flight, or `null` when idle. */
  readonly activity = computed(() => this.activities().at(-1)?.label ?? null);
  /** Files being imported right now (shown as placeholders in the media bin). */
  readonly importing = signal<readonly Activity[]>([]);
  /** Viewport previews by source id. */
  readonly previews = signal<ReadonlyMap<Id, PreviewState>>(new Map());
  readonly previewsLoading = computed(
    () => [...this.previews().values()].filter((p) => p.status === 'loading').length,
  );

  readonly playing = signal(false);
  /** Export progress in 0..1, or `null` when no export is running. */
  readonly exportProgress = signal<number | null>(null);
  readonly sequenceEnd = computed(() => {
    const sequence = this.activeSequence();
    return sequence ? sequenceDuration(sequence) : 0;
  });
  readonly canExport = computed(
    () => (this.mediaStatus()?.canExport ?? false) && this.sequenceEnd() > 0,
  );
  private playbackFrame: number | null = null;

  constructor() {
    // Prepare previews for every visual source used by the active sequence,
    // so conversions start as soon as a clip is placed on the timeline.
    effect(() => {
      const sequence = this.activeSequence();
      const media = this.media();
      if (!sequence) {
        return;
      }
      const used = new Set(sequence.tracks.flatMap((t) => t.clips.map((c) => c.source.sourceId)));
      untracked(() => media.filter((m) => used.has(m.id)).forEach((m) => this.ensurePreview(m)));
    });
  }

  /** Starts loading the viewport preview for `source` unless already known. */
  ensurePreview(source: MediaSource): void {
    if (source.kind !== 'audio' && !this.previews().has(source.id)) {
      void this.loadPreview(source.id, false);
    }
  }

  /**
   * Called when the viewport cannot decode a preview: retries once with an
   * FFmpeg conversion, then reports the source as unplayable.
   */
  previewFailed(sourceId: Id): void {
    const current = this.previews().get(sourceId);
    if (current?.status !== 'ready') {
      return;
    }
    if (!current.converted) {
      void this.loadPreview(sourceId, true);
    } else {
      this.setPreview(sourceId, { status: 'error', message: 'This file cannot be previewed' });
    }
  }

  private async loadPreview(sourceId: Id, convert: boolean): Promise<void> {
    this.setPreview(sourceId, { status: 'loading', converting: convert });
    const done = this.pendingTasks.add();
    try {
      const url = await this.backend.previewUrl(sourceId, convert);
      this.setPreview(sourceId, { status: 'ready', url, converted: convert });
    } catch (err) {
      this.setPreview(sourceId, { status: 'error', message: errorMessage(err) });
    } finally {
      done();
    }
  }

  private setPreview(sourceId: Id, state: PreviewState): void {
    this.previews.update((map) => new Map(map).set(sourceId, state));
  }

  /** Starts advancing the playhead in real time; restarts from 0 at the end. */
  play(): void {
    const end = this.sequenceEnd();
    if (this.playing() || end <= 0) {
      return;
    }
    if (this.playhead() >= end) {
      this.playhead.set(0);
    }
    this.playing.set(true);
    let last: number | null = null;
    const tick = (now: number) => {
      if (!this.playing()) {
        return;
      }
      const stop = this.sequenceEnd();
      const next = this.playhead() + ((now - (last ?? now)) * TICKS_PER_SECOND) / 1000;
      last = now;
      if (next >= stop) {
        this.playhead.set(stop);
        this.pause();
      } else {
        this.playhead.set(Math.round(next));
        this.playbackFrame = requestAnimationFrame(tick);
      }
    };
    this.playbackFrame = requestAnimationFrame(tick);
  }

  pause(): void {
    this.playing.set(false);
    if (this.playbackFrame !== null) {
      cancelAnimationFrame(this.playbackFrame);
      this.playbackFrame = null;
    }
  }

  togglePlayback(): void {
    if (this.playing()) {
      this.pause();
    } else {
      this.play();
    }
  }

  stop(): void {
    this.pause();
    this.playhead.set(0);
  }

  async exportSequence(): Promise<void> {
    const sequence = this.activeSequence();
    if (!sequence || this.exportProgress() !== null) {
      return;
    }
    this.pause();
    this.exportProgress.set(0);
    const ok = await this.run(async () => {
      const path = await this.backend.exportSequence(sequence.id, sequence.name, (fraction) =>
        this.exportProgress.set(fraction),
      );
      if (path) {
        this.status.set(`Exported ${path}`);
      }
    });
    this.exportProgress.set(null);
    if (!ok && this.error()?.includes('cancelled')) {
      this.error.set(null);
      this.status.set('Export cancelled');
    }
  }

  async cancelExport(): Promise<void> {
    if (this.exportProgress() !== null) {
      await this.backend.cancelExport();
    }
  }

  async newProject(): Promise<void> {
    await this.run(async () => {
      this.resetView(await this.backend.newProject());
      this.status.set('New project');
    });
  }

  async openProject(): Promise<void> {
    await this.run(async () => {
      const snapshot = await this.backend.openProject();
      if (snapshot) {
        this.resetView(snapshot);
        this.status.set(`Opened ${snapshot.project.name}`);
      }
    }, 'Opening project…');
  }

  async saveProject(saveAs = false): Promise<void> {
    await this.run(async () => {
      const snapshot = await this.backend.saveProject(
        saveAs ? null : (this.snapshot()?.path ?? null),
      );
      if (snapshot) {
        this.setSnapshot(snapshot);
        this.status.set(`Saved to ${snapshot.path}`);
      }
    }, 'Saving project…');
  }

  /** Imports `paths`, or files chosen in a dialog when omitted. */
  async importMedia(paths?: string[]): Promise<void> {
    let files = paths ?? null;
    if (!files && !(await this.run(async () => (files = await this.backend.chooseMediaFiles())))) {
      return;
    }
    if (!files || files.length === 0) {
      return;
    }
    const chosen: string[] = files;
    const placeholders = chosen.map((path) => ({
      id: ++nextActivityId,
      label: path.split(/[\\/]/).pop() || path,
    }));
    this.importing.update((current) => [...current, ...placeholders]);
    try {
      await this.run(
        async () => {
          const before = new Set(this.media().map((m) => m.id));
          const snapshot = await this.backend.importMedia(chosen);
          this.setSnapshot(snapshot);
          const count = snapshot.project.media.filter((m) => !before.has(m.id)).length;
          const skipped = chosen.length - count;
          this.status.set(
            `Imported ${plural(count, 'file')}` +
              (skipped > 0 ? ` (${skipped} unsupported skipped)` : ''),
          );
        },
        `Importing ${chosen.length === 1 ? placeholders[0].label : plural(chosen.length, 'file')}…`,
      );
    } finally {
      this.importing.update((current) => current.filter((item) => !placeholders.includes(item)));
    }
  }

  async renameProject(name: string): Promise<void> {
    const trimmed = name.trim();
    if (trimmed && trimmed !== this.project()?.name) {
      await this.commit({ type: 'renameProject', name: trimmed });
    }
  }

  /**
   * Places a media source on the timeline: at the playhead on a track of the
   * matching kind (the target track when suitable), or after the last clip on
   * that track when the playhead position is occupied.
   */
  async addToTimeline(source: MediaSource): Promise<void> {
    const sequence = this.activeSequence();
    if (!sequence) {
      return;
    }
    const kind = source.kind === 'audio' ? 'audio' : 'video';
    const candidates = sequence.tracks.filter((t) => t.kind === kind && !t.locked);
    const track =
      candidates.find((t) => t.id === this.targetTrackId()) ??
      (kind === 'video' ? [...candidates].sort((a, b) => a.zIndex - b.zIndex) : candidates)[0];
    if (!track) {
      this.error.set(`No unlocked ${kind} track available`);
      return;
    }
    const playhead = this.playhead();
    const end = playhead + source.duration;
    const occupied = track.clips.some((c) => c.start < end && c.start + c.duration > playhead);
    const start = occupied
      ? track.clips.reduce((latest, c) => Math.max(latest, c.start + c.duration), 0)
      : playhead;
    const ok = await this.commit(
      {
        type: 'addClip',
        sequenceId: sequence.id,
        trackId: track.id,
        sourceId: source.id,
        start,
        duration: null,
      },
      `Adding ${source.name} to ${track.name}…`,
    );
    if (ok) {
      this.status.set(`Added ${source.name} to ${track.name}`);
    }
  }

  /** Adds an empty video (top of the stack) or audio (bottom) track. */
  async addTrack(kind: TrackKind): Promise<void> {
    const sequenceId = this.activeSequence()?.id;
    if (!sequenceId) {
      return;
    }
    await this.run(async () => {
      const response = await this.backend.apply({ type: 'addTrack', sequenceId, kind, name: null });
      this.applyResponse(response);
      const id = response.outcome.createdTrackId;
      const track = this.activeSequence()?.tracks.find((t) => t.id === id);
      if (track) {
        this.targetTrackId.set(track.id);
        this.status.set(`Added track ${track.name}`);
      }
    }, `Adding ${kind} track…`);
  }

  /** Removes a track and its clips (undoable). */
  async removeTrack(trackId: Id): Promise<void> {
    const sequence = this.activeSequence();
    const track = sequence?.tracks.find((t) => t.id === trackId);
    if (!sequence || !track) {
      return;
    }
    const ok = await this.commit(
      { type: 'removeTrack', sequenceId: sequence.id, trackId },
      `Removing track ${track.name}…`,
    );
    if (ok) {
      if (this.targetTrackId() === trackId) {
        this.targetTrackId.set(null);
      }
      const clips = track.clips.length;
      this.status.set(
        `Removed track ${track.name}` +
          (clips > 0 ? ` and ${plural(clips, 'clip')} (Undo restores them)` : ''),
      );
    }
  }

  /** Changes the active sequence's frame size (aspect ratio). */
  async setSequenceResolution(resolution: Resolution): Promise<void> {
    const sequence = this.activeSequence();
    const { width, height } = resolution;
    if (
      !sequence ||
      (sequence.resolution.width === width && sequence.resolution.height === height)
    ) {
      return;
    }
    if (await this.commit({ type: 'setSequenceResolution', sequenceId: sequence.id, resolution })) {
      this.status.set(`${sequence.name} is now ${width}×${height}`);
    }
  }

  /** Fits, fills or stretches a clip to the frame, or restores its proportions. */
  fitClip(clipId: Id, mode: FitMode): Promise<boolean> {
    const found = this.clipContext(clipId);
    if (!found) {
      return Promise.resolve(false);
    }
    const { transform, source, frame } = found;
    return this.setClipTransform(clipId, fitTransform(mode, transform, source, frame));
  }

  /** Resizes a clip to `width` × `height` sequence pixels (may change its proportions). */
  setClipSize(clipId: Id, width: number, height: number): Promise<boolean> {
    const found = this.clipContext(clipId);
    if (!found || !(width > 0) || !(height > 0)) {
      return Promise.resolve(false);
    }
    return this.setClipTransform(clipId, withSize(found.transform, found.source, width, height));
  }

  private clipContext(clipId: Id) {
    const sequence = this.activeSequence();
    const clip = sequence && findClip(sequence, clipId)?.clip;
    if (!sequence || !clip) {
      return null;
    }
    const source = this.media().find((m) => m.id === clip.source.sourceId);
    return {
      transform: clip.transform,
      source: sourceSize(source, sequence.resolution),
      frame: sequence.resolution,
    };
  }

  private resetView(snapshot: EditorSnapshot): void {
    this.pause();
    this.clearFailedPreviews();
    this.selectedSequenceId.set(null);
    this.selection.set(new Set());
    this.targetTrackId.set(null);
    this.playhead.set(0);
    this.setSnapshot(snapshot);
  }

  /** Forgets previews that failed so they are retried (e.g. after installing FFmpeg). */
  private clearFailedPreviews(): void {
    this.previews.update(
      (map) => new Map([...map].filter(([, preview]) => preview.status !== 'error')),
    );
  }

  async load(): Promise<void> {
    this.clearFailedPreviews();
    await this.run(async () => {
      this.setSnapshot(await this.backend.getState());
      this.mediaStatus.set(await this.backend.mediaStatus());
    });
  }

  selectSequence(id: Id): void {
    if (id !== this.activeSequence()?.id) {
      this.pause();
      this.selectedSequenceId.set(id);
      this.selection.set(new Set());
      this.targetTrackId.set(null);
      this.playhead.set(0);
    }
  }

  selectClip(id: Id, additive: boolean): void {
    this.selection.update((current) => {
      if (!additive) {
        return current.has(id) && current.size === 1 ? current : new Set([id]);
      }
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  clearSelection(): void {
    this.selection.set(new Set());
  }

  setTargetTrack(id: Id | null): void {
    this.targetTrackId.set(id);
  }

  setPlayhead(time: Ticks): void {
    this.playhead.set(Math.max(0, Math.round(time)));
  }

  zoom(factor: number): void {
    this.pixelsPerSecond.update((pps) => Math.min(800, Math.max(10, pps * factor)));
  }

  /** Commits a completed timeline drag as a single `moveClip` operation. */
  moveClip(clipId: Id, trackId: Id, start: Ticks): Promise<boolean> {
    const sequenceId = this.activeSequence()?.id;
    if (!sequenceId) {
      return Promise.resolve(false);
    }
    return this.commit({ type: 'moveClip', sequenceId, clipId, trackId, start });
  }

  /** Commits a completed viewport drag as a single `setClipTransform` operation. */
  setClipTransform(clipId: Id, transform: Transform): Promise<boolean> {
    const sequenceId = this.activeSequence()?.id;
    if (!sequenceId) {
      return Promise.resolve(false);
    }
    return this.commit({ type: 'setClipTransform', sequenceId, clipId, transform });
  }

  async deleteSelection(): Promise<void> {
    const sequenceId = this.activeSequence()?.id;
    const clipIds = [...this.selection()];
    if (
      sequenceId &&
      clipIds.length > 0 &&
      (await this.commit({ type: 'deleteClips', sequenceId, clipIds }))
    ) {
      this.selection.set(new Set());
    }
  }

  async addSequence(): Promise<void> {
    const template = this.activeSequence();
    const name = `Sequence ${this.sequences().length + 1}`;
    await this.run(async () => {
      const response = await this.backend.apply({
        type: 'addSequence',
        name,
        frameRate: template?.frameRate ?? { numerator: 30, denominator: 1 },
        resolution: template?.resolution ?? { width: 1920, height: 1080 },
      });
      this.applyResponse(response);
      if (response.outcome.createdSequenceId) {
        this.selectSequence(response.outcome.createdSequenceId);
      }
      this.status.set(`Added ${name}`);
    });
  }

  async copySelection(): Promise<void> {
    const sequenceId = this.activeSequence()?.id;
    const clipIds = [...this.selection()];
    if (!sequenceId || clipIds.length === 0) {
      this.status.set('Nothing selected to copy');
      return;
    }
    await this.queueClipboardAction(async () => {
      await this.run(async () => {
        this.setSnapshot(await this.backend.copyClips(sequenceId, clipIds));
        this.status.set(`Copied ${clipIds.length} clip${clipIds.length === 1 ? '' : 's'}`);
      });
    });
  }

  /** Pastes the editor clipboard at the playhead, onto the target track if set. */
  async paste(): Promise<void> {
    const sequence = this.activeSequence();
    const target = this.targetTrackId();
    const at = this.playhead();
    await this.queueClipboardAction(async () => {
      if (!sequence || !this.snapshot()?.clipboard) {
        this.status.set('Clipboard is empty');
        return;
      }
      const baseTrackId = target && sequence.tracks.some((t) => t.id === target) ? target : null;
      await this.run(async () => {
        const response = await this.backend.pasteClips(sequence.id, at, baseTrackId);
        this.applyResponse(response);
        this.selection.set(new Set(response.outcome.createdClipIds));
        const count = response.outcome.createdClipIds.length;
        this.status.set(`Pasted ${count} clip${count === 1 ? '' : 's'}`);
      });
    });
  }

  private queueClipboardAction(action: () => Promise<void>): Promise<void> {
    const pending = this.clipboardActions.then(action);
    this.clipboardActions = pending.catch(() => {});
    return pending;
  }

  async undo(): Promise<void> {
    await this.run(async () => this.setSnapshot(await this.backend.undo()));
  }

  async redo(): Promise<void> {
    await this.run(async () => this.setSnapshot(await this.backend.redo()));
  }

  private async commit(op: EditOp, label?: string): Promise<boolean> {
    return this.run(async () => this.applyResponse(await this.backend.apply(op)), label);
  }

  private applyResponse(response: EditResponse): void {
    this.setSnapshot(response.snapshot);
  }

  private setSnapshot(snapshot: EditorSnapshot): void {
    this.snapshot.set(snapshot);
    // Drop selections that no longer exist (e.g. after undo or delete).
    const sequence = this.activeSequence();
    const selection = this.selection();
    if (sequence && [...selection].some((id) => !findClip(sequence, id))) {
      this.selection.set(new Set([...selection].filter((id) => findClip(sequence, id))));
    }
  }

  /** Runs a backend call; a `label` shows a loading indicator while it runs. */
  private async run(action: () => Promise<unknown>, label?: string): Promise<boolean> {
    // Keep the app "unstable" while a backend call is in flight.
    const done = this.pendingTasks.add();
    const activity = label ? { id: ++nextActivityId, label } : null;
    if (activity) {
      this.activities.update((current) => [...current, activity]);
    }
    try {
      await action();
      this.error.set(null);
      return true;
    } catch (err) {
      this.error.set(errorMessage(err));
      return false;
    } finally {
      if (activity) {
        this.activities.update((current) => current.filter((a) => a !== activity));
      }
      done();
    }
  }
}
