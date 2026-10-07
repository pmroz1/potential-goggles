use thiserror::Error;

use crate::ids::{ClipId, SequenceId, SourceId, TrackId};
use crate::model::TrackKind;

/// Reasons an edit operation can be rejected. A rejected operation leaves the
/// project untouched.
#[derive(Debug, Clone, PartialEq, Error)]
pub enum EditError {
    #[error("sequence {0} not found")]
    SequenceNotFound(SequenceId),
    #[error("track {0} not found")]
    TrackNotFound(TrackId),
    #[error("clip {0} not found")]
    ClipNotFound(ClipId),
    #[error("media source {0} not found")]
    SourceNotFound(SourceId),
    #[error("track {0} is locked")]
    TrackLocked(TrackId),
    #[error("cannot place a {clip:?} clip on a {track:?} track")]
    TrackKindMismatch { clip: TrackKind, track: TrackKind },
    #[error("clip would overlap clip {0}")]
    Overlap(ClipId),
    #[error("clips cannot start before the beginning of the timeline")]
    NegativeTime,
    #[error("no track available at lane offset {0} for paste")]
    NoTrackForLane(u32),
    #[error("transform values must be finite and scale must be positive")]
    InvalidTransform,
    #[error("resolution must be between 1 and 16384 pixels in each dimension")]
    InvalidResolution,
    #[error("frame rate numerator and denominator must be positive")]
    InvalidFrameRate,
    #[error("duration must be positive and no longer than the media")]
    InvalidDuration,
    #[error("name must not be empty")]
    EmptyName,
    #[error("nothing selected")]
    EmptySelection,
    #[error("clipboard is empty")]
    ClipboardEmpty,
    #[error("invalid clipboard payload: {0}")]
    InvalidClipboard(String),
    #[error("nothing to undo")]
    NothingToUndo,
    #[error("nothing to redo")]
    NothingToRedo,
}
