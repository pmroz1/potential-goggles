//! [`MediaBackend`] implementation that drives the `ffmpeg` / `ffprobe`
//! command-line tools. It probes media and renders sequences; frame-accurate
//! decoding for the viewport is not supported (see [`FfmpegCli::open_decoder`]).

use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use editor_core::{
    BlendMode, FrameRate, MediaKind, MediaSource, Project, Resolution, Sequence, SequenceId, Ticks, TrackKind,
};

use crate::{BackendStatus, ExportSettings, FrameDecoder, MediaBackend, MediaError, MediaInfo};

const AUDIO_SAMPLE_RATE: u32 = 48_000;

#[derive(Debug, Clone)]
pub struct FfmpegCli {
    ffmpeg: PathBuf,
    ffprobe: PathBuf,
    version: Option<String>,
}

impl FfmpegCli {
    /// Looks for `ffmpeg` and `ffprobe` on `PATH`.
    pub fn detect() -> Self {
        Self::with_binaries("ffmpeg", "ffprobe")
    }

    pub fn with_binaries(ffmpeg: impl Into<PathBuf>, ffprobe: impl Into<PathBuf>) -> Self {
        let ffmpeg = ffmpeg.into();
        let ffprobe = ffprobe.into();
        let version = tool_version(&ffmpeg).filter(|_| tool_version(&ffprobe).is_some());
        Self {
            ffmpeg,
            ffprobe,
            version,
        }
    }

    fn require_available(&self) -> Result<(), MediaError> {
        if self.version.is_some() {
            Ok(())
        } else {
            Err(MediaError::BackendUnavailable("ffmpeg".to_owned()))
        }
    }
}

fn tool_version(binary: &Path) -> Option<String> {
    let output = Command::new(binary).arg("-version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .map(str::to_owned)
}

impl MediaBackend for FfmpegCli {
    fn status(&self) -> BackendStatus {
        match &self.version {
            Some(version) => BackendStatus {
                name: "ffmpeg".to_owned(),
                available: true,
                can_decode: false,
                can_export: true,
                detail: format!("{version}; export, media probing and preview conversion enabled"),
            },
            None => BackendStatus {
                name: "ffmpeg".to_owned(),
                available: false,
                can_decode: false,
                can_export: false,
                detail: "ffmpeg and ffprobe were not found on PATH; install FFmpeg to enable export".to_owned(),
            },
        }
    }

    fn probe(&self, path: &Path) -> Result<MediaInfo, MediaError> {
        self.require_available()?;
        let output = Command::new(&self.ffprobe)
            .args(["-v", "error", "-print_format", "json", "-show_format", "-show_streams"])
            .arg(path)
            .output()
            .map_err(|e| MediaError::Io(e.to_string()))?;
        if !output.status.success() {
            return Err(MediaError::Unsupported(
                String::from_utf8_lossy(&output.stderr).trim().to_owned(),
            ));
        }
        parse_probe(&String::from_utf8_lossy(&output.stdout))
    }

    fn open_decoder(&self, _source: &MediaSource) -> Result<Box<dyn FrameDecoder>, MediaError> {
        Err(MediaError::Unsupported(
            "frame decoding for the viewport is not implemented".to_owned(),
        ))
    }

    fn make_preview(&self, input: &Path, kind: MediaKind, output: &Path) -> Result<(), MediaError> {
        self.require_available()?;
        if !input.is_file() {
            return Err(MediaError::Io(format!("media file not found: {}", input.display())));
        }
        // Render next to the target and rename, so a half-written preview is
        // never picked up (also when two requests race for the same file).
        let mut partial = output.as_os_str().to_owned();
        partial.push(format!(
            ".{}-{:?}.part",
            std::process::id(),
            std::thread::current().id()
        ));
        let partial = PathBuf::from(partial);
        let args = build_preview_args(input, kind, &partial)?;
        let result = Command::new(&self.ffmpeg)
            .args(&args)
            .stdin(Stdio::null())
            .output()
            .map_err(|e| MediaError::Io(e.to_string()));
        let output_ok = match result {
            Ok(out) if out.status.success() => Ok(()),
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr);
                let tail: Vec<&str> = stderr.lines().rev().take(4).collect();
                Err(MediaError::Decode(
                    tail.into_iter().rev().collect::<Vec<_>>().join("\n"),
                ))
            }
            Err(e) => Err(e),
        };
        let renamed =
            output_ok.and_then(|()| std::fs::rename(&partial, output).map_err(|e| MediaError::Io(e.to_string())));
        if renamed.is_err() {
            let _ = std::fs::remove_file(&partial);
        }
        renamed
    }

    fn export(
        &self,
        project: &Project,
        sequence_id: SequenceId,
        settings: &ExportSettings,
        progress: &mut dyn FnMut(f32) -> bool,
    ) -> Result<(), MediaError> {
        self.require_available()?;
        let sequence = project
            .sequence(sequence_id)
            .ok_or_else(|| MediaError::Encode("sequence not found".to_owned()))?;
        let total = sequence.duration();
        let args = build_export_args(project, sequence, settings)?;

        let mut child = Command::new(&self.ffmpeg)
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| MediaError::Io(e.to_string()))?;
        let stderr = child.stderr.take().expect("stderr is piped");
        // Drain stderr on a thread so ffmpeg can never block on a full pipe.
        let stderr_reader = std::thread::spawn(move || {
            let mut text = String::new();
            let _ = BufReader::new(stderr).take(1 << 20).read_to_string(&mut text);
            text
        });

        let stdout = child.stdout.take().expect("stdout is piped");
        let mut cancelled = false;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Some(micros) = line
                .strip_prefix("out_time_us=")
                .and_then(|v| v.trim().parse::<i64>().ok())
            else {
                continue;
            };
            let fraction = (micros as f64 / 1e6 / total.as_seconds_f64()).clamp(0.0, 1.0) as f32;
            if !progress(fraction) {
                cancelled = true;
                let _ = child.kill();
                break;
            }
        }
        let status = child.wait().map_err(|e| MediaError::Io(e.to_string()))?;
        let stderr_text = stderr_reader.join().unwrap_or_default();
        if cancelled {
            let _ = std::fs::remove_file(&settings.output_path);
            return Err(MediaError::Cancelled);
        }
        if !status.success() {
            let _ = std::fs::remove_file(&settings.output_path);
            let tail: Vec<&str> = stderr_text.lines().rev().take(6).collect();
            return Err(MediaError::Encode(
                tail.into_iter().rev().collect::<Vec<_>>().join("\n"),
            ));
        }
        progress(1.0);
        Ok(())
    }
}

