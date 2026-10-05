use crate::demo::demo_project;
use crate::*;

fn secs(s: i64) -> Ticks {
    Ticks::from_seconds(s)
}

/// Returns (editor, main sequence id, [A1, V1, V2] track ids).
fn setup() -> (Editor, SequenceId, [TrackId; 3]) {
    let project = demo_project();
    let seq = &project.sequences[0];
    let ids = [seq.tracks[0].id, seq.tracks[1].id, seq.tracks[2].id];
    let seq_id = seq.id;
    (Editor::new(project), seq_id, ids)
}

fn main_seq(editor: &Editor) -> &Sequence {
    &editor.project().sequences[0]
}

fn clip_named<'a>(seq: &'a Sequence, name: &str) -> &'a Clip {
    seq.tracks
        .iter()
        .flat_map(|t| &t.clips)
        .find(|c| c.name == name)
        .unwrap()
}

#[test]
fn project_holds_multiple_sequences_with_tracks_and_clips() {
    let (editor, _, _) = setup();
    let project = editor.project();
    assert_eq!(project.sequences.len(), 2);
    let main = &project.sequences[0];
    assert_eq!(main.tracks.len(), 3);
    assert_eq!(main.duration(), secs(24));
    for clip in main.tracks.iter().flat_map(|t| &t.clips) {
        assert!(
            project.source(clip.source.source_id).is_some(),
            "clip source must resolve"
        );
    }
}

