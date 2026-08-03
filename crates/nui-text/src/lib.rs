//! Text pipeline skeleton (ADR-006 §3.1).
//!
//! Modules are placeholders until HarfBuzz / ICU / SkParagraph land.
//! Callers must not treat `draw_str` in `nui-render-skia` as the long-term API.

pub mod bidi;
pub mod editable_text;
pub mod font_database;
pub mod font_fallback;
pub mod line_breaking;
pub mod paragraph;
pub mod selection;
pub mod shaping;

/// Acceptance strings for the first real text slice (ADR-006).
pub const ACCEPTANCE_SAMPLES: &[&str] = &[
    "Hello, Nexa",
    "你好，Nexa UI",
    "مرحباً بالعالم",
    "👨‍👩‍👧‍👦 ❤️ 🧑🏽‍💻",
    "English 中文 mixed text",
];

#[must_use]
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acceptance_samples_non_empty() {
        assert_eq!(ACCEPTANCE_SAMPLES.len(), 5);
        assert!(ACCEPTANCE_SAMPLES.iter().all(|s| !s.is_empty()));
    }
}