fn parse_probe(json: &str) -> Result<MediaInfo, MediaError> {
    let value: serde_json::Value = serde_json::from_str(json).map_err(|e| MediaError::Decode(e.to_string()))?;
    let streams = value["streams"].as_array().cloned().unwrap_or_default();
    let stream_of = |kind: &str| streams.iter().find(|s| s["codec_type"] == kind);
    let video = stream_of("video");
    let audio = stream_of("audio");

    let duration_secs = value["format"]["duration"]
        .as_str()
        .and_then(|d| d.parse::<f64>().ok())
        .or_else(|| {
            video
                .and_then(|v| v["duration"].as_str())
                .and_then(|d| d.parse::<f64>().ok())
        });
    let resolution = video.and_then(|v| {
        Some(Resolution {
            width: v["width"].as_u64()? as u32,
            height: v["height"].as_u64()? as u32,
        })
    });
    let frame_rate = video.and_then(|v| {
        let (n, d) = v["avg_frame_rate"].as_str()?.split_once('/')?;
        let (n, d) = (n.parse::<u32>().ok()?, d.parse::<u32>().ok()?);
        (n > 0 && d > 0).then(|| FrameRate::new(n, d))
    });
    // Still images are decoded as one-frame "video" streams without a real duration.
    let is_image = video.is_some() && audio.is_none() && duration_secs.is_none_or(|d| d <= 0.05);
    let kind = match (video.is_some(), audio.is_some()) {
        (true, _) if is_image => MediaKind::Image,
        (true, _) => MediaKind::Video,
        (false, true) => MediaKind::Audio,
        _ => return Err(MediaError::Unsupported("no audio or video streams".to_owned())),
    };
    let duration = match kind {
        MediaKind::Image => Ticks::from_seconds(5),
        _ => match duration_secs {
            Some(d) if d > 0.0 => Ticks((d * editor_core::TICKS_PER_SECOND as f64) as i64),
            _ => return Err(MediaError::Unsupported("unknown duration".to_owned())),
        },
    };
    Ok(MediaInfo {
        kind,
        duration,
        resolution,
        frame_rate,
        audio_sample_rate: audio
            .and_then(|a| a["sample_rate"].as_str())
            .and_then(|r| r.parse().ok()),
        audio_channels: audio.and_then(|a| a["channels"].as_u64()).map(|c| c as u16),
        video_codec: video.and_then(|v| v["codec_name"].as_str()).map(str::to_owned),
        audio_codec: audio.and_then(|a| a["codec_name"].as_str()).map(str::to_owned),
    })
}

