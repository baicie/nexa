//! Lossless HandleRef transport codecs for the v1 Host ABI.
//!
//! Packed `NodeId` values remain an internal Rust representation. The stable
//! boundary uses two u32 fields and the canonical `h1/<slot>/<generation>`
//! token for string results.

use nui_core::NodeId;
use nui_protocol::common;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandleCodecError {
    Shape,
    Hex,
    Generation,
}

/// Encode a logical HandleRef as the canonical v1 ASCII token.
pub fn encode_handle_token(handle: &common::HandleRef) -> Result<String, HandleCodecError> {
    if handle.generation < common::HANDLE_GENERATION_MIN {
        return Err(HandleCodecError::Generation);
    }
    Ok(format!(
        "{}/{:08x}/{:08x}",
        common::HANDLE_TOKEN_PREFIX,
        handle.slot,
        handle.generation
    ))
}

/// Decode a canonical v1 token, rejecting alternate casing or widths.
pub fn decode_handle_token(token: &str) -> Result<common::HandleRef, HandleCodecError> {
    let mut parts = token.split('/');
    let Some(prefix) = parts.next() else {
        return Err(HandleCodecError::Shape);
    };
    let Some(slot) = parts.next() else {
        return Err(HandleCodecError::Shape);
    };
    let Some(generation) = parts.next() else {
        return Err(HandleCodecError::Shape);
    };
    if parts.next().is_some() || prefix != common::HANDLE_TOKEN_PREFIX {
        return Err(HandleCodecError::Shape);
    }

    let slot = parse_hex_component(slot)?;
    let generation = parse_hex_component(generation)?;
    if generation < common::HANDLE_GENERATION_MIN {
        return Err(HandleCodecError::Generation);
    }
    Ok(common::HandleRef { slot, generation })
}

fn parse_hex_component(value: &str) -> Result<u32, HandleCodecError> {
    if value.len() != 8
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(if value.len() == 8 {
            HandleCodecError::Hex
        } else {
            HandleCodecError::Shape
        });
    }
    u32::from_str_radix(value, 16).map_err(|_| HandleCodecError::Hex)
}

/// Convert the native packed representation into the public logical handle.
pub fn node_id_to_handle(id: NodeId) -> Result<common::HandleRef, HandleCodecError> {
    let handle = common::HandleRef {
        slot: id.slot(),
        generation: id.generation(),
    };
    encode_handle_token(&handle).map(|_| handle)
}

/// Convert a validated logical handle into the native packed representation.
pub fn handle_to_node_id(handle: &common::HandleRef) -> Result<NodeId, HandleCodecError> {
    encode_handle_token(handle)?;
    Ok(NodeId::new(handle.slot, handle.generation))
}

#[cfg(test)]
mod tests {
    use super::{decode_handle_token, encode_handle_token, handle_to_node_id, node_id_to_handle};
    use nui_core::NodeId;
    use nui_protocol::common;

    #[test]
    fn round_trips_minimum_and_maximum_handles() {
        for handle in [
            common::HandleRef {
                slot: 0,
                generation: 1,
            },
            common::HandleRef {
                slot: u32::MAX,
                generation: u32::MAX,
            },
        ] {
            let token = encode_handle_token(&handle).unwrap();
            assert_eq!(decode_handle_token(&token).unwrap(), handle);
            assert_eq!(
                handle_to_node_id(&handle).unwrap(),
                NodeId::new(handle.slot, handle.generation)
            );
            assert_eq!(
                node_id_to_handle(NodeId::new(handle.slot, handle.generation)).unwrap(),
                handle
            );
        }
    }

    #[test]
    fn rejects_non_canonical_tokens() {
        for token in [
            "",
            "h1/0/00000001",
            "h1/00000000/0",
            "h1/00000000/00000000",
            "h1/00000000/FFFFFFFF",
            "h1/00000000/00000001/extra",
            "h2/00000000/00000001",
            "h1/gggggggg/00000001",
        ] {
            assert!(decode_handle_token(token).is_err(), "accepted {token}");
        }
    }
}
