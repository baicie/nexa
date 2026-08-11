//! Deterministic family, style, script, and missing-glyph selection.

use unicode_script::{Script, UnicodeScript};

use crate::font_database::{
    normalize_family, FontDatabase, FontId, FontSelectionKey, FontSlant, FontStyle, RegisteredFace,
};

/// Owned face request suitable for reuse by paragraph and shaping caches.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash)]
pub struct FontRequest {
    families: Vec<String>,
    normalized_families: Vec<String>,
    style: FontStyle,
    script: Option<Script>,
}

impl FontRequest {
    #[must_use]
    pub fn new<I, S>(families: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let mut request = Self::default();
        for family in families {
            let family = family.into().trim().to_owned();
            let normalized = normalize_family(&family);
            if normalized.is_empty() || request.normalized_families.contains(&normalized) {
                continue;
            }
            request.families.push(family);
            request.normalized_families.push(normalized);
        }
        request
    }

    #[must_use]
    pub const fn with_style(mut self, style: FontStyle) -> Self {
        self.style = style;
        self
    }

    #[must_use]
    pub const fn with_script(mut self, script: Script) -> Self {
        self.script = Some(script);
        self
    }

    #[must_use]
    pub fn families(&self) -> &[String] {
        &self.families
    }

    #[must_use]
    pub const fn style(&self) -> FontStyle {
        self.style
    }

    #[must_use]
    pub const fn script(&self) -> Option<Script> {
        self.script
    }

