//! Backend-neutral font metadata and database lifecycle.

use std::collections::HashMap;
use std::error::Error;
use std::fmt;
use std::sync::{Arc, Mutex, PoisonError};

use harfrust::FontRef;
use nui_core::{ResourceId, ResourceStore};
use read_fonts::TableProvider;
use unicode_script::Script;

/// Immutable font bytes and collection index shared by shaper and renderer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FontSource {
    bytes: Arc<[u8]>,
    face_index: u32,
}

impl FontSource {
    pub fn new(bytes: Arc<[u8]>, face_index: u32) -> Result<Self, FontSourceError> {
        let source = Self { bytes, face_index };
        if source.font_ref().is_none() {
            return Err(FontSourceError::InvalidFace { face_index });
        }
        Ok(source)
    }

    #[must_use]
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    #[must_use]
    pub fn shared_bytes(&self) -> Arc<[u8]> {
        Arc::clone(&self.bytes)
    }

    #[must_use]
    pub const fn face_index(&self) -> u32 {
        self.face_index
    }

    pub(crate) fn font_ref(&self) -> Option<FontRef<'_>> {
        let font = FontRef::from_index(&self.bytes, self.face_index).ok()?;
        font.head().ok()?;
        font.hhea().ok()?;
        font.maxp().ok()?;
        Some(font)
    }

    pub(crate) fn supports(&self, character: char) -> bool {
        self.font_ref()
            .and_then(|font| font.cmap().ok())
            .and_then(|cmap| cmap.map_codepoint(character))
            .is_some()
    }
}

/// Font bytes or collection index rejected before database registration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FontSourceError {
    InvalidFace { face_index: u32 },
}

impl fmt::Display for FontSourceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidFace { face_index } => {
                write!(
                    formatter,
                    "font source does not contain face index {face_index}"
                )
            }
        }
    }
}

impl Error for FontSourceError {}

/// Generation-bearing identity for a registered font face.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct FontId(ResourceId);

impl FontId {
    #[must_use]
    pub const fn get(self) -> u64 {
        self.0.raw()
    }

    const fn resource_id(self) -> ResourceId {
        self.0
    }
}

impl fmt::Debug for FontId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_tuple("FontId").field(&self.get()).finish()
    }
}

/// Monotonic database revision used to invalidate paragraph and shaping caches.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct FontDatabaseRevision(u64);

impl FontDatabaseRevision {
    #[must_use]
    pub const fn get(self) -> u64 {
        self.0
    }
}

/// CSS-compatible font weight in the inclusive range `1..=1000`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct FontWeight(u16);

impl FontWeight {
    pub const THIN: Self = Self(100);
    pub const EXTRA_LIGHT: Self = Self(200);
    pub const LIGHT: Self = Self(300);
    pub const NORMAL: Self = Self(400);
    pub const MEDIUM: Self = Self(500);
    pub const SEMI_BOLD: Self = Self(600);
    pub const BOLD: Self = Self(700);
    pub const EXTRA_BOLD: Self = Self(800);
    pub const BLACK: Self = Self(900);

    #[must_use]
    pub const fn new(value: u16) -> Option<Self> {
        if value >= 1 && value <= 1000 {
            Some(Self(value))
        } else {
            None
        }
    }

    #[must_use]
    pub const fn get(self) -> u16 {
        self.0
    }
}

impl Default for FontWeight {
    fn default() -> Self {
        Self::NORMAL
    }
}

/// Discrete CSS font-stretch class.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(u8)]
pub enum FontStretch {
    UltraCondensed = 1,
    ExtraCondensed = 2,
    Condensed = 3,
    SemiCondensed = 4,
    #[default]
    Normal = 5,
    SemiExpanded = 6,
    Expanded = 7,
    ExtraExpanded = 8,
    UltraExpanded = 9,
}

/// Upright, italic, or oblique face selection.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub enum FontSlant {
    #[default]
    Normal,
    Italic,
    Oblique,
}

/// Font properties participating in face matching.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub struct FontStyle {
    pub weight: FontWeight,
    pub stretch: FontStretch,
    pub slant: FontSlant,
}

impl FontStyle {
    #[must_use]
    pub const fn with_weight(mut self, weight: FontWeight) -> Self {
        self.weight = weight;
        self
    }

    #[must_use]
    pub const fn with_stretch(mut self, stretch: FontStretch) -> Self {
        self.stretch = stretch;
        self
    }

    #[must_use]
    pub const fn with_slant(mut self, slant: FontSlant) -> Self {
        self.slant = slant;
        self
    }
}

