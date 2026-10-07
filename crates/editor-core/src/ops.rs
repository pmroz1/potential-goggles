//! Edit operations. Each operation is a single, atomic, serializable command
//! applied to a [`Project`]. The UI performs interactive gestures (e.g. drags)
//! locally and commits exactly one operation when the gesture completes.

use serde::{Deserialize, Serialize};

use crate::clipboard::ClipboardPayload;
use crate::error::EditError;
use crate::ids::SourceId;
use crate::ids::{ClipId, SequenceId, TrackId};
use crate::model::{
    Clip, MediaKind, MediaSource, Project, Resolution, Sequence, SourceRef, Track, TrackKind, Transform,
};
use crate::time::{FrameRate, Ticks, TimeRange};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum EditOp {
    /// Move a clip to a new timeline position and/or track.
    MoveClip {
        sequence_id: SequenceId,
        clip_id: ClipId,
        track_id: TrackId,
        start: Ticks,
    },
    /// Replace the spatial transform of a clip (viewport move/scale/rotate).
    SetClipTransform {
        sequence_id: SequenceId,
        clip_id: ClipId,
        transform: Transform,
    },
    /// Change which part of the source a clip shows and where it sits on the
    /// timeline (trim from either end). Video and audio clips must stay within
    /// their source media; still images can be stretched to any length.
    TrimClip {
        sequence_id: SequenceId,
        clip_id: ClipId,
        start: Ticks,
        in_point: Ticks,
        duration: Ticks,
    },
    /// Cut each clip at timeline time `at` into two clips. The left part keeps
    /// the original id; the right parts are reported in `created_clip_ids`.
    /// Every clip must strictly contain `at`.
    SplitClips {
        sequence_id: SequenceId,
        clip_ids: Vec<ClipId>,
        at: Ticks,
    },
    /// Remove clips from a sequence.
    DeleteClips {
        sequence_id: SequenceId,
        clip_ids: Vec<ClipId>,
    },
    /// Paste clipboard clips at `at`. When `base_track_id` is given, the lowest
    /// copied lane is pasted onto that track; otherwise the original tracks are
    /// reused when they exist in the target sequence, else the bottom of the stack.
    PasteClips {
        sequence_id: SequenceId,
        payload: ClipboardPayload,
        at: Ticks,
        base_track_id: Option<TrackId>,
    },
    /// Add a media file to the project's media pool.
    ImportMedia { source: MediaSource },
    /// Place a clip covering `duration` ticks of a media source on a track.
    /// A `duration` of `None` uses the whole source.
    AddClip {
        sequence_id: SequenceId,
        track_id: TrackId,
        source_id: SourceId,
        start: Ticks,
        duration: Option<Ticks>,
    },
    /// Rename the project.
    RenameProject { name: String },
    /// Add a new sequence with the default track layout.
    AddSequence {
        name: String,
        frame_rate: FrameRate,
        resolution: Resolution,
    },
    /// Change a sequence's frame size (and therefore its aspect ratio).
    SetSequenceResolution {
        sequence_id: SequenceId,
        resolution: Resolution,
    },
    /// Add an empty track. Video tracks go on top of the compositing stack,
    /// audio tracks below every other track. A missing or blank `name` gets
    /// the next free `V<n>` / `A<n>` name.
    AddTrack {
        sequence_id: SequenceId,
        kind: TrackKind,
        name: Option<String>,
    },
    /// Remove a track together with all of its clips.
    RemoveTrack { sequence_id: SequenceId, track_id: TrackId },
}

/// Largest accepted sequence width or height, in pixels.
pub const MAX_RESOLUTION: u32 = 16_384;

/// Information about entities created by an operation.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditOutcome {
    pub revision: u64,
    pub created_clip_ids: Vec<ClipId>,
    pub created_sequence_id: Option<SequenceId>,
    pub created_source_id: Option<SourceId>,
    pub created_track_id: Option<TrackId>,
}

