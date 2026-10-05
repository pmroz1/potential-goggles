//! Integer timeline time.
//!
//! All timeline positions and durations are stored as integer [`Ticks`] to keep
//! edits exact and deterministic (no floating point drift). The tick rate is the
//! "flick" (1/705_600_000 s), which divides evenly into all common video frame
//! rates (including NTSC rates such as 30000/1001) and audio sample rates.

use std::ops::{Add, Sub};

use serde::{Deserialize, Serialize};

/// Number of ticks in one second.
pub const TICKS_PER_SECOND: i64 = 705_600_000;

/// A point in time or a duration on the timeline, measured in ticks.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Ticks(pub i64);

impl Ticks {
    pub const ZERO: Ticks = Ticks(0);

    pub const fn from_seconds(seconds: i64) -> Self {
        Ticks(seconds * TICKS_PER_SECOND)
    }

    pub fn as_seconds_f64(self) -> f64 {
        self.0 as f64 / TICKS_PER_SECOND as f64
    }

    pub fn is_negative(self) -> bool {
        self.0 < 0
    }
}

impl Add for Ticks {
    type Output = Ticks;
    fn add(self, rhs: Ticks) -> Ticks {
        Ticks(self.0.saturating_add(rhs.0))
    }
}

impl Sub for Ticks {
    type Output = Ticks;
    fn sub(self, rhs: Ticks) -> Ticks {
        Ticks(self.0.saturating_sub(rhs.0))
    }
}

/// A rational frame rate, e.g. `30000/1001` for 29.97 fps.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameRate {
    pub numerator: u32,
    pub denominator: u32,
}

impl FrameRate {
    pub const fn new(numerator: u32, denominator: u32) -> Self {
        Self { numerator, denominator }
    }

    /// Duration of a single frame in ticks.
    pub fn frame_duration(self) -> Ticks {
        Ticks(TICKS_PER_SECOND * self.denominator as i64 / self.numerator.max(1) as i64)
    }

    /// Ticks for the start of the given frame number.
    pub fn frames_to_ticks(self, frames: i64) -> Ticks {
        Ticks(frames * TICKS_PER_SECOND * self.denominator as i64 / self.numerator.max(1) as i64)
    }
}

/// Half-open range `[start, start + duration)` on the timeline.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimeRange {
    pub start: Ticks,
    pub duration: Ticks,
}

impl TimeRange {
    pub fn new(start: Ticks, duration: Ticks) -> Self {
        Self { start, duration }
    }

    pub fn end(self) -> Ticks {
        self.start + self.duration
    }

    pub fn contains(self, t: Ticks) -> bool {
        t >= self.start && t < self.end()
    }

    pub fn overlaps(self, other: TimeRange) -> bool {
        self.start < other.end() && other.start < self.end()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn common_frame_rates_are_exact() {
        for (num, den) in [
            (24, 1),
            (25, 1),
            (30, 1),
            (50, 1),
            (60, 1),
            (24000, 1001),
            (30000, 1001),
            (60000, 1001),
        ] {
            let rate = FrameRate::new(num, den);
            assert_eq!(
                (TICKS_PER_SECOND * den as i64) % num as i64,
                0,
                "{num}/{den} should divide evenly"
            );
            assert_eq!(rate.frames_to_ticks(num as i64), Ticks::from_seconds(den as i64));
        }
    }

    #[test]
    fn ranges_are_half_open() {
        let a = TimeRange::new(Ticks(0), Ticks(10));
        let b = TimeRange::new(Ticks(10), Ticks(10));
        assert!(!a.overlaps(b));
        assert!(a.overlaps(TimeRange::new(Ticks(9), Ticks(1))));
        assert!(a.contains(Ticks(0)));
        assert!(!a.contains(Ticks(10)));
    }
}
