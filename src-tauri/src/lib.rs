//! Tauri desktop shell. Hosts the Angular UI and exposes the Rust editing core
//! through a small set of coarse-grained IPC commands. Interactive gestures are
//! handled entirely in the UI; the backend only receives committed operations.

use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};

use editor_core::model::{MediaKind, MediaSource, Resolution};
use editor_core::{ClipId, EditOp, EditOutcome, Editor, Project, SequenceId, SourceId, Ticks, TrackId};
use media::{BackendStatus, ExportSettings, FfmpegCli, MediaBackend, MediaError, MediaInfo};
use serde::Serialize;

/// Lightweight description of the editor clipboard sent to the UI.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardSummary {
    pub clip_count: usize,
    pub source_sequence_id: SequenceId,
}

/// Full editor state as seen by the UI.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorSnapshot {
    pub project: Project,
    pub can_undo: bool,
    pub can_redo: bool,
    pub clipboard: Option<ClipboardSummary>,
    /// File the project was last opened from or saved to.
    pub path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditResponse {
    pub snapshot: EditorSnapshot,
    pub outcome: EditOutcome,
}

pub struct AppState {
    editor: Mutex<Editor>,
    path: Mutex<Option<PathBuf>>,
    exporting: AtomicBool,
    export_cancelled: AtomicBool,
    media: Box<dyn MediaBackend>,
    /// Cache directory for converted viewport previews.
    preview_dir: PathBuf,
}

impl AppState {
    pub fn new(project: Project, media: Box<dyn MediaBackend>) -> Self {
        Self {
            editor: Mutex::new(Editor::new(project)),
            path: Mutex::new(None),
            exporting: AtomicBool::new(false),
            export_cancelled: AtomicBool::new(false),
            media,
            preview_dir: std::env::temp_dir().join("potential-goggles-previews"),
        }
    }

    fn editor(&self) -> MutexGuard<'_, Editor> {
        // Operations are applied to a copy of the project, so a panic while the
        // lock is held cannot leave the editor half-edited: recover from poisoning.
        self.editor.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn path(&self) -> MutexGuard<'_, Option<PathBuf>> {
        self.path.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn snapshot_of(&self, editor: &Editor) -> EditorSnapshot {
        EditorSnapshot {
            path: self.path().as_ref().map(|p| p.to_string_lossy().into_owned()),
            project: editor.project().clone(),
            can_undo: editor.can_undo(),
            can_redo: editor.can_redo(),
            clipboard: editor.clipboard().map(|c| ClipboardSummary {
                clip_count: c.entries.len(),
                source_sequence_id: c.source_sequence_id,
            }),
        }
    }

    pub fn snapshot(&self) -> EditorSnapshot {
        self.snapshot_of(&self.editor())
    }

    pub fn apply(&self, op: &EditOp) -> Result<EditResponse, String> {
        let mut editor = self.editor();
        let outcome = editor.apply(op).map_err(|e| e.to_string())?;
        Ok(EditResponse {
            snapshot: self.snapshot_of(&editor),
            outcome,
        })
    }

    pub fn undo(&self) -> Result<EditorSnapshot, String> {
        let mut editor = self.editor();
        editor.undo().map_err(|e| e.to_string())?;
        Ok(self.snapshot_of(&editor))
    }

    pub fn redo(&self) -> Result<EditorSnapshot, String> {
        let mut editor = self.editor();
        editor.redo().map_err(|e| e.to_string())?;
        Ok(self.snapshot_of(&editor))
    }

    pub fn copy(&self, sequence_id: SequenceId, clip_ids: &[ClipId]) -> Result<EditorSnapshot, String> {
        let mut editor = self.editor();
        editor.copy(sequence_id, clip_ids).map_err(|e| e.to_string())?;
        Ok(self.snapshot_of(&editor))
    }

    pub fn paste(
        &self,
        sequence_id: SequenceId,
        at: Ticks,
        base_track_id: Option<TrackId>,
    ) -> Result<EditResponse, String> {
        let mut editor = self.editor();
        let outcome = editor
            .paste(sequence_id, at, base_track_id)
            .map_err(|e| e.to_string())?;
        Ok(EditResponse {
            snapshot: self.snapshot_of(&editor),
            outcome,
        })
    }

