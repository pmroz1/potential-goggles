//! Strongly typed identifiers. Serialized as UUID strings.

use std::fmt;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

macro_rules! id_type {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub Uuid);

        impl $name {
            pub fn new() -> Self {
                Self(Uuid::new_v4())
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                self.0.fmt(f)
            }
        }
    };
}

id_type!(
    /// Identifies a [`crate::Project`].
    ProjectId
);
id_type!(
    /// Identifies a [`crate::MediaSource`] in the project's media pool.
    SourceId
);
id_type!(
    /// Identifies a [`crate::Sequence`] (timeline).
    SequenceId
);
id_type!(
    /// Identifies a [`crate::Track`] within a sequence.
    TrackId
);
id_type!(
    /// Identifies a [`crate::Clip`] placed on a track.
    ClipId
);
