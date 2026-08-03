//! Platform window / input via winit + softbuffer present.
//!
//! Slice 0: open a native window and present CPU-rendered frames.
//! Slice 1: forward pointer presses for hit-testing.
//! See softbuffer + winit `ApplicationHandler` integration patterns:
//! <https://github.com/rust-windowing/softbuffer>

use std::num::NonZeroU32;
use std::rc::Rc;

use softbuffer::{Context, Surface};
use winit::application::ApplicationHandler;
use winit::dpi::LogicalSize;
use winit::event::{ElementState, Ime, KeyEvent, MouseButton, WindowEvent};
use winit::event_loop::{ActiveEventLoop, EventLoop};
use winit::keyboard::{Key, NamedKey};
use winit::window::{Window, WindowId};

use nui_core::VERSION as CORE_VERSION;

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

/// Application callbacks driven by the platform event loop.
pub trait WindowApp {
    /// Paint into a softbuffer frame (`width`/`height` are physical pixels).
    fn paint(&mut self, pixels: &mut [u32], width: u32, height: u32, scale: f64);

    /// Left-button press at physical pixel coordinates.
    /// Return `true` to request a redraw.
    fn pointer_pressed(&mut self, x: f64, y: f64, scale: f64) -> bool {
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

    /// Backspace / delete backward.
    fn key_backspace(&mut self) -> bool {
        false
    }

    /// Enter / Return (single-line submit).
    fn key_enter(&mut self) -> bool {
        false
    }
}

/// Open a window and pump the event loop until close.
pub fn run_app(title: &str, app: impl WindowApp + 'static) -> Result<(), PlatformError> {
    let event_loop = EventLoop::new().map_err(|e| PlatformError::EventLoop(e.to_string()))?;
    let mut host = Host {
        title: title.to_owned(),
        app: Box::new(app),
        window: None,
        context: None,
        surface: None,
        cursor: (0.0, 0.0),
    };
    event_loop
        .run_app(&mut host)
        .map_err(|e| PlatformError::EventLoop(e.to_string()))
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

struct Host {
    title: String,
    app: Box<dyn WindowApp>,
    window: Option<Rc<Window>>,
    context: Option<Context<Rc<Window>>>,
    surface: Option<Surface<Rc<Window>, Rc<Window>>>,
    cursor: (f64, f64),
}

impl ApplicationHandler for Host {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }

        let attrs = Window::default_attributes()
            .with_title(self.title.clone())
            .with_inner_size(LogicalSize::new(640.0, 420.0));

        let window = match event_loop.create_window(attrs) {
            Ok(window) => Rc::new(window),
            Err(err) => {
                eprintln!("nui-platform-winit: failed to create window: {err}");
                event_loop.exit();
                return;
            }
        };

        let context = match Context::new(window.clone()) {
            Ok(context) => context,
            Err(err) => {
                eprintln!("nui-platform-winit: softbuffer context failed: {err}");
                event_loop.exit();
                return;
            }
        };

        let mut surface = match Surface::new(&context, window.clone()) {
            Ok(surface) => surface,
            Err(err) => {
                eprintln!("nui-platform-winit: softbuffer surface failed: {err}");
                event_loop.exit();
                return;
            }
        };

        let size = window.inner_size();
        if let (Some(width), Some(height)) =
            (NonZeroU32::new(size.width), NonZeroU32::new(size.height))
        {
            if let Err(err) = surface.resize(width, height) {
                eprintln!("nui-platform-winit: surface resize failed: {err}");
                event_loop.exit();
                return;
            }
        }

        window.set_ime_allowed(true);
        window.request_redraw();
        self.window = Some(window);
        self.context = Some(context);
        self.surface = Some(surface);
    }

    fn window_event(
        &mut self,
        event_loop: &ActiveEventLoop,
        window_id: WindowId,
        event: WindowEvent,
    ) {
        let Some(window) = self.window.as_ref() else {
            return;
        };
        if window.id() != window_id {
            return;
        }

        match event {
            WindowEvent::CloseRequested => {
                event_loop.exit();
            }
            WindowEvent::Resized(size) => {
                if let Some(surface) = self.surface.as_mut() {
                    if let (Some(width), Some(height)) =
                        (NonZeroU32::new(size.width), NonZeroU32::new(size.height))
                    {
                        if let Err(err) = surface.resize(width, height) {
                            eprintln!("nui-platform-winit: surface resize failed: {err}");
                        }
                    }
                }
                window.request_redraw();
            }
            WindowEvent::ScaleFactorChanged { .. } => {
                window.request_redraw();
            }
            WindowEvent::CursorMoved { position, .. } => {
                self.cursor = (position.x, position.y);
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
                        state: ElementState::Pressed,
                        text,
                        ..
                    },
                ..
            } => {
                let redraw = match &logical_key {
                    Key::Named(NamedKey::Backspace) => self.app.key_backspace(),
                    Key::Named(NamedKey::Enter) => self.app.key_enter(),
                    Key::Character(ch) if !ch.is_empty() => self.app.text_input(ch.as_str()),
                    _ => {
                        // Fallback for layouts that only populate `text`.
                        if let Some(t) = text.as_ref() {
                            if !t.is_empty()
                                && t.chars().all(|c| !c.is_control())
                            {
                                self.app.text_input(t)
                            } else {
                                false
                            }
                        } else {
                            false
                        }
                    }
                };
                if redraw {
                    window.request_redraw();
                }
            }
            WindowEvent::Ime(Ime::Commit(s)) => {
                if !s.is_empty() && self.app.text_input(&s) {
                    window.request_redraw();
                }
            }
            WindowEvent::RedrawRequested => {
                let Some(surface) = self.surface.as_mut() else {
                    return;
                };
                let size = window.inner_size();
                let width = size.width;
                let height = size.height;
                if width == 0 || height == 0 {
                    return;
                }
                let scale = window.scale_factor();

                let mut buffer = match surface.buffer_mut() {
                    Ok(buffer) => buffer,
                    Err(err) => {
                        eprintln!("nui-platform-winit: buffer_mut failed: {err}");
                        return;
                    }
                };

                self.app.paint(buffer.as_mut(), width, height, scale);

                if let Err(err) = buffer.present() {
                    eprintln!("nui-platform-winit: present failed: {err}");
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_is_winit() {
        assert_eq!(backend_name(), "winit");
        assert!(!core_version().is_empty());
    }
}