/// Maximum width of generated video previews; keeps conversion fast.
const PREVIEW_MAX_WIDTH: u32 = 1280;

/// Builds the `ffmpeg` arguments that convert `input` into a web-view friendly
/// preview at `output` (see [`MediaBackend::make_preview`]).
pub fn build_preview_args(input: &Path, kind: MediaKind, output: &Path) -> Result<Vec<String>, MediaError> {
    let mut args: Vec<String> = ["-y", "-hide_banner", "-nostdin", "-v", "error", "-i"]
        .map(str::to_owned)
        .into();
    args.push(input.to_string_lossy().into_owned());
    match kind {
        MediaKind::Video => {
            args.extend(["-map", "0:v:0", "-map", "0:a:0?", "-vf"].map(str::to_owned));
            // Even dimensions (required by yuv420p), never upscaled.
            args.push(format!(
                "scale='trunc(min({PREVIEW_MAX_WIDTH},iw)/2)*2':-2,format=yuv420p"
            ));
            args.extend(
                [
                    "-c:v",
                    "libx264",
                    "-preset",
                    "veryfast",
                    "-crf",
                    "26",
                    // Frequent keyframes keep scrubbing in the viewport responsive.
                    "-g",
                    "15",
                    "-c:a",
                    "aac",
                    "-b:a",
                    "128k",
                    "-movflags",
                    "+faststart",
                    "-f",
                    "mp4",
                ]
                .map(str::to_owned),
            );
        }
        MediaKind::Image => args.extend(["-frames:v", "1", "-c:v", "png", "-f", "image2"].map(str::to_owned)),
        MediaKind::Audio => {
            return Err(MediaError::Unsupported("audio files have no visual preview".to_owned()));
        }
    }
    args.push(output.to_string_lossy().into_owned());
    Ok(args)
}

fn secs(ticks: Ticks) -> String {
    format!("{:.6}", ticks.as_seconds_f64())
}

fn overlay_blend(mode: BlendMode) -> Option<&'static str> {
    match mode {
        BlendMode::Normal => None,
        BlendMode::Add => Some("addition"),
        BlendMode::Multiply => Some("multiply"),
        BlendMode::Screen => Some("screen"),
    }
}

