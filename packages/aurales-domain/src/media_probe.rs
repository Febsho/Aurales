use serde::{Deserialize, Serialize};

pub const SAMPLE_BYTES: u64 = 256 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StreamProbeResponse {
    pub status: u16,
    pub content_type: Option<String>,
    pub accept_ranges: bool,
    pub content_length: Option<u64>,
    pub final_url: String,
    pub sampled_bytes: u64,
    pub elapsed_ms: u64,
}

/// Shared interpretation of range headers for native and server-side probes.
pub fn accepts_byte_ranges(status: u16, accept_ranges: Option<&str>) -> bool {
    status == 206
        || accept_ranges
            .map(|value| value.to_ascii_lowercase().contains("bytes"))
            .unwrap_or(false)
}

/// Prefer the total resource size from Content-Range. A partial Content-Length
/// is only the size of that response and must not be mistaken for total size.
pub fn total_content_length(
    status: u16,
    content_range: Option<&str>,
    content_length: Option<&str>,
) -> Option<u64> {
    content_range
        .and_then(|value| value.rsplit('/').next())
        .and_then(|total| total.trim().parse::<u64>().ok())
        .or_else(|| {
            if status == 206 {
                None
            } else {
                content_length.and_then(|value| value.trim().parse::<u64>().ok())
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn range_metadata_uses_the_total_size_for_partial_responses() {
        assert!(accepts_byte_ranges(206, None));
        assert!(accepts_byte_ranges(200, Some("bytes")));
        assert!(!accepts_byte_ranges(200, Some("none")));
        assert_eq!(
            total_content_length(206, Some("bytes 0-99/1000"), Some("100")),
            Some(1000)
        );
        assert_eq!(total_content_length(206, None, Some("100")), None);
        assert_eq!(total_content_length(200, None, Some("1000")), Some(1000));
    }
}