    fn selection_key(&self, script: Script, character: Option<char>) -> FontSelectionKey {
        FontSelectionKey {
            families: self.normalized_families.clone(),
            style: self.style,
            script,
            character,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct FaceScore {
    script_mismatch: u8,
    family_rank: usize,
    slant_distance: u8,
    stretch_distance: u8,
    weight_distance: u16,
    registration_order: usize,
}

impl FontDatabase {
    /// Resolves the best face for a family/style/script request.
    #[must_use]
    pub fn resolve(&self, request: &FontRequest) -> Option<FontId> {
        let script = request.script.unwrap_or(Script::Common);
        self.select(request, script, None)
    }

    /// Selects the best requested or fallback face that contains `character`.
    #[must_use]
    pub fn fallback_for_char(&self, request: &FontRequest, character: char) -> Option<FontId> {
        let script = request.script.unwrap_or_else(|| character.script());
        self.select(request, script, Some(character))
    }

    /// Selects one face for an entire extended grapheme cluster.
    #[must_use]
    pub fn fallback_for_cluster(&self, request: &FontRequest, cluster: &str) -> Option<FontId> {
        if cluster.is_empty() {
            return None;
        }
        let script = request.script.unwrap_or_else(|| {
            cluster
                .chars()
                .map(|character| character.script())
                .find(|script| {
                    !matches!(script, Script::Common | Script::Inherited | Script::Unknown)
                })
                .unwrap_or(Script::Common)
        });
        let script_fallbacks = self.script_fallbacks(script);
        let key = request.selection_key(script, None);
        self.faces()
            .filter(|face| {
                cluster.chars().all(|character| {
                    is_default_ignorable_for_shaping(character)
                        || face.descriptor.supports_character(character)
                })
            })
            .min_by_key(|face| face_score(face, &key, script_fallbacks))
            .map(|face| face.id)
    }

    fn select(
        &self,
        request: &FontRequest,
        script: Script,
        character: Option<char>,
    ) -> Option<FontId> {
        let key = request.selection_key(script, character);
        if let Some(selection) = self.cached_selection(&key) {
            return selection;
        }

        let script_fallbacks = self.script_fallbacks(script);
        let selection = self
            .faces()
            .filter(|face| character.is_none_or(|value| face.descriptor.supports_character(value)))
            .min_by_key(|face| face_score(face, &key, script_fallbacks))
            .map(|face| face.id);
        self.cache_selection(key, selection);
        selection
    }
}

pub(crate) fn is_default_ignorable_for_shaping(character: char) -> bool {
    matches!(
        character as u32,
        0x00ad
            | 0x034f
            | 0x061c
            | 0x180b..=0x180f
            | 0x200b..=0x200f
            | 0x202a..=0x202e
            | 0x2060..=0x206f
            | 0xfe00..=0xfe0f
            | 0xfeff
            | 0xfff0..=0xfff8
            | 0x1bca0..=0x1bca3
            | 0x1d173..=0x1d17a
            | 0xe0000..=0xe0fff
    )
}

fn face_score(
    face: &RegisteredFace<'_>,
    request: &FontSelectionKey,
    script_fallbacks: &[String],
) -> FaceScore {
    let style = face.descriptor.style();
    FaceScore {
        script_mismatch: u8::from(!face.descriptor.supports_script(request.script)),
        family_rank: family_rank(face, &request.families, script_fallbacks),
        slant_distance: slant_distance(style.slant, request.style.slant),
        stretch_distance: (style.stretch as u8).abs_diff(request.style.stretch as u8),
        weight_distance: style.weight.get().abs_diff(request.style.weight.get()),
        registration_order: face.registration_order,
    }
}

fn family_rank(
    face: &RegisteredFace<'_>,
    requested_families: &[String],
    script_fallbacks: &[String],
) -> usize {
    if let Some(rank) = requested_families
        .iter()
        .position(|family| face.descriptor.supports_family(family))
    {
        return rank;
    }
    if let Some(rank) = script_fallbacks
        .iter()
        .position(|family| face.descriptor.supports_family(family))
    {
        return requested_families.len() + rank;
    }
    requested_families.len() + script_fallbacks.len()
}

const fn slant_distance(candidate: FontSlant, requested: FontSlant) -> u8 {
    match (candidate, requested) {
        (left, right) if left as u8 == right as u8 => 0,
        (FontSlant::Italic, FontSlant::Oblique) | (FontSlant::Oblique, FontSlant::Italic) => 1,
        _ => 2,
    }
}

#[cfg(test)]
mod tests {
    use unicode_script::Script;

    use crate::font_database::{
        FontDatabase, FontFaceDescriptor, FontSlant, FontStyle, FontWeight, GlyphCoverage,
    };
    use crate::font_fallback::FontRequest;

    fn face(
        family: &str,
        style: FontStyle,
        scripts: impl IntoIterator<Item = Script>,
        characters: &str,
    ) -> FontFaceDescriptor {
        FontFaceDescriptor::new(family, style, GlyphCoverage::from_chars(characters.chars()))
            .expect("fixture family is valid")
            .with_scripts(scripts)
    }

    #[test]
    fn resolves_family_alias_and_nearest_style_deterministically() {
        let mut database = FontDatabase::new();
        let regular = database.register_face(
            face("Nexa Sans", FontStyle::default(), [Script::Latin], "abc")
                .with_aliases(["Nexa UI Sans"]),
        );
        let bold = database.register_face(face(
            "Nexa Sans",
            FontStyle::default().with_weight(FontWeight::BOLD),
            [Script::Latin],
            "abc",
        ));
        let italic = database.register_face(face(
            "Nexa Sans",
            FontStyle::default().with_slant(FontSlant::Italic),
            [Script::Latin],
            "abc",
        ));

        let alias_request = FontRequest::new(["nexa   ui sans"])
            .with_style(FontStyle::default().with_weight(FontWeight::new(650).unwrap()))
            .with_script(Script::Latin);
        assert_eq!(database.resolve(&alias_request), Some(bold));

        let italic_request = FontRequest::new(["NEXA SANS"])
            .with_style(FontStyle::default().with_slant(FontSlant::Italic))
            .with_script(Script::Latin);
        assert_eq!(database.resolve(&italic_request), Some(italic));

        let regular_request = FontRequest::new(["Nexa Sans"]);
        assert_eq!(database.resolve(&regular_request), Some(regular));
    }

    #[test]
    fn chooses_configured_script_fallback_when_primary_lacks_a_glyph() {
        let mut database = FontDatabase::new();
        let primary = database.register_face(face(
            "Nexa Sans",
            FontStyle::default(),
            [Script::Latin],
            "Nexa",
        ));
        let global_han = database.register_face(face(
            "Global Han",
            FontStyle::default(),
            [Script::Han],
            "中文",
        ));
        let preferred_han = database.register_face(face(
            "Preferred Han",
            FontStyle::default(),
            [Script::Han],
            "中文",
        ));
        let request = FontRequest::new(["Nexa Sans"]);
        assert_eq!(database.fallback_for_char(&request, 'N'), Some(primary));
        assert_eq!(database.fallback_for_char(&request, '中'), Some(global_han));

        database.set_script_fallbacks(Script::Han, ["Preferred Han", "Global Han"]);
        assert_eq!(
            database.fallback_for_char(&request, '中'),
            Some(preferred_han)
        );
        assert_ne!(database.fallback_for_char(&request, '中'), Some(global_han));

        let han_request = request.with_script(Script::Han);
        assert_eq!(database.resolve(&han_request), Some(preferred_han));
    }

    #[test]
    fn skips_faces_that_do_not_cover_the_requested_character() {
        let mut database = FontDatabase::new();
        database.register_face(face(
            "Primary",
            FontStyle::default(),
            [Script::Latin],
            "ABC",
        ));
        let greek = database.register_face(face(
            "Greek Fallback",
            FontStyle::default(),
            [Script::Greek],
            "Ω",
        ));

        let request = FontRequest::new(["Primary"]).with_script(Script::Greek);
        assert_eq!(database.fallback_for_char(&request, 'Ω'), Some(greek));
        assert_eq!(database.fallback_for_char(&request, 'Ж'), None);
    }

    #[test]
    fn database_mutations_invalidate_positive_and_negative_cache_entries() {
        let mut database = FontDatabase::new();
        let request = FontRequest::new(["Arabic UI"]);
        assert_eq!(database.fallback_for_char(&request, 'م'), None);
        let before_registration = database.revision();

        let arabic = database.register_face(face(
            "Arabic UI",
            FontStyle::default(),
            [Script::Arabic],
            "مرحبا",
        ));
        assert!(database.revision() > before_registration);
        assert_eq!(database.fallback_for_char(&request, 'م'), Some(arabic));

        let before_removal = database.revision();
        assert!(database.remove_face(arabic).is_some());
        assert!(database.revision() > before_removal);
        assert_eq!(database.fallback_for_char(&request, 'م'), None);
    }

    #[test]
    fn explicit_invalidation_advances_revision() {
        let mut database = FontDatabase::new();
        let before = database.revision();
        database.invalidate_cache();
        assert!(database.revision() > before);
    }
}