/// Builds the complete `ffmpeg` argument list that renders `sequence`.
///
/// Video clips are composited over black in track z-order using the clip
/// transform (scale, rotation, offset from centre) and opacity. Only audio-track
/// clips contribute sound; muted/hidden tracks are skipped.
pub fn build_export_args(
    project: &Project,
    sequence: &Sequence,
    settings: &ExportSettings,
) -> Result<Vec<String>, MediaError> {
    let total = sequence.duration();
    if total <= Ticks::ZERO {
        return Err(MediaError::Encode("the sequence has no clips to export".to_owned()));
    }
    let Resolution { width, height } = settings.resolution;
    if width == 0 || height == 0 || width % 2 != 0 || height % 2 != 0 {
        return Err(MediaError::Encode(
            "export resolution must be even and non-zero".to_owned(),
        ));
    }
    let fps = settings.frame_rate;
    if fps.numerator == 0 || fps.denominator == 0 {
        return Err(MediaError::Encode("invalid frame rate".to_owned()));
    }

    let mut args: Vec<String> = ["-y", "-hide_banner", "-nostdin", "-nostats", "-progress", "pipe:1"]
        .map(str::to_owned)
        .into();
    let mut filters: Vec<String> = Vec::new();
    let mut input_count = 0usize;

    // Input 0: black canvas.
    args.extend([
        "-f".to_owned(),
        "lavfi".to_owned(),
        "-i".to_owned(),
        format!(
            "color=c=black:s={width}x{height}:r={}/{}:d={}",
            fps.numerator,
            fps.denominator,
            secs(total)
        ),
    ]);
    input_count += 1;
    filters.push("[0:v]format=yuv420p[base0]".to_owned());
    let mut current = "base0".to_owned();
    let mut layer = 0usize;

    let mut add_input = |args: &mut Vec<String>, source: &MediaSource, in_point: Ticks, duration: Ticks| {
        if !Path::new(&source.path).is_file() {
            return Err(MediaError::Io(format!("media file not found: {}", source.path)));
        }
        if source.kind == MediaKind::Image {
            args.extend(["-loop".to_owned(), "1".to_owned(), "-framerate".to_owned()]);
            args.push(format!("{}/{}", fps.numerator, fps.denominator));
        } else {
            args.extend(["-ss".to_owned(), secs(in_point)]);
        }
        args.extend(["-t".to_owned(), secs(duration), "-i".to_owned(), source.path.clone()]);
        input_count += 1;
        Ok(input_count - 1)
    };

    for track in sequence.tracks_by_z() {
        if track.kind != TrackKind::Video || !track.visible {
            continue;
        }
        for clip in &track.clips {
            let source = project
                .source(clip.source.source_id)
                .ok_or_else(|| MediaError::Encode(format!("missing media source for clip '{}'", clip.name)))?;
            if source.kind == MediaKind::Audio {
                continue;
            }
            let idx = add_input(&mut args, source, clip.source.in_point, clip.duration)?;
            let t = clip.transform;
            let mut chain = format!(
                "[{idx}:v]format=rgba,scale=iw*{:.6}:ih*{:.6}",
                t.width_factor(),
                t.height_factor()
            );
            if t.rotation != 0.0 {
                let rad = t.rotation.to_radians();
                chain.push_str(&format!(",rotate={rad:.6}:ow=rotw({rad:.6}):oh=roth({rad:.6}):c=none"));
            }
            if clip.opacity < 1.0 {
                chain.push_str(&format!(",colorchannelmixer=aa={:.4}", clip.opacity.clamp(0.0, 1.0)));
            }
            chain.push_str(&format!(",setpts=PTS-STARTPTS+{}/TB[l{layer}]", secs(clip.start)));
            filters.push(chain);

            let next = format!("base{}", layer + 1);
            let blend = overlay_blend(track.blend_mode);
            let (start, end) = (secs(clip.start), secs(clip.range().end()));
            let position = format!("x=(W-w)/2+({:.3}):y=(H-h)/2+({:.3})", t.x, t.y);
            let overlay = format!("overlay={position}:eof_action=pass:format=auto:enable='between(t,{start},{end})'");
            match blend {
                None => filters.push(format!("[{current}][l{layer}]{overlay}[{next}]")),
                Some(mode) => {
                    // Blend modes need a full-frame layer: pad the clip onto transparent canvas first.
                    filters.push(format!(
                        "[l{layer}]pad=w={width}:h={height}:x=(ow-iw)/2+({:.3}):y=(oh-ih)/2+({:.3}):color=black@0[p{layer}]",
                        t.x, t.y
                    ));
                    filters.push(format!(
                        "[{current}][p{layer}]blend=all_mode={mode}:enable='between(t,{start},{end})'[{next}]"
                    ));
                }
            }
            current = next;
            layer += 1;
        }
    }

    let mut audio_labels = Vec::new();
    for track in &sequence.tracks {
        if track.kind != TrackKind::Audio || track.muted {
            continue;
        }
        for clip in &track.clips {
            let source = project
                .source(clip.source.source_id)
                .ok_or_else(|| MediaError::Encode(format!("missing media source for clip '{}'", clip.name)))?;
            let idx = add_input(&mut args, source, clip.source.in_point, clip.duration)?;
            let label = format!("a{}", audio_labels.len());
            let delay_ms = (clip.start.as_seconds_f64() * 1000.0).round() as i64;
            filters.push(format!(
                "[{idx}:a]aresample={AUDIO_SAMPLE_RATE},aformat=channel_layouts=stereo,volume={:.4},asetpts=PTS-STARTPTS,adelay={delay_ms}|{delay_ms}[{label}]",
                clip.opacity.clamp(0.0, 1.0)
            ));
            audio_labels.push(label);
        }
    }
    let has_audio = !audio_labels.is_empty();
    if has_audio {
        let inputs: String = audio_labels.iter().map(|l| format!("[{l}]")).collect();
        filters.push(format!(
            "{inputs}amix=inputs={}:duration=longest:normalize=0,apad,atrim=duration={}[aout]",
            audio_labels.len(),
            secs(total)
        ));
    }

    args.extend(["-filter_complex".to_owned(), filters.join(";")]);
    args.extend(["-map".to_owned(), format!("[{current}]")]);
    if has_audio {
        args.extend(["-map".to_owned(), "[aout]".to_owned()]);
    }
    args.extend([
        "-r".to_owned(),
        format!("{}/{}", fps.numerator, fps.denominator),
        "-c:v".to_owned(),
        settings.video_codec.clone(),
    ]);
    if let Some(kbps) = settings.video_bitrate_kbps {
        args.extend(["-b:v".to_owned(), format!("{kbps}k")]);
    }
    if has_audio {
        args.extend(["-c:a".to_owned(), settings.audio_codec.clone()]);
    }
    args.extend([
        "-t".to_owned(),
        secs(total),
        "-f".to_owned(),
        settings.container.clone(),
        settings.output_path.to_string_lossy().into_owned(),
    ]);
    Ok(args)
}

