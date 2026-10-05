//! Media decoding / export boundary.
//!
//! The editing core never talks to codecs directly. Instead, everything that
//! needs actual media bytes (probing files, decoding frames for the viewport,
//! rendering a sequence to a file) goes through the [`MediaBackend`] trait.
//! The intended production implementation wraps FFmpeg (libavformat /
//! libavcodec / libswscale / libswresample); it is not linked yet, so the
//! application ships with [`UnavailableBackend`], which reports itself as
//! unavailable and rejects all requests.
//!
//! Keeping this boundary narrow lets the FFmpeg integration (and its native
//! build/licensing concerns) be added later without touching the editing core
//! or the UI.

use std::path::{Path, PathBuf};

use editor_core::{FrameRate, MediaKind, MediaSource, Project, Resolution, SequenceId, Ticks};
use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Error)]
pub enum MediaError {
    #[error("media backend '{0}' is not available")]
    BackendUnavailable(String),
    #[error("unsupported media: {0}")]
    Unsupported(String),
    #[error("i/o error: {0}")]
    Io(String),
    #[error("decode error: {0}")]
    Decode(String),
    #[error("encode error: {0}")]
    Encode(String),
    #[error("export cancelled")]
    Cancelled,
}

/// Result of probing a media file (container + primary streams).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub kind: MediaKind,
    pub duration: Ticks,
    pub resolution: Option<Resolution>,
    pub frame_rate: Option<FrameRate>,
    pub audio_sample_rate: Option<u32>,
    pub audio_channels: Option<u16>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PixelFormat {
    Rgba8,
}

/// A decoded video frame in a GPU/compositor friendly layout.
#[derive(Debug, Clone, PartialEq)]
pub struct VideoFrame {
    pub width: u32,
    pub height: u32,
    pub stride: usize,
    pub format: PixelFormat,
    /// Presentation time relative to the start of the source.
    pub pts: Ticks,
    pub data: Vec<u8>,
}

/// Sequential/random-access decoder for one media source.
pub trait FrameDecoder: Send {
    /// Decodes the frame displayed at `source_time` (seeking if necessary).
    fn frame_at(&mut self, source_time: Ticks) -> Result<VideoFrame, MediaError>;
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSettings {
    pub output_path: PathBuf,
    /// Container short name, e.g. `mp4`, `mov`, `mkv`.
    pub container: String,
    /// Encoder name, e.g. `libx264`, `prores_ks`.
    pub video_codec: String,
    pub audio_codec: String,
    pub resolution: Resolution,
    pub frame_rate: FrameRate,
    pub video_bitrate_kbps: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendStatus {
    pub name: String,
    pub available: bool,
    pub can_decode: bool,
    pub can_export: bool,
    pub detail: String,
}

/// The integration point for media I/O (FFmpeg in production).
pub trait MediaBackend: Send + Sync {
    fn status(&self) -> BackendStatus;

    fn probe(&self, path: &Path) -> Result<MediaInfo, MediaError>;

    fn open_decoder(&self, source: &MediaSource) -> Result<Box<dyn FrameDecoder>, MediaError>;

    /// Renders `sequence_id` of `project` to a file. `progress` receives values
    /// in `0.0..=1.0` and may return `false` to cancel.
    fn export(
        &self,
        project: &Project,
        sequence_id: SequenceId,
        settings: &ExportSettings,
        progress: &mut dyn FnMut(f32) -> bool,
    ) -> Result<(), MediaError>;
}

/// Placeholder backend used until FFmpeg is linked.
#[derive(Debug, Default, Clone, Copy)]
pub struct UnavailableBackend;

impl UnavailableBackend {
    const NAME: &'static str = "ffmpeg";

    fn unavailable<T>(&self) -> Result<T, MediaError> {
        Err(MediaError::BackendUnavailable(Self::NAME.to_owned()))
    }
}

impl MediaBackend for UnavailableBackend {
    fn status(&self) -> BackendStatus {
        BackendStatus {
            name: Self::NAME.to_owned(),
            available: false,
            can_decode: false,
            can_export: false,
            detail: "FFmpeg is not linked yet; viewport shows placeholders".to_owned(),
        }
    }

    fn probe(&self, _path: &Path) -> Result<MediaInfo, MediaError> {
        self.unavailable()
    }

    fn open_decoder(&self, _source: &MediaSource) -> Result<Box<dyn FrameDecoder>, MediaError> {
        self.unavailable()
    }

    fn export(
        &self,
        _project: &Project,
        _sequence_id: SequenceId,
        _settings: &ExportSettings,
        _progress: &mut dyn FnMut(f32) -> bool,
    ) -> Result<(), MediaError> {
        self.unavailable()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unavailable_backend_rejects_requests() {
        let backend: Box<dyn MediaBackend> = Box::new(UnavailableBackend);
        assert!(!backend.status().available);
        assert!(matches!(
            backend.probe(Path::new("clip.mp4")),
            Err(MediaError::BackendUnavailable(_))
        ));
        let project = editor_core::demo::demo_project();
        let settings = ExportSettings {
            output_path: "out.mp4".into(),
            container: "mp4".into(),
            video_codec: "libx264".into(),
            audio_codec: "aac".into(),
            resolution: Resolution {
                width: 1920,
                height: 1080,
            },
            frame_rate: FrameRate::new(30, 1),
            video_bitrate_kbps: None,
        };
        let result = backend.export(&project, project.sequences[0].id, &settings, &mut |_| true);
        assert!(matches!(result, Err(MediaError::BackendUnavailable(_))));
        assert!(backend.open_decoder(&project.media[0]).is_err());
    }
}
