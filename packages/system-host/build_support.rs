use std::fs;
use std::path::Path;

pub(crate) fn read_bounded_regular_file(
    path: &Path,
    source_name: &str,
    max_bytes: u64,
) -> Result<Vec<u8>, String> {
    let metadata = fs::metadata(path).map_err(|error| {
        format!(
            "failed to inspect {source_name} at {}: {error}",
            path.display()
        )
    })?;
    if !metadata.is_file() {
        return Err(format!(
            "{source_name} must reference a regular file: {}",
            path.display()
        ));
    }
    if metadata.len() > max_bytes {
        return Err(format!(
            "{source_name} exceeds the {max_bytes} byte limit: {}",
            path.display()
        ));
    }

    let bytes = fs::read(path).map_err(|error| {
        format!(
            "failed to read {source_name} at {}: {error}",
            path.display()
        )
    })?;
    if bytes.len() as u64 > max_bytes {
        return Err(format!(
            "{source_name} changed while reading and exceeds the {max_bytes} byte limit: {}",
            path.display()
        ));
    }
    Ok(bytes)
}