#[cfg(test)]
mod tests {
    use super::*;
    use editor_core::{Clip, ClipId, SourceId, SourceRef, Transform};

    fn settings() -> ExportSettings {
        ExportSettings {
            output_path: "out.mp4".into(),
            container: "mp4".into(),
            video_codec: "libx264".into(),
            audio_codec: "aac".into(),
            resolution: Resolution {
                width: 1280,
                height: 720,
            },
            frame_rate: FrameRate::new(30, 1),
            video_bitrate_kbps: None,
        }
    }

    fn project_with(path: &str, kind: MediaKind, track_index: usize) -> (Project, SourceId) {
        let mut project = Project::blank("p");
        let source = MediaSource {
            id: SourceId::new(),
            name: "a".into(),
            path: path.into(),
            kind,
            duration: Ticks::from_seconds(10),
            width: Some(1920),
            height: Some(1080),
        };
        let id = source.id;
        project.media.push(source);
        project.sequences[0].tracks[track_index].clips.push(Clip {
            id: ClipId::new(),
            name: "clip".into(),
            source: SourceRef {
                source_id: id,
                in_point: Ticks::from_seconds(1),
            },
            start: Ticks::from_seconds(2),
            duration: Ticks::from_seconds(4),
            transform: Transform {
                x: 10.0,
                y: -20.0,
                scale: 0.5,
                scale_x: 2.0,
                rotation: 90.0,
                ..Transform::default()
            },
            opacity: 0.5,
            color: "#fff".into(),
        });
        (project, id)
    }

    #[test]
    fn empty_sequence_cannot_export() {
        let project = Project::blank("p");
        assert!(build_export_args(&project, &project.sequences[0], &settings()).is_err());
    }

    #[test]
    fn missing_media_file_is_reported() {
        let (project, _) = project_with("/definitely/missing.mp4", MediaKind::Video, 1);
        let err = build_export_args(&project, &project.sequences[0], &settings()).unwrap_err();
        assert!(matches!(err, MediaError::Io(m) if m.contains("missing.mp4")));
    }

    #[test]
    fn video_clip_builds_overlay_graph() {
        let file = std::env::temp_dir().join("pg-export-test-video.mp4");
        std::fs::write(&file, b"x").unwrap();
        let (project, _) = project_with(file.to_str().unwrap(), MediaKind::Video, 1);
        let args = build_export_args(&project, &project.sequences[0], &settings()).unwrap();
        std::fs::remove_file(&file).unwrap();
        let graph = &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        assert!(graph.contains("scale=iw*1.000000:ih*0.500000"));
        assert!(graph.contains("rotate=1.570796"));
        assert!(graph.contains("colorchannelmixer=aa=0.5000"));
        assert!(graph.contains("setpts=PTS-STARTPTS+2.000000/TB"));
        assert!(graph.contains("x=(W-w)/2+(10.000):y=(H-h)/2+(-20.000)"));
        assert!(graph.contains("between(t,2.000000,6.000000)"));
        assert!(args.contains(&"[base1]".to_owned()));
        assert!(!args.contains(&"[aout]".to_owned()));
        assert!(args.windows(2).any(|w| w == ["-ss", "1.000000"]));
        assert_eq!(args.last().unwrap(), "out.mp4");
    }

