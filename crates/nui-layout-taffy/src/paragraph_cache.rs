//! Paragraph snapshots shared by Taffy measure callbacks.

use std::collections::HashMap;
use std::sync::Arc;

use nui_core::{NodeId, ResourceId, ResourceStore};
use nui_text::{
    layout_paragraph, FontDatabase, FontDatabaseRevision, FontRequest, FontStyle, ParagraphError,
    ParagraphSnapshot, ParagraphStyle, ParagraphWidth, TextDirection,
};

/// Maximum paragraph snapshots retained by the default layout cache.
pub const DEFAULT_PARAGRAPH_CACHE_CAPACITY: usize = 256;

/// Width constraint supplied by a layout engine to a paragraph measure.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TextWidthConstraint {
    /// The paragraph may wrap to the given finite width.
    Definite(f32),
    /// Measure under the minimum-content constraint.
    MinContent,
    /// Measure without a wrapping limit.
    MaxContent,
}

impl TextWidthConstraint {
    fn paragraph_width(self) -> Result<ParagraphWidth, ParagraphError> {
        match self {
            Self::Definite(width) => ParagraphWidth::at_most(width),
            Self::MinContent => ParagraphWidth::at_most(0.0),
            Self::MaxContent => Ok(ParagraphWidth::unbounded()),
        }
    }