/// Inclusive Unicode scalar range covered by a face.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct UnicodeRange {
    start: u32,
    end: u32,
}

impl UnicodeRange {
    #[must_use]
    pub const fn new(start: char, end: char) -> Option<Self> {
        if start as u32 <= end as u32 {
            Some(Self {
                start: start as u32,
                end: end as u32,
            })
        } else {
            None
        }
    }

    #[must_use]
    pub const fn single(character: char) -> Self {
        let scalar = character as u32;
        Self {
            start: scalar,
            end: scalar,
        }
    }

    #[must_use]
    pub const fn start(self) -> u32 {
        self.start
    }

    #[must_use]
    pub const fn end(self) -> u32 {
        self.end
    }

    #[must_use]
    pub const fn contains(self, character: char) -> bool {
        let scalar = character as u32;
        scalar >= self.start && scalar <= self.end
    }
}

/// Normalized coverage map used for deterministic missing-glyph checks.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GlyphCoverage {
    ranges: Vec<UnicodeRange>,
}

impl GlyphCoverage {
    #[must_use]
    pub fn from_ranges(ranges: impl IntoIterator<Item = UnicodeRange>) -> Self {
        let mut ranges: Vec<_> = ranges.into_iter().collect();
        ranges.sort_unstable_by_key(|range| range.start);

        let mut merged: Vec<UnicodeRange> = Vec::with_capacity(ranges.len());
        for range in ranges {
            if let Some(previous) = merged.last_mut() {
                if range.start <= previous.end.saturating_add(1) {
                    previous.end = previous.end.max(range.end);
                    continue;
                }
            }
            merged.push(range);
        }
        Self { ranges: merged }
    }

    #[must_use]
    pub fn from_chars(characters: impl IntoIterator<Item = char>) -> Self {
        Self::from_ranges(characters.into_iter().map(UnicodeRange::single))
    }

    #[must_use]
    pub fn contains(&self, character: char) -> bool {
        let scalar = character as u32;
        let insertion = self.ranges.partition_point(|range| range.start <= scalar);
        insertion > 0 && self.ranges[insertion - 1].contains(character)
    }

    #[must_use]
    pub fn ranges(&self) -> &[UnicodeRange] {
        &self.ranges
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.ranges.is_empty()
    }
}

/// Invalid font metadata rejected at the database boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FontDatabaseError {
    EmptyFamily,
}

impl fmt::Display for FontDatabaseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyFamily => formatter.write_str("font family must not be empty"),
        }
    }
}

impl Error for FontDatabaseError {}

/// Metadata required to match a font face before shaping.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FontFaceDescriptor {
    family: String,
    aliases: Vec<String>,
    normalized_families: Vec<String>,
    style: FontStyle,
    scripts: Vec<Script>,
    coverage: GlyphCoverage,
    source: Option<FontSource>,
}

impl FontFaceDescriptor {
    pub fn new(
        family: impl Into<String>,
        style: FontStyle,
        coverage: GlyphCoverage,
    ) -> Result<Self, FontDatabaseError> {
        let family = family.into().trim().to_owned();
        let normalized_family = normalize_family(&family);
        if normalized_family.is_empty() {
            return Err(FontDatabaseError::EmptyFamily);
        }
        Ok(Self {
            family,
            aliases: Vec::new(),
            normalized_families: vec![normalized_family],
            style,
            scripts: Vec::new(),
            coverage,
            source: None,
        })
    }

    #[must_use]
    pub fn with_aliases<I, S>(mut self, aliases: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        for alias in aliases {
            let alias = alias.into().trim().to_owned();
            let normalized = normalize_family(&alias);
            if normalized.is_empty() || self.normalized_families.contains(&normalized) {
                continue;
            }
            self.aliases.push(alias);
            self.normalized_families.push(normalized);
        }
        self
    }

    fn add_alias(&mut self, alias: String) {
        let normalized = normalize_family(&alias);
        if normalized.is_empty() || self.normalized_families.contains(&normalized) {
            return;
        }
        self.aliases.push(alias);
        self.normalized_families.push(normalized);
    }

    #[must_use]
    pub fn with_scripts(mut self, scripts: impl IntoIterator<Item = Script>) -> Self {
        for script in scripts {
            if !self.scripts.contains(&script) {
                self.scripts.push(script);
            }
        }
        self
    }

    #[must_use]
    pub fn with_source(mut self, source: FontSource) -> Self {
        self.source = Some(source);
        self
    }

    #[must_use]
    pub fn family(&self) -> &str {
        &self.family
    }

    #[must_use]
    pub fn aliases(&self) -> &[String] {
        &self.aliases
    }