/// Applies `op` to `project`. On error the project may be partially modified,
/// so callers wanting atomicity should apply to a copy (see [`crate::Editor`]).
pub fn apply(project: &mut Project, op: &EditOp) -> Result<EditOutcome, EditError> {
    let mut outcome = EditOutcome::default();
    match op {
        EditOp::MoveClip {
            sequence_id,
            clip_id,
            track_id,
            start,
        } => {
            let sequence = sequence_mut(project, *sequence_id)?;
            move_clip(sequence, *clip_id, *track_id, *start)?;
        }
        EditOp::SetClipTransform {
            sequence_id,
            clip_id,
            transform,
        } => {
            if !transform.is_valid() {
                return Err(EditError::InvalidTransform);
            }
            let sequence = sequence_mut(project, *sequence_id)?;
            let (ti, ci) = sequence
                .locate_clip(*clip_id)
                .ok_or(EditError::ClipNotFound(*clip_id))?;
            let track = &mut sequence.tracks[ti];
            if track.locked {
                return Err(EditError::TrackLocked(track.id));
            }
            track.clips[ci].transform = *transform;
        }
        EditOp::TrimClip {
            sequence_id,
            clip_id,
            start,
            in_point,
            duration,
        } => {
            trim_clip(project, *sequence_id, *clip_id, *start, *in_point, *duration)?;
        }
        EditOp::SplitClips {
            sequence_id,
            clip_ids,
            at,
        } => {
            outcome.created_clip_ids = split_clips(sequence_mut(project, *sequence_id)?, clip_ids, *at)?;
        }
        EditOp::DeleteClips { sequence_id, clip_ids } => {
            let sequence = sequence_mut(project, *sequence_id)?;
            for clip_id in clip_ids {
                let (ti, ci) = sequence
                    .locate_clip(*clip_id)
                    .ok_or(EditError::ClipNotFound(*clip_id))?;
                let track = &mut sequence.tracks[ti];
                if track.locked {
                    return Err(EditError::TrackLocked(track.id));
                }
                track.clips.remove(ci);
            }
        }
        EditOp::PasteClips {
            sequence_id,
            payload,
            at,
            base_track_id,
        } => {
            outcome.created_clip_ids = paste_clips(project, *sequence_id, payload, *at, *base_track_id)?;
        }
        EditOp::ImportMedia { source } => {
            if source.duration <= Ticks::ZERO {
                return Err(EditError::InvalidDuration);
            }
            let mut source = source.clone();
            // The pool owns identity: never trust or collide with caller ids.
            if project.source(source.id).is_some() {
                source.id = SourceId::new();
            }
            outcome.created_source_id = Some(source.id);
            project.media.push(source);
        }
        EditOp::AddClip {
            sequence_id,
            track_id,
            source_id,
            start,
            duration,
        } => {
            let source = project
                .source(*source_id)
                .ok_or(EditError::SourceNotFound(*source_id))?
                .clone();
            let duration = duration.unwrap_or(source.duration);
            if duration <= Ticks::ZERO || duration > source.duration {
                return Err(EditError::InvalidDuration);
            }
            let kind = match source.kind {
                MediaKind::Audio => TrackKind::Audio,
                MediaKind::Video | MediaKind::Image => TrackKind::Video,
            };
            let sequence = sequence_mut(project, *sequence_id)?;
            let track = sequence
                .track_mut(*track_id)
                .ok_or(EditError::TrackNotFound(*track_id))?;
            let clip = Clip {
                id: ClipId::new(),
                name: source.name.clone(),
                source: SourceRef {
                    source_id: source.id,
                    in_point: Ticks::ZERO,
                },
                start: *start,
                duration,
                transform: Transform::default(),
                opacity: 1.0,
                color: match source.kind {
                    MediaKind::Video => "#4f7cff",
                    MediaKind::Audio => "#3fb27f",
                    MediaKind::Image => "#ff9f43",
                }
                .to_owned(),
            };
            check_placement(track, kind, clip.range(), None)?;
            outcome.created_clip_ids.push(clip.id);
            track.insert_sorted(clip);
        }
        EditOp::RenameProject { name } => {
            let name = name.trim();
            if name.is_empty() {
                return Err(EditError::EmptyName);
            }
            project.name = name.to_owned();
        }
        EditOp::AddSequence {
            name,
            frame_rate,
            resolution,
        } => {
            if frame_rate.numerator == 0 || frame_rate.denominator == 0 {
                return Err(EditError::InvalidFrameRate);
            }
            validate_resolution(*resolution)?;
            let sequence = Sequence::with_default_tracks(name.clone(), *frame_rate, *resolution);
            outcome.created_sequence_id = Some(sequence.id);
            project.sequences.push(sequence);
        }
        EditOp::SetSequenceResolution {
            sequence_id,
            resolution,
        } => {
            validate_resolution(*resolution)?;
            sequence_mut(project, *sequence_id)?.resolution = *resolution;
        }
        EditOp::AddTrack {
            sequence_id,
            kind,
            name,
        } => {
            let sequence = sequence_mut(project, *sequence_id)?;
            let name = match name.as_deref().map(str::trim) {
                Some(name) if !name.is_empty() => name.to_owned(),
                _ => next_track_name(sequence, *kind),
            };
            let z_index = match kind {
                TrackKind::Video => sequence.tracks.iter().map(|t| t.z_index).max().map_or(0, |z| z + 1),
                TrackKind::Audio => sequence.tracks.iter().map(|t| t.z_index).min().map_or(0, |z| z - 1),
            };
            let track = Track::new(name, *kind, z_index);
            outcome.created_track_id = Some(track.id);
            sequence.tracks.push(track);
        }
        EditOp::RemoveTrack { sequence_id, track_id } => {
            let sequence = sequence_mut(project, *sequence_id)?;
            let index = sequence
                .tracks
                .iter()
                .position(|t| t.id == *track_id)
                .ok_or(EditError::TrackNotFound(*track_id))?;
            if sequence.tracks[index].locked {
                return Err(EditError::TrackLocked(*track_id));
            }
            sequence.tracks.remove(index);
        }
    }
    project.revision += 1;
    outcome.revision = project.revision;
    Ok(outcome)
}

