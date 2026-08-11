//! Bounded system-font discovery for the technical-preview Host.

use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use font_types::NameId;
use harfrust::FontRef;
use read_fonts::tables::os2::SelectionFlags;
use read_fonts::TableProvider;

use crate::{
    FontDatabase, FontFaceDescriptor, FontRequest, FontSource, FontStretch, FontStyle, FontWeight,
    GlyphCoverage, UnicodeRange,
};

const MAX_SYSTEM_FACES: usize = 128;
const MAX_SYSTEM_FILES: usize = 32;
// Current macOS Apple Color Emoji collections exceed 64 MiB. Keep discovery
// bounded while allowing the platform emoji face required by the text contract.
const MAX_FONT_FILE_BYTES: u64 = 256 * 1024 * 1024;

/// Failure raised when no usable platform font can be discovered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SystemFontError {
    NoUsableFonts,
}

impl std::fmt::Display for SystemFontError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoUsableFonts => formatter.write_str("no usable system fonts were discovered"),
        }
    }
}

impl std::error::Error for SystemFontError {}

/// Discovers a bounded set of platform fonts and returns a default family request.
///
/// The returned bytes are owned by `FontSource` values and shared with the future
/// shaper. Discovery is intentionally bounded so a machine with a large font
/// collection cannot turn Host startup into an unbounded scan or allocation.
pub fn system_font_database() -> Result<(FontDatabase, FontRequest), SystemFontError> {
    let paths = prioritized_font_paths(discover_font_paths());
    let mut sources = Vec::new();
    for path in paths {
        if sources.len() >= MAX_SYSTEM_FILES {
            break;
        }
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        if metadata.len() > MAX_FONT_FILE_BYTES {
            continue;
        }
        let Ok(bytes) = fs::read(&path) else {
            continue;
        };
        sources.push(Arc::<[u8]>::from(bytes));
    }
    database_from_sources(sources)
}

fn database_from_sources(
    sources: impl IntoIterator<Item = Arc<[u8]>>,
) -> Result<(FontDatabase, FontRequest), SystemFontError> {
    let mut database = FontDatabase::new();
    let mut default_family = None;
    let mut registered_faces = 0;

    for bytes in sources {
        if registered_faces >= MAX_SYSTEM_FACES {
            break;
        }
        for face in FontRef::fonts(&bytes) {
            if registered_faces >= MAX_SYSTEM_FACES {
                break;
            }
            let Ok(face) = face else {
                continue;
            };
            let face_index = face.ttc_index().unwrap_or(0);
            let Some(family) = face_family(&face) else {
                continue;
            };
            let Ok(source) = FontSource::new(Arc::clone(&bytes), face_index) else {
                continue;
            };
            let os2 = face.os2().ok();
            let weight = os2
                .as_ref()
                .map_or(FontWeight::NORMAL.get(), |table| table.us_weight_class())
                .clamp(1, 1000);
            let width = os2
                .as_ref()
                .map_or(FontStretch::Normal as u16, |table| table.us_width_class());
            let selection = os2
                .as_ref()
                .map(|table| table.fs_selection())
                .unwrap_or_default();
            let has_italic_angle = face
                .post()
                .is_ok_and(|table| table.italic_angle().to_f32() != 0.0);
            let style = FontStyle::default()
                .with_weight(FontWeight::new(weight).unwrap_or(FontWeight::NORMAL))
                .with_stretch(font_stretch(width))
                .with_slant(
                    if selection.contains(SelectionFlags::ITALIC) || has_italic_angle {
                        crate::FontSlant::Italic
                    } else if os2.as_ref().is_some_and(|table| {
                        table.version() >= 4 && selection.contains(SelectionFlags::OBLIQUE)
                    }) {
                        crate::FontSlant::Oblique
                    } else {
                        crate::FontSlant::Normal
                    },
                );
            let coverage = GlyphCoverage::from_ranges([
                UnicodeRange::new('\0', '\u{d7ff}').expect("valid BMP range"),
                UnicodeRange::new('\u{e000}', '\u{10ffff}').expect("valid scalar range"),
            ]);
            let Ok(descriptor) = FontFaceDescriptor::new(family.clone(), style, coverage) else {
                continue;
            };
            database.register_face(descriptor.with_source(source));
            default_family.get_or_insert(family);
            registered_faces += 1;
        }
    }

    let Some(family) = default_family else {
        return Err(SystemFontError::NoUsableFonts);
    };
    Ok((database, FontRequest::new([family])))
}

