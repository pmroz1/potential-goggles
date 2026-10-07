import { Injectable } from '@angular/core';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
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
  /** Asks the user for media files; resolves `null` when cancelled. */
  abstract chooseMediaFiles(): Promise<string[] | null>;
  /** Adds files to the media pool (probing them may take a while). */
  abstract importMedia(paths: string[]): Promise<EditorSnapshot>;
  /**
   * Resolves a URL the viewport can load for a video or image source. With
   * `convert`, always uses an FFmpeg conversion instead of the original file
   * (for formats or codecs the web view cannot play).
   */
  abstract previewUrl(sourceId: Id, convert: boolean): Promise<string>;
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
/** Mirrors the extension lists in `src-tauri/src/lib.rs`. */
const VIDEO_EXTENSIONS = [
  ...['mp4', 'm4v', 'mov', 'qt', 'mkv', 'webm', 'avi', 'wmv', 'asf', 'flv', 'f4v', 'mpg'],
  ...['mpeg', 'm2v', 'ts', 'mts', 'm2ts', '3gp', '3g2', 'ogv', 'vob', 'mxf', 'dv', 'y4m'],
];
const AUDIO_EXTENSIONS = [
  ...['mp3', 'wav', 'flac', 'aac', 'ogg', 'oga', 'm4a', 'opus', 'wma', 'aif', 'aiff', 'aifc'],
  ...['alac', 'ac3', 'amr', 'mka'],
];
const IMAGE_EXTENSIONS = [
  ...['png', 'jpg', 'jpeg', 'jfif', 'gif', 'bmp', 'webp', 'avif', 'tif', 'tiff', 'tga', 'ico'],
  ...['heic', 'heif', 'jxl'],
];
const MEDIA_FILTER = [
  { name: 'Media', extensions: [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS, ...IMAGE_EXTENSIONS] },
  { name: 'Video', extensions: VIDEO_EXTENSIONS },
  { name: 'Audio', extensions: AUDIO_EXTENSIONS },
  { name: 'Images', extensions: IMAGE_EXTENSIONS },
  // Anything else FFmpeg can read is detected by probing on import.
  { name: 'All files', extensions: ['*'] },
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

  async chooseMediaFiles(): Promise<string[] | null> {
    return open({ multiple: true, directory: false, filters: MEDIA_FILTER });
  }

  importMedia(paths: string[]): Promise<EditorSnapshot> {
    return invoke('import_media', { paths });
  }

  async previewUrl(sourceId: Id, convert: boolean): Promise<string> {
    const path = await invoke<string>('prepare_preview', { sourceId, forceConvert: convert });
    return convertFileSrc(path);
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