#[test]
fn compositing_stack_follows_explicit_z_index() {
    let (mut editor, seq_id, [_, v1, v2]) = setup();
    let names = |e: &Editor| {
        main_seq(e)
            .compositing_stack_at(secs(3))
            .iter()
            .map(|(_, c)| c.name.clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(names(&editor), ["Interview A", "Logo"]);

    // Swap z-order explicitly: V1 above V2.
    let mut project = editor.project().clone();
    let seq = project.sequence_mut(seq_id).unwrap();
    seq.track_mut(v1).unwrap().z_index = 10;
    seq.track_mut(v2).unwrap().z_index = 5;
    editor = Editor::new(project);
    assert_eq!(names(&editor), ["Logo", "Interview A"]);
}

#[test]
fn move_clip_within_and_across_tracks() {
    let (mut editor, seq_id, [_, v1, v2]) = setup();
    let broll = clip_named(main_seq(&editor), "B-roll").id;

    let outcome = editor
        .apply(&EditOp::MoveClip {
            sequence_id: seq_id,
            clip_id: broll,
            track_id: v2,
            start: secs(30),
        })
        .unwrap();
    assert_eq!(outcome.revision, 1);
    let seq = main_seq(&editor);
    assert!(seq.track(v1).unwrap().clips.iter().all(|c| c.id != broll));
    let moved = seq.track(v2).unwrap().clips.iter().find(|c| c.id == broll).unwrap();
    assert_eq!(moved.start, secs(30));
    assert_eq!(moved.duration, secs(6));
    // Clips stay sorted by start.
    let starts: Vec<_> = seq.track(v2).unwrap().clips.iter().map(|c| c.start).collect();
    assert!(starts.windows(2).all(|w| w[0] <= w[1]));
}

#[test]
fn rejected_moves_leave_project_untouched() {
    let (mut editor, seq_id, [a1, v1, _]) = setup();
    let broll = clip_named(main_seq(&editor), "B-roll").id;
    let before = editor.project().clone();

    let overlap = editor.apply(&EditOp::MoveClip {
        sequence_id: seq_id,
        clip_id: broll,
        track_id: v1,
        start: secs(1),
    });
    assert!(matches!(overlap, Err(EditError::Overlap(_))));
    let kind = editor.apply(&EditOp::MoveClip {
        sequence_id: seq_id,
        clip_id: broll,
        track_id: a1,
        start: secs(40),
    });
    assert!(matches!(kind, Err(EditError::TrackKindMismatch { .. })));
    let negative = editor.apply(&EditOp::MoveClip {
        sequence_id: seq_id,
        clip_id: broll,
        track_id: v1,
        start: Ticks(-1),
    });
    assert_eq!(negative, Err(EditError::NegativeTime));

    assert_eq!(editor.project(), &before);
    assert!(!editor.can_undo());
}

#[test]
fn moving_onto_own_previous_range_is_allowed() {
    let (mut editor, seq_id, [_, v1, _]) = setup();
    let interview_b = clip_named(main_seq(&editor), "Interview B").id;
    // Nudge one frame later: the new range overlaps only the clip's own old range.
    let target = secs(14) + main_seq(&editor).frame_rate.frame_duration();
    editor
        .apply(&EditOp::MoveClip {
            sequence_id: seq_id,
            clip_id: interview_b,
            track_id: v1,
            start: target,
        })
        .expect("a clip never collides with itself");
    assert_eq!(main_seq(&editor).clip(interview_b).unwrap().start, target);
}

#[test]
fn locked_tracks_reject_edits() {
    let (editor, seq_id, [_, v1, _]) = setup();
    let mut project = editor.project().clone();
    project.sequence_mut(seq_id).unwrap().track_mut(v1).unwrap().locked = true;
    let mut editor = Editor::new(project);
    let broll = clip_named(main_seq(&editor), "B-roll").id;
    let result = editor.apply(&EditOp::MoveClip {
        sequence_id: seq_id,
        clip_id: broll,
        track_id: v1,
        start: secs(50),
    });
    assert_eq!(result, Err(EditError::TrackLocked(v1)));
}

#[test]
fn set_transform_and_validation() {
    let (mut editor, seq_id, _) = setup();
    let logo = clip_named(main_seq(&editor), "Logo").id;
    let transform = Transform {
        x: 10.0,
        y: 20.0,
        scale: 0.5,
        rotation: 15.0,
    };
    editor
        .apply(&EditOp::SetClipTransform {
            sequence_id: seq_id,
            clip_id: logo,
            transform,
        })
        .unwrap();
    assert_eq!(clip_named(main_seq(&editor), "Logo").transform, transform);

    let bad = Transform {
        x: f64::NAN,
        ..transform
    };
    assert_eq!(
        editor.apply(&EditOp::SetClipTransform {
            sequence_id: seq_id,
            clip_id: logo,
            transform: bad
        }),
        Err(EditError::InvalidTransform)
    );
}

#[test]
fn copy_paste_preserves_clip_properties_with_new_ids() {
    let (mut editor, seq_id, [_, v1, v2]) = setup();
    let seq = main_seq(&editor);
    let logo = clip_named(seq, "Logo").clone();
    let broll = clip_named(seq, "B-roll").clone();

    let payload = editor.copy(seq_id, &[logo.id, broll.id]).unwrap().clone();
    assert_eq!(payload.format, CLIPBOARD_FORMAT);
    assert_eq!(payload.entries.len(), 2);
    // Ordered by lane: B-roll (V1) is lane offset 0, Logo (V2) lane offset 1.
    assert_eq!(payload.entries[0].clip.id, broll.id);
    assert_eq!(payload.entries[0].lane_offset, 0);
    assert_eq!(payload.entries[1].lane_offset, 1);
    // Anchor is the earliest start (Logo at 2s; B-roll at 8s).
    assert_eq!(payload.entries[1].time_offset, Ticks::ZERO);
    assert_eq!(payload.entries[0].time_offset, secs(6));

    let outcome = editor.paste(seq_id, secs(40), None).unwrap();
    assert_eq!(outcome.created_clip_ids.len(), 2);

    let seq = main_seq(&editor);
    let pasted_broll = seq
        .track(v1)
        .unwrap()
        .clips
        .iter()
        .find(|c| outcome.created_clip_ids.contains(&c.id))
        .unwrap();
    let pasted_logo = seq
        .track(v2)
        .unwrap()
        .clips
        .iter()
        .find(|c| outcome.created_clip_ids.contains(&c.id))
        .unwrap();
    assert_ne!(pasted_logo.id, logo.id);
    assert_eq!(pasted_logo.start, secs(40));
    assert_eq!(pasted_broll.start, secs(46));
    for (pasted, original) in [(pasted_logo, &logo), (pasted_broll, &broll)] {
        assert_eq!(pasted.name, original.name);
        assert_eq!(pasted.source, original.source);
        assert_eq!(pasted.duration, original.duration);
        assert_eq!(pasted.transform, original.transform);
        assert_eq!(pasted.opacity, original.opacity);
        assert_eq!(pasted.color, original.color);
    }
    // Originals untouched.
    assert_eq!(clip_named(seq, "Logo").start, secs(2));
}

#[test]
fn paste_onto_base_track_and_other_sequence() {
    let (mut editor, seq_id, [_, v1, v2]) = setup();
    let broll = clip_named(main_seq(&editor), "B-roll").id;
    editor.copy(seq_id, &[broll]).unwrap();

    // Explicit base track: V2.
    let outcome = editor.paste(seq_id, secs(30), Some(v2)).unwrap();
    assert!(
        main_seq(&editor)
            .track(v2)
            .unwrap()
            .clips
            .iter()
            .any(|c| c.id == outcome.created_clip_ids[0])
    );
    assert!(
        main_seq(&editor)
            .track(v1)
            .unwrap()
            .clips
            .iter()
            .all(|c| c.id != outcome.created_clip_ids[0])
    );

    // Other sequence: original track doesn't exist there, so lanes map from the bottom
    // of the stack (A1) and the video clip is rejected on the audio lane...
    let other = editor.project().sequences[1].id;
    assert!(matches!(
        editor.paste(other, secs(20), None),
        Err(EditError::TrackKindMismatch { .. })
    ));
    // ...but pasting with an explicit video base track works.
    let other_v1 = editor.project().sequences[1].tracks[1].id;
    let outcome = editor.paste(other, secs(20), Some(other_v1)).unwrap();
    let pasted = editor.project().sequences[1].clip(outcome.created_clip_ids[0]).unwrap();
    assert_eq!(pasted.start, secs(20));
    assert_eq!(pasted.name, "B-roll");
}

#[test]
fn paste_is_atomic_when_any_clip_collides() {
    let (mut editor, seq_id, _) = setup();
    let seq = main_seq(&editor);
    let ids = [clip_named(seq, "Logo").id, clip_named(seq, "B-roll").id];
    editor.copy(seq_id, &ids).unwrap();
    let before = editor.project().clone();
    // At 0s the Logo copy lands on V2 (free) but B-roll at 6s collides with Interview A on V1.
    assert!(matches!(
        editor.paste(seq_id, Ticks::ZERO, None),
        Err(EditError::Overlap(_))
    ));
    assert_eq!(editor.project(), &before);
}

#[test]
fn paste_requires_clipboard_and_known_sources() {
    let (mut editor, seq_id, _) = setup();
    assert_eq!(editor.paste(seq_id, Ticks::ZERO, None), Err(EditError::ClipboardEmpty));

    let broll = clip_named(main_seq(&editor), "B-roll").id;
    let mut payload = editor.copy(seq_id, &[broll]).unwrap().clone();
    payload.entries[0].clip.source.source_id = SourceId::new();
    let result = editor.apply(&EditOp::PasteClips {
        sequence_id: seq_id,
        payload,
        at: secs(50),
        base_track_id: None,
    });
    assert!(matches!(result, Err(EditError::SourceNotFound(_))));
}

#[test]
fn paste_rejects_invalid_transforms_without_mutating_project() {
    let (mut editor, seq_id, _) = setup();
    let logo = clip_named(main_seq(&editor), "Logo").id;
    let mut payload = editor.copy(seq_id, &[logo]).unwrap().clone();
    let before = editor.project().clone();
    for scale in [0.0, -1.0, f64::NAN] {
        payload.entries[0].clip.transform.scale = scale;
        assert_eq!(
            editor.apply(&EditOp::PasteClips {
                sequence_id: seq_id,
                payload: payload.clone(),
                at: secs(40),
                base_track_id: None,
            }),
            Err(EditError::InvalidTransform)
        );
        assert_eq!(editor.project(), &before);
    }
}

#[test]
fn clipboard_json_roundtrip_and_validation() {
    let (mut editor, seq_id, _) = setup();
    let logo = clip_named(main_seq(&editor), "Logo").id;
    let payload = editor.copy(seq_id, &[logo]).unwrap().clone();
    let json = payload.to_json();
    assert!(json.contains(CLIPBOARD_FORMAT));
    assert_eq!(ClipboardPayload::from_json(&json).unwrap(), payload);

    let wrong = json.replace(CLIPBOARD_FORMAT, "text/plain");
    assert!(matches!(
        ClipboardPayload::from_json(&wrong),
        Err(EditError::InvalidClipboard(_))
    ));
    assert!(matches!(
        ClipboardPayload::from_json("{}"),
        Err(EditError::InvalidClipboard(_))
    ));
}

#[test]
fn undo_redo_restores_snapshots() {
    let (mut editor, seq_id, [_, _, v2]) = setup();
    let original = editor.project().clone();
    let broll = clip_named(main_seq(&editor), "B-roll").id;
    editor
        .apply(&EditOp::MoveClip {
            sequence_id: seq_id,
            clip_id: broll,
            track_id: v2,
            start: secs(30),
        })
        .unwrap();
    let moved = editor.project().clone();

    editor.undo().unwrap();
    assert_eq!(editor.project(), &original);
    assert!(editor.can_redo());
    editor.redo().unwrap();
    assert_eq!(editor.project(), &moved);
    assert_eq!(editor.redo(), Err(EditError::NothingToRedo));
}

#[test]
fn add_and_delete() {
    let (mut editor, seq_id, _) = setup();
    let outcome = editor
        .apply(&EditOp::AddSequence {
            name: "Trailer".into(),
            frame_rate: FrameRate::new(24, 1),
            resolution: Resolution {
                width: 3840,
                height: 2160,
            },
        })
        .unwrap();
    let new_id = outcome.created_sequence_id.unwrap();
    assert_eq!(editor.project().sequence(new_id).unwrap().tracks.len(), 3);

    let logo = clip_named(main_seq(&editor), "Logo").id;
    editor
        .apply(&EditOp::DeleteClips {
            sequence_id: seq_id,
            clip_ids: vec![logo],
        })
        .unwrap();
    assert!(main_seq(&editor).clip(logo).is_none());
}

#[test]
fn add_sequence_rejects_zero_frame_rate_components() {
    let (mut editor, _, _) = setup();
    let before = editor.project().clone();
    for (numerator, denominator) in [(0, 1), (30, 0), (0, 0)] {
        assert_eq!(
            editor.apply(&EditOp::AddSequence {
                name: "Invalid".into(),
                frame_rate: FrameRate::new(numerator, denominator),
                resolution: Resolution {
                    width: 1920,
                    height: 1080,
                },
            }),
            Err(EditError::InvalidFrameRate)
        );
        assert_eq!(editor.project(), &before);
        assert!(!editor.can_undo());
    }
}

#[test]
fn edit_op_wire_format_is_tagged_camel_case() {
    let op = EditOp::MoveClip {
        sequence_id: SequenceId::new(),
        clip_id: ClipId::new(),
        track_id: TrackId::new(),
        start: secs(1),
    };
    let value = serde_json::to_value(&op).unwrap();
    assert_eq!(value["type"], "moveClip");
    assert_eq!(value["start"], TICKS_PER_SECOND);
    assert!(value.get("sequenceId").is_some());
    assert!(value.get("clipId").is_some());
    assert!(value.get("trackId").is_some());
    let back: EditOp = serde_json::from_value(value).unwrap();
    assert_eq!(back, op);
}

#[test]
fn import_media_and_add_clip() {
    use crate::model::{MediaKind, MediaSource};
    let mut editor = Editor::new(Project::blank("P"));
    let seq = editor.project().sequences[0].clone();
    let video = seq.tracks.iter().find(|t| t.kind == TrackKind::Video).unwrap().id;
    let audio = seq.tracks.iter().find(|t| t.kind == TrackKind::Audio).unwrap().id;
    let source = MediaSource {
        id: SourceId::new(),
        name: "a.mp4".into(),
        path: "a.mp4".into(),
        kind: MediaKind::Video,
        duration: Ticks::from_seconds(10),
        width: None,
        height: None,
    };
    let id = editor
        .apply(&EditOp::ImportMedia { source })
        .unwrap()
        .created_source_id
        .unwrap();
    let add = |track_id, start| EditOp::AddClip {
        sequence_id: seq.id,
        track_id,
        source_id: id,
        start,
        duration: None,
    };
    editor.apply(&add(video, Ticks::ZERO)).unwrap();
    assert!(matches!(
        editor.apply(&add(video, Ticks::from_seconds(5))),
        Err(EditError::Overlap(_))
    ));
    assert!(matches!(
        editor.apply(&add(audio, Ticks::ZERO)),
        Err(EditError::TrackKindMismatch { .. })
    ));
    assert!(editor.apply(&EditOp::RenameProject { name: "  ".into() }).is_err());
    editor.undo().unwrap();
    assert!(editor.project().sequences[0].tracks.iter().all(|t| t.clips.is_empty()));
}