fn validate_resolution(resolution: Resolution) -> Result<(), EditError> {
    let valid = |v: u32| (1..=MAX_RESOLUTION).contains(&v);
    if valid(resolution.width) && valid(resolution.height) {
        Ok(())
    } else {
        Err(EditError::InvalidResolution)
    }
}

/// First unused `V<n>` / `A<n>` name in the sequence.
fn next_track_name(sequence: &Sequence, kind: TrackKind) -> String {
    let prefix = match kind {
        TrackKind::Video => "V",
        TrackKind::Audio => "A",
    };
    (1..)
        .map(|n| format!("{prefix}{n}"))
        .find(|name| sequence.tracks.iter().all(|t| &t.name != name))
        .expect("an unused name exists")
}

fn sequence_mut(project: &mut Project, id: SequenceId) -> Result<&mut Sequence, EditError> {
    project.sequence_mut(id).ok_or(EditError::SequenceNotFound(id))
}

fn move_clip(sequence: &mut Sequence, clip_id: ClipId, track_id: TrackId, start: Ticks) -> Result<(), EditError> {
    if start.is_negative() {
        return Err(EditError::NegativeTime);
    }
    let (ti, ci) = sequence.locate_clip(clip_id).ok_or(EditError::ClipNotFound(clip_id))?;
    let from = &sequence.tracks[ti];
    if from.locked {
        return Err(EditError::TrackLocked(from.id));
    }
    let clip_kind = from.kind;
    let duration = from.clips[ci].duration;

    let to = sequence.track(track_id).ok_or(EditError::TrackNotFound(track_id))?;
    check_placement(to, clip_kind, TimeRange::new(start, duration), Some(clip_id))?;

    let mut clip = sequence.tracks[ti].clips.remove(ci);
    clip.start = start;
    sequence
        .track_mut(track_id)
        .expect("target track checked above")
        .insert_sorted(clip);
    Ok(())
}

fn trim_clip(
    project: &mut Project,
    sequence_id: SequenceId,
    clip_id: ClipId,
    start: Ticks,
    in_point: Ticks,
    duration: Ticks,
) -> Result<(), EditError> {
    if start.is_negative() || in_point.is_negative() {
        return Err(EditError::NegativeTime);
    }
    if duration <= Ticks::ZERO {
        return Err(EditError::InvalidDuration);
    }
    let sequence = project
        .sequences
        .iter_mut()
        .find(|s| s.id == sequence_id)
        .ok_or(EditError::SequenceNotFound(sequence_id))?;
    let (ti, ci) = sequence.locate_clip(clip_id).ok_or(EditError::ClipNotFound(clip_id))?;
    let track = &mut sequence.tracks[ti];
    let source_id = track.clips[ci].source.source_id;
    let source = project
        .media
        .iter()
        .find(|m| m.id == source_id)
        .ok_or(EditError::SourceNotFound(source_id))?;
    if source.kind != MediaKind::Image && in_point + duration > source.duration {
        return Err(EditError::InvalidDuration);
    }
    check_placement(track, track.kind, TimeRange::new(start, duration), Some(clip_id))?;
    let mut clip = track.clips.remove(ci);
    clip.start = start;
    clip.source.in_point = in_point;
    clip.duration = duration;
    track.insert_sorted(clip);
    Ok(())
}