    /// Starts a fresh, empty project and forgets the current file.
    pub fn new_project(&self) -> EditorSnapshot {
        let mut editor = self.editor();
        editor.replace_project(Project::blank("Untitled Project"));
        *self.path() = None;
        self.snapshot_of(&editor)
    }

    pub fn open_project(&self, path: &Path) -> Result<EditorSnapshot, String> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("Could not read {}: {e}", path.display()))?;
        let project: Project =
            serde_json::from_str(&text).map_err(|e| format!("{} is not a valid project: {e}", path.display()))?;
        if project.sequences.is_empty() {
            return Err(format!("{} contains no sequences", path.display()));
        }
        let mut editor = self.editor();
        editor.replace_project(project);
        *self.path() = Some(path.to_owned());
        Ok(self.snapshot_of(&editor))
    }

    pub fn save_project(&self, path: &Path) -> Result<EditorSnapshot, String> {
        let editor = self.editor();
        let json = serde_json::to_string_pretty(editor.project()).map_err(|e| e.to_string())?;
        // Write next to the target first so a failed save never truncates it.
        let mut tmp = path.as_os_str().to_owned();
        tmp.push(".tmp");
        let tmp = PathBuf::from(tmp);
        std::fs::write(&tmp, json).map_err(|e| format!("Could not save {}: {e}", path.display()))?;
        std::fs::rename(&tmp, path).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("Could not save {}: {e}", path.display())
        })?;
        *self.path() = Some(path.to_owned());
        Ok(self.snapshot_of(&editor))
    }

    /// Adds files to the media pool. Files are recognised by extension, or by
    /// probing them with FFmpeg when the extension is unknown; anything else is
    /// skipped. Probing runs before the editor is locked, so a slow import never
    /// blocks other edits.
    pub fn import_media(&self, paths: &[String]) -> Result<EditorSnapshot, String> {
        let sources: Vec<MediaSource> = paths
            .iter()
            .filter_map(|raw| {
                let path = Path::new(raw);
                media_source_for(path, self.media.probe(path).ok())
            })
            .collect();
        if sources.is_empty() {
            return Err(if paths.is_empty() {
                "No files to import".to_owned()
            } else {
                "Unsupported media type (use video, audio or image files)".to_owned()
            });
        }
        let mut editor = self.editor();
        for source in sources {
            editor
                .apply(&EditOp::ImportMedia { source })
                .map_err(|e| e.to_string())?;
        }
        Ok(self.snapshot_of(&editor))
    }

    /// Returns a file the web view can display for a media source: the
    /// original file when its format plays natively (unless `force_convert`),
    /// otherwise a cached FFmpeg conversion (H.264 MP4 or PNG).
    pub fn preview_file(&self, source_id: SourceId, force_convert: bool) -> Result<PathBuf, String> {
        let source = self
            .editor()
            .project()
            .source(source_id)
            .cloned()
            .ok_or_else(|| "Media source not found".to_owned())?;
        if source.kind == MediaKind::Audio {
            return Err("Audio has no visual preview".to_owned());
        }
        let path = PathBuf::from(&source.path);
        let metadata = std::fs::metadata(&path).map_err(|_| format!("Media file not found: {}", source.path))?;
        if !force_convert && plays_natively(&path, source.kind) {
            return Ok(path);
        }
        if !self.media.status().available {
            return Err(format!(
                "Install FFmpeg to preview {} (format not supported by the viewer)",
                source.name
            ));
        }
        // Key the cache on the file identity so edited files are re-converted.
        let mut hasher = DefaultHasher::new();
        source.path.hash(&mut hasher);
        metadata.len().hash(&mut hasher);
        metadata.modified().ok().hash(&mut hasher);
        let extension = if source.kind == MediaKind::Image { "png" } else { "mp4" };
        let preview = self.preview_dir.join(format!("{:016x}.{extension}", hasher.finish()));
        if !preview.is_file() {
            std::fs::create_dir_all(&self.preview_dir).map_err(|e| format!("Could not create preview cache: {e}"))?;
            self.media
                .make_preview(&path, source.kind, &preview)
                .map_err(|e| format!("Could not convert {} for preview: {e}", source.name))?;
        }
        Ok(preview)
    }

    /// Renders a sequence to `path` as H.264/AAC in an MP4 container at the
    /// sequence's frame rate and resolution. `progress` receives `0.0..=1.0`.
    pub fn export(
        &self,
        sequence_id: SequenceId,
        path: &Path,
        progress: &mut dyn FnMut(f32),
    ) -> Result<PathBuf, String> {
        if self.exporting.swap(true, Ordering::SeqCst) {
            return Err("An export is already running".to_owned());
        }
        self.export_cancelled.store(false, Ordering::SeqCst);
        let result = self.export_inner(sequence_id, path, progress);
        self.exporting.store(false, Ordering::SeqCst);
        result
    }

    fn export_inner(
        &self,
        sequence_id: SequenceId,
        path: &Path,
        progress: &mut dyn FnMut(f32),
    ) -> Result<PathBuf, String> {
        // Work on a copy so the editor stays responsive while rendering.
        let project = self.editor().project().clone();
        let sequence = project
            .sequence(sequence_id)
            .ok_or_else(|| "Sequence not found".to_owned())?;
        let output = if path.extension().is_some() {
            path.to_owned()
        } else {
            path.with_extension("mp4")
        };
        if project.media.iter().any(|m| Path::new(&m.path) == output) {
            return Err("Choose an output file that is not one of the project's media files".to_owned());
        }
        let even = |v: u32| (v & !1).max(2);
        let settings = ExportSettings {
            output_path: output.clone(),
            container: "mp4".to_owned(),
            video_codec: "libx264".to_owned(),
            audio_codec: "aac".to_owned(),
            resolution: Resolution {
                width: even(sequence.resolution.width),
                height: even(sequence.resolution.height),
            },
            frame_rate: sequence.frame_rate,
            video_bitrate_kbps: None,
        };
        self.media
            .export(&project, sequence_id, &settings, &mut |fraction| {
                progress(fraction);
                !self.export_cancelled.load(Ordering::SeqCst)
            })
            .map_err(|e| match e {
                MediaError::Cancelled => "Export cancelled".to_owned(),
                other => other.to_string(),
            })?;
        Ok(output)
    }

    pub fn cancel_export(&self) {
        self.export_cancelled.store(true, Ordering::SeqCst);
    }

    pub fn media_status(&self) -> BackendStatus {
        self.media.status()
    }
}

const VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "m4v", "mov", "qt", "mkv", "webm", "avi", "wmv", "asf", "flv", "f4v", "mpg", "mpeg", "m2v", "ts", "mts",
    "m2ts", "3gp", "3g2", "ogv", "vob", "mxf", "dv", "y4m",
];
const AUDIO_EXTENSIONS: &[&str] = &[
    "mp3", "wav", "flac", "aac", "ogg", "oga", "m4a", "opus", "wma", "aif", "aiff", "aifc", "alac", "ac3", "amr", "mka",
];
const IMAGE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "jfif", "gif", "bmp", "webp", "avif", "tif", "tiff", "tga", "ico", "heic", "heif", "jxl",
];
/// Formats every supported web view (WebView2, WebKit) can show directly;
/// everything else is converted for the viewport. Codecs inside a supported
/// container can still be unplayable; the UI then asks for a conversion.
const WEBVIEW_VIDEO_EXTENSIONS: &[&str] = &["mp4", "m4v", "mov", "webm"];
const WEBVIEW_IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "jfif", "gif", "bmp", "webp"];

fn extension_of(path: &Path) -> Option<String> {
    Some(path.extension()?.to_str()?.to_ascii_lowercase())
}

fn plays_natively(path: &Path, kind: MediaKind) -> bool {
    let list = match kind {
        MediaKind::Video => WEBVIEW_VIDEO_EXTENSIONS,
        MediaKind::Image => WEBVIEW_IMAGE_EXTENSIONS,
        MediaKind::Audio => return false,
    };
    extension_of(path).is_some_and(|ext| list.contains(&ext.as_str()))
}

