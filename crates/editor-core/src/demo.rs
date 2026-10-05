//! A small sample project used to bootstrap the prototype UI and tests.

use crate::ids::{ClipId, SourceId};
use crate::model::{Clip, MediaKind, MediaSource, Project, Resolution, Sequence, SourceRef, Transform};
use crate::time::{FrameRate, Ticks};

pub fn demo_project() -> Project {
    let mut project = Project::new("Untitled Project");

    let source = |name: &str, path: &str, kind: MediaKind, seconds: i64| MediaSource {
        id: SourceId::new(),
        name: name.to_owned(),
        path: path.to_owned(),
        kind,
        duration: Ticks::from_seconds(seconds),
        width: (kind != MediaKind::Audio).then_some(1920),
        height: (kind != MediaKind::Audio).then_some(1080),
    };
    let interview = source("interview.mp4", "media/interview.mp4", MediaKind::Video, 120);
    let broll = source("b-roll.mov", "media/b-roll.mov", MediaKind::Video, 60);
    let logo = source("logo.png", "media/logo.png", MediaKind::Image, 3600);
    let music = source("music.wav", "media/music.wav", MediaKind::Audio, 180);

    let clip = |name: &str, src: &MediaSource, in_s: i64, start_s: i64, dur_s: i64, color: &str| Clip {
        id: ClipId::new(),
        name: name.to_owned(),
        source: SourceRef {
            source_id: src.id,
            in_point: Ticks::from_seconds(in_s),
        },
        start: Ticks::from_seconds(start_s),
        duration: Ticks::from_seconds(dur_s),
        transform: Transform::default(),
        opacity: 1.0,
        color: color.to_owned(),
    };

    let mut main = Sequence::with_default_tracks(
        "Main Edit",
        FrameRate::new(30, 1),
        Resolution {
            width: 1920,
            height: 1080,
        },
    );
    // Default layout (bottom → top): A1 (z 0), V1 (z 1), V2 (z 2).
    main.tracks[0].clips.push(clip("Music", &music, 0, 0, 24, "#3fb27f"));
    main.tracks[1]
        .clips
        .push(clip("Interview A", &interview, 5, 0, 8, "#4f7cff"));
    main.tracks[1].clips.push(clip("B-roll", &broll, 2, 8, 6, "#7d5cff"));
    main.tracks[1]
        .clips
        .push(clip("Interview B", &interview, 40, 14, 10, "#4f7cff"));
    let mut logo_clip = clip("Logo", &logo, 0, 2, 12, "#ff9f43");
    logo_clip.transform = Transform {
        x: 760.0,
        y: -400.0,
        scale: 0.2,
        rotation: 0.0,
    };
    main.tracks[2].clips.push(logo_clip);

    let mut alt = Sequence::with_default_tracks(
        "Social Cut",
        FrameRate::new(30, 1),
        Resolution {
            width: 1080,
            height: 1920,
        },
    );
    alt.tracks[1]
        .clips
        .push(clip("Interview A", &interview, 5, 0, 6, "#4f7cff"));

    project.media = vec![interview, broll, logo, music];
    project.sequences = vec![main, alt];
    project
}
