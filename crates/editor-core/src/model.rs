//! Project data model: project → sequences → tracks → clips.

use serde::{Deserialize, Serialize};

use crate::ids::{ClipId, ProjectId, SequenceId, SourceId, TrackId};
use crate::time::{FrameRate, Ticks, TimeRange};

/// Root document. A project owns a media pool and any number of sequences.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: ProjectId,
    pub name: String,
    /// Incremented by every successfully applied edit operation.
    pub revision: u64,
    pub media: Vec<MediaSource>,
    pub sequences: Vec<Sequence>,
}

impl Project {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            id: ProjectId::new(),
            name: name.into(),
            revision: 0,
            media: Vec::new(),
            sequences: Vec::new(),
        }
    }

    /// A new project containing one empty sequence (1080p30, tracks V1, V2, A1).
    pub fn blank(name: impl Into<String>) -> Self {
        let mut project = Self::new(name);
        project.sequences.push(Sequence::with_default_tracks(
            "Sequence 1",
            FrameRate::new(30, 1),
            Resolution {
                width: 1920,
                height: 1080,
            },
        ));
        project
    }

    pub fn sequence(&self, id: SequenceId) -> Option<&Sequence> {
        self.sequences.iter().find(|s| s.id == id)
    }

    pub fn sequence_mut(&mut self, id: SequenceId) -> Option<&mut Sequence> {
        self.sequences.iter_mut().find(|s| s.id == id)
    }

    pub fn source(&self, id: SourceId) -> Option<&MediaSource> {
        self.media.iter().find(|m| m.id == id)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MediaKind {
    Video,
    Audio,
    Image,
}

/// An entry in the media pool. Clips reference sources by [`SourceId`]; the
/// actual decoding is performed by the `media` crate (FFmpeg boundary).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSource {
    pub id: SourceId,
    pub name: String,
    /// Location of the media file on disk.
    pub path: String,
    pub kind: MediaKind,
    pub duration: Ticks,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolution {
    pub width: u32,
    pub height: u32,
}

/// A timeline. Contains tracks that are composited according to their
/// explicit [`Track::z_index`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sequence {
    pub id: SequenceId,
    pub name: String,
    pub frame_rate: FrameRate,
    pub resolution: Resolution,
    pub tracks: Vec<Track>,
}

impl Sequence {
    /// Creates an empty sequence with the default track layout (V1, V2, A1).
    pub fn with_default_tracks(name: impl Into<String>, frame_rate: FrameRate, resolution: Resolution) -> Self {
        Self {
            id: SequenceId::new(),
            name: name.into(),
            frame_rate,
            resolution,
            tracks: vec![
                Track::new("A1", TrackKind::Audio, 0),
                Track::new("V1", TrackKind::Video, 1),
                Track::new("V2", TrackKind::Video, 2),
            ],
        }
    }

    pub fn track(&self, id: TrackId) -> Option<&Track> {
        self.tracks.iter().find(|t| t.id == id)
    }

    pub fn track_mut(&mut self, id: TrackId) -> Option<&mut Track> {
        self.tracks.iter_mut().find(|t| t.id == id)
    }

    /// Tracks ordered bottom → top by compositing order (ascending `z_index`).
    /// Ties are broken by declaration order so the result is deterministic.
    pub fn tracks_by_z(&self) -> Vec<&Track> {
        let mut tracks: Vec<&Track> = self.tracks.iter().collect();
        tracks.sort_by_key(|t| t.z_index);
        tracks
    }

    /// Returns `(track_index, clip_index)` of a clip in `self.tracks`.
    pub fn locate_clip(&self, clip_id: ClipId) -> Option<(usize, usize)> {
        self.tracks
            .iter()
            .enumerate()
            .find_map(|(ti, track)| track.clips.iter().position(|c| c.id == clip_id).map(|ci| (ti, ci)))
    }

    pub fn clip(&self, clip_id: ClipId) -> Option<&Clip> {
        self.locate_clip(clip_id).map(|(ti, ci)| &self.tracks[ti].clips[ci])
    }

    /// Visual clips active at `time`, ordered bottom → top (the order in which
    /// a compositor should draw them).
    pub fn compositing_stack_at(&self, time: Ticks) -> Vec<(&Track, &Clip)> {
        self.tracks_by_z()
            .into_iter()
            .filter(|t| t.kind == TrackKind::Video && t.visible)
            .filter_map(|t| t.clip_at(time).map(|c| (t, c)))
            .collect()
    }