/// Describes a media file for the pool. Probed details (`info`) take
/// precedence; without them the kind comes from the extension and the
/// duration and size are placeholder defaults.
fn media_source_for(path: &Path, info: Option<MediaInfo>) -> Option<MediaSource> {
    let ext = extension_of(path).unwrap_or_default();
    let guessed = if VIDEO_EXTENSIONS.contains(&ext.as_str()) {
        Some(MediaKind::Video)
    } else if AUDIO_EXTENSIONS.contains(&ext.as_str()) {
        Some(MediaKind::Audio)
    } else if IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        Some(MediaKind::Image)
    } else {
        None
    };
    // FFmpeg's `tty` demuxer renders text files as "ansi" video; not media.
    let info = info.filter(|i| guessed.is_some() || i.video_codec.as_deref() != Some("ansi"));
    let name = path.file_name()?.to_string_lossy().into_owned();
    let mut source = MediaSource {
        id: SourceId::new(),
        name,
        path: path.to_string_lossy().into_owned(),
        kind: MediaKind::Video,
        duration: Ticks::ZERO,
        width: None,
        height: None,
    };
    match (info, guessed) {
        (Some(info), _) => {
            source.kind = info.kind;
            source.duration = info.duration;
            source.width = info.resolution.map(|r| r.width);
            source.height = info.resolution.map(|r| r.height);
        }
        (None, Some(kind)) => {
            source.kind = kind;
            source.duration = Ticks::from_seconds(if kind == MediaKind::Image { 5 } else { 10 });
            source.width = (kind != MediaKind::Audio).then_some(1920);
            source.height = (kind != MediaKind::Audio).then_some(1080);
        }
        (None, None) => return None,
    }
    Some(source)
}

mod commands {
    use super::*;
    use tauri::{AppHandle, Emitter, Manager, State};

    #[tauri::command]
    pub fn get_editor_state(state: State<'_, AppState>) -> EditorSnapshot {
        state.snapshot()
    }

    /// Prepares a viewport preview for a media source (converting it when the
    /// web view cannot show the original) and grants the web view read access
    /// to exactly that file through the asset protocol. Resolves the file path.
    #[tauri::command]
    pub async fn prepare_preview(app: AppHandle, source_id: SourceId, force_convert: bool) -> Result<String, String> {
        tauri::async_runtime::spawn_blocking(move || {
            let path = app.state::<AppState>().preview_file(source_id, force_convert)?;
            app.asset_protocol_scope()
                .allow_file(&path)
                .map_err(|e| e.to_string())?;
            Ok(path.to_string_lossy().into_owned())
        })
        .await
        .map_err(|e| e.to_string())?
    }

    #[tauri::command]
    pub fn apply_edit(state: State<'_, AppState>, op: EditOp) -> Result<EditResponse, String> {
        state.apply(&op)
    }

    #[tauri::command]
    pub fn undo(state: State<'_, AppState>) -> Result<EditorSnapshot, String> {
        state.undo()
    }

    #[tauri::command]
    pub fn redo(state: State<'_, AppState>) -> Result<EditorSnapshot, String> {
        state.redo()
    }

    #[tauri::command]
    pub fn copy_clips(
        state: State<'_, AppState>,
        sequence_id: SequenceId,
        clip_ids: Vec<ClipId>,
    ) -> Result<EditorSnapshot, String> {
        state.copy(sequence_id, &clip_ids)
    }

    #[tauri::command]
    pub fn paste_clips(
        state: State<'_, AppState>,
        sequence_id: SequenceId,
        at: Ticks,
        base_track_id: Option<TrackId>,
    ) -> Result<EditResponse, String> {
        state.paste(sequence_id, at, base_track_id)
    }

    #[tauri::command]
    pub fn new_project(state: State<'_, AppState>) -> EditorSnapshot {
        state.new_project()
    }