    #[must_use]
    pub const fn style(&self) -> FontStyle {
        self.style
    }

    #[must_use]
    pub fn scripts(&self) -> &[Script] {
        &self.scripts
    }

    #[must_use]
    pub const fn coverage(&self) -> &GlyphCoverage {
        &self.coverage
    }

    #[must_use]
    pub const fn source(&self) -> Option<&FontSource> {
        self.source.as_ref()
    }

    pub(crate) fn supports_family(&self, normalized_family: &str) -> bool {
        self.normalized_families
            .iter()
            .any(|family| family == normalized_family)
    }

    pub(crate) fn supports_script(&self, script: Script) -> bool {
        self.scripts.is_empty()
            || matches!(script, Script::Common | Script::Inherited | Script::Unknown)
            || self.scripts.contains(&script)
    }

    pub(crate) fn supports_character(&self, character: char) -> bool {
        self.coverage.contains(character)
            && self
                .source
                .as_ref()
                .is_none_or(|source| source.supports(character))
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct RegisteredFace<'a> {
    pub(crate) id: FontId,
    pub(crate) descriptor: &'a FontFaceDescriptor,
    pub(crate) registration_order: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct FontSelectionKey {
    pub(crate) families: Vec<String>,
    pub(crate) style: FontStyle,
    pub(crate) script: Script,
    pub(crate) character: Option<char>,
}

/// Mutable registry with stable face IDs and revision-aware match caching.
#[derive(Debug)]
pub struct FontDatabase {
    faces: ResourceStore<FontFaceDescriptor>,
    face_order: Vec<FontId>,
    script_fallbacks: HashMap<Script, Vec<String>>,
    selection_cache: Mutex<HashMap<FontSelectionKey, Option<FontId>>>,
    revision: FontDatabaseRevision,
}

impl FontDatabase {
    #[must_use]
    pub fn new() -> Self {
        Self {
            faces: ResourceStore::new(),
            face_order: Vec::new(),
            script_fallbacks: HashMap::new(),
            selection_cache: Mutex::new(HashMap::new()),
            revision: FontDatabaseRevision::default(),
        }
    }

    pub fn register_face(&mut self, mut descriptor: FontFaceDescriptor) -> FontId {
        let canonical_family = descriptor.normalized_families[0].clone();
        let mut family_aliases = descriptor.aliases.clone();
        for id in self.face_order.iter().copied() {
            let face = self
                .faces
                .get(id.resource_id())
                .expect("font order references an active resource");
            if face.normalized_families[0] == canonical_family {
                family_aliases.extend(face.aliases.iter().cloned());
            }
        }
        for alias in &family_aliases {
            descriptor.add_alias(alias.clone());
        }
        for id in self.face_order.iter().copied() {
            let face = self
                .faces
                .get_mut(id.resource_id())
                .expect("font order references an active resource");
            if face.normalized_families[0] == canonical_family {
                for alias in &family_aliases {
                    face.add_alias(alias.clone());
                }
            }
        }

        let id = FontId(self.faces.insert(descriptor));
        self.face_order.push(id);
        self.invalidate_cache();
        id
    }

    pub fn remove_face(&mut self, id: FontId) -> Option<FontFaceDescriptor> {
        let removed = self.faces.remove(id.resource_id())?;
        let position = self
            .face_order
            .iter()
            .position(|candidate| *candidate == id)
            .expect("active font resource is present in registration order");
        self.face_order.remove(position);
        self.invalidate_cache();
        Some(removed)
    }

    pub fn set_script_fallbacks<I, S>(&mut self, script: Script, families: I)
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut normalized = Vec::new();
        for family in families {
            let family = normalize_family(family.as_ref());
            if !family.is_empty() && !normalized.contains(&family) {
                normalized.push(family);
            }
        }

        let changed = if normalized.is_empty() {
            self.script_fallbacks.remove(&script).is_some()
        } else if self.script_fallbacks.get(&script) == Some(&normalized) {
            false
        } else {
            self.script_fallbacks.insert(script, normalized);
            true
        };
        if changed {
            self.invalidate_cache();
        }
    }

    #[must_use]
    pub fn face(&self, id: FontId) -> Option<&FontFaceDescriptor> {
        self.faces.get(id.resource_id())
    }

    #[must_use]
    pub fn revision(&self) -> FontDatabaseRevision {
        self.revision
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.faces.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.faces.is_empty()
    }

    /// Iterates over registered faces that have source bytes available to a
    /// shaping or rendering backend.
    pub fn source_faces(&self) -> impl Iterator<Item = (FontId, &FontSource)> {
        self.face_order.iter().copied().filter_map(|id| {
            self.faces
                .get(id.resource_id())
                .expect("font order references an active resource")
                .source()
                .map(|source| (id, source))
        })
    }

    pub fn invalidate_cache(&mut self) {
        self.revision.0 = self
            .revision
            .0
            .checked_add(1)
            .expect("font database exhausted its revision space");
        self.selection_cache
            .get_mut()
            .unwrap_or_else(PoisonError::into_inner)
            .clear();
    }

    pub(crate) fn faces(&self) -> impl Iterator<Item = RegisteredFace<'_>> + '_ {
        self.face_order
            .iter()
            .copied()
            .enumerate()
            .map(|(registration_order, id)| RegisteredFace {
                id,
                descriptor: self
                    .faces
                    .get(id.resource_id())
                    .expect("font order references an active resource"),
                registration_order,
            })
    }

    pub(crate) fn script_fallbacks(&self, script: Script) -> &[String] {
        self.script_fallbacks
            .get(&script)
            .map_or(&[], Vec::as_slice)
    }

    pub(crate) fn cached_selection(&self, key: &FontSelectionKey) -> Option<Option<FontId>> {
        self.selection_cache
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(key)
            .copied()
    }

    pub(crate) fn cache_selection(&self, key: FontSelectionKey, selection: Option<FontId>) {
        self.selection_cache
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(key, selection);
    }
}

impl Default for FontDatabase {
    fn default() -> Self {
        Self::new()
    }
}

pub(crate) fn normalize_family(value: &str) -> String {
    let mut normalized = String::new();
    let mut pending_space = false;
    for character in value.trim().chars() {
        if character.is_whitespace() {
            pending_space = true;
            continue;
        }
        if pending_space && !normalized.is_empty() {
            normalized.push(' ');
        }
        normalized.extend(character.to_lowercase());
        pending_space = false;
    }
    normalized
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::{
        FontDatabase, FontFaceDescriptor, FontSource, FontStyle, GlyphCoverage, UnicodeRange,
    };

    #[test]
    fn coverage_merges_overlapping_and_adjacent_ranges() {
        let coverage = GlyphCoverage::from_ranges([
            UnicodeRange::new('d', 'f').unwrap(),
            UnicodeRange::new('a', 'c').unwrap(),
            UnicodeRange::single('z'),
        ]);

        assert_eq!(coverage.ranges().len(), 2);
        assert!(coverage.contains('e'));
        assert!(!coverage.contains('x'));
        assert!(coverage.contains('z'));
    }

    #[test]
    fn removed_face_slot_is_reused_without_reviving_its_stale_id() {
        let mut database = FontDatabase::new();
        let first = database.register_face(
            FontFaceDescriptor::new(
                "First Face",
                FontStyle::default(),
                GlyphCoverage::from_chars(['a']),
            )
            .unwrap(),
        );

        assert!(database.remove_face(first).is_some());
        let replacement = database.register_face(
            FontFaceDescriptor::new(
                "Replacement Face",
                FontStyle::default(),
                GlyphCoverage::from_chars(['b']),
            )
            .unwrap(),
        );

        assert_eq!(first.get() as u32, replacement.get() as u32);
        assert_eq!(first.get() >> 32, 1);
        assert_eq!(replacement.get() >> 32, 2);
        assert!(database.face(first).is_none());
        assert!(database.remove_face(first).is_none());
        assert_eq!(
            database.face(replacement).map(FontFaceDescriptor::family),
            Some("Replacement Face")
        );
        assert_eq!(database.len(), 1);
    }

    #[test]
    fn source_faces_keep_active_registration_order_after_slot_reuse() {
        let descriptor = |family: &str, character| {
            FontFaceDescriptor::new(
                family,
                FontStyle::default(),
                GlyphCoverage::from_chars([character]),
            )
            .unwrap()
            .with_source(
                FontSource::new(
                    Arc::<[u8]>::from(font_test_data::NOTOSERIF_AUTOHINT_SHAPING),
                    0,
                )
                .unwrap(),
            )
        };
        let mut database = FontDatabase::new();
        let removed = database.register_face(descriptor("Removed Face", 'a'));
        let retained = database.register_face(descriptor("Retained Face", 'b'));

        assert!(database.remove_face(removed).is_some());
        let replacement = database.register_face(descriptor("Replacement Face", 'c'));

        assert_eq!(removed.get() as u32, replacement.get() as u32);
        assert_eq!(
            database
                .source_faces()
                .map(|(id, _)| id)
                .collect::<Vec<_>>(),
            vec![retained, replacement]
        );
    }
}
