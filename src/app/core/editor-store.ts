import { computed, inject, Injectable, PendingTasks, signal } from '@angular/core';

import { EditorBackend } from './editor-backend';
import {
  EditOp,
  EditorSnapshot,
  EditResponse,
  Id,
  MediaBackendStatus,
  MediaSource,
  Sequence,
  Ticks,
  Transform,
  findClip,
} from './models';
import { TICKS_PER_SECOND } from './time';

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
    });
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
    });
  }

  async importMedia(paths?: string[]): Promise<void> {
    const before = this.media().length;
    await this.run(async () => {
      const snapshot = await this.backend.importMedia(paths);
      if (snapshot) {
        this.setSnapshot(snapshot);
        const count = snapshot.project.media.length - before;
        this.status.set(`Imported ${count} file${count === 1 ? '' : 's'}`);
      }
    });
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
    const ok = await this.commit({
      type: 'addClip',
      sequenceId: sequence.id,
      trackId: track.id,
      sourceId: source.id,
      start,
      duration: null,
    });
    if (ok) {
      this.status.set(`Added ${source.name} to ${track.name}`);
    }
  }

  private resetView(snapshot: EditorSnapshot): void {
    this.selectedSequenceId.set(null);
    this.selection.set(new Set());
    this.targetTrackId.set(null);
    this.playhead.set(0);
    this.setSnapshot(snapshot);
  }

  async load(): Promise<void> {
    await this.run(async () => {
      this.setSnapshot(await this.backend.getState());
      this.mediaStatus.set(await this.backend.mediaStatus());
    });
  }

  selectSequence(id: Id): void {
    if (id !== this.activeSequence()?.id) {
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

  private async commit(op: EditOp): Promise<boolean> {
    return this.run(async () => this.applyResponse(await this.backend.apply(op)));
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

  private async run(action: () => Promise<void>): Promise<boolean> {
    // Keep the app "unstable" while a backend call is in flight.
    const done = this.pendingTasks.add();
    try {
      await action();
      this.error.set(null);
      return true;
    } catch (err) {
      this.error.set(
        typeof err === 'string' ? err : err instanceof Error ? err.message : String(err),
      );
      return false;
    } finally {
      done();
    }
  }
}
