//! Platform window / input via winit + softbuffer present.
//!
//! Slice 0: open a native window and present CPU-rendered frames.
//! Slice 1: forward pointer presses for hit-testing.
//! See softbuffer + winit `ApplicationHandler` integration patterns:
//! <https://github.com/rust-windowing/softbuffer>

use std::cell::RefCell;
use std::num::NonZeroU32;
use std::rc::Rc;
#[cfg(test)]
use std::sync::Arc;

use accesskit_winit::{Adapter as AccessKitAdapter, Event as AccessKitEvent};
use softbuffer::{Context, Surface};
use winit::application::ApplicationHandler;
use winit::dpi::{LogicalPosition, LogicalSize};
use winit::event::{ElementState, Ime, KeyEvent, MouseButton, WindowEvent};
use winit::event_loop::{ActiveEventLoop, EventLoop, EventLoopProxy};
use winit::keyboard::{Key, ModifiersState, NamedKey};
use winit::platform::run_on_demand::EventLoopExtRunOnDemand;
use winit::window::{Window, WindowId};

mod accessibility;

use accessibility::{normalize_action_request, AccessibilityTree};
pub use accessibility::{AccessibilityActionRequest, AccessibilityViewport};

use nui_core::{SemanticTreeSnapshot, SurfaceGeneration, VERSION as CORE_VERSION};

/// Backend identity for diagnostics.
#[must_use]
pub fn backend_name() -> &'static str {
    "winit"
}

/// Confirms the crate links against `nui-core`.
#[must_use]
pub fn core_version() -> &'static str {
    CORE_VERSION
}

/// Named keyboard commands exposed by the platform adapter without leaking
/// winit's key types into the Host bridge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyInput {
    Backspace,
    Delete,
    Enter,
    Space,
    Tab,
    ArrowLeft,
    ArrowRight,
    ArrowUp,
    ArrowDown,
    Home,
    End,
    Copy,
    Cut,
    Paste,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct KeyModifiers {
    pub shift: bool,
    pub control: bool,
    pub alt: bool,
    pub meta: bool,
}

/// Desktop keymap selected independently from the build host so both MVP
/// platform policies can be covered by one deterministic test suite.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DesktopPlatform {
    MacOs,
    Windows,
    Other,
}

impl DesktopPlatform {
    #[must_use]
    pub const fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::MacOs
        } else if cfg!(target_os = "windows") {
            Self::Windows
        } else {
            Self::Other
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextNavigation {
    VisualLeft,
    VisualRight,
    WordLeft,
    WordRight,
    VisualUp,
    VisualDown,
    VisualLineStart,
    VisualLineEnd,
    DocumentStart,
    DocumentEnd,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextEditingCommand {
    Navigate {
        target: TextNavigation,
        extend: bool,
    },
    DeleteBackward {
        word: bool,
    },
    DeleteForward {
        word: bool,
    },
    Enter,
    Copy,
    Cut,
    Paste,
}

/// Convert a normalized key plus the complete modifier snapshot into one
/// platform-correct editing intent. Unsupported shortcut combinations stay
/// out of the editor instead of being mistaken for word movement/deletion.
#[must_use]
pub fn text_editing_command(
    key: KeyInput,
    modifiers: KeyModifiers,
    platform: DesktopPlatform,
) -> Option<TextEditingCommand> {
    let action_modifiers = (modifiers.control, modifiers.alt, modifiers.meta);
    let navigate = |target| {
        Some(TextEditingCommand::Navigate {
            target,
            extend: modifiers.shift,
        })
    };
    match key {
        KeyInput::ArrowLeft | KeyInput::ArrowRight => {
            let left = matches!(key, KeyInput::ArrowLeft);
            match (platform, action_modifiers) {
                (_, (false, false, false)) => navigate(if left {
                    TextNavigation::VisualLeft
                } else {
                    TextNavigation::VisualRight
                }),
                (DesktopPlatform::MacOs, (false, true, false)) => navigate(if left {
                    TextNavigation::WordLeft
                } else {
                    TextNavigation::WordRight
                }),
                (DesktopPlatform::MacOs, (false, false, true)) => navigate(if left {
                    TextNavigation::VisualLineStart
                } else {
                    TextNavigation::VisualLineEnd
                }),
                (DesktopPlatform::Windows | DesktopPlatform::Other, (true, false, false)) => {
                    navigate(if left {
                        TextNavigation::WordLeft
                    } else {
                        TextNavigation::WordRight
                    })
                }
                _ => None,
            }
        }
        KeyInput::ArrowUp | KeyInput::ArrowDown => {
            let up = matches!(key, KeyInput::ArrowUp);
            match (platform, action_modifiers) {
                (_, (false, false, false)) => navigate(if up {
                    TextNavigation::VisualUp
                } else {
                    TextNavigation::VisualDown
                }),
                (DesktopPlatform::MacOs, (false, false, true)) => navigate(if up {
                    TextNavigation::DocumentStart
                } else {
                    TextNavigation::DocumentEnd
                }),
                _ => None,
            }
        }
        KeyInput::Home | KeyInput::End => {
            let start = matches!(key, KeyInput::Home);
            match (platform, action_modifiers) {
                (_, (false, false, false)) => navigate(if start {
                    TextNavigation::VisualLineStart
                } else {
                    TextNavigation::VisualLineEnd
                }),
                (DesktopPlatform::MacOs, (false, false, true))
                | (DesktopPlatform::Windows | DesktopPlatform::Other, (true, false, false)) => {
                    navigate(if start {
                        TextNavigation::DocumentStart
                    } else {
                        TextNavigation::DocumentEnd
                    })
                }
                _ => None,
            }
        }
        KeyInput::Backspace | KeyInput::Delete => {
            let word = match (platform, action_modifiers) {
                (_, (false, false, false)) => false,
                (DesktopPlatform::MacOs, (false, true, false))
                | (DesktopPlatform::Windows | DesktopPlatform::Other, (true, false, false)) => true,
                _ => return None,
            };
            if matches!(key, KeyInput::Backspace) {
                Some(TextEditingCommand::DeleteBackward { word })
            } else {
                Some(TextEditingCommand::DeleteForward { word })
            }
        }
        KeyInput::Enter if matches!(action_modifiers, (false, false, false)) => {
            Some(TextEditingCommand::Enter)
        }
        KeyInput::Copy | KeyInput::Cut | KeyInput::Paste => {
            if modifiers.shift {
                return None;
            }
            let primary_modifier = match platform {
                DesktopPlatform::MacOs => action_modifiers == (false, false, true),
                DesktopPlatform::Windows | DesktopPlatform::Other => {
                    action_modifiers == (true, false, false)
                }
            };
            primary_modifier.then_some(match key {
                KeyInput::Copy => TextEditingCommand::Copy,
                KeyInput::Cut => TextEditingCommand::Cut,
                KeyInput::Paste => TextEditingCommand::Paste,
                _ => unreachable!("clipboard branch filters key variants"),
            })
        }
        KeyInput::Enter | KeyInput::Space | KeyInput::Tab => None,
    }
}

/// Validated logical rectangle used to place the native IME candidate window.
///
/// Coordinates may be negative when an editor is inside a scrolled or clipped
/// subtree. Dimensions must be finite and strictly positive because winit
/// forwards them directly to the platform text-input API.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ImeCursorArea {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// IME cursor or selection expressed as UTF-16 code units relative to a
/// preedit string.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImeUtf16Selection {
    pub start: usize,
    pub end: usize,
}

/// Convert winit's UTF-8 byte range into the UTF-16 units used by the Host
/// protocol. Missing or malformed platform ranges intentionally return
/// `None`; the editor then falls back to a collapsed cursor at preedit end.
#[must_use]
pub fn ime_preedit_selection_utf16(
    preedit: &str,
    cursor: Option<(usize, usize)>,
) -> Option<ImeUtf16Selection> {
    let (start, end) = cursor?;
    if start > end
        || end > preedit.len()
        || !preedit.is_char_boundary(start)
        || !preedit.is_char_boundary(end)
    {
        return None;
    }
    Some(ImeUtf16Selection {
        start: preedit[..start].encode_utf16().count(),
        end: preedit[..end].encode_utf16().count(),
    })
}

impl ImeCursorArea {
    /// Construct a candidate-window rectangle after validating all geometry.
    #[must_use]
    pub fn new(x: f64, y: f64, width: f64, height: f64) -> Option<Self> {
        if !x.is_finite()
            || !y.is_finite()
            || !width.is_finite()
            || !height.is_finite()
            || width <= 0.0
            || height <= 0.0
        {
            return None;
        }
        Some(Self {
            x,
            y,
            width,
            height,
        })
    }

    #[must_use]
    pub const fn x(self) -> f64 {
        self.x
    }

    #[must_use]
    pub const fn y(self) -> f64 {
        self.y
    }

    #[must_use]
    pub const fn width(self) -> f64 {
        self.width
    }

    #[must_use]
    pub const fn height(self) -> f64 {
        self.height
    }
}

/// Native IME activation and optional candidate-window geometry.
///
/// `Enabled` without an area preserves the last valid platform position while
/// an editor is focused but its next paragraph layout is not ready yet.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ImeState {
    Disabled,
    Enabled { cursor_area: Option<ImeCursorArea> },
}

