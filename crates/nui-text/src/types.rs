//! Explicit text offset units shared by itemization, shaping, and paragraphs.

use std::error::Error;
use std::fmt;

/// A UTF-8 byte offset tied to the length of its source string.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Utf8Offset {
    value: usize,
    source_len: usize,
}

impl Utf8Offset {
    #[must_use]
    pub const fn get(self) -> usize {
        self.value
    }

    #[must_use]
    pub const fn source_len(self) -> usize {
        self.source_len
    }

    pub(crate) const fn validated(value: usize, source_len: usize) -> Self {
        Self { value, source_len }
    }
}

/// A half-open range of absolute UTF-8 byte offsets validated against a source length.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Utf8Range {
    start: usize,
    end: usize,
    source_len: usize,
}

impl Utf8Range {
    pub fn new(text: &str, start: usize, end: usize) -> Result<Self, Utf8RangeError> {
        if start > end {
            return Err(Utf8RangeError::StartAfterEnd { start, end });
        }
        if end > text.len() {
            return Err(Utf8RangeError::OutOfBounds {
                end,
                source_len: text.len(),
            });
        }
        if !text.is_char_boundary(start) {
            return Err(Utf8RangeError::NotCharBoundary { offset: start });
        }
        if !text.is_char_boundary(end) {
            return Err(Utf8RangeError::NotCharBoundary { offset: end });
        }
        Ok(Self::validated(start, end, text.len()))
    }

    #[must_use]
    pub const fn start(self) -> Utf8Offset {
        Utf8Offset::validated(self.start, self.source_len)
    }

    #[must_use]
    pub const fn end(self) -> Utf8Offset {
        Utf8Offset::validated(self.end, self.source_len)
    }

    #[must_use]
    pub const fn source_len(self) -> usize {
        self.source_len
    }

    #[must_use]
    pub const fn len(self) -> usize {
        self.end - self.start
    }

    #[must_use]
    pub const fn is_empty(self) -> bool {
        self.start == self.end
    }

    #[must_use]
    /// Returns the selected slice when `text` has the validated byte length.
    ///
    /// This range does not encode source identity. Owners such as paragraph snapshots
    /// must retain the source string when identity matters.
    pub fn slice(self, text: &str) -> Option<&str> {
        if text.len() != self.source_len {
            return None;
        }
        text.get(self.start..self.end)
    }

    #[must_use]
    pub const fn intersection(self, other: Self) -> Option<Self> {
        if self.source_len != other.source_len {
            return None;
        }
        let start = if self.start > other.start {
            self.start
        } else {
            other.start
        };
        let end = if self.end < other.end {
            self.end
        } else {
            other.end
        };
        if start < end {
            Some(Self::validated(start, end, self.source_len))
        } else {
            None
        }
    }

    pub(crate) const fn validated(start: usize, end: usize, source_len: usize) -> Self {
        Self {
            start,
            end,
            source_len,
        }
    }
}

/// Invalid UTF-8 range supplied at a public text boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Utf8RangeError {
    StartAfterEnd { start: usize, end: usize },
    OutOfBounds { end: usize, source_len: usize },
    NotCharBoundary { offset: usize },
}

impl fmt::Display for Utf8RangeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::StartAfterEnd { start, end } => {
                write!(formatter, "UTF-8 range start {start} exceeds end {end}")
            }
            Self::OutOfBounds { end, source_len } => write!(
                formatter,
                "UTF-8 range end {end} exceeds source length {source_len}"
            ),
            Self::NotCharBoundary { offset } => {
                write!(
                    formatter,
                    "UTF-8 offset {offset} is not a character boundary"
                )
            }
        }
    }
}

impl Error for Utf8RangeError {}