    #[test]
    fn audio_clip_is_delayed_and_mapped() {
        let file = std::env::temp_dir().join("pg-export-test-audio.wav");
        std::fs::write(&file, b"x").unwrap();
        let (mut project, _) = project_with(file.to_str().unwrap(), MediaKind::Audio, 0);
        let args = build_export_args(&project, &project.sequences[0], &settings()).unwrap();
        let graph = &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        assert!(graph.contains("adelay=2000|2000"));
        assert!(args.windows(2).any(|w| w == ["-map", "[aout]"]));
        project.sequences[0].tracks[0].muted = true;
        let args = build_export_args(&project, &project.sequences[0], &settings());
        std::fs::remove_file(&file).unwrap();
        // Only a muted audio clip: nothing audible, still a valid (silent) video render.
        assert!(!args.unwrap().contains(&"[aout]".to_owned()));
    }

    #[test]
    fn parses_probe_output() {
        let video = r#"{"streams":[{"codec_type":"video","codec_name":"h264","width":1280,"height":720,"avg_frame_rate":"30000/1001"},
            {"codec_type":"audio","codec_name":"aac","sample_rate":"48000","channels":2}],"format":{"duration":"12.5"}}"#;
        let info = parse_probe(video).unwrap();
        assert_eq!(info.kind, MediaKind::Video);
        assert_eq!(
            info.resolution,
            Some(Resolution {
                width: 1280,
                height: 720
            })
        );
        assert_eq!(info.frame_rate, Some(FrameRate::new(30000, 1001)));
        assert_eq!(info.audio_channels, Some(2));
        assert_eq!(
            info.duration,
            Ticks(12 * editor_core::TICKS_PER_SECOND + editor_core::TICKS_PER_SECOND / 2)
        );

        let image = r#"{"streams":[{"codec_type":"video","codec_name":"png","width":10,"height":10,"avg_frame_rate":"0/0"}],"format":{"duration":"0.040000"}}"#;
        assert_eq!(parse_probe(image).unwrap().kind, MediaKind::Image);
        let audio = r#"{"streams":[{"codec_type":"audio","codec_name":"mp3"}],"format":{"duration":"3"}}"#;
        assert_eq!(parse_probe(audio).unwrap().kind, MediaKind::Audio);
        assert!(parse_probe(r#"{"streams":[],"format":{}}"#).is_err());
    }

    #[test]
    fn preview_args_target_web_friendly_formats() {
        let args = build_preview_args(Path::new("in.mkv"), MediaKind::Video, Path::new("out.mp4")).unwrap();
        assert!(args.windows(2).any(|w| w == ["-c:v", "libx264"]));
        assert!(args.windows(2).any(|w| w == ["-map", "0:a:0?"]));
        assert!(args.iter().any(|a| a.contains("min(1280,iw)") && a.contains("yuv420p")));
        assert_eq!(&args[args.len() - 3..], ["-f", "mp4", "out.mp4"]);
        let args = build_preview_args(Path::new("in.tiff"), MediaKind::Image, Path::new("out.png")).unwrap();
        assert!(args.windows(2).any(|w| w == ["-frames:v", "1"]));
        assert!(build_preview_args(Path::new("in.wav"), MediaKind::Audio, Path::new("o")).is_err());
    }

    #[test]
    fn missing_binaries_report_unavailable() {
        let backend = FfmpegCli::with_binaries("/nonexistent/ffmpeg", "/nonexistent/ffprobe");
        assert!(!backend.status().available);
        assert!(matches!(
            backend.probe(Path::new("x.mp4")),
            Err(MediaError::BackendUnavailable(_))
        ));
    }

    fn generate(backend: &FfmpegCli, dir: &Path, name: &str, input: &[&str]) -> PathBuf {
        let path = dir.join(name);
        let status = Command::new(&backend.ffmpeg)
            .args(["-y", "-v", "error"])
            .args(input)
            .arg(&path)
            .status()
            .unwrap();
        assert!(status.success());
        path
    }

    /// Renders real media end to end; skipped when FFmpeg is not installed.
    #[test]
    fn exports_video_image_and_audio_with_ffmpeg() {
        let backend = FfmpegCli::detect();
        if !backend.status().available {
            eprintln!("skipping: ffmpeg not installed");
            return;
        }
        let dir = std::env::temp_dir().join(format!("pg-e2e-{}", SourceId::new()));
        std::fs::create_dir_all(&dir).unwrap();
        let video = generate(
            &backend,
            &dir,
            "v.mp4",
            &["-f", "lavfi", "-i", "testsrc=s=320x240:r=30:d=3", "-pix_fmt", "yuv420p"],
        );
        let image = generate(
            &backend,
            &dir,
            "i.png",
            &["-f", "lavfi", "-i", "color=c=red:s=64x64", "-frames:v", "1"],
        );
        let audio = generate(&backend, &dir, "a.wav", &["-f", "lavfi", "-i", "sine=d=3"]);

        let mut project = Project::blank("e2e");
        let mut add = |path: &Path, track: usize, start: i64, dur: i64, transform: Transform| {
            let info = backend.probe(path).unwrap();
            let source = MediaSource {
                id: SourceId::new(),
                name: "m".into(),
                path: path.to_string_lossy().into_owned(),
                kind: info.kind,
                duration: info.duration,
                width: info.resolution.map(|r| r.width),
                height: info.resolution.map(|r| r.height),
            };
            let clip = Clip {
                id: ClipId::new(),
                name: "c".into(),
                source: SourceRef {
                    source_id: source.id,
                    in_point: Ticks::ZERO,
                },
                start: Ticks::from_seconds(start),
                duration: Ticks::from_seconds(dur),
                transform,
                opacity: 0.8,
                color: "#fff".into(),
            };
            project.media.push(source);
            project.sequences[0].tracks[track].clips.push(clip);
        };
        add(&audio, 0, 0, 2, Transform::default());
        add(&video, 1, 0, 3, Transform::default());
        add(
            &image,
            2,
            1,
            1,
            Transform {
                x: 100.0,
                y: -50.0,
                scale: 2.0,
                rotation: 30.0,
                ..Transform::default()
            },
        );
        assert_eq!(project.media[1].width, Some(320));

        let out = dir.join("out.mp4");
        let mut settings = settings();
        settings.output_path = out.clone();
        settings.resolution = Resolution {
            width: 640,
            height: 360,
        };
        let mut last = 0.0;
        backend
            .export(&project, project.sequences[0].id, &settings, &mut |p| {
                last = p;
                true
            })
            .unwrap();
        assert_eq!(last, 1.0);
        let info = backend.probe(&out).unwrap();
        assert_eq!(
            info.resolution,
            Some(Resolution {
                width: 640,
                height: 360
            })
        );
        assert!(info.audio_codec.is_some());
        assert!((info.duration.as_seconds_f64() - 3.0).abs() < 0.2);

        // Formats a web view may not play are converted to H.264 MP4 / PNG previews.
        let mkv = generate(
            &backend,
            &dir,
            "v.mkv",
            &["-f", "lavfi", "-i", "testsrc=s=321x241:r=25:d=1", "-c:v", "mpeg4"],
        );
        let preview = dir.join("preview.mp4");
        backend.make_preview(&mkv, MediaKind::Video, &preview).unwrap();
        let info = backend.probe(&preview).unwrap();
        assert_eq!(info.video_codec.as_deref(), Some("h264"));
        assert_eq!(info.resolution.map(|r| (r.width, r.height)), Some((320, 240)));
        let still = dir.join("still.png");
        backend.make_preview(&image, MediaKind::Image, &still).unwrap();
        assert_eq!(backend.probe(&still).unwrap().kind, MediaKind::Image);
        assert!(
            backend
                .make_preview(&dir.join("missing.mkv"), MediaKind::Video, &preview)
                .is_err()
        );
        let leftovers = std::fs::read_dir(&dir)
            .unwrap()
            .filter(|e| e.as_ref().unwrap().path().to_string_lossy().ends_with(".part"))
            .count();
        assert_eq!(leftovers, 0);

        let cancelled = backend.export(&project, project.sequences[0].id, &settings, &mut |_| false);
        assert_eq!(cancelled, Err(MediaError::Cancelled));
        assert!(!out.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