impl Default for ImeState {
    fn default() -> Self {
        Self::Enabled { cursor_area: None }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum PreeditState {
    #[default]
    Idle,
    Active,
    ClearedPendingCommit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PreeditTransition {
    Ignore,
    StartAndUpdate,
    Update,
    ClearPendingCommit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
struct TextInputRouting {
    preedit: PreeditState,
}

impl TextInputRouting {
    fn keyboard_text<'a>(&self, text: Option<&'a str>, modifiers: KeyModifiers) -> Option<&'a str> {
        let text = text?;
        let is_shortcut = modifiers.meta || (modifiers.control && !modifiers.alt);
        if self.preedit != PreeditState::Idle
            || text.is_empty()
            || text.chars().any(char::is_control)
            || is_shortcut
        {
            return None;
        }
        Some(text)
    }

    fn ime_preedit(&mut self, text: &str) -> PreeditTransition {
        if text.is_empty() {
            return match self.preedit {
                PreeditState::Idle => PreeditTransition::Ignore,
                PreeditState::Active | PreeditState::ClearedPendingCommit => {
                    self.preedit = PreeditState::ClearedPendingCommit;
                    PreeditTransition::ClearPendingCommit
                }
            };
        }
        let transition = match self.preedit {
            PreeditState::Idle => PreeditTransition::StartAndUpdate,
            PreeditState::Active | PreeditState::ClearedPendingCommit => PreeditTransition::Update,
        };
        self.preedit = PreeditState::Active;
        transition
    }

    fn ime_commit(&mut self) -> bool {
        let active = self.preedit != PreeditState::Idle;
        self.preedit = PreeditState::Idle;
        active
    }

    fn ime_enabled(&mut self) -> bool {
        self.clear()
    }

    fn ime_disabled(&mut self) -> bool {
        self.clear()
    }

    fn flush_pending_clear(&mut self) -> bool {
        if self.preedit != PreeditState::ClearedPendingCommit {
            return false;
        }
        self.preedit = PreeditState::Idle;
        true
    }

    fn clear(&mut self) -> bool {
        let active = self.preedit != PreeditState::Idle;
        self.preedit = PreeditState::Idle;
        active
    }
}

fn named_key_input(logical_key: &Key) -> Option<KeyInput> {
    match logical_key {
        Key::Named(NamedKey::Backspace) => Some(KeyInput::Backspace),
        Key::Named(NamedKey::Delete) => Some(KeyInput::Delete),
        Key::Named(NamedKey::Enter) => Some(KeyInput::Enter),
        Key::Named(NamedKey::Space) => Some(KeyInput::Space),
        Key::Named(NamedKey::Tab) => Some(KeyInput::Tab),
        Key::Named(NamedKey::ArrowLeft) => Some(KeyInput::ArrowLeft),
        Key::Named(NamedKey::ArrowRight) => Some(KeyInput::ArrowRight),
        Key::Named(NamedKey::ArrowUp) => Some(KeyInput::ArrowUp),
        Key::Named(NamedKey::ArrowDown) => Some(KeyInput::ArrowDown),
        Key::Named(NamedKey::Home) => Some(KeyInput::Home),
        Key::Named(NamedKey::End) => Some(KeyInput::End),
        Key::Character(value) if value.eq_ignore_ascii_case("c") => Some(KeyInput::Copy),
        Key::Character(value) if value.eq_ignore_ascii_case("x") => Some(KeyInput::Cut),
        Key::Character(value) if value.eq_ignore_ascii_case("v") => Some(KeyInput::Paste),
        _ => None,
    }
}

#[cfg(test)]
fn dispatch_keyboard_press(
    app: &mut dyn WindowApp,
    routing: &TextInputRouting,
    logical_key: &Key,
    text: Option<&str>,
    modifiers: KeyModifiers,
) -> bool {
    dispatch_keyboard_press_with_repeat(app, routing, logical_key, text, modifiers, false)
}

fn dispatch_keyboard_press_with_repeat(
    app: &mut dyn WindowApp,
    routing: &TextInputRouting,
    logical_key: &Key,
    text: Option<&str>,
    modifiers: KeyModifiers,
    repeat: bool,
) -> bool {
    if routing.preedit != PreeditState::Idle {
        return false;
    }
    let command_redraw = named_key_input(logical_key)
        .is_some_and(|key| app.key_command_with_repeat(key, modifiers, repeat));
    let text_redraw = routing
        .keyboard_text(text, modifiers)
        .is_some_and(|text| app.text_input(text));
    command_redraw || text_redraw
}

fn dispatch_keyboard_release(
    app: &mut dyn WindowApp,
    logical_key: &Key,
    modifiers: KeyModifiers,
) -> bool {
    named_key_input(logical_key).is_some_and(|key| app.key_command_released(key, modifiers))
}

fn dispatch_pointer_moved(app: &mut dyn WindowApp, x: f64, y: f64, scale: f64) -> bool {
    app.pointer_moved(x, y, scale)
}

fn dispatch_pointer_exited(app: &mut dyn WindowApp) -> bool {
    app.pointer_exited()
}

/// Lifecycle states for the backend surface and its CPU/GPU resources.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SurfaceState {
    Absent,
    Ready,
    Suspended,
    Recreating,
    Failed,
}

/// Small deterministic state machine shared by platform integration and tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SurfaceLifecycle {
    state: SurfaceState,
    generation: SurfaceGeneration,
    full_repaint_pending: bool,
}

impl Default for SurfaceLifecycle {
    fn default() -> Self {
        Self {
            state: SurfaceState::Absent,
            generation: SurfaceGeneration::default(),
            full_repaint_pending: false,
        }
    }
}

impl SurfaceLifecycle {
    #[must_use]
    pub const fn state(self) -> SurfaceState {
        self.state
    }

    #[must_use]
    pub const fn generation(self) -> SurfaceGeneration {
        self.generation
    }

    #[must_use]
    pub const fn full_repaint_pending(self) -> bool {
        self.full_repaint_pending
    }

    /// Begin creation or recreation. Repeated calls while recreating are
    /// idempotent, and a ready surface is left intact.
    pub fn begin_recreate(&mut self) -> bool {
        match self.state {
            SurfaceState::Ready | SurfaceState::Recreating => false,
            SurfaceState::Absent | SurfaceState::Suspended | SurfaceState::Failed => {
                self.state = SurfaceState::Recreating;
                true
            }
        }
    }

    /// Complete one successful creation and publish a fresh backend identity.
    pub fn mark_ready(&mut self) -> Option<SurfaceGeneration> {
        if self.state != SurfaceState::Recreating {
            return None;
        }
        self.generation = self.generation.next();
        self.state = SurfaceState::Ready;
        self.full_repaint_pending = true;
        Some(self.generation)
    }

    /// Record a successful present for the current surface. Returns `true`
    /// only when this clears the recovery repaint obligation.
    pub fn mark_presented(&mut self, generation: SurfaceGeneration) -> bool {
        if self.state != SurfaceState::Ready
            || self.generation != generation
            || !self.full_repaint_pending
        {
            return false;
        }
        self.full_repaint_pending = false;
        true
    }

    pub fn suspend(&mut self) {
        if self.state != SurfaceState::Absent {
            self.state = SurfaceState::Suspended;
            self.full_repaint_pending = false;
        }
    }

    pub fn fail(&mut self) {
        self.state = SurfaceState::Failed;
        self.full_repaint_pending = false;
    }

    pub fn clear(&mut self) {
        self.state = SurfaceState::Absent;
        self.full_repaint_pending = false;
    }
}

/// Errors from creating or running the platform window.
#[derive(Debug)]
pub enum PlatformError {
    EventLoop(String),
    Window(String),
    SoftBuffer(String),
}

impl std::fmt::Display for PlatformError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EventLoop(msg) | Self::Window(msg) | Self::SoftBuffer(msg) => f.write_str(msg),
        }
    }
}

impl std::error::Error for PlatformError {}

/// Stable platform operation that failed inside the event loop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlatformFailureStage {
    CreateWindow,
    CreateContext,
    CreateSurface,
    ConfigureSurface,
    ResizeSurface,
    AcquireFrame,
    PresentFrame,
}

impl PlatformFailureStage {
    #[must_use]
    pub const fn operation(self) -> &'static str {
        match self {
            Self::CreateWindow => "createWindow",
            Self::CreateContext => "createRenderContext",
            Self::CreateSurface => "createSurface",
            Self::ConfigureSurface => "configureSurface",
            Self::ResizeSurface => "resizeSurface",
            Self::AcquireFrame => "acquireFrame",
            Self::PresentFrame => "presentFrame",
        }
    }

    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::CreateWindow | Self::CreateContext | Self::CreateSurface | Self::ConfigureSurface
        )
    }
}

/// Typed failure reported by the platform adapter to its owning application.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlatformFailure {
    stage: PlatformFailureStage,
    message: String,
}

impl PlatformFailure {
    #[must_use]
    pub fn new(stage: PlatformFailureStage, message: impl Into<String>) -> Self {
        Self {
            stage,
            message: message.into(),
        }
    }