    #[tauri::command]
    pub fn open_project(state: State<'_, AppState>, path: String) -> Result<EditorSnapshot, String> {
        state.open_project(Path::new(&path))
    }

    #[tauri::command]
    pub fn save_project(state: State<'_, AppState>, path: String) -> Result<EditorSnapshot, String> {
        state.save_project(Path::new(&path))
    }

    /// Probes files on a worker thread so the window stays responsive.
    #[tauri::command]
    pub async fn import_media(app: AppHandle, paths: Vec<String>) -> Result<EditorSnapshot, String> {
        tauri::async_runtime::spawn_blocking(move || app.state::<AppState>().import_media(&paths))
            .await
            .map_err(|e| e.to_string())?
    }

    /// Renders on a worker thread, emitting `export-progress` (0..1) events.
    /// Resolves with the path of the written file.
    #[tauri::command]
    pub async fn export_sequence(app: AppHandle, sequence_id: SequenceId, path: String) -> Result<String, String> {
        tauri::async_runtime::spawn_blocking(move || {
            let state = app.state::<AppState>();
            let output = state.export(sequence_id, Path::new(&path), &mut |fraction| {
                let _ = app.emit("export-progress", fraction);
            })?;
            Ok(output.to_string_lossy().into_owned())
        })
        .await
        .map_err(|e| e.to_string())?
    }

    #[tauri::command]
    pub fn cancel_export(state: State<'_, AppState>) {
        state.cancel_export();
    }

    #[tauri::command]
    pub fn media_backend_status(state: State<'_, AppState>) -> BackendStatus {
        state.media_status()
    }
}

