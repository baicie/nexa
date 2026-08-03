//! Slice 0 acceptance: static native window with Skia text + rounded rect.
//!
//! ```text
//! cargo run -p rust-counter            # open window
//! cargo run -p rust-counter -- --smoke # offscreen one frame, exit 0
//! ```

use nui_platform_winit::run_window;
use nui_render_skia::{paint_hello_frame, smoke_paint_hello};

fn main() {
    let smoke = std::env::args().any(|arg| arg == "--smoke");

    if smoke {
        match smoke_paint_hello(640, 420, 1.0) {
            Ok(pixels) => {
                let non_zero = pixels.iter().filter(|&&p| p != 0).count();
                println!(
                    "nexa-ui smoke ok: {}x{} frame, {non_zero} non-zero pixels (core={})",
                    640,
                    420,
                    nui_core::VERSION
                );
            }
            Err(err) => {
                eprintln!("nexa-ui smoke failed: {err}");
                std::process::exit(1);
            }
        }
        return;
    }

    println!(
        "Nexa UI Slice 0\n  core={}  platform={}  render={}  layout={}",
        nui_core::VERSION,
        nui_platform_winit::backend_name(),
        nui_render_skia::backend_name(),
        nui_layout_taffy::backend_name(),
    );

    if let Err(err) = run_window("Nexa UI", |pixels, width, height, scale| {
        if let Err(err) = paint_hello_frame(pixels, width, height, scale) {
            eprintln!("paint failed: {err}");
        }
    }) {
        eprintln!("failed to run window: {err}");
        std::process::exit(1);
    }
}