    #[must_use]
    pub const fn stage(&self) -> PlatformFailureStage {
        self.stage
    }

    #[must_use]
    pub const fn operation(&self) -> &'static str {
        self.stage.operation()
    }

    #[must_use]
    pub const fn is_terminal(&self) -> bool {
        self.stage.is_terminal()
    }

    #[must_use]
    pub const fn retryable(&self) -> bool {
        !self.is_terminal()
    }

    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }
}

thread_local! {
    static EVENT_LOOP: RefCell<Option<EventLoop<UserEvent>>> = const { RefCell::new(None) };
}

#[derive(Debug)]
enum UserEvent {
    AccessKit(AccessKitEvent),
    RuntimeWake,
}

impl From<AccessKitEvent> for UserEvent {
    fn from(event: AccessKitEvent) -> Self {
        Self::AccessKit(event)
    }
}

#[derive(Clone)]
enum RuntimeWakerInner {
    EventLoop(EventLoopProxy<UserEvent>),
    #[cfg(test)]
    Callback(Arc<dyn Fn() + Send + Sync + 'static>),
}

/// Thread-safe handle used by background runtime producers to wake the UI
/// event loop after queuing work.
#[derive(Clone)]
pub struct RuntimeWaker {
    inner: RuntimeWakerInner,
}

impl std::fmt::Debug for RuntimeWaker {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RuntimeWaker")
            .finish_non_exhaustive()
    }
}

impl RuntimeWaker {
    fn from_event_loop_proxy(proxy: EventLoopProxy<UserEvent>) -> Self {
        Self {
            inner: RuntimeWakerInner::EventLoop(proxy),
        }
    }

    #[cfg(test)]
    fn for_test(wake: impl Fn() + Send + Sync + 'static) -> Self {
        Self {
            inner: RuntimeWakerInner::Callback(Arc::new(wake)),
        }
    }

    /// Wake a parked event loop. Calls made after the loop has closed are
    /// ignored because no UI owner remains to observe them.
    pub fn wake(&self) {
        match &self.inner {
            RuntimeWakerInner::EventLoop(proxy) => {
                let _ = proxy.send_event(UserEvent::RuntimeWake);
            }
            #[cfg(test)]
            RuntimeWakerInner::Callback(wake) => wake(),
        }
    }
}

fn run_reusable_on_demand<R, E>(
    runner: &mut Option<R>,
    create: impl FnOnce() -> Result<R, E>,
    run: impl FnOnce(&mut R) -> Result<(), E>,
) -> Result<(), E> {
    if runner.is_none() {
        *runner = Some(create()?);
    }
    run(runner.as_mut().expect("runner initialized"))
}

/// Application callbacks driven by the platform event loop.
pub trait WindowApp {
    /// Install the event-loop waker before the application loop starts.
    /// Paint-only and legacy apps can retain the no-op default.
    fn install_runtime_waker(&mut self, waker: RuntimeWaker) {
        let _ = waker;
    }

    /// Paint into a softbuffer frame (`width`/`height` are physical pixels).
    fn paint(&mut self, pixels: &mut [u32], width: u32, height: u32, scale: f64);

    /// Paint one frame and return whether it is valid to present it.
    ///
    /// The default preserves the original paint-only contract. Runtime-backed
    /// apps override this when a renderer error must skip presentation of the
    /// partially-written buffer.
    fn paint_frame(&mut self, pixels: &mut [u32], width: u32, height: u32, scale: f64) -> bool {
        self.paint(pixels, width, height, scale);
        true
    }

    /// Pointer motion at physical pixel coordinates.
    /// Return `true` to request a redraw.
    fn pointer_moved(&mut self, x: f64, y: f64, scale: f64) -> bool {
        let _ = (x, y, scale);
        false
    }

    /// Pointer left the window content area.
    /// Return `true` to request a redraw.
    fn pointer_exited(&mut self) -> bool {
        false
    }

    /// Left-button press at physical pixel coordinates.
    /// Return `true` to request a redraw.
    fn pointer_pressed(&mut self, x: f64, y: f64, scale: f64) -> bool {
        let _ = (x, y, scale);
        false
    }

    /// Left-button release at physical pixel coordinates.
    /// Return `true` to request a redraw.
    fn pointer_released(&mut self, x: f64, y: f64, scale: f64) -> bool {
        let _ = (x, y, scale);
        false
    }

    /// Mouse wheel at physical pixel coordinates (`delta_y` is line/pixel-ish).
    /// Return `true` to request a redraw.
    fn wheel_scrolled(&mut self, x: f64, y: f64, delta_y: f64, scale: f64) -> bool {
        let _ = (x, y, delta_y, scale);
        false
    }

    /// UTF-8 text committed via keyboard / IME.
    /// Return `true` to request a redraw.
    fn text_input(&mut self, text: &str) -> bool {
        let _ = text;
        false
    }

    /// Begin a new IME composition before its first non-empty preedit update.
    fn ime_start(&mut self) -> bool {
        false
    }

    /// Update the active IME preedit. `cursor` retains winit's UTF-8 byte
    /// offset contract; adapters can use [`ime_preedit_selection_utf16`] at
    /// their UTF-16 protocol boundary.
    fn ime_preedit(&mut self, text: &str, _cursor: Option<(usize, usize)>) -> bool {
        let _ = text;
        false
    }

    /// Commit the active IME preedit.
    fn ime_commit(&mut self, text: &str) -> bool {
        self.text_input(text)
    }

    /// Cancel the active IME preedit.
    fn ime_cancel(&mut self) -> bool {
        false
    }

    /// Return native IME activation and candidate-window placement state.
    /// The default keeps IME enabled for compatibility with paint-only and
    /// legacy apps that only override `text_input` or `ime_commit`.
    fn ime_state(&mut self) -> ImeState {
        ImeState::default()
    }

    /// Backspace / delete backward.
    fn key_backspace(&mut self) -> bool {
        false
    }

    /// Enter / Return (single-line submit).
    fn key_enter(&mut self) -> bool {
        false
    }

    /// Tab traversal. `backwards` is true for Shift+Tab.
    fn key_tab(&mut self, backwards: bool) -> bool {
        let _ = backwards;
        false
    }

    /// Dispatch a named editing command with the platform modifier snapshot.
    /// The legacy key methods above remain available to compatibility hosts.
    fn key_command(&mut self, key: KeyInput, modifiers: KeyModifiers) -> bool {
        match key {
            KeyInput::Backspace => self.key_backspace(),
            KeyInput::Enter => self.key_enter(),
            KeyInput::Tab => self.key_tab(modifiers.shift),
            _ => {
                let _ = modifiers;
                false
            }
        }
    }

    /// Dispatch a named editing command and preserve the platform key-repeat
    /// bit. The default retains the legacy behavior for existing apps.
    fn key_command_with_repeat(
        &mut self,
        key: KeyInput,
        modifiers: KeyModifiers,
        repeat: bool,
    ) -> bool {
        let _ = repeat;
        self.key_command(key, modifiers)
    }

    /// Dispatch release for a named key. Compatibility apps that do not keep
    /// press/release visual state can ignore it.
    fn key_command_released(&mut self, key: KeyInput, modifiers: KeyModifiers) -> bool {
        let _ = (key, modifiers);
        false
    }

    /// Run one application-runtime tick after platform events have been
    /// collected. Returning `true` requests one coalesced redraw.
    fn tick(&mut self) -> bool {
        false
    }

    /// Request a graceful event-loop exit after the current application tick.
    ///
    /// This is intentionally opt-in. Production hosts keep the default and
    /// continue to exit only from a native close request; short-lived platform
    /// smoke fixtures can use it to return an assertion-backed process status.
    fn exit_requested(&mut self) -> bool {
        false
    }

    /// Return the committed semantic snapshot for the accessibility bridge.
    /// Legacy paint-only applications can keep the default synthetic window
    /// root by returning `None`.
    fn accessibility_snapshot(&mut self) -> Option<SemanticTreeSnapshot> {
        None
    }

    /// Receive an action from an assistive technology. Implementations should
    /// enqueue the request for their runtime tick; the default ignores it.
    fn accessibility_action(&mut self, _request: AccessibilityActionRequest) -> bool {
        false
    }

    /// A new backend surface is ready. The generation changes only after a
    /// successful create/configure sequence.
    fn surface_ready(&mut self, generation: SurfaceGeneration) {
        let _ = generation;
    }

    /// The active surface was suspended after its window-owned backend
    /// resources were released. CPU application state remains valid.
    fn surface_suspended(&mut self) {}

    /// The active surface was lost and all window-owned backend resources
    /// have been released. The default preserves structured diagnostics.
    fn surface_lost(&mut self, failure: &PlatformFailure) {
        self.report_platform_failure(failure);
    }

    /// A call to the backend present operation is about to begin.
    fn frame_presenting(&mut self, generation: SurfaceGeneration) {
        let _ = generation;
    }

    /// One frame was successfully presented on the current surface.
    fn frame_presented(&mut self, generation: SurfaceGeneration) {
        let _ = generation;
    }