    fn key(self) -> WidthKey {
        match self {
            Self::Definite(width) => WidthKey::Definite(width.to_bits()),
            Self::MinContent => WidthKey::MinContent,
            Self::MaxContent => WidthKey::MaxContent,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum WidthKey {
    Definite(u32),
    MinContent,
    MaxContent,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ParagraphCacheKey {
    source: String,
    font_size: u32,
    width: WidthKey,
    font_revision: FontDatabaseRevision,
    font_request: FontRequest,
    default_direction: Option<TextDirection>,
}

/// Revision-aware immutable paragraph snapshot cache.
#[derive(Debug)]
pub struct ParagraphCache {
    database: FontDatabase,
    font_request: FontRequest,
    default_direction: Option<TextDirection>,
    entries: HashMap<ParagraphCacheKey, ResourceId>,
    node_snapshots: HashMap<NodeId, ResourceId>,
    resources: ResourceStore<Arc<ParagraphSnapshot>>,
    cached_revision: FontDatabaseRevision,
    capacity: usize,
}

impl Default for ParagraphCache {
    fn default() -> Self {
        Self::empty()
    }
}

impl ParagraphCache {
    /// Creates a cache backed by an injected font database and request.
    #[must_use]
    pub fn new(database: FontDatabase, font_request: FontRequest) -> Self {
        Self::with_capacity(database, font_request, DEFAULT_PARAGRAPH_CACHE_CAPACITY)
    }

    /// Creates a cache with an explicit snapshot capacity. A zero capacity
    /// performs paragraph layout without retaining snapshots.
    #[must_use]
    pub fn with_capacity(
        database: FontDatabase,
        font_request: FontRequest,
        capacity: usize,
    ) -> Self {
        let cached_revision = database.revision();
        Self {
            database,
            font_request,
            default_direction: None,
            entries: HashMap::new(),
            node_snapshots: HashMap::new(),
            resources: ResourceStore::new(),
            cached_revision,
            capacity,
        }
    }

    /// Creates an empty cache for callers that have not registered fonts yet.
    #[must_use]
    pub fn empty() -> Self {
        Self::new(FontDatabase::new(), FontRequest::default())
    }

    /// Sets the paragraph base direction used for future snapshots.
    pub fn set_default_direction(&mut self, direction: Option<TextDirection>) {
        if self.default_direction != direction {
            self.default_direction = direction;
            self.clear();
        }
    }

    /// Returns the registered font database for read-only inspection.
    #[must_use]
    pub const fn database(&self) -> &FontDatabase {
        &self.database
    }

    /// Returns the mutable font database. Callers should clear the cache after
    /// replacing external font state; revision changes prevent stale matches.
    pub fn database_mut(&mut self) -> &mut FontDatabase {
        &mut self.database
    }

    /// Returns the configured base style used when a node does not override it.
    #[must_use]
    pub const fn font_style(&self) -> FontStyle {
        self.font_request.style()
    }

    /// Removes all retained snapshots.
    pub fn clear(&mut self) {
        self.entries.clear();
        self.node_snapshots.clear();
        self.resources.clear();
    }

    /// Number of currently retained reusable cache entries.
    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether no reusable snapshots are currently retained.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Maximum number of reusable snapshots retained across layout passes.
    #[must_use]
    pub const fn capacity(&self) -> usize {
        self.capacity
    }

    /// Starts one layout pass and drops node bindings from the previous pass.
    pub(crate) fn begin_layout_pass(&mut self) {
        self.refresh_revision();
        self.node_snapshots.clear();
        self.retain_referenced_resources();
    }

    /// Drops node bindings when a layout pass cannot produce a usable frame.
    pub(crate) fn discard_layout_pass(&mut self) {
        self.node_snapshots.clear();
        self.retain_referenced_resources();
    }

    /// Pins the exact immutable snapshot used to measure one node.
    pub(crate) fn record_snapshot_for_node(&mut self, node: NodeId, resource_id: ResourceId) {
        self.refresh_revision();
        self.node_snapshots.insert(node, resource_id);
        self.retain_referenced_resources();
    }

    /// Returns the snapshot used by the current layout pass for `node`.
    pub fn snapshot_for_node(&mut self, node: NodeId) -> Option<Arc<ParagraphSnapshot>> {
        self.refresh_revision();
        let resource_id = *self.node_snapshots.get(&node)?;
        self.resources.get(resource_id).map(Arc::clone)
    }

    #[cfg(test)]
    pub(crate) fn resource_id_for_node(&mut self, node: NodeId) -> Option<ResourceId> {
        self.refresh_revision();
        let resource_id = *self.node_snapshots.get(&node)?;
        self.resources.get(resource_id).map(|_| resource_id)
    }

    #[cfg(test)]
    pub(crate) fn clear_retained_entries_for_test(&mut self) {
        self.entries.clear();
        self.retain_referenced_resources();
    }

    /// Gets or creates a paragraph snapshot for one measure constraint.
    pub fn snapshot(
        &mut self,
        source: &str,
        font_size: f32,
        width: TextWidthConstraint,
    ) -> Result<Arc<ParagraphSnapshot>, ParagraphError> {
        let request = self.font_request.clone();
        let (_, snapshot) =
            self.snapshot_resource_with_request(source, font_size, width, request)?;
        self.retain_referenced_resources();
        Ok(snapshot)
    }

    /// Gets or creates a snapshot using a node-specific font style while
    /// preserving the cache's configured family and script preferences.
    pub fn snapshot_with_style(
        &mut self,
        source: &str,
        font_size: f32,
        font_style: FontStyle,
        width: TextWidthConstraint,
    ) -> Result<Arc<ParagraphSnapshot>, ParagraphError> {
        let request = self.font_request.clone().with_style(font_style);
        let (_, snapshot) =
            self.snapshot_resource_with_request(source, font_size, width, request)?;
        self.retain_referenced_resources();
        Ok(snapshot)
    }

    pub(crate) fn snapshot_resource_with_style(
        &mut self,
        source: &str,
        font_size: f32,
        font_style: FontStyle,
        width: TextWidthConstraint,
    ) -> Result<(ResourceId, Arc<ParagraphSnapshot>), ParagraphError> {
        let request = self.font_request.clone().with_style(font_style);
        self.snapshot_resource_with_request(source, font_size, width, request)
    }

    fn snapshot_resource_with_request(
        &mut self,
        source: &str,
        font_size: f32,
        width: TextWidthConstraint,
        font_request: FontRequest,
    ) -> Result<(ResourceId, Arc<ParagraphSnapshot>), ParagraphError> {
        self.refresh_revision();
        let key = ParagraphCacheKey {
            source: source.to_owned(),
            font_size: font_size.to_bits(),
            width: width.key(),
            font_revision: self.database.revision(),
            font_request,
            default_direction: self.default_direction,
        };
        if let Some(resource_id) = self.entries.get(&key).copied() {
            if let Some(snapshot) = self.resources.get(resource_id) {
                return Ok((resource_id, Arc::clone(snapshot)));
            }
            self.entries.remove(&key);
        }

        let mut style = ParagraphStyle::new(key.font_request.clone(), font_size)?;
        if let Some(direction) = self.default_direction {
            style = style.with_default_direction(direction);
        }
        let snapshot = Arc::new(layout_paragraph(
            &self.database,
            source,
            &style,
            width.paragraph_width()?,
        )?);
        let resource_id = self.resources.insert(Arc::clone(&snapshot));
        if self.capacity > 0 {
            if self.entries.len() >= self.capacity {
                self.entries.clear();
                self.retain_referenced_resources();
            }
            self.entries.insert(key, resource_id);
        }
        Ok((resource_id, snapshot))
    }

    fn refresh_revision(&mut self) {
        let revision = self.database.revision();
        if self.cached_revision != revision {
            self.entries.clear();
            self.node_snapshots.clear();
            self.resources.clear();
            self.cached_revision = revision;
        }
    }

    fn retain_referenced_resources(&mut self) {
        let mut referenced = self
            .entries
            .values()
            .copied()
            .collect::<std::collections::HashSet<_>>();
        referenced.extend(self.node_snapshots.values().copied());
        let stale = self
            .resources
            .iter()
            .filter_map(|(resource_id, _)| {
                (!referenced.contains(&resource_id)).then_some(resource_id)
            })
            .collect::<Vec<_>>();
        for resource_id in stale {
            self.resources.remove(resource_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use nui_text::{FontFaceDescriptor, FontSource, FontStyle, FontWeight, GlyphCoverage, Script};

    use super::*;

    fn fixture_cache() -> ParagraphCache {
        let mut database = FontDatabase::new();
        database.register_face(
            FontFaceDescriptor::new(
                "Ahem Fixture",
                FontStyle::default(),
                GlyphCoverage::from_chars("A ".chars()),
            )
            .unwrap()
            .with_scripts([Script::Latin])
            .with_source(FontSource::new(Arc::<[u8]>::from(font_test_data::AHEM), 0).unwrap()),
        );
        ParagraphCache::new(database, FontRequest::new(["Ahem Fixture"]))
    }

    #[test]
    fn reuses_snapshots_for_the_same_source_style_and_width() {
        let mut cache = fixture_cache();
        let first = cache
            .snapshot("A A", 20.0, TextWidthConstraint::MaxContent)
            .unwrap();
        let second = cache
            .snapshot("A A", 20.0, TextWidthConstraint::MaxContent)
            .unwrap();

        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(cache.len(), 1);
    }

    #[test]
    fn width_constraints_change_wrapping_and_cache_identity() {
        let mut cache = fixture_cache();
        let unbounded = cache
            .snapshot("A A", 20.0, TextWidthConstraint::MaxContent)
            .unwrap();
        let width = unbounded.lines()[0].metrics().advance();
        let wrapped = cache
            .snapshot("A A", 20.0, TextWidthConstraint::Definite(width - 0.01))
            .unwrap();

        assert_eq!(unbounded.lines().len(), 1);
        assert_eq!(wrapped.lines().len(), 2);
        assert_eq!(cache.len(), 2);
    }

    #[test]
    fn distinguishes_min_content_from_a_zero_definite_width() {
        let mut cache = fixture_cache();
        cache
            .snapshot("A", 20.0, TextWidthConstraint::MinContent)
            .unwrap();
        cache
            .snapshot("A", 20.0, TextWidthConstraint::Definite(0.0))
            .unwrap();

        assert_eq!(cache.len(), 2);
    }

    #[test]
    fn font_database_revision_discards_old_snapshots() {
        let mut cache = fixture_cache();
        cache
            .snapshot("A", 20.0, TextWidthConstraint::MaxContent)
            .unwrap();
        cache.database_mut().invalidate_cache();
        cache
            .snapshot("A", 20.0, TextWidthConstraint::MaxContent)
            .unwrap();

        assert_eq!(cache.len(), 1);
    }

    #[test]
    fn node_font_style_participates_in_selection_and_cache_identity() {
        let mut database = FontDatabase::new();
        let regular_id = database.register_face(
            FontFaceDescriptor::new(
                "Weight Fixture",
                FontStyle::default(),
                GlyphCoverage::from_chars("A ".chars()),
            )
            .unwrap()
            .with_scripts([Script::Latin])
            .with_source(FontSource::new(Arc::<[u8]>::from(font_test_data::AHEM), 0).unwrap()),
        );
        let bold_id = database.register_face(
            FontFaceDescriptor::new(
                "Weight Fixture",
                FontStyle::default().with_weight(FontWeight::BOLD),
                GlyphCoverage::from_chars("A ".chars()),
            )
            .unwrap()
            .with_scripts([Script::Latin])
            .with_source(FontSource::new(Arc::<[u8]>::from(font_test_data::AHEM), 0).unwrap()),
        );
        let mut cache = ParagraphCache::new(database, FontRequest::new(["Weight Fixture"]));

        let regular = cache
            .snapshot_with_style(
                "A",
                20.0,
                FontStyle::default(),
                TextWidthConstraint::MaxContent,
            )
            .unwrap();
        let bold = cache
            .snapshot_with_style(
                "A",
                20.0,
                FontStyle::default().with_weight(FontWeight::BOLD),
                TextWidthConstraint::MaxContent,
            )
            .unwrap();

        assert_eq!(regular.lines()[0].runs()[0].font_id(), regular_id);
        assert_eq!(bold.lines()[0].runs()[0].font_id(), bold_id);
        assert_eq!(cache.len(), 2);
    }

    #[test]
    fn capacity_bounds_dynamic_text_history_by_clearing_one_generation() {
        let mut cache = fixture_cache();
        cache.capacity = 2;

        cache
            .snapshot("A", 20.0, TextWidthConstraint::MaxContent)
            .unwrap();
        cache
            .snapshot("A A", 20.0, TextWidthConstraint::MaxContent)
            .unwrap();
        assert_eq!(cache.len(), 2);

        cache
            .snapshot("A A A", 20.0, TextWidthConstraint::MaxContent)
            .unwrap();

        assert_eq!(cache.len(), 1);
        assert_eq!(cache.capacity(), 2);
    }
}
