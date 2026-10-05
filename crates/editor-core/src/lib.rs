//! Editing core for the video editor.
//!
//! This crate is UI- and platform-independent: it owns the project model
//! (project → sequences → tracks → clips), the edit operations that mutate it,
//! undo/redo, and the structured editor clipboard. The desktop shell
//! (`src-tauri`) exposes it to the frontend over IPC.

pub mod clipboard;
pub mod demo;
pub mod editor;
pub mod error;
pub mod ids;
pub mod model;
pub mod ops;
pub mod time;

pub use clipboard::{CLIPBOARD_FORMAT, CLIPBOARD_VERSION, ClipboardEntry, ClipboardPayload};
pub use editor::Editor;
pub use error::EditError;
pub use ids::{ClipId, ProjectId, SequenceId, SourceId, TrackId};
pub use model::{
    BlendMode, Clip, MediaKind, MediaSource, Project, Resolution, Sequence, SourceRef, Track, TrackKind, Transform,
};
pub use ops::{EditOp, EditOutcome};
pub use time::{FrameRate, TICKS_PER_SECOND, Ticks, TimeRange};

#[cfg(test)]
mod tests;