fn face_family(face: &FontRef<'_>) -> Option<String> {
    let names = face.name().ok()?;
    let data = names.string_data();
    let mut fallback = None;
    for name in names.name_record() {
        if !matches!(
            name.name_id(),
            NameId::FAMILY_NAME | NameId::TYPOGRAPHIC_FAMILY_NAME | NameId::WWS_FAMILY_NAME
        ) {
            continue;
        }
        let Ok(value) = name.string(data) else {
            continue;
        };
        let value = value.to_string();
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        if name.name_id() == NameId::FAMILY_NAME {
            return Some(value.to_owned());
        }
        fallback.get_or_insert_with(|| value.to_owned());
    }
    fallback
}

const fn font_stretch(value: u16) -> FontStretch {
    match value {
        1 => FontStretch::UltraCondensed,
        2 => FontStretch::ExtraCondensed,
        3 => FontStretch::Condensed,
        4 => FontStretch::SemiCondensed,
        6 => FontStretch::SemiExpanded,
        7 => FontStretch::Expanded,
        8 => FontStretch::ExtraExpanded,
        9 => FontStretch::UltraExpanded,
        _ => FontStretch::Normal,
    }
}

fn discover_font_paths() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    #[cfg(target_os = "macos")]
    {
        roots.extend([
            PathBuf::from("/System/Library/Fonts"),
            PathBuf::from("/Library/Fonts"),
        ]);
        if let Some(home) = std::env::var_os("HOME") {
            roots.push(PathBuf::from(home).join("Library/Fonts"));
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(windir) = std::env::var_os("WINDIR") {
            roots.push(PathBuf::from(windir).join("Fonts"));
        }
    }
    #[cfg(target_os = "linux")]
    {
        roots.extend([
            PathBuf::from("/usr/share/fonts"),
            PathBuf::from("/usr/local/share/fonts"),
        ]);
        if let Some(home) = std::env::var_os("HOME") {
            roots.push(PathBuf::from(&home).join(".fonts"));
            roots.push(PathBuf::from(&home).join(".local/share/fonts"));
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        if let Some(home) = std::env::var_os("HOME") {
            roots.push(PathBuf::from(home).join(".fonts"));
        }
    }

    let mut files = Vec::new();
    for root in roots {
        collect_font_files(&root, 0, &mut files);
    }
    files.sort();
    files.dedup();
    files
}

fn collect_font_files(path: &Path, depth: usize, files: &mut Vec<PathBuf>) {
    if depth > 4 {
        return;
    }
    let Ok(entries) = fs::read_dir(path) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            collect_font_files(&path, depth + 1, files);
        } else if file_type.is_file() && is_font_path(&path) {
            files.push(path);
        }
    }
}

fn is_font_path(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(OsStr::to_str)
            .map(|extension| extension.to_ascii_lowercase())
            .as_deref(),
        Some("ttf" | "otf" | "ttc")
    )
}

fn prioritized_font_paths(mut paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let preferred = {
        #[cfg(target_os = "macos")]
        {
            [
                "SFNS.ttf",
                "HelveticaNeue.ttc",
                "PingFang.ttc",
                "AppleSDGothicNeo.ttc",
                "Apple Color Emoji.ttc",
            ]
        }
        #[cfg(target_os = "windows")]
        {
            [
                "segoeui.ttf",
                "segoeuib.ttf",
                "segoeuii.ttf",
                "segoeuisl.ttf",
                "seguiemj.ttf",
            ]
        }
        #[cfg(target_os = "linux")]
        {
            [
                "DejaVuSans.ttf",
                "NotoSans-Regular.ttf",
                "NotoSansCJK-Regular.ttc",
                "NotoColorEmoji.ttf",
            ]
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        {
            ["DejaVuSans.ttf"]
        }
    };
    paths.sort_by_key(|path| {
        let name = path.file_name().and_then(OsStr::to_str).unwrap_or_default();
        preferred
            .iter()
            .position(|candidate| candidate.eq_ignore_ascii_case(name))
            .unwrap_or(preferred.len())
    });
    paths
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_real_font_bytes_into_a_source_backed_default_request() {
        let (database, request) = database_from_sources([Arc::<[u8]>::from(font_test_data::AHEM)])
            .expect("fixture font parses");

        let id = database.resolve(&request).expect("default face resolves");
        assert!(database.face(id).and_then(|face| face.source()).is_some());
        assert_eq!(database.len(), 1);
    }

    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    #[test]
    fn discovers_a_source_backed_platform_face_on_supported_desktops() {
        let (database, request) = system_font_database().expect("desktop system fonts");
        let id = database
            .resolve(&request)
            .expect("platform default resolves");
        assert!(database.face(id).and_then(|face| face.source()).is_some());
    }
}
