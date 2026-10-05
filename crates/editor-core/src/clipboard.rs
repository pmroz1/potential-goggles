//! Structured editor clipboard.
//!
//! Copying clips produces a self-describing [`ClipboardPayload`] that carries
//! full clip data (source reference, duration, transform, opacity, ...) plus
//! the relative layout needed to paste the selection elsewhere: the time
//! offset of each clip from the earliest copied clip and its lane offset in
//! the compositing stack relative to the lowest copied track.

use serde::{Deserialize, Serialize};

use crate::error::EditError;
use crate::ids::{ClipId, SequenceId, TrackId};
use crate::model::{Clip, Sequence, TrackKind};
use crate::time::Ticks;

/// Format tag identifying editor clip payloads (e.g. on a system clipboard).
pub const CLIPBOARD_FORMAT: &str = "application/x-potential-goggles-clips";
/// Current payload schema version.
pub const CLIPBOARD_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardPayload {
    pub format: String,
    pub version: u32,
    pub source_sequence_id: SequenceId,
    /// Entries ordered by lane, then by time.
    pub entries: Vec<ClipboardEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardEntry {
    /// The copied clip with all of its properties.
    pub clip: Clip,
    pub source_track_id: TrackId,
    pub track_kind: TrackKind,
    /// Offset in the z-ordered track stack relative to the lowest copied track.
    pub lane_offset: u32,
    /// Offset from the start of the earliest copied clip.
    pub time_offset: Ticks,
}

impl ClipboardPayload {
    /// Builds a payload from the given clips of `sequence`.
    pub fn copy_from(sequence: &Sequence, clip_ids: &[ClipId]) -> Result<Self, EditError> {
        if clip_ids.is_empty() {
            return Err(EditError::EmptySelection);
        }
        let stack = sequence.tracks_by_z();
        let mut picked = Vec::with_capacity(clip_ids.len());
        for &clip_id in clip_ids {
            let (lane, track, clip) = stack
                .iter()
                .enumerate()
                .find_map(|(lane, t)| t.clips.iter().find(|c| c.id == clip_id).map(|c| (lane, *t, c)))
                .ok_or(EditError::ClipNotFound(clip_id))?;
            if !picked.iter().any(|(_, _, c): &(usize, _, &Clip)| c.id == clip_id) {
                picked.push((lane, track, clip));
            }
        }
        let min_lane = picked.iter().map(|(lane, _, _)| *lane).min().unwrap_or(0);
        let anchor = picked.iter().map(|(_, _, c)| c.start).min().unwrap_or(Ticks::ZERO);
        picked.sort_by_key(|(lane, _, c)| (*lane, c.start));

        Ok(Self {
            format: CLIPBOARD_FORMAT.to_owned(),
            version: CLIPBOARD_VERSION,
            source_sequence_id: sequence.id,
            entries: picked
                .into_iter()
                .map(|(lane, track, clip)| ClipboardEntry {
                    clip: clip.clone(),
                    source_track_id: track.id,
                    track_kind: track.kind,
                    lane_offset: (lane - min_lane) as u32,
                    time_offset: clip.start - anchor,
                })
                .collect(),
        })
    }

    /// Serializes the payload for interchange (e.g. a system clipboard).
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("clipboard payload is always serializable")
    }

    /// Parses and validates a payload produced by [`Self::to_json`].
    pub fn from_json(json: &str) -> Result<Self, EditError> {
        let payload: Self = serde_json::from_str(json).map_err(|e| EditError::InvalidClipboard(e.to_string()))?;
        payload.validate()?;
        Ok(payload)
    }

    pub fn validate(&self) -> Result<(), EditError> {
        if self.format != CLIPBOARD_FORMAT {
            return Err(EditError::InvalidClipboard(format!(
                "unexpected format '{}'",
                self.format
            )));
        }
        if self.version != CLIPBOARD_VERSION {
            return Err(EditError::InvalidClipboard(format!(
                "unsupported version {}",
                self.version
            )));
        }
        if self.entries.is_empty() {
            return Err(EditError::EmptySelection);
        }
        Ok(())
    }
}
