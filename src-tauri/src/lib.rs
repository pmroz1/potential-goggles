//! Tauri desktop shell. Hosts the Angular UI and exposes the Rust editing core
//! through a small set of coarse-grained IPC commands. Interactive gestures are
//! handled entirely in the UI; the backend only receives committed operations.

use std::sync::{Mutex, MutexGuard};

use editor_core::{ClipId, EditOp, EditOutcome, Editor, Project, SequenceId, Ticks, TrackId};
use media::{BackendStatus, MediaBackend, UnavailableBackend};
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
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditResponse {
    pub snapshot: EditorSnapshot,
    pub outcome: EditOutcome,
}

pub struct AppState {
    editor: Mutex<Editor>,
    media: Box<dyn MediaBackend>,
}

impl AppState {
    pub fn new(project: Project, media: Box<dyn MediaBackend>) -> Self {
        Self {
            editor: Mutex::new(Editor::new(project)),
            media,
        }
    }

    fn editor(&self) -> MutexGuard<'_, Editor> {
        // Operations are applied to a copy of the project, so a panic while the
        // lock is held cannot leave the editor half-edited: recover from poisoning.
        self.editor.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn snapshot_of(editor: &Editor) -> EditorSnapshot {
        EditorSnapshot {
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
        Self::snapshot_of(&self.editor())
    }

    pub fn apply(&self, op: &EditOp) -> Result<EditResponse, String> {
        let mut editor = self.editor();
        let outcome = editor.apply(op).map_err(|e| e.to_string())?;
        Ok(EditResponse {
            snapshot: Self::snapshot_of(&editor),
            outcome,
        })
    }

    pub fn undo(&self) -> Result<EditorSnapshot, String> {
        let mut editor = self.editor();
        editor.undo().map_err(|e| e.to_string())?;
        Ok(Self::snapshot_of(&editor))
    }

    pub fn redo(&self) -> Result<EditorSnapshot, String> {
        let mut editor = self.editor();
        editor.redo().map_err(|e| e.to_string())?;
        Ok(Self::snapshot_of(&editor))
    }

    pub fn copy(&self, sequence_id: SequenceId, clip_ids: &[ClipId]) -> Result<EditorSnapshot, String> {
        let mut editor = self.editor();
        editor.copy(sequence_id, clip_ids).map_err(|e| e.to_string())?;
        Ok(Self::snapshot_of(&editor))
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
            snapshot: Self::snapshot_of(&editor),
            outcome,
        })
    }

    pub fn media_status(&self) -> BackendStatus {
        self.media.status()
    }
}

mod commands {
    use super::*;
    use tauri::State;

    #[tauri::command]
    pub fn get_editor_state(state: State<'_, AppState>) -> EditorSnapshot {
        state.snapshot()
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
    pub fn media_backend_status(state: State<'_, AppState>) -> BackendStatus {
        state.media_status()
    }
}

pub fn run() {
    tauri::Builder::default()
        .manage(AppState::new(
            editor_core::demo::demo_project(),
            Box::new(UnavailableBackend),
        ))
        .invoke_handler(tauri::generate_handler![
            commands::get_editor_state,
            commands::apply_edit,
            commands::undo,
            commands::redo,
            commands::copy_clips,
            commands::paste_clips,
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
    fn snapshot_serializes_camel_case() {
        let json = serde_json::to_value(state().snapshot()).unwrap();
        assert!(json.get("canUndo").is_some());
        assert!(json["project"]["sequences"][0]["tracks"][0].get("zIndex").is_some());
    }
}
