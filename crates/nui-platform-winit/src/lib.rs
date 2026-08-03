//! Platform window / input via winit + softbuffer present.
//!
//! Slice 0: open a native window and present CPU-rendered frames.
//! See softbuffer + winit `ApplicationHandler` integration patterns:
//! <https://github.com/rust-windowing/softbuffer>

use std::num::NonZeroU32;
use std::rc::Rc;

use softbuffer::{Context, Surface};
use winit::application::ApplicationHandler;
use winit::dpi::LogicalSize;
use winit::event::WindowEvent;
use winit::event_loop::{ActiveEventLoop, EventLoop};
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

/// Paint callback: pixels (softbuffer `u32` 0x00RRGGBB), width, height, scale factor.
pub type PaintFn = dyn FnMut(&mut [u32], u32, u32, f64);

/// Open a window and pump the event loop until close.
///
/// `paint` is invoked on every `RedrawRequested` with a writable frame buffer.
pub fn run_window(
    title: &str,
    paint: impl FnMut(&mut [u32], u32, u32, f64) + 'static,
) -> Result<(), PlatformError> {
    let event_loop = EventLoop::new().map_err(|e| PlatformError::EventLoop(e.to_string()))?;
    let mut app = App {
        title: title.to_owned(),
        paint: Box::new(paint),
        window: None,
        context: None,
        surface: None,
    };
    event_loop
        .run_app(&mut app)
        .map_err(|e| PlatformError::EventLoop(e.to_string()))
}

struct App {
    title: String,
    paint: Box<PaintFn>,
    window: Option<Rc<Window>>,
    context: Option<Context<Rc<Window>>>,
    surface: Option<Surface<Rc<Window>, Rc<Window>>>,
}

impl ApplicationHandler for App {
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

                (self.paint)(buffer.as_mut(), width, height, scale);

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
