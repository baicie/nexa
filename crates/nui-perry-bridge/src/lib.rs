//! NUI Host engine used by the Perry native-library wrapper.
//!
//! This crate intentionally does **not** depend on `perry-ffi`, so the
//! workspace can test HostOps without linking Perry. The `packages/nui-host`
//! crate owns `#[no_mangle]` exports and Perry ABI types.
//!
//! Tree state is `Arc`-shared so Perry click callbacks can `set_text` while
//! the window event loop owns the same arena (Slice 2→3 fix).

mod host;
mod window;

pub use host::{pack_rgba, HostUiEvent, NuiHost};

#[cfg(test)]
mod tests {
    use nui_core::{NodeType, PropertyId};

    use super::*;
    use crate::host::{backspace_at_caret, insert_text_at_caret};

    #[test]
    fn build_counter_tree_and_hit() {
        let host = NuiHost::new();
        let root = host.create_node(NodeType::View);
        host.set_number(root, PropertyId::Padding, 24.0);
        host.set_number(root, PropertyId::Gap, 16.0);

        let label = host.create_text("Count: 0");
        host.set_number(label, PropertyId::FontSize, 28.0);
        host.insert(label, root);

        let button = host.create_node(NodeType::View);
        host.set_number(button, PropertyId::Padding, 12.0);
        host.set_number(button, PropertyId::BorderRadius, 12.0);
        host.set_number(
            button,
            PropertyId::BackgroundColor,
            f64::from(pack_rgba(0x1f, 0x6f, 0xeb, 0xff)),
        );
        host.add_click_listener(button, 42);
        host.insert(button, root);

        let btn_label = host.create_text("Increment");
        host.set_number(btn_label, PropertyId::FontSize, 18.0);
        host.set_number(
            btn_label,
            PropertyId::TextColor,
            f64::from(pack_rgba(0xff, 0xff, 0xff, 0xff)),
        );
        host.insert(btn_label, button);

        host.layout(320.0, 240.0);
        let layout = {
            let inner = host.inner.lock().expect("host inner");
            inner.arena.get(button).unwrap().layout
        };
        let hit = host
            .hit_clickable(layout.x + 1.0, layout.y + 1.0)
            .expect("button hit");
        assert_eq!(hit, button);
        assert_eq!(host.click_token(button), Some(42));
    }

    #[test]
    fn host_accepts_generated_protocol_ids() {
        let host = NuiHost::new();
        let node = host.create_node(nui_core::protocol::ui::NodeType::View);
        host.set_number(node, nui_core::protocol::ui::PropertyId::Width, 120.0);

        let inner = host.inner.lock().expect("host inner");
        assert_eq!(inner.arena.get(node).unwrap().style.width, Some(120.0));
    }

    #[test]
    fn remove_clears_subtree_and_tokens() {
        let host = NuiHost::new();
        let root = host.create_node(NodeType::View);
        let child = host.create_node(NodeType::View);
        host.add_click_listener(child, 7);
        host.insert(child, root);
        host.remove(child);
        assert!(host.click_token(child).is_none());
        let inner = host.inner.lock().expect("host inner");
        assert!(inner.arena.get(child).is_none());
        assert!(inner.arena.get(root).unwrap().children.is_empty());
    }

    #[test]
    fn input_insert_and_backspace() {
        let host = NuiHost::new();
        let root = host.create_node(NodeType::View);
        let field = host.create_node(NodeType::View);
        let text = host.create_text("");
        host.insert(text, field);
        host.insert(field, root);
        host.register_input(field, text, "Type…");
        {
            let mut inner = host.inner.lock().expect("host inner");
            inner.focused = Some(field);
            let (_, v) = insert_text_at_caret(&mut inner, "Hi").expect("insert");
            assert_eq!(v, "Hi");
            let (_, v) = insert_text_at_caret(&mut inner, "!").expect("insert");
            assert_eq!(v, "Hi!");
            let (_, v) = backspace_at_caret(&mut inner).expect("backspace");
            assert_eq!(v, "Hi");
        }
        let inner = host.inner.lock().expect("host inner");
        assert_eq!(
            inner
                .arena
                .get(text)
                .and_then(|n| n.text.clone())
                .as_deref(),
            Some("Hi")
        );
    }

    #[test]
    fn set_image_missing_file_stores_placeholder() {
        let host = NuiHost::new();
        let root = host.create_node(NodeType::View);
        let image = host.create_node(NodeType::Image);
        host.insert(image, root);
        host.set_image(image, "/tmp/nexa-ui-missing-image-fixture.png");
        assert_eq!(
            host.image_path(image).as_deref(),
            Some("/tmp/nexa-ui-missing-image-fixture.png")
        );
        let inner = host.inner.lock().expect("host inner");
        let asset = inner.images.get(&image.raw()).expect("asset");
        assert!(asset.pixels.is_empty());
        assert_eq!((asset.width, asset.height), (64, 64));
        let style = &inner.arena.get(image).unwrap().style;
        assert_eq!(style.width, Some(64.0));
        assert_eq!(style.height, Some(64.0));
    }
}
