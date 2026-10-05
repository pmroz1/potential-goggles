import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open, save } from '@tauri-apps/plugin-dialog';

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
  abstract newProject(): Promise<EditorSnapshot>;
  /** Asks for a project file and opens it; resolves `null` when cancelled. */
  abstract openProject(): Promise<EditorSnapshot | null>;
  /** Saves to `currentPath`, or asks for a location; resolves `null` when cancelled. */
  abstract saveProject(currentPath: string | null): Promise<EditorSnapshot | null>;
  /** Imports `paths`, or asks for files when omitted; resolves `null` when cancelled. */
  abstract importMedia(paths?: string[]): Promise<EditorSnapshot | null>;
  /**
   * Asks where to save, then renders the sequence. Resolves the output path, or
   * `null` when the save dialog is cancelled. `onProgress` receives 0..1.
   */
  abstract exportSequence(
    sequenceId: Id,
    defaultName: string,
    onProgress: (fraction: number) => void,
  ): Promise<string | null>;
  abstract cancelExport(): Promise<void>;
  /** Subscribes to files dropped onto the window. Returns an unsubscribe function. */
  abstract onFilesDropped(
    handler: (paths: string[]) => void,
    onHover?: (active: boolean) => void,
  ): Promise<() => void>;
}

const PROJECT_FILTER = [{ name: 'Potential Goggles project', extensions: ['pgproj'] }];
const MEDIA_FILTER = [
  {
    name: 'Media',
    extensions: [
      ...['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'wmv'],
      ...['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'opus'],
      ...['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'],
    ],
  },
];

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

  async exportSequence(
    sequenceId: Id,
    defaultName: string,
    onProgress: (fraction: number) => void,
  ): Promise<string | null> {
    const path = await save({
      defaultPath: `${defaultName}.mp4`,
      filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
    });
    if (!path) {
      return null;
    }
    const unlisten = await listen<number>('export-progress', (event) => onProgress(event.payload));
    try {
      return await invoke<string>('export_sequence', { sequenceId, path });
    } finally {
      unlisten();
    }
  }

  async cancelExport(): Promise<void> {
    await invoke('cancel_export');
  }

  newProject(): Promise<EditorSnapshot> {
    return invoke('new_project');
  }

  async openProject(): Promise<EditorSnapshot | null> {
    const path = await open({ multiple: false, directory: false, filters: PROJECT_FILTER });
    return path ? invoke('open_project', { path }) : null;
  }

  async saveProject(currentPath: string | null): Promise<EditorSnapshot | null> {
    const path =
      currentPath ??
      (await save({ defaultPath: 'Untitled Project.pgproj', filters: PROJECT_FILTER }));
    return path ? invoke('save_project', { path }) : null;
  }

  async importMedia(paths?: string[]): Promise<EditorSnapshot | null> {
    const chosen =
      paths ?? (await open({ multiple: true, directory: false, filters: MEDIA_FILTER }));
    return chosen && chosen.length > 0 ? invoke('import_media', { paths: chosen }) : null;
  }

  onFilesDropped(
    handler: (paths: string[]) => void,
    onHover?: (active: boolean) => void,
  ): Promise<() => void> {
    return getCurrentWebview().onDragDropEvent((event) => {
      onHover?.(event.payload.type === 'enter' || event.payload.type === 'over');
      if (event.payload.type === 'drop') {
        handler(event.payload.paths);
      }
    });
  }
}
