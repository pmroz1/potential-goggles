import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';

import { EditOp, EditorSnapshot, EditResponse, Id, MediaBackendStatus, Ticks } from './models';

/**
 * Boundary between the UI and the Rust editing core. All calls are coarse
 * grained: the UI never calls the backend during an interactive gesture, only
 * when an edit is committed.
 */
export abstract class EditorBackend {
  abstract getState(): Promise<EditorSnapshot>;
  abstract apply(op: EditOp): Promise<EditResponse>;
  abstract undo(): Promise<EditorSnapshot>;
  abstract redo(): Promise<EditorSnapshot>;
  abstract copyClips(sequenceId: Id, clipIds: Id[]): Promise<EditorSnapshot>;
  abstract pasteClips(sequenceId: Id, at: Ticks, baseTrackId: Id | null): Promise<EditResponse>;
  abstract mediaStatus(): Promise<MediaBackendStatus>;
}

/** Talks to the commands registered in `src-tauri/src/lib.rs`. */
@Injectable()
export class TauriEditorBackend extends EditorBackend {
  getState(): Promise<EditorSnapshot> {
    return invoke('get_editor_state');
  }

  apply(op: EditOp): Promise<EditResponse> {
    return invoke('apply_edit', { op });
  }

  undo(): Promise<EditorSnapshot> {
    return invoke('undo');
  }

  redo(): Promise<EditorSnapshot> {
    return invoke('redo');
  }

  copyClips(sequenceId: Id, clipIds: Id[]): Promise<EditorSnapshot> {
    return invoke('copy_clips', { sequenceId, clipIds });
  }

  pasteClips(sequenceId: Id, at: Ticks, baseTrackId: Id | null): Promise<EditResponse> {
    return invoke('paste_clips', { sequenceId, at, baseTrackId });
  }

  mediaStatus(): Promise<MediaBackendStatus> {
    return invoke('media_backend_status');
  }
}