    /// End of the last clip on any track.
    pub fn duration(&self) -> Ticks {
        self.tracks
            .iter()
            .flat_map(|t| t.clips.iter())
            .map(|c| c.range().end())
            .max()
            .unwrap_or(Ticks::ZERO)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TrackKind {
    Video,
    Audio,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BlendMode {
    #[default]
    Normal,
    Add,
    Multiply,
    Screen,
}

/// A track holds non-overlapping clips sorted by start time.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: TrackId,
    pub name: String,
    pub kind: TrackKind,
    /// Explicit compositing order: higher values are drawn on top.
    pub z_index: i32,
    pub blend_mode: BlendMode,
    pub visible: bool,
    pub muted: bool,
    pub locked: bool,
    pub clips: Vec<Clip>,
}

impl Track {
    pub fn new(name: impl Into<String>, kind: TrackKind, z_index: i32) -> Self {
        Self {
            id: TrackId::new(),
            name: name.into(),
            kind,
            z_index,
            blend_mode: BlendMode::Normal,
            visible: true,
            muted: false,
            locked: false,
            clips: Vec::new(),
        }
    }

    pub fn clip_at(&self, time: Ticks) -> Option<&Clip> {
        self.clips.iter().find(|c| c.range().contains(time))
    }

    /// Returns the first clip (other than `ignore`) overlapping `range`.
    pub fn find_overlap(&self, range: TimeRange, ignore: Option<ClipId>) -> Option<&Clip> {
        self.clips
            .iter()
            .filter(|c| Some(c.id) != ignore)
            .find(|c| c.range().overlaps(range))
    }

    /// Inserts a clip keeping `clips` sorted by start time. Callers are
    /// responsible for checking overlaps first.
    pub(crate) fn insert_sorted(&mut self, clip: Clip) {
        let idx = self.clips.partition_point(|c| c.start <= clip.start);
        self.clips.insert(idx, clip);
    }
}

/// Spatial transform of a visual clip inside the sequence frame. Positions are
/// expressed in sequence pixels relative to the frame centre.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transform {
    pub x: f64,
    pub y: f64,
    /// Uniform scale (keeps the source proportions).
    pub scale: f64,
    /// Horizontal stretch applied on top of `scale` (1.0 = source proportions).
    #[serde(default = "one")]
    pub scale_x: f64,
    /// Vertical stretch applied on top of `scale` (1.0 = source proportions).
    #[serde(default = "one")]
    pub scale_y: f64,
    pub rotation: f64,
}

fn one() -> f64 {
    1.0
}

impl Default for Transform {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            scale: 1.0,
            scale_x: 1.0,
            scale_y: 1.0,
            rotation: 0.0,
        }
    }
}

impl Transform {
    pub fn is_finite(&self) -> bool {
        [self.x, self.y, self.scale, self.scale_x, self.scale_y, self.rotation]
            .iter()
            .all(|v| v.is_finite())
    }

    /// Finite, with positive scale factors.
    pub fn is_valid(&self) -> bool {
        self.is_finite() && self.scale > 0.0 && self.scale_x > 0.0 && self.scale_y > 0.0
    }

    /// Effective horizontal scale (`scale * scale_x`).
    pub fn width_factor(&self) -> f64 {
        self.scale * self.scale_x
    }

    /// Effective vertical scale (`scale * scale_y`).
    pub fn height_factor(&self) -> f64 {
        self.scale * self.scale_y
    }
}

/// Reference into a media source: which source, and where in it the clip starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRef {
    pub source_id: SourceId,
    /// Offset into the source media at which playback of this clip begins.
    pub in_point: Ticks,
}

/// A clip placed on a track.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    pub id: ClipId,
    pub name: String,
    pub source: SourceRef,
    /// Timeline position of the first frame.
    pub start: Ticks,
    /// Timeline duration.
    pub duration: Ticks,
    pub transform: Transform,
    pub opacity: f64,
    /// UI label colour (CSS hex string).
    pub color: String,
}

impl Clip {
    pub fn range(&self) -> TimeRange {
        TimeRange::new(self.start, self.duration)
    }
}