pub fn run() {
    tauri::Builder::default()
        .manage(AppState::new(
            Project::blank("Untitled Project"),
            Box::new(FfmpegCli::detect()),
        ))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::get_editor_state,
            commands::apply_edit,
            commands::undo,
            commands::redo,
            commands::copy_clips,
            commands::paste_clips,
            commands::new_project,
            commands::open_project,
            commands::save_project,
            commands::import_media,
            commands::prepare_preview,
            commands::export_sequence,
            commands::cancel_export,
            commands::media_backend_status,
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use media::UnavailableBackend;

    fn state() -> AppState {
        AppState::new(editor_core::demo::demo_project(), Box::new(UnavailableBackend))
    }

    #[test]
    fn copy_paste_undo_through_app_state() {
        let state = state();
        let initial = state.snapshot();
        assert!(!initial.can_undo);
        let seq = &initial.project.sequences[0];
        let clip = &seq.tracks[1].clips[1];

        let after_copy = state.copy(seq.id, &[clip.id]).unwrap();
        assert_eq!(after_copy.clipboard.as_ref().unwrap().clip_count, 1);
        assert!(!after_copy.can_undo, "copy does not create an undo step");

        let response = state.paste(seq.id, Ticks::from_seconds(60), None).unwrap();
        assert_eq!(response.outcome.created_clip_ids.len(), 1);
        assert!(response.snapshot.can_undo);

        let undone = state.undo().unwrap();
        assert_eq!(undone.project, initial.project);
        assert!(
            state
                .apply(&EditOp::DeleteClips {
                    sequence_id: seq.id,
                    clip_ids: vec![ClipId::new()]
                })
                .is_err()
        );
        assert!(!state.media_status().available);
    }

    #[test]
    fn import_save_and_reopen_project() {
        let state = AppState::new(Project::blank("Test"), Box::new(UnavailableBackend));
        assert!(state.import_media(&["notes.txt".to_owned()]).is_err());
        let snap = state
            .import_media(&[
                "/tmp/a.MP4".to_owned(),
                "/tmp/b.wav".to_owned(),
                "/tmp/c.mkv".to_owned(),
                "/tmp/d.tiff".to_owned(),
                "/tmp/e.wma".to_owned(),
                "/tmp/skip.txt".to_owned(),
            ])
            .unwrap();
        let kinds: Vec<MediaKind> = snap.project.media.iter().map(|m| m.kind).collect();
        use MediaKind::*;
        assert_eq!(kinds, [Video, Audio, Video, Image, Audio]);

        let path = std::env::temp_dir().join(format!("pg-test-{}.pgproj", SourceId::new()));
        let saved = state.save_project(&path).unwrap();
        assert_eq!(saved.path.as_deref(), Some(path.to_string_lossy().as_ref()));

        let fresh = state.new_project();
        assert!(fresh.project.media.is_empty() && fresh.path.is_none() && !fresh.can_undo);
        let reopened = state.open_project(&path).unwrap();
        assert_eq!(reopened.project, snap.project);
        std::fs::remove_file(&path).unwrap();
        assert!(state.open_project(&path).is_err());
    }

    #[test]
    fn export_requires_a_working_backend_and_clips() {
        let state = state();
        let seq = state.snapshot().project.sequences[0].id;
        let out = std::env::temp_dir().join("pg-never-written.mp4");
        let err = state.export(seq, &out, &mut |_| {}).unwrap_err();
        assert!(err.contains("not available"), "{err}");
        assert!(!out.exists());
        // The in-flight flag is released after a failure so the user can retry.
        assert!(state.export(seq, &out, &mut |_| {}).is_err());
        // Never overwrite a source file.
        let source = state.snapshot().project.media[0].path.clone();
        let err = state.export(seq, Path::new(&source), &mut |_| {}).unwrap_err();
        assert!(err.contains("not one of the project's media"), "{err}");
    }

    #[test]
    fn previews_use_native_files_or_report_missing_converter() {
        let dir = std::env::temp_dir().join(format!("pg-preview-{}", SourceId::new()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = |name: &str| {
            let path = dir.join(name);
            std::fs::write(&path, b"x").unwrap();
            path.to_string_lossy().into_owned()
        };
        let state = AppState::new(Project::blank("Test"), Box::new(UnavailableBackend));
        let paths = [file("a.mp4"), file("b.mkv"), file("c.wav"), file("d.png")];
        let snap = state.import_media(&paths).unwrap();
        let id = |i: usize| snap.project.media[i].id;

        assert_eq!(state.preview_file(id(0), false).unwrap(), Path::new(&paths[0]));
        assert_eq!(state.preview_file(id(3), false).unwrap(), Path::new(&paths[3]));
        let err = state.preview_file(id(1), false).unwrap_err();
        assert!(err.contains("Install FFmpeg"), "{err}");
        assert!(state.preview_file(id(0), true).unwrap_err().contains("Install FFmpeg"));
        assert!(state.preview_file(id(2), false).unwrap_err().contains("Audio"));
        assert!(state.preview_file(SourceId::new(), false).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(state.preview_file(id(0), false).unwrap_err().contains("not found"));
    }

    #[test]
    fn unknown_extensions_need_a_successful_probe() {
        let info = MediaInfo {
            kind: MediaKind::Video,
            duration: Ticks::from_seconds(3),
            resolution: Some(Resolution {
                width: 640,
                height: 480,
            }),
            frame_rate: None,
            audio_sample_rate: None,
            audio_channels: None,
            video_codec: None,
            audio_codec: None,
        };
        assert!(media_source_for(Path::new("clip.xyz"), None).is_none());
        let text = MediaInfo {
            video_codec: Some("ansi".into()),
            ..info.clone()
        };
        assert!(media_source_for(Path::new("notes.txt"), Some(text)).is_none());
        let source = media_source_for(Path::new("clip.xyz"), Some(info)).unwrap();
        assert_eq!(
            (source.kind, source.width, source.height),
            (MediaKind::Video, Some(640), Some(480))
        );
        assert_eq!(source.duration, Ticks::from_seconds(3));
        assert!(plays_natively(Path::new("a.WEBM"), MediaKind::Video));
        assert!(!plays_natively(Path::new("a.avi"), MediaKind::Video));
        assert!(!plays_natively(Path::new("a.tiff"), MediaKind::Image));
    }

    #[test]
    fn snapshot_serializes_camel_case() {
        let json = serde_json::to_value(state().snapshot()).unwrap();
        assert!(json.get("canUndo").is_some());
        assert!(json["project"]["sequences"][0]["tracks"][0].get("zIndex").is_some());
    }
}