    /// Notify the app before the event loop starts destroying window-owned
    /// resources. Implementations must stop accepting new owner-scoped work.
    fn close_requested(&mut self) {}

    /// Receive a typed platform failure. Runtime-backed apps override this to
    /// enqueue structured diagnostics; paint-only clients retain stderr as a
    /// development fallback.
    fn report_platform_failure(&mut self, failure: &PlatformFailure) {
        eprintln!(
            "nui-platform-winit: {} failed: {}",
            failure.operation(),
            failure.message()
        );
    }
}

/// Open a window and pump the event loop until close.
///
/// winit permits only one `EventLoop` per process. Its desktop
/// `run_app_on_demand` extension reuses that loop for orthogonal app sessions:
/// <https://docs.rs/winit/0.30.13/winit/platform/run_on_demand/trait.EventLoopExtRunOnDemand.html#method.run_app_on_demand>
pub fn run_app(title: &str, app: impl WindowApp + 'static) -> Result<(), PlatformError> {
    let title = title.to_owned();
    let mut host = Host {
        title: title.clone(),
        app: Box::new(app),
        event_loop_proxy: None,
        window: None,
        context: None,
        surface: None,
        accessibility_adapter: None,
        accessibility_tree: AccessibilityTree::new(title),
        surface_state: SurfaceLifecycle::default(),
        cursor: (0.0, 0.0),
        modifiers: ModifiersState::default(),
        text_input_routing: TextInputRouting::default(),
        terminal_error: None,
    };
    EVENT_LOOP.with(|event_loop| {
        let mut event_loop = event_loop.try_borrow_mut().map_err(|_| {
            PlatformError::EventLoop("nui event loop is already running".to_owned())
        })?;
        run_reusable_on_demand(
            &mut event_loop,
            || EventLoop::with_user_event().build(),
            |event_loop| {
                let proxy = event_loop.create_proxy();
                host.event_loop_proxy = Some(proxy.clone());
                host.app
                    .install_runtime_waker(RuntimeWaker::from_event_loop_proxy(proxy));
                event_loop.run_app_on_demand(&mut host)
            },
        )
        .map_err(|error| PlatformError::EventLoop(error.to_string()))
    })?;
    host.terminal_error.map_or(Ok(()), Err)
}

/// Convenience wrapper for paint-only apps (Slice 0 style).
pub fn run_window(
    title: &str,
    paint: impl FnMut(&mut [u32], u32, u32, f64) + 'static,
) -> Result<(), PlatformError> {
    struct PaintOnly<F>(F);
    impl<F: FnMut(&mut [u32], u32, u32, f64)> WindowApp for PaintOnly<F> {
        fn paint(&mut self, pixels: &mut [u32], width: u32, height: u32, scale: f64) {
            (self.0)(pixels, width, height, scale);
        }
    }
    run_app(title, PaintOnly(paint))
}

trait ImeWindowTarget {
    fn set_ime_allowed(&self, allowed: bool);
    fn set_ime_cursor_area(&self, area: ImeCursorArea);
}

impl ImeWindowTarget for Window {
    fn set_ime_allowed(&self, allowed: bool) {
        Window::set_ime_allowed(self, allowed);
    }

    fn set_ime_cursor_area(&self, area: ImeCursorArea) {
        Window::set_ime_cursor_area(
            self,
            LogicalPosition::new(area.x(), area.y()),
            LogicalSize::new(area.width(), area.height()),
        );
    }
}

fn apply_ime_state(target: &impl ImeWindowTarget, state: ImeState) {
    match state {
        ImeState::Disabled => target.set_ime_allowed(false),
        ImeState::Enabled { cursor_area } => {
            target.set_ime_allowed(true);
            if let Some(area) = cursor_area {
                target.set_ime_cursor_area(area);
            }
        }
    }
}

struct Host {
    title: String,
    app: Box<dyn WindowApp>,
    event_loop_proxy: Option<EventLoopProxy<UserEvent>>,
    window: Option<Rc<Window>>,
    context: Option<Context<Rc<Window>>>,
    surface: Option<Surface<Rc<Window>, Rc<Window>>>,
    accessibility_adapter: Option<AccessKitAdapter>,
    accessibility_tree: AccessibilityTree,
    surface_state: SurfaceLifecycle,
    cursor: (f64, f64),
    modifiers: ModifiersState,
    text_input_routing: TextInputRouting,
    terminal_error: Option<PlatformError>,
}

impl Host {
    fn sync_ime_cursor_area(&mut self, window: &Window) {
        apply_ime_state(window, self.app.ime_state());
    }

    fn report_failure(&mut self, stage: PlatformFailureStage, message: String) {
        self.app
            .report_platform_failure(&PlatformFailure::new(stage, message));
    }

    fn drop_surface_resources(&mut self) {
        self.accessibility_adapter = None;
        self.accessibility_tree.reset();
        self.surface = None;
        self.context = None;
        self.window = None;
    }

    fn accessibility_viewport(window: &Window) -> AccessibilityViewport {
        let scale_factor = window.scale_factor().max(0.5);
        let size = window.inner_size();
        AccessibilityViewport::new(
            f64::from(size.width) / scale_factor,
            f64::from(size.height) / scale_factor,
            scale_factor,
        )
    }

    fn publish_accessibility_snapshot(&mut self, window: &Window, full: bool) {
        let Some(adapter) = self.accessibility_adapter.as_mut() else {
            return;
        };
        let snapshot = self.app.accessibility_snapshot().unwrap_or_default();
        let viewport = Self::accessibility_viewport(window);
        let mut candidate = self.accessibility_tree.clone();
        let update = if full {
            Some(candidate.full_update(&snapshot, viewport))
        } else {
            candidate.incremental_update(&snapshot, viewport)
        };
        let Some(update) = update else {
            return;
        };
        let tree = &mut self.accessibility_tree;
        adapter.update_if_active(|| {
            *tree = candidate;
            update
        });
    }

    fn handle_accessibility_event(&mut self, event: AccessKitEvent) {
        let Some(window) = self.window.clone() else {
            return;
        };
        if window.id() != event.window_id {
            return;
        }
        match event.window_event {
            accesskit_winit::WindowEvent::InitialTreeRequested => {
                self.publish_accessibility_snapshot(&window, true);
            }
            accesskit_winit::WindowEvent::ActionRequested(request) => {
                if let Some(request) = normalize_action_request(request) {
                    if self.app.accessibility_action(request) {
                        window.request_redraw();
                    }
                }
            }
            accesskit_winit::WindowEvent::AccessibilityDeactivated => {
                self.accessibility_tree.reset();
            }
        }
    }

    fn publish_surface_ready(&mut self) -> Option<SurfaceGeneration> {
        let generation = self.surface_state.mark_ready()?;
        self.app.surface_ready(generation);
        Some(generation)
    }

    fn handle_surface_loss(&mut self, stage: PlatformFailureStage, message: String) {
        self.drop_surface_resources();
        self.surface_state.fail();
        self.app.surface_lost(&PlatformFailure::new(stage, message));
    }

    fn handle_suspend(&mut self) {
        self.drop_surface_resources();
        self.surface_state.suspend();
        self.app.surface_suspended();
    }

    fn publish_frame_presented(&mut self) {
        if self.surface_state.state() != SurfaceState::Ready {
            return;
        }
        let generation = self.surface_state.generation();
        let _ = self.surface_state.mark_presented(generation);
        self.app.frame_presented(generation);
    }

    fn fail_recreation(
        &mut self,
        event_loop: &ActiveEventLoop,
        stage: PlatformFailureStage,
        error: PlatformError,
    ) {
        let message = error.to_string();
        self.drop_surface_resources();
        self.surface_state.fail();
        self.report_failure(stage, message);
        self.terminal_error = Some(error);
        event_loop.exit();
    }

    fn recreate_surface(&mut self, event_loop: &ActiveEventLoop) {
        if !self.surface_state.begin_recreate() {
            return;
        }

        let attrs = Window::default_attributes()
            .with_title(self.title.clone())
            .with_inner_size(LogicalSize::new(640.0, 420.0))
            .with_visible(false);
        let window = match event_loop.create_window(attrs) {
            Ok(window) => Rc::new(window),
            Err(error) => {
                self.fail_recreation(
                    event_loop,
                    PlatformFailureStage::CreateWindow,
                    PlatformError::Window(error.to_string()),
                );
                return;
            }
        };
        let proxy = self
            .event_loop_proxy
            .as_ref()
            .expect("event loop proxy is initialized before window creation")
            .clone();
        let accessibility_adapter =
            AccessKitAdapter::with_event_loop_proxy(event_loop, &window, proxy);
        let context = match Context::new(Rc::clone(&window)) {
            Ok(context) => context,
            Err(error) => {
                self.fail_recreation(
                    event_loop,
                    PlatformFailureStage::CreateContext,
                    PlatformError::SoftBuffer(error.to_string()),
                );
                return;
            }
        };
        let mut surface = match Surface::new(&context, Rc::clone(&window)) {
            Ok(surface) => surface,
            Err(error) => {
                self.fail_recreation(
                    event_loop,
                    PlatformFailureStage::CreateSurface,
                    PlatformError::SoftBuffer(error.to_string()),
                );
                return;
            }
        };

        let size = window.inner_size();
        if let (Some(width), Some(height)) =
            (NonZeroU32::new(size.width), NonZeroU32::new(size.height))
        {
            if let Err(error) = surface.resize(width, height) {
                self.fail_recreation(
                    event_loop,
                    PlatformFailureStage::ConfigureSurface,
                    PlatformError::SoftBuffer(error.to_string()),
                );
                return;
            }
        }

        self.window = Some(Rc::clone(&window));
        self.context = Some(context);
        self.surface = Some(surface);
        self.accessibility_adapter = Some(accessibility_adapter);
        self.publish_surface_ready()
            .expect("surface recreation completes from Recreating");
        self.sync_ime_cursor_area(&window);
        window.set_visible(true);
        window.request_redraw();
    }
}