fn split_clips(sequence: &mut Sequence, clip_ids: &[ClipId], at: Ticks) -> Result<Vec<ClipId>, EditError> {
    if clip_ids.is_empty() {
        return Err(EditError::EmptySelection);
    }
    let mut created = Vec::with_capacity(clip_ids.len());
    for clip_id in clip_ids {
        let (ti, ci) = sequence
            .locate_clip(*clip_id)
            .ok_or(EditError::ClipNotFound(*clip_id))?;
        let track = &mut sequence.tracks[ti];
        if track.locked {
            return Err(EditError::TrackLocked(track.id));
        }
        let left = &mut track.clips[ci];
        if at <= left.start || at >= left.range().end() {
            return Err(EditError::SplitOutsideClip(*clip_id));
        }
        let offset = at - left.start;
        let right = Clip {
            id: ClipId::new(),
            start: at,
            duration: left.duration - offset,
            source: SourceRef {
                in_point: left.source.in_point + offset,
                ..left.source
            },
            ..left.clone()
        };
        left.duration = offset;
        created.push(right.id);
        track.insert_sorted(right);
    }
    Ok(created)
}

fn check_placement(
    track: &crate::model::Track,
    clip_kind: TrackKind,
    range: TimeRange,
    ignore: Option<ClipId>,
) -> Result<(), EditError> {
    if track.locked {
        return Err(EditError::TrackLocked(track.id));
    }
    if track.kind != clip_kind {
        return Err(EditError::TrackKindMismatch {
            clip: clip_kind,
            track: track.kind,
        });
    }
    if range.start.is_negative() {
        return Err(EditError::NegativeTime);
    }
    if let Some(other) = track.find_overlap(range, ignore) {
        return Err(EditError::Overlap(other.id));
    }
    Ok(())
}

fn paste_clips(
    project: &mut Project,
    sequence_id: SequenceId,
    payload: &ClipboardPayload,
    at: Ticks,
    base_track_id: Option<TrackId>,
) -> Result<Vec<ClipId>, EditError> {
    payload.validate()?;
    if at.is_negative() {
        return Err(EditError::NegativeTime);
    }
    for entry in &payload.entries {
        if !entry.clip.transform.is_valid() {
            return Err(EditError::InvalidTransform);
        }
        let source_id = entry.clip.source.source_id;
        if project.source(source_id).is_none() {
            return Err(EditError::SourceNotFound(source_id));
        }
    }

    let sequence = sequence_mut(project, sequence_id)?;
    let stack: Vec<TrackId> = sequence.tracks_by_z().iter().map(|t| t.id).collect();

    // Resolve the destination track for every entry before mutating anything.
    let reuse_original_tracks = base_track_id.is_none()
        && payload
            .entries
            .iter()
            .all(|e| sequence.track(e.source_track_id).is_some());
    let base_lane = match base_track_id {
        Some(id) => stack
            .iter()
            .position(|t| *t == id)
            .ok_or(EditError::TrackNotFound(id))?,
        None => 0,
    };
    let mut placements = Vec::with_capacity(payload.entries.len());
    for entry in &payload.entries {
        let track_id = if reuse_original_tracks {
            entry.source_track_id
        } else {
            *stack
                .get(base_lane + entry.lane_offset as usize)
                .ok_or(EditError::NoTrackForLane(entry.lane_offset))?
        };
        let clip = Clip {
            id: ClipId::new(),
            start: at + entry.time_offset,
            ..entry.clip.clone()
        };
        placements.push((track_id, entry.track_kind, clip));
    }

    let mut created = Vec::with_capacity(placements.len());
    for (track_id, kind, clip) in placements {
        let track = sequence.track_mut(track_id).ok_or(EditError::TrackNotFound(track_id))?;
        check_placement(track, kind, clip.range(), None)?;
        created.push(clip.id);
        track.insert_sorted(clip);
    }
    Ok(created)
}
