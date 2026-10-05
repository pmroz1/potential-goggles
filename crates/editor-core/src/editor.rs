//! Stateful editing session: current project, undo/redo history and the
//! editor clipboard.

use crate::clipboard::ClipboardPayload;
use crate::error::EditError;
use crate::ids::{ClipId, SequenceId, TrackId};
use crate::model::Project;
use crate::ops::{self, EditOp, EditOutcome};
use crate::time::Ticks;

/// Maximum number of undo steps retained.
pub const DEFAULT_HISTORY_LIMIT: usize = 200;

#[derive(Debug, Clone)]
pub struct Editor {
    project: Project,
    undo_stack: Vec<Project>,
    redo_stack: Vec<Project>,
    clipboard: Option<ClipboardPayload>,
    history_limit: usize,
}

impl Editor {
    pub fn new(project: Project) -> Self {
        Self {
            project,
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            clipboard: None,
            history_limit: DEFAULT_HISTORY_LIMIT,
        }
    }

    pub fn project(&self) -> &Project {
        &self.project
    }

    pub fn can_undo(&self) -> bool {
        !self.undo_stack.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo_stack.is_empty()
    }

    pub fn clipboard(&self) -> Option<&ClipboardPayload> {
        self.clipboard.as_ref()
    }

    /// Applies an operation atomically: either it fully succeeds and becomes a
    /// single undo step, or the project is left untouched.
    pub fn apply(&mut self, op: &EditOp) -> Result<EditOutcome, EditError> {
        let mut next = self.project.clone();
        let outcome = ops::apply(&mut next, op)?;
        let previous = std::mem::replace(&mut self.project, next);
        self.undo_stack.push(previous);
        if self.undo_stack.len() > self.history_limit {
            self.undo_stack.remove(0);
        }
        self.redo_stack.clear();
        Ok(outcome)
    }

    pub fn undo(&mut self) -> Result<(), EditError> {
        let previous = self.undo_stack.pop().ok_or(EditError::NothingToUndo)?;
        let current = std::mem::replace(&mut self.project, previous);
        self.redo_stack.push(current);
        Ok(())
    }

    pub fn redo(&mut self) -> Result<(), EditError> {
        let next = self.redo_stack.pop().ok_or(EditError::NothingToRedo)?;
        let current = std::mem::replace(&mut self.project, next);
        self.undo_stack.push(current);
        Ok(())
    }

    /// Copies clips into the editor clipboard. Does not modify the project.
    pub fn copy(&mut self, sequence_id: SequenceId, clip_ids: &[ClipId]) -> Result<&ClipboardPayload, EditError> {
        let sequence = self
            .project
            .sequence(sequence_id)
            .ok_or(EditError::SequenceNotFound(sequence_id))?;
        let payload = ClipboardPayload::copy_from(sequence, clip_ids)?;
        Ok(self.clipboard.insert(payload))
    }

    /// Pastes the editor clipboard as a single undoable operation.
    pub fn paste(
        &mut self,
        sequence_id: SequenceId,
        at: Ticks,
        base_track_id: Option<TrackId>,
    ) -> Result<EditOutcome, EditError> {
        let payload = self.clipboard.clone().ok_or(EditError::ClipboardEmpty)?;
        self.apply(&EditOp::PasteClips {
            sequence_id,
            payload,
            at,
            base_track_id,
        })
    }
}
