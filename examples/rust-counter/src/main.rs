//! Slice 1 acceptance: pure Rust interactive Counter.
//!
//! ```text
//! cargo run -p rust-counter            # open window, click Increment
//! cargo run -p rust-counter -- --smoke # offscreen layout/paint/click simulation
//! ```

use nui_core::{hit_test, Arena, ColorRgba, FlexDirection, NodeId, NodeType, Style};
use nui_layout_taffy::layout_tree;
use nui_platform_winit::{run_app, WindowApp};
use nui_render_skia::paint_tree;

fn main() {
    let smoke = std::env::args().any(|arg| arg == "--smoke");

    if smoke {
        if let Err(err) = run_smoke() {
            eprintln!("nexa-ui smoke failed: {err}");
            std::process::exit(1);
        }
        return;
    }

    println!(
        "Nexa UI Slice 1 (Counter)\n  core={}  platform={}  render={}",
        nui_core::VERSION,
        nui_platform_winit::backend_name(),
        nui_render_skia::backend_name(),
    );

    let app = CounterApp::new();
    if let Err(err) = run_app("Nexa UI — Counter", app) {
        eprintln!("failed to run window: {err}");
        std::process::exit(1);
    }
}

struct CounterApp {
    arena: Arena,
    root: NodeId,
    label: NodeId,
    button: NodeId,
    count: i32,
    /// Last logical viewport used for layout.
    viewport: (f32, f32),
}

impl CounterApp {
    fn new() -> Self {
        let mut arena = Arena::new();
        let root = arena.create(NodeType::View);
        arena.set_style(
            root,
            Style {
                padding: 24.0,
                gap: 16.0,
                flex_direction: FlexDirection::Column,
                background: Some(ColorRgba::rgb(0xF4, 0xF6, 0xF8)),
                ..Style::default()
            },
        );

        let label = arena.create(NodeType::Text);
        arena.set_text(label, "Count: 0");
        arena.set_style(
            label,
            Style {
                font_size: 28.0,
                color: ColorRgba::rgb(0x11, 0x18, 0x27),
                ..Style::default()
            },
        );
        arena.insert_child(root, label);

        let button = arena.create(NodeType::View);
        arena.set_style(
            button,
            Style {
                padding: 12.0,
                border_radius: 12.0,
                background: Some(ColorRgba::rgb(0x1F, 0x6F, 0xEB)),
                ..Style::default()
            },
        );
        arena.set_clickable(button, true);
        arena.insert_child(root, button);

        let button_label = arena.create(NodeType::Text);
        arena.set_text(button_label, "Increment");
        arena.set_style(
            button_label,
            Style {
                font_size: 18.0,
                color: ColorRgba::rgb(0xFF, 0xFF, 0xFF),
                ..Style::default()
            },
        );
        arena.insert_child(button, button_label);

        Self {
            arena,
            root,
            label,
            button,
            count: 0,
            viewport: (640.0, 420.0),
        }
    }

    fn sync_label(&mut self) {
        self.arena
            .set_text(self.label, format!("Count: {}", self.count));
    }

    fn relayout(&mut self, logical_w: f32, logical_h: f32) {
        self.viewport = (logical_w, logical_h);
        if let Some(node) = self.arena.get_mut(self.root) {
            node.style.width = Some(logical_w);
            node.style.height = Some(logical_h);
        }
        layout_tree(&mut self.arena, self.root, logical_w, logical_h);
    }
}

impl WindowApp for CounterApp {
    fn paint(&mut self, pixels: &mut [u32], width: u32, height: u32, scale: f64) {
        let scale = scale.max(0.5);
        let logical_w = width as f64 / scale;
        let logical_h = height as f64 / scale;
        self.relayout(logical_w as f32, logical_h as f32);
        if let Err(err) = paint_tree(&self.arena, self.root, pixels, width, height, scale) {
            eprintln!("paint failed: {err}");
        }
    }

    fn pointer_pressed(&mut self, x: f64, y: f64, scale: f64) -> bool {
        let scale = scale.max(0.5);
        let lx = (x / scale) as f32;
        let ly = (y / scale) as f32;
        // Ensure layout matches last paint viewport.
        layout_tree(&mut self.arena, self.root, self.viewport.0, self.viewport.1);
        if hit_test(&self.arena, self.root, lx, ly) == Some(self.button) {
            self.count += 1;
            self.sync_label();
            true
        } else {
            false
        }
    }
}

fn run_smoke() -> Result<(), String> {
    let mut app = CounterApp::new();
    let width = 640_u32;
    let height = 420_u32;
    let scale = 1.0_f64;
    let mut pixels = vec![0_u32; (width as usize) * (height as usize)];

    app.paint(&mut pixels, width, height, scale);
    let before = pixels.clone();

    let button_layout = app.arena.get(app.button).ok_or("missing button")?.layout;
    let click_x = (button_layout.x + button_layout.width * 0.5) as f64 * scale;
    let click_y = (button_layout.y + button_layout.height * 0.5) as f64 * scale;

    if !app.pointer_pressed(click_x, click_y, scale) {
        return Err("expected click on Increment button".into());
    }
    if app.count != 1 {
        return Err(format!("expected count=1, got {}", app.count));
    }

    app.paint(&mut pixels, width, height, scale);
    if pixels == before {
        return Err("frame did not change after click".into());
    }

    println!(
        "nexa-ui smoke ok: counter click -> count={}, frame dirty (core={})",
        app.count,
        nui_core::VERSION
    );
    Ok(())
}
