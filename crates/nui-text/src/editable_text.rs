//! Text offset contracts shared by editing, shaping, and hit testing.

use unicode_segmentation::UnicodeSegmentation;

/// A single user-perceived grapheme cluster and its native index ranges.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GraphemeBoundary {
    pub utf8_start: usize,
    pub utf8_end: usize,
    pub utf16_start: usize,
    pub utf16_end: usize,
    pub scalar_start: usize,
    pub scalar_end: usize,
}

/// Immutable mapping between the offset units used at different boundaries.
///
/// Offsets returned by this type are always cluster boundaries. Callers must
/// not use a byte or UTF-16 offset as a scalar/grapheme offset without an
/// explicit conversion through this map.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextIndexMap {
    text: String,
    boundaries: Vec<GraphemeBoundary>,
}

impl TextIndexMap {
    #[must_use]
    pub fn new(text: impl Into<String>) -> Self {
        let text = text.into();
        let mut boundaries = Vec::new();
        let mut scalar_start = 0;
        let mut utf16_start = 0;
        for (utf8_start, grapheme) in text.grapheme_indices(true) {
            let scalar_count = grapheme.chars().count();
            let utf16_count = grapheme.encode_utf16().count();
            boundaries.push(GraphemeBoundary {
                utf8_start,
                utf8_end: utf8_start + grapheme.len(),
                utf16_start,
                utf16_end: utf16_start + utf16_count,
                scalar_start,
                scalar_end: scalar_start + scalar_count,
            });
            scalar_start += scalar_count;
            utf16_start += utf16_count;
        }
        Self { text, boundaries }
    }

    #[must_use]
    pub fn text(&self) -> &str {
        &self.text
    }

    #[must_use]
    pub fn grapheme_count(&self) -> usize {
        self.boundaries.len()
    }

    #[must_use]
    pub fn boundaries(&self) -> &[GraphemeBoundary] {
        &self.boundaries
    }

    #[must_use]
    pub fn grapheme_to_utf8(&self, index: usize) -> Option<usize> {
        if index == self.boundaries.len() {
            return Some(self.text.len());
        }
        self.boundaries
            .get(index)
            .map(|boundary| boundary.utf8_start)
    }

    #[must_use]
    pub fn grapheme_to_utf16(&self, index: usize) -> Option<usize> {
        if index == self.boundaries.len() {
            return Some(self.text.encode_utf16().count());
        }
        self.boundaries
            .get(index)
            .map(|boundary| boundary.utf16_start)
    }

    #[must_use]
    pub fn grapheme_to_scalar(&self, index: usize) -> Option<usize> {
        if index == self.boundaries.len() {
            return Some(self.text.chars().count());
        }
        self.boundaries
            .get(index)
            .map(|boundary| boundary.scalar_start)
    }

    #[must_use]
    pub fn utf8_to_grapheme(&self, offset: usize) -> Option<usize> {
        if offset == self.text.len() {
            return Some(self.boundaries.len());
        }
        self.boundaries
            .iter()
            .position(|boundary| boundary.utf8_start == offset)
    }

    #[must_use]
    pub fn utf16_to_grapheme(&self, offset: usize) -> Option<usize> {
        if offset == self.text.encode_utf16().count() {
            return Some(self.boundaries.len());
        }
        self.boundaries
            .iter()
            .position(|boundary| boundary.utf16_start == offset)
    }

    #[must_use]
    pub fn scalar_to_grapheme(&self, offset: usize) -> Option<usize> {
        if offset == self.text.chars().count() {
            return Some(self.boundaries.len());
        }
        self.boundaries
            .iter()
            .position(|boundary| boundary.scalar_start == offset)
    }
}

#[cfg(test)]
mod tests {
    use super::TextIndexMap;

    #[test]
    fn maps_utf8_utf16_scalar_and_grapheme_boundaries() {
        let map = TextIndexMap::new("Aé😀中");
        assert_eq!(map.grapheme_count(), 4);
        assert_eq!(map.grapheme_to_utf8(3), Some(7));
        assert_eq!(map.grapheme_to_utf16(3), Some(4));
        assert_eq!(map.grapheme_to_scalar(3), Some(3));
        assert_eq!(map.utf8_to_grapheme(7), Some(3));
        assert_eq!(map.utf16_to_grapheme(4), Some(3));
        assert_eq!(map.scalar_to_grapheme(3), Some(3));
        assert_eq!(map.grapheme_to_utf8(4), Some("Aé😀中".len()));
    }

    #[test]
    fn keeps_combining_zwj_modifier_and_flag_sequences_together() {
        let map = TextIndexMap::new("e\u{301}👨‍👩‍👧‍👦👍🏽🇨🇳");
        assert_eq!(map.grapheme_count(), 4);
        assert_eq!(map.boundaries()[0].scalar_end, 2);
        assert_eq!(
            map.boundaries()[1].scalar_end - map.boundaries()[1].scalar_start,
            7
        );
        assert_eq!(
            map.boundaries()[2].scalar_end - map.boundaries()[2].scalar_start,
            2
        );
        assert_eq!(
            map.boundaries()[3].scalar_end - map.boundaries()[3].scalar_start,
            2
        );
    }

    #[test]
    fn rejects_offsets_inside_a_cluster() {
        let map = TextIndexMap::new("😀");
        assert_eq!(map.utf8_to_grapheme(1), None);
        assert_eq!(map.utf16_to_grapheme(1), None);
        assert_eq!(map.scalar_to_grapheme(1), Some(1));
        assert_eq!(map.grapheme_to_utf16(1), Some(2));
    }
}