impl ApplicationHandler<UserEvent> for Host {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }
        self.recreate_surface(event_loop);
    }

    fn suspended(&mut self, _event_loop: &ActiveEventLoop) {
        self.handle_suspend();
    }

    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        if self.surface_state.state() == SurfaceState::Failed && self.terminal_error.is_none() {
            self.recreate_surface(event_loop);
        }
        let Some(window) = self.window.clone() else {
            return;
        };
        let composition_redraw =
            self.text_input_routing.flush_pending_clear() && self.app.ime_cancel();
        let redraw = self.app.tick() || composition_redraw;
        if self.app.exit_requested() {
            self.app.close_requested();
            event_loop.exit();
            return;
        }
        self.sync_ime_cursor_area(&window);
        if redraw {
            window.request_redraw();
        }
    }

    fn window_event(
        &mut self,
        event_loop: &ActiveEventLoop,
        window_id: WindowId,
        event: WindowEvent,
    ) {
        let Some(window) = self.window.clone() else {
            return;
        };
        if window.id() != window_id {
            return;
        }

        if let Some(adapter) = self.accessibility_adapter.as_mut() {
            adapter.process_event(&window, &event);
        }

        match event {
            WindowEvent::CloseRequested => {
                self.app.close_requested();
                event_loop.exit();
            }
            WindowEvent::Resized(size) => {
                let resize_failure = if let Some(surface) = self.surface.as_mut() {
                    if let (Some(width), Some(height)) =
                        (NonZeroU32::new(size.width), NonZeroU32::new(size.height))
                    {
                        surface
                            .resize(width, height)
                            .err()
                            .map(|error| error.to_string())
                    } else {
                        None
                    }
                } else {
                    None
                };
                if let Some(message) = resize_failure {
                    self.handle_surface_loss(PlatformFailureStage::ResizeSurface, message);
                    return;
                }
                window.request_redraw();
            }
            WindowEvent::ScaleFactorChanged { .. } => {
                window.request_redraw();
            }
            WindowEvent::CursorMoved { position, .. } => {
                self.cursor = (position.x, position.y);
                if dispatch_pointer_moved(
                    self.app.as_mut(),
                    position.x,
                    position.y,
                    window.scale_factor(),
                ) {
                    window.request_redraw();
                }
            }
            WindowEvent::CursorLeft { .. } => {
                if dispatch_pointer_exited(self.app.as_mut()) {
                    window.request_redraw();
                }
            }
            WindowEvent::ModifiersChanged(modifiers) => {
                self.modifiers = modifiers.state();
            }
            WindowEvent::MouseInput {
                state: ElementState::Pressed,
                button: MouseButton::Left,
                ..
            } => {
                let scale = window.scale_factor();
                let (x, y) = self.cursor;
                if self.app.pointer_pressed(x, y, scale) {
                    window.request_redraw();
                }
            }
            WindowEvent::MouseInput {
                state: ElementState::Released,
                button: MouseButton::Left,
                ..
            } => {
                let scale = window.scale_factor();
                let (x, y) = self.cursor;
                if self.app.pointer_released(x, y, scale) {
                    window.request_redraw();
                }
            }
            WindowEvent::MouseWheel { delta, .. } => {
                let scale = window.scale_factor();
                let (x, y) = self.cursor;
                let delta_y = match delta {
                    winit::event::MouseScrollDelta::LineDelta(_, y) => f64::from(y) * 24.0,
                    winit::event::MouseScrollDelta::PixelDelta(p) => p.y,
                };
                if self.app.wheel_scrolled(x, y, delta_y, scale) {
                    window.request_redraw();
                }
            }
            WindowEvent::KeyboardInput {
                event:
                    KeyEvent {
                        logical_key,
                        text,
                        repeat,
                        state,
                        ..
                    },
                ..
            } => {
                let modifiers = KeyModifiers {
                    shift: self.modifiers.shift_key(),
                    control: self.modifiers.control_key(),
                    alt: self.modifiers.alt_key(),
                    meta: self.modifiers.super_key(),
                };
                let redraw = match state {
                    ElementState::Pressed => dispatch_keyboard_press_with_repeat(
                        self.app.as_mut(),
                        &self.text_input_routing,
                        &logical_key,
                        text.as_deref(),
                        modifiers,
                        repeat,
                    ),
                    ElementState::Released => {
                        dispatch_keyboard_release(self.app.as_mut(), &logical_key, modifiers)
                    }
                };
                if redraw {
                    window.request_redraw();
                }
            }
            WindowEvent::Ime(Ime::Enabled) => {
                if self.text_input_routing.ime_enabled() && self.app.ime_cancel() {
                    window.request_redraw();
                }
            }
            WindowEvent::Ime(Ime::Preedit(s, cursor)) => {
                let transition = self.text_input_routing.ime_preedit(&s);
                let redraw = match transition {
                    PreeditTransition::Ignore => false,
                    PreeditTransition::StartAndUpdate => {
                        self.app.ime_start() | self.app.ime_preedit(&s, cursor)
                    }
                    PreeditTransition::Update | PreeditTransition::ClearPendingCommit => {
                        self.app.ime_preedit(&s, cursor)
                    }
                };
                if redraw {
                    window.request_redraw();
                }
            }
            WindowEvent::Ime(Ime::Commit(s)) => {
                let _ = self.text_input_routing.ime_commit();
                if self.app.ime_commit(&s) {
                    window.request_redraw();
                }
            }
            WindowEvent::Ime(Ime::Disabled) => {
                let _ = self.text_input_routing.ime_disabled();
                if self.app.ime_cancel() {
                    window.request_redraw();
                }
            }
            WindowEvent::RedrawRequested => {
                if self.surface_state.state() != SurfaceState::Ready {
                    return;
                }
                let size = window.inner_size();
                let width = size.width;
                let height = size.height;
                if width == 0 || height == 0 {
                    return;
                }
                let scale = window.scale_factor();

                let mut buffer = match self
                    .surface
                    .as_mut()
                    .expect("ready lifecycle owns a surface")
                    .buffer_mut()
                {
                    Ok(buffer) => buffer,
                    Err(error) => {
                        self.handle_surface_loss(
                            PlatformFailureStage::AcquireFrame,
                            error.to_string(),
                        );
                        return;
                    }
                };

                if !self.app.paint_frame(buffer.as_mut(), width, height, scale) {
                    return;
                }

                self.app.frame_presenting(self.surface_state.generation());
                match buffer.present() {
                    Ok(()) => {
                        self.publish_frame_presented();
                        self.publish_accessibility_snapshot(&window, false);
                    }
                    Err(error) => self
                        .handle_surface_loss(PlatformFailureStage::PresentFrame, error.to_string()),
                }
            }
            _ => {}
        }
        self.sync_ime_cursor_area(&window);
    }

    fn user_event(&mut self, _event_loop: &ActiveEventLoop, event: UserEvent) {
        match event {
            UserEvent::AccessKit(event) => self.handle_accessibility_event(event),
            UserEvent::RuntimeWake => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    #[test]
    fn backend_is_winit() {
        assert_eq!(backend_name(), "winit");
        assert!(!core_version().is_empty());
    }

    #[test]
    fn ime_cursor_area_accepts_finite_positive_logical_geometry() {
        let area = ImeCursorArea::new(-2.5, 3.25, 1.0, 20.0).expect("valid IME cursor area");

        assert_eq!(area.x(), -2.5);
        assert_eq!(area.y(), 3.25);
        assert_eq!(area.width(), 1.0);
        assert_eq!(area.height(), 20.0);
    }

    #[test]
    fn ime_cursor_area_rejects_non_finite_coordinates_and_non_positive_sizes() {
        for (x, y, width, height) in [
            (f64::NAN, 0.0, 1.0, 20.0),
            (0.0, f64::INFINITY, 1.0, 20.0),
            (0.0, 0.0, f64::NEG_INFINITY, 20.0),
            (0.0, 0.0, 1.0, f64::NAN),
            (0.0, 0.0, 0.0, 20.0),
            (0.0, 0.0, -1.0, 20.0),
            (0.0, 0.0, 1.0, 0.0),
            (0.0, 0.0, 1.0, -20.0),
        ] {
            assert!(
                ImeCursorArea::new(x, y, width, height).is_none(),
                "accepted invalid geometry ({x}, {y}, {width}, {height})"
            );
        }
    }

    #[test]
    fn ime_preedit_byte_ranges_convert_to_relative_utf16_without_panics() {
        assert_eq!(
            ime_preedit_selection_utf16("A😀B", Some((1, 5))),
            Some(ImeUtf16Selection { start: 1, end: 3 })
        );
        assert_eq!(
            ime_preedit_selection_utf16("你e\u{301}👩‍💻", Some((3, 6))),
            Some(ImeUtf16Selection { start: 1, end: 3 })
        );
        assert_eq!(ime_preedit_selection_utf16("😀", None), None);
        for invalid in [Some((2, 1)), Some((0, 5)), Some((1, 4))] {
            assert_eq!(ime_preedit_selection_utf16("😀", invalid), None);
        }
    }

    #[test]
    fn default_window_app_keeps_ime_enabled_without_candidate_geometry() {
        struct DefaultImeApp;

        impl WindowApp for DefaultImeApp {
            fn paint(&mut self, _pixels: &mut [u32], _width: u32, _height: u32, _scale: f64) {}
        }

        assert_eq!(
            DefaultImeApp.ime_state(),
            ImeState::Enabled { cursor_area: None }
        );
    }

    #[test]
    fn runtime_waker_clone_notifies_a_parked_waiter() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::{Arc, Condvar, Mutex};
        use std::thread;

        let state = Arc::new((Mutex::new(false), Condvar::new()));
        let observed = Arc::clone(&state);
        let waker = RuntimeWaker::for_test(move || {
            let (flag, wake) = &*observed;
            *flag.lock().expect("wake flag") = true;
            wake.notify_one();
        });
        let clone = waker.clone();
        let parked = thread::spawn(move || {
            let (flag, wake) = &*state;
            let guard = flag.lock().expect("wake flag");
            let guard = wake
                .wait_timeout_while(guard, std::time::Duration::from_secs(1), |ready| !*ready)
                .expect("wait for runtime wake");
            *guard.0 && !guard.1.timed_out()
        });

        // Keep the assertion independent from scheduler timing: either clone
        // must deliver the same wake signal to the parked runtime.
        clone.wake();
        assert!(parked.join().expect("parked waiter"));

        let called = Arc::new(AtomicBool::new(false));
        let called_clone = Arc::clone(&called);
        let second = RuntimeWaker::for_test(move || {
            called_clone.store(true, Ordering::SeqCst);
        });
        second.wake();
        assert!(called.load(Ordering::SeqCst));
    }

    #[test]
    fn default_window_app_runtime_waker_hook_is_backward_compatible() {
        struct PaintOnlyApp;

        impl WindowApp for PaintOnlyApp {
            fn paint(&mut self, _pixels: &mut [u32], _width: u32, _height: u32, _scale: f64) {}
        }

        let mut app = PaintOnlyApp;
        app.install_runtime_waker(RuntimeWaker::for_test(|| {}));
    }

    #[test]
    fn g3b04_adapter_window_app_accessibility_hooks_are_backwards_compatible() {
        struct DefaultAccessibilityApp;

        impl WindowApp for DefaultAccessibilityApp {
            fn paint(&mut self, _pixels: &mut [u32], _width: u32, _height: u32, _scale: f64) {}
        }

        let mut app = DefaultAccessibilityApp;
        assert_eq!(app.accessibility_snapshot(), None);
        assert!(!app.accessibility_action(AccessibilityActionRequest {
            target: nui_core::NodeId::new(7, 3),
            action: nui_core::SemanticAction::Invoke,
            value: None,
        }));
    }

    #[test]
    fn pointer_motion_routes_coordinates_and_window_exit_to_the_app() {
        #[derive(Default)]
        struct RecordingPointerApp {
            moves: Vec<(f64, f64, f64)>,
            exits: usize,
        }

        impl WindowApp for RecordingPointerApp {
            fn paint(&mut self, _pixels: &mut [u32], _width: u32, _height: u32, _scale: f64) {}

            fn pointer_moved(&mut self, x: f64, y: f64, scale: f64) -> bool {
                self.moves.push((x, y, scale));
                true
            }

            fn pointer_exited(&mut self) -> bool {
                self.exits += 1;
                true
            }
        }

        let mut app = RecordingPointerApp::default();
        assert!(dispatch_pointer_moved(&mut app, 12.5, 24.0, 2.0));
        assert!(dispatch_pointer_exited(&mut app));
        assert_eq!(app.moves, vec![(12.5, 24.0, 2.0)]);
        assert_eq!(app.exits, 1);
    }

    #[test]
    fn ime_state_maps_to_platform_activation_and_cursor_updates() {
        #[derive(Debug, Clone, Copy, PartialEq)]
        enum Call {
            Allowed(bool),
            Cursor(ImeCursorArea),
        }

        #[derive(Default)]
        struct RecordingImeTarget(RefCell<Vec<Call>>);

        impl ImeWindowTarget for RecordingImeTarget {
            fn set_ime_allowed(&self, allowed: bool) {
                self.0.borrow_mut().push(Call::Allowed(allowed));
            }

            fn set_ime_cursor_area(&self, area: ImeCursorArea) {
                self.0.borrow_mut().push(Call::Cursor(area));
            }
        }

        let target = RecordingImeTarget::default();
        apply_ime_state(&target, ImeState::Disabled);
        assert_eq!(*target.0.borrow(), vec![Call::Allowed(false)]);

        target.0.borrow_mut().clear();
        apply_ime_state(&target, ImeState::Enabled { cursor_area: None });
        assert_eq!(*target.0.borrow(), vec![Call::Allowed(true)]);

        target.0.borrow_mut().clear();
        let area = ImeCursorArea::new(4.0, 8.0, 1.0, 20.0).expect("valid area");
        apply_ime_state(
            &target,
            ImeState::Enabled {
                cursor_area: Some(area),
            },
        );
        assert_eq!(
            *target.0.borrow(),
            vec![Call::Allowed(true), Call::Cursor(area)]
        );
    }

    #[test]
    fn surface_lifecycle_preserves_state_across_suspend_and_recreate() {
        let mut lifecycle = SurfaceLifecycle::default();
        assert_eq!(lifecycle.state(), SurfaceState::Absent);
        assert!(lifecycle.begin_recreate());
        assert_eq!(lifecycle.state(), SurfaceState::Recreating);
        assert!(!lifecycle.begin_recreate());
        lifecycle.mark_ready();
        assert_eq!(lifecycle.state(), SurfaceState::Ready);
        lifecycle.suspend();
        assert_eq!(lifecycle.state(), SurfaceState::Suspended);
        lifecycle.suspend();
        assert_eq!(lifecycle.state(), SurfaceState::Suspended);
        assert!(lifecycle.begin_recreate());
        lifecycle.mark_ready();
        lifecycle.fail();
        assert_eq!(lifecycle.state(), SurfaceState::Failed);
        assert!(lifecycle.begin_recreate());
        lifecycle.clear();
        assert_eq!(lifecycle.state(), SurfaceState::Absent);
    }

    #[test]
    fn surface_generation_advances_only_after_successful_recreation() {
        let mut lifecycle = SurfaceLifecycle::default();
        assert_eq!(
            lifecycle.generation(),
            nui_core::SurfaceGeneration::default()
        );

        assert!(lifecycle.begin_recreate());
        lifecycle.fail();
        assert_eq!(
            lifecycle.generation(),
            nui_core::SurfaceGeneration::default()
        );

        assert!(lifecycle.begin_recreate());
        let first = lifecycle.mark_ready().expect("first ready generation");
        assert_eq!(first, nui_core::SurfaceGeneration::new(1));
        assert!(lifecycle.full_repaint_pending());

        assert!(lifecycle.mark_ready().is_none());
        assert_eq!(lifecycle.generation(), first);

        lifecycle.fail();
        assert_eq!(lifecycle.generation(), first);
        assert!(lifecycle.begin_recreate());
        let second = lifecycle.mark_ready().expect("replacement generation");
        assert!(second > first);
    }

    #[test]
    fn successful_present_clears_full_repaint_exactly_once() {
        let mut lifecycle = SurfaceLifecycle::default();
        assert!(lifecycle.begin_recreate());
        let generation = lifecycle.mark_ready().expect("ready generation");
        assert!(lifecycle.full_repaint_pending());

        assert!(!lifecycle.mark_presented(nui_core::SurfaceGeneration::default()));
        assert!(lifecycle.full_repaint_pending());
        assert!(lifecycle.mark_presented(generation));
        assert!(!lifecycle.full_repaint_pending());
        assert!(!lifecycle.mark_presented(generation));
    }

    #[derive(Debug, Default)]
    struct RecordedSurfaceEvents {
        ready: Vec<SurfaceGeneration>,
        suspended: usize,
        lost: Vec<PlatformFailureStage>,
        presenting: Vec<SurfaceGeneration>,
        presented: Vec<SurfaceGeneration>,
        present_order: Vec<&'static str>,
        business_state: u32,
    }

    struct RecordingWindowApp(Rc<RefCell<RecordedSurfaceEvents>>);

    impl WindowApp for RecordingWindowApp {
        fn paint(&mut self, _pixels: &mut [u32], _width: u32, _height: u32, _scale: f64) {}

        fn surface_ready(&mut self, generation: SurfaceGeneration) {
            self.0.borrow_mut().ready.push(generation);
        }

        fn surface_suspended(&mut self) {
            self.0.borrow_mut().suspended += 1;
        }

        fn surface_lost(&mut self, failure: &PlatformFailure) {
            self.0.borrow_mut().lost.push(failure.stage());
        }

        fn frame_presenting(&mut self, generation: SurfaceGeneration) {
            let mut events = self.0.borrow_mut();
            events.presenting.push(generation);
            events.present_order.push("presenting");
        }

        fn frame_presented(&mut self, generation: SurfaceGeneration) {
            let mut events = self.0.borrow_mut();
            events.presented.push(generation);
            events.present_order.push("presented");
        }
    }

    #[test]
    fn injected_surface_loss_preserves_app_state_and_publishes_recovery_hooks() {
        let events = Rc::new(RefCell::new(RecordedSurfaceEvents {
            business_state: 41,
            ..RecordedSurfaceEvents::default()
        }));
        let mut host = Host {
            title: String::from("surface-test"),
            app: Box::new(RecordingWindowApp(Rc::clone(&events))),
            event_loop_proxy: None,
            window: None,
            context: None,
            surface: None,
            accessibility_adapter: None,
            accessibility_tree: AccessibilityTree::new("surface-test"),
            surface_state: SurfaceLifecycle::default(),
            cursor: (0.0, 0.0),
            modifiers: ModifiersState::default(),
            text_input_routing: TextInputRouting::default(),
            terminal_error: None,
        };

        assert!(host.surface_state.begin_recreate());
        let first = host.publish_surface_ready().expect("first surface");
        host.handle_surface_loss(PlatformFailureStage::PresentFrame, "lost".to_owned());
        assert_eq!(host.surface_state.state(), SurfaceState::Failed);
        assert_eq!(host.surface_state.generation(), first);

        assert!(host.surface_state.begin_recreate());
        let second = host.publish_surface_ready().expect("recovered surface");
        host.app.frame_presenting(second);
        host.publish_frame_presented();

        let events = events.borrow();
        assert_eq!(events.business_state, 41);
        assert_eq!(events.ready, vec![first, second]);
        assert_eq!(events.lost, vec![PlatformFailureStage::PresentFrame]);
        assert_eq!(events.presenting, vec![second]);
        assert_eq!(events.presented, vec![second]);
        assert_eq!(events.present_order, vec!["presenting", "presented"]);
        assert!(!host.surface_state.full_repaint_pending());
    }

    #[test]
    fn injected_suspend_releases_surface_and_notifies_app_without_losing_state() {
        let events = Rc::new(RefCell::new(RecordedSurfaceEvents {
            business_state: 41,
            ..RecordedSurfaceEvents::default()
        }));
        let mut host = Host {
            title: String::from("suspend-test"),
            app: Box::new(RecordingWindowApp(Rc::clone(&events))),
            event_loop_proxy: None,
            window: None,
            context: None,
            surface: None,
            accessibility_adapter: None,
            accessibility_tree: AccessibilityTree::new("suspend-test"),
            surface_state: SurfaceLifecycle::default(),
            cursor: (0.0, 0.0),
            modifiers: ModifiersState::default(),
            text_input_routing: TextInputRouting::default(),
            terminal_error: None,
        };
        assert!(host.surface_state.begin_recreate());
        let generation = host.publish_surface_ready().expect("ready surface");

        host.handle_suspend();
        host.handle_suspend();

        assert_eq!(host.surface_state.state(), SurfaceState::Suspended);
        assert_eq!(host.surface_state.generation(), generation);
        let events = events.borrow();
        assert_eq!(events.business_state, 41);
        assert_eq!(events.ready, vec![generation]);
        assert_eq!(events.suspended, 2);
        assert!(events.lost.is_empty());
    }

    #[test]
    fn platform_failure_stages_have_stable_routing_metadata() {
        let cases = [
            (
                PlatformFailureStage::CreateWindow,
                "createWindow",
                true,
                false,
            ),
            (
                PlatformFailureStage::CreateContext,
                "createRenderContext",
                true,
                false,
            ),
            (
                PlatformFailureStage::CreateSurface,
                "createSurface",
                true,
                false,
            ),
            (
                PlatformFailureStage::ConfigureSurface,
                "configureSurface",
                true,
                false,
            ),
            (
                PlatformFailureStage::ResizeSurface,
                "resizeSurface",
                false,
                true,
            ),
            (
                PlatformFailureStage::AcquireFrame,
                "acquireFrame",
                false,
                true,
            ),
            (
                PlatformFailureStage::PresentFrame,
                "presentFrame",
                false,
                true,
            ),
        ];

        for (stage, operation, terminal, retryable) in cases {
            let failure = PlatformFailure::new(stage, "platform test failure");
            assert_eq!(failure.operation(), operation);
            assert_eq!(failure.is_terminal(), terminal);
            assert_eq!(failure.retryable(), retryable);
        }
    }

    #[test]
    fn on_demand_runner_initializes_once_and_runs_each_session() {
        let mut runner = None;
        let mut initializations = 0;
        let mut sessions = Vec::new();

        run_reusable_on_demand(
            &mut runner,
            || {
                initializations += 1;
                Ok::<_, ()>(41_u32)
            },
            |runner| {
                sessions.push(*runner);
                Ok(())
            },
        )
        .expect("first session");
        run_reusable_on_demand(
            &mut runner,
            || {
                initializations += 1;
                Ok::<_, ()>(99_u32)
            },
            |runner| {
                sessions.push(*runner);
                Ok(())
            },
        )
        .expect("second session");

        assert_eq!(initializations, 1);
        assert_eq!(sessions, vec![41, 41]);
    }

    #[test]
    fn keyboard_text_routing_forwards_printable_text_space_and_emoji() {
        let routing = TextInputRouting::default();
        let modifiers = KeyModifiers::default();

        assert_eq!(routing.keyboard_text(Some("a"), modifiers), Some("a"));
        assert_eq!(routing.keyboard_text(Some(" "), modifiers), Some(" "));
        assert_eq!(
            routing.keyboard_text(Some("\u{1f600}"), modifiers),
            Some("\u{1f600}")
        );
        assert_eq!(
            routing.keyboard_text(Some("\u{4f60}\u{597d}"), modifiers),
            Some("\u{4f60}\u{597d}")
        );
        assert_eq!(
            routing.keyboard_text(Some("\u{1f469}\u{200d}\u{1f4bb}"), modifiers),
            Some("\u{1f469}\u{200d}\u{1f4bb}")
        );
        assert_eq!(routing.keyboard_text(None, modifiers), None);
    }

    #[test]
    fn macos_and_windows_text_command_matrix_keeps_modifier_roles_distinct() {
        let shift_alt = KeyModifiers {
            shift: true,
            alt: true,
            ..KeyModifiers::default()
        };
        assert_eq!(
            text_editing_command(KeyInput::ArrowLeft, shift_alt, DesktopPlatform::MacOs),
            Some(TextEditingCommand::Navigate {
                target: TextNavigation::WordLeft,
                extend: true,
            })
        );
        assert_eq!(
            text_editing_command(
                KeyInput::ArrowLeft,
                KeyModifiers {
                    meta: true,
                    ..KeyModifiers::default()
                },
                DesktopPlatform::MacOs,
            ),
            Some(TextEditingCommand::Navigate {
                target: TextNavigation::VisualLineStart,
                extend: false,
            })
        );
        assert_eq!(
            text_editing_command(
                KeyInput::Home,
                KeyModifiers::default(),
                DesktopPlatform::MacOs
            ),
            Some(TextEditingCommand::Navigate {
                target: TextNavigation::VisualLineStart,
                extend: false,
            })
        );
        assert_eq!(
            text_editing_command(
                KeyInput::Home,
                KeyModifiers {
                    meta: true,
                    ..KeyModifiers::default()
                },
                DesktopPlatform::MacOs,
            ),
            Some(TextEditingCommand::Navigate {
                target: TextNavigation::DocumentStart,
                extend: false,
            })
        );
        assert_eq!(
            text_editing_command(
                KeyInput::ArrowRight,
                KeyModifiers {
                    control: true,
                    shift: true,
                    ..KeyModifiers::default()
                },
                DesktopPlatform::Windows,
            ),
            Some(TextEditingCommand::Navigate {
                target: TextNavigation::WordRight,
                extend: true,
            })
        );
        assert_eq!(
            text_editing_command(
                KeyInput::End,
                KeyModifiers::default(),
                DesktopPlatform::Windows,
            ),
            Some(TextEditingCommand::Navigate {
                target: TextNavigation::VisualLineEnd,
                extend: false,
            })
        );
        assert_eq!(
            text_editing_command(
                KeyInput::End,
                KeyModifiers {
                    control: true,
                    ..KeyModifiers::default()
                },
                DesktopPlatform::Windows,
            ),
            Some(TextEditingCommand::Navigate {
                target: TextNavigation::DocumentEnd,
                extend: false,
            })
        );
    }

    #[test]
    fn unsupported_shortcut_chords_do_not_become_word_edits() {
        let mac_control = KeyModifiers {
            control: true,
            ..KeyModifiers::default()
        };
        let windows_alt = KeyModifiers {
            alt: true,
            ..KeyModifiers::default()
        };
        let alt_gr = KeyModifiers {
            control: true,
            alt: true,
            ..KeyModifiers::default()
        };

        assert_eq!(
            text_editing_command(KeyInput::ArrowLeft, mac_control, DesktopPlatform::MacOs),
            None
        );
        assert_eq!(
            text_editing_command(KeyInput::Backspace, windows_alt, DesktopPlatform::Windows,),
            None
        );
        assert_eq!(
            text_editing_command(KeyInput::Delete, alt_gr, DesktopPlatform::Windows),
            None
        );
        assert_eq!(
            text_editing_command(
                KeyInput::Backspace,
                KeyModifiers {
                    alt: true,
                    ..KeyModifiers::default()
                },
                DesktopPlatform::MacOs,
            ),
            Some(TextEditingCommand::DeleteBackward { word: true })
        );
        assert_eq!(
            text_editing_command(
                KeyInput::Delete,
                KeyModifiers {
                    control: true,
                    ..KeyModifiers::default()
                },
                DesktopPlatform::Windows,
            ),
            Some(TextEditingCommand::DeleteForward { word: true })
        );
    }

    #[test]
    fn keyboard_text_routing_rejects_commands_and_shortcuts_but_allows_alt_gr() {
        let routing = TextInputRouting::default();

        for command_text in ["\r", "\t", "\u{8}", "\u{1b}"] {
            assert_eq!(
                routing.keyboard_text(Some(command_text), KeyModifiers::default()),
                None
            );
        }
        assert_eq!(
            routing.keyboard_text(
                Some("c"),
                KeyModifiers {
                    control: true,
                    ..KeyModifiers::default()
                }
            ),
            None
        );
        assert_eq!(
            routing.keyboard_text(
                Some("v"),
                KeyModifiers {
                    meta: true,
                    ..KeyModifiers::default()
                }
            ),
            None
        );
        assert_eq!(
            routing.keyboard_text(
                Some("@"),
                KeyModifiers {
                    control: true,
                    alt: true,
                    ..KeyModifiers::default()
                }
            ),
            Some("@")
        );
    }

    #[test]
    fn active_ime_preedit_suppresses_keyboard_text_until_ime_state_clears() {
        let mut routing = TextInputRouting::default();
        let modifiers = KeyModifiers::default();

        assert_eq!(routing.ime_preedit("ni"), PreeditTransition::StartAndUpdate);
        assert_eq!(routing.keyboard_text(Some("n"), modifiers), None);

        assert_eq!(
            routing.ime_preedit(""),
            PreeditTransition::ClearPendingCommit
        );
        assert_eq!(routing.keyboard_text(Some("a"), modifiers), None);
        assert!(routing.flush_pending_clear());
        assert_eq!(routing.keyboard_text(Some("a"), modifiers), Some("a"));

        assert_eq!(
            routing.ime_preedit("hao"),
            PreeditTransition::StartAndUpdate
        );
        assert!(routing.ime_commit());
        assert_eq!(routing.keyboard_text(Some("b"), modifiers), Some("b"));

        routing.ime_preedit("ma");
        assert!(routing.ime_disabled());
        assert_eq!(routing.keyboard_text(Some("c"), modifiers), Some("c"));

        routing.ime_preedit("stale");
        assert!(routing.ime_enabled());
        assert_eq!(routing.keyboard_text(Some("d"), modifiers), Some("d"));
    }

    #[test]
    fn cleared_preedit_followed_by_commit_never_flushes_a_false_cancel() {
        let mut routing = TextInputRouting::default();
        assert_eq!(
            routing.ime_preedit("かな"),
            PreeditTransition::StartAndUpdate
        );
        assert_eq!(
            routing.ime_preedit(""),
            PreeditTransition::ClearPendingCommit
        );

        assert!(routing.ime_commit());
        assert!(!routing.flush_pending_clear());
        assert_eq!(
            routing.ime_preedit("next"),
            PreeditTransition::StartAndUpdate
        );
    }

    #[derive(Debug, Default, PartialEq, Eq)]
    struct RecordedKeyboardInput {
        commands: Vec<KeyInput>,
        repeats: Vec<bool>,
        releases: Vec<KeyInput>,
        text: Vec<String>,
    }

    struct RecordingKeyboardApp(Rc<RefCell<RecordedKeyboardInput>>);

    impl WindowApp for RecordingKeyboardApp {
        fn paint(&mut self, _pixels: &mut [u32], _width: u32, _height: u32, _scale: f64) {}

        fn text_input(&mut self, text: &str) -> bool {
            self.0.borrow_mut().text.push(text.to_owned());
            false
        }

        fn key_command_with_repeat(
            &mut self,
            key: KeyInput,
            _modifiers: KeyModifiers,
            repeat: bool,
        ) -> bool {
            let mut events = self.0.borrow_mut();
            events.commands.push(key);
            events.repeats.push(repeat);
            true
        }

        fn key_command_released(&mut self, key: KeyInput, _modifiers: KeyModifiers) -> bool {
            self.0.borrow_mut().releases.push(key);
            true
        }
    }

    #[test]
    fn active_preedit_suppresses_repeated_keyboard_commands_and_text() {
        let events = Rc::new(RefCell::new(RecordedKeyboardInput::default()));
        let mut app = RecordingKeyboardApp(Rc::clone(&events));
        let mut routing = TextInputRouting::default();
        assert_eq!(routing.ime_preedit("ni"), PreeditTransition::StartAndUpdate);

        assert!(!dispatch_keyboard_press_with_repeat(
            &mut app,
            &routing,
            &Key::Named(NamedKey::Backspace),
            Some("n"),
            KeyModifiers::default(),
            true,
        ));

        assert_eq!(*events.borrow(), RecordedKeyboardInput::default());
    }

    #[test]
    fn keyboard_press_dispatches_text_without_turning_commands_into_text() {
        let events = Rc::new(RefCell::new(RecordedKeyboardInput::default()));
        let mut app = RecordingKeyboardApp(Rc::clone(&events));
        let routing = TextInputRouting::default();
        let modifiers = KeyModifiers::default();

        assert!(!dispatch_keyboard_press(
            &mut app,
            &routing,
            &Key::Character("a".into()),
            Some("a"),
            modifiers,
        ));
        assert!(dispatch_keyboard_press(
            &mut app,
            &routing,
            &Key::Named(NamedKey::Space),
            Some(" "),
            modifiers,
        ));
        assert!(dispatch_keyboard_press(
            &mut app,
            &routing,
            &Key::Named(NamedKey::Enter),
            Some("\r"),
            modifiers,
        ));
        assert!(dispatch_keyboard_press(
            &mut app,
            &routing,
            &Key::Named(NamedKey::ArrowUp),
            None,
            modifiers,
        ));
        assert!(dispatch_keyboard_press_with_repeat(
            &mut app,
            &routing,
            &Key::Named(NamedKey::ArrowDown),
            None,
            modifiers,
            true,
        ));
        assert!(dispatch_keyboard_release(
            &mut app,
            &Key::Named(NamedKey::Enter),
            modifiers,
        ));

        assert_eq!(
            *events.borrow(),
            RecordedKeyboardInput {
                commands: vec![
                    KeyInput::Space,
                    KeyInput::Enter,
                    KeyInput::ArrowUp,
                    KeyInput::ArrowDown,
                ],
                repeats: vec![false, false, false, true],
                releases: vec![KeyInput::Enter],
                text: vec!["a".to_owned(), " ".to_owned()],
            }
        );
    }

    #[test]
    fn g3a11_clipboard_shortcuts_use_the_native_primary_modifier_on_both_desktops() {
        let mac = KeyModifiers {
            meta: true,
            ..KeyModifiers::default()
        };
        let windows = KeyModifiers {
            control: true,
            ..KeyModifiers::default()
        };
        for (key, expected) in [
            (KeyInput::Copy, TextEditingCommand::Copy),
            (KeyInput::Cut, TextEditingCommand::Cut),
            (KeyInput::Paste, TextEditingCommand::Paste),
        ] {
            assert_eq!(
                text_editing_command(key, mac, DesktopPlatform::MacOs),
                Some(expected)
            );
            assert_eq!(
                text_editing_command(key, windows, DesktopPlatform::Windows),
                Some(expected)
            );
            assert_eq!(
                text_editing_command(key, windows, DesktopPlatform::MacOs),
                None
            );
            assert_eq!(
                text_editing_command(key, mac, DesktopPlatform::Windows),
                None
            );
        }
    }

    #[test]
    fn g3a11_character_key_normalization_recognizes_clipboard_letters_case_insensitively() {
        assert_eq!(
            named_key_input(&Key::Character("C".into())),
            Some(KeyInput::Copy)
        );
        assert_eq!(
            named_key_input(&Key::Character("x".into())),
            Some(KeyInput::Cut)
        );
        assert_eq!(
            named_key_input(&Key::Character("v".into())),
            Some(KeyInput::Paste)
        );
    }
}
