//! Slice 0/1 scaffold — pure Rust Counter acceptance target.
//!
//! Current milestone: print backend identity (CI-safe).
//! Next: winit window → hand layout → Skia text/button → click updates.

fn main() {
    println!(
        "Nexa UI rust-counter scaffold\n  core={}  platform={}  render={}  layout={}",
        nui_core::VERSION,
        nui_platform_winit::backend_name(),
        nui_render_skia::backend_name(),
        nui_layout_taffy::backend_name(),
    );
    println!("Next: Slice 0 — open a native window and draw Hello Nexa UI.");
}
