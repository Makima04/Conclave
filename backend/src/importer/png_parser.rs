use crate::importer::types::*;
use base64::Engine;
use sha2::{Digest, Sha256};

// ─── PNG signature ───

const PNG_SIGNATURE: [u8; 8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

// ─── Public API ───

/// Parse a PNG file, extract ccv3/chara metadata, return ExternalCard.
pub fn parse_png(bytes: &[u8]) -> Result<ExternalCard, ImportError> {
    // 1. Validate PNG signature
    if bytes.len() < 8 {
        return Err(ImportError::PngParse(
            "File too short to be a valid PNG".to_string(),
        ));
    }
    if bytes[..8] != PNG_SIGNATURE {
        return Err(ImportError::PngParse("Invalid PNG signature".to_string()));
    }

    // 2. Walk chunks, collect text keyword-value pairs
    let text_chunks = extract_png_text_chunks(bytes);

    // 3. Try ccv3 first, then chara
    let source_hash = compute_hash(bytes);

    let ccv3_pair = text_chunks.iter().find(|(kw, _)| kw == "ccv3");
    let chara_pair = text_chunks.iter().find(|(kw, _)| kw == "chara");

    if let Some((_, value_bytes)) = ccv3_pair {
        let json = decode_base64_json(value_bytes, "ccv3")?;
        return parse_ccv3_json(json, source_hash);
    }

    if let Some((_, value_bytes)) = chara_pair {
        let json = decode_base64_json(value_bytes, "chara")?;
        return parse_chara_json(json, source_hash);
    }

    Err(ImportError::PngParse(
        "No ccv3 or chara metadata found in PNG text chunks".to_string(),
    ))
}

/// Extract all text chunk keyword-value pairs from PNG.
fn extract_png_text_chunks(bytes: &[u8]) -> Vec<(String, Vec<u8>)> {
    let mut results = Vec::new();
    let mut pos = 8; // skip 8-byte signature

    while pos + 8 <= bytes.len() {
        // 4-byte length (big-endian u32)
        let length =
            u32::from_be_bytes([bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]])
                as usize;

        // 4-byte type (4 ASCII chars)
        let chunk_type = &bytes[pos + 4..pos + 8];
        let type_str = std::str::from_utf8(chunk_type).unwrap_or("");

        // Check we have enough bytes for data + CRC
        let data_start = pos + 8;
        let data_end = data_start + length;
        let chunk_end = data_end + 4; // 4-byte CRC

        if chunk_end > bytes.len() {
            break; // truncated chunk, stop parsing
        }

        let data = &bytes[data_start..data_end];

        match type_str {
            "tEXt" => {
                // tEXt: keyword\0text
                if let Some(null_pos) = data.iter().position(|&b| b == 0) {
                    let keyword = String::from_utf8_lossy(&data[..null_pos]).to_string();
                    let value = data[null_pos + 1..].to_vec();
                    results.push((keyword, value));
                }
            }
            "iTXt" => {
                // iTXt: keyword\0compression_flag\0compression_method\0language_tag\0translated_keyword\0text
                let parts: Vec<&[u8]> = data.splitn(6, |&b| b == 0).collect();
                if parts.len() >= 6 {
                    let keyword = String::from_utf8_lossy(parts[0]).to_string();
                    let compression_flag = parts[1].first().copied().unwrap_or(0);
                    let text_bytes = parts[5];

                    let value = if compression_flag == 1 {
                        // compressed with zlib - attempt decompression
                        match inflate_zlib(text_bytes) {
                            Ok(decompressed) => decompressed,
                            Err(_) => continue, // skip if decompression fails
                        }
                    } else {
                        text_bytes.to_vec()
                    };

                    results.push((keyword, value));
                }
            }
            "IEND" => {
                break; // end of PNG
            }
            _ => {}
        }

        pos = chunk_end;
    }

    results
}

/// Attempt zlib decompression of data.
fn inflate_zlib(data: &[u8]) -> Result<Vec<u8>, ImportError> {
    // Skip the 2-byte zlib header if present, then use flate2 or raw inflate.
    // We don't have flate2 as a dependency, but iTXt compression is rare.
    // For now, try using the miniz_oxide approach via raw deflate bytes.
    // Since we don't have a deflate dependency, we return an error for compressed data.
    // Most character cards use uncompressed text chunks.
    Err(ImportError::PngParse(format!(
        "Compressed iTXt chunk encountered ({} bytes) but zlib decompression is not available",
        data.len()
    )))
}

/// Decode a base64-encoded text value into JSON.
fn decode_base64_json(value_bytes: &[u8], keyword: &str) -> Result<serde_json::Value, ImportError> {
    let value_str = String::from_utf8_lossy(value_bytes);
    let trimmed = value_str.trim();

    let decoded = base64::engine::general_purpose::STANDARD
        .decode(trimmed)
        .map_err(|e| {
            ImportError::PngParse(format!(
                "Failed to base64-decode '{}' text chunk: {}",
                keyword, e
            ))
        })?;

    serde_json::from_slice(&decoded).map_err(|e| {
        ImportError::PngParse(format!(
            "Failed to parse JSON from '{}' text chunk: {}",
            keyword, e
        ))
    })
}

/// Parse ccv3 JSON into ExternalCard.
fn parse_ccv3_json(
    json: serde_json::Value,
    source_hash: String,
) -> Result<ExternalCard, ImportError> {
    // ccv3 format has "spec" -> "chara_card_v2" and "data" sub-object
    let spec = json
        .get("spec")
        .and_then(|v| v.as_str())
        .unwrap_or("chara_card_v2")
        .to_string();

    let data = json
        .get("data")
        .ok_or_else(|| ImportError::PngParse("ccv3 JSON missing 'data' field".to_string()))?;

    let name = data
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    if name.is_empty() {
        return Err(ImportError::PngParse(
            "ccv3 card has empty name".to_string(),
        ));
    }

    Ok(ExternalCard {
        name,
        description: get_str(data, "description"),
        personality: get_str(data, "personality"),
        scenario: get_str(data, "scenario"),
        first_mes: get_str(data, "first_mes"),
        alternate_greetings: get_arr_str(data, "alternate_greetings"),
        system_prompt: get_str(data, "system_prompt"),
        post_history_instructions: get_str(data, "post_history_instructions"),
        creator_notes: get_str(data, "creator_notes"),
        mes_example: get_str(data, "mes_example"),
        creator: get_str(data, "creator"),
        character_version: get_str(data, "character_version"),
        tags: get_arr_str(data, "tags"),
        spec,
        extensions: data
            .get("extensions")
            .cloned()
            .unwrap_or(serde_json::json!({})),
        avatar: json
            .get("avatar")
            .and_then(|v| v.as_str())
            .unwrap_or("none")
            .to_string(),
        source_format: SourceFormat::PngCcv3,
        source_hash,
    })
}

/// Parse chara (v2) JSON into ExternalCard.
fn parse_chara_json(
    json: serde_json::Value,
    source_hash: String,
) -> Result<ExternalCard, ImportError> {
    // chara format: direct fields at top level (or under "data")
    let data = json.get("data").unwrap_or(&json);

    let name = data
        .get("name")
        .or_else(|| json.get("name"))
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    if name.is_empty() {
        return Err(ImportError::PngParse(
            "chara card has empty name".to_string(),
        ));
    }

    Ok(ExternalCard {
        name,
        description: get_str(data, "description"),
        personality: get_str(data, "personality"),
        scenario: get_str(data, "scenario"),
        first_mes: get_str(data, "first_mes"),
        alternate_greetings: get_arr_str(data, "alternate_greetings"),
        system_prompt: get_str(data, "system_prompt"),
        post_history_instructions: get_str(data, "post_history_instructions"),
        creator_notes: data
            .get("creator_notes")
            .and_then(|v| v.as_str())
            .or_else(|| json.get("creatorcomment").and_then(|v| v.as_str()))
            .unwrap_or("")
            .to_string(),
        mes_example: get_str(data, "mes_example"),
        creator: data
            .get("creator")
            .and_then(|v| v.as_str())
            .or_else(|| json.get("creator").and_then(|v| v.as_str()))
            .unwrap_or("")
            .to_string(),
        character_version: data
            .get("character_version")
            .and_then(|v| v.as_str())
            .or_else(|| json.get("character_version").and_then(|v| v.as_str()))
            .unwrap_or("")
            .to_string(),
        tags: get_arr_str(data, "tags"),
        spec: json
            .get("spec")
            .and_then(|v| v.as_str())
            .or_else(|| json.get("spec_version").and_then(|v| v.as_str()))
            .unwrap_or("chara_card_v2")
            .to_string(),
        extensions: data
            .get("extensions")
            .cloned()
            .unwrap_or(serde_json::json!({})),
        avatar: json
            .get("avatar")
            .and_then(|v| v.as_str())
            .unwrap_or("none")
            .to_string(),
        source_format: SourceFormat::PngChara,
        source_hash,
    })
}

// ─── Helpers ───

fn get_str(obj: &serde_json::Value, key: &str) -> String {
    obj.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn get_arr_str(obj: &serde_json::Value, key: &str) -> Vec<String> {
    obj.get(key)
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

/// Compute sha256 hex string.
pub fn compute_hash(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("sha256:{:x}", hasher.finalize())
}

// ─── Tests ───

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compute_hash() {
        let data = b"hello world";
        let hash = compute_hash(data);
        assert!(hash.starts_with("sha256:"));
        // sha256 of "hello world" is known
        assert_eq!(
            hash,
            "sha256:b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );
    }

    #[test]
    fn test_compute_hash_empty() {
        let hash = compute_hash(b"");
        assert!(hash.starts_with("sha256:"));
        // sha256 of empty is e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
        assert_eq!(
            hash,
            "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn test_parse_ccv3_json() {
        let json = serde_json::json!({
            "spec": "chara_card_v2",
            "data": {
                "name": "TestChar",
                "description": "A test character",
                "personality": "Friendly",
                "scenario": "In a tavern",
                "first_mes": "Hello there!",
                "alternate_greetings": ["Hey!", "Hi!"],
                "system_prompt": "You are TestChar.",
                "post_history_instructions": "Stay in character.",
                "creator_notes": "Test notes",
                "mes_example": "<START>\nTest exchange",
                "creator": "TestCreator",
                "character_version": "1.0",
                "tags": ["test", "fantasy"],
                "extensions": {
                    "regex_scripts": []
                }
            },
            "avatar": "test.png"
        });

        let hash = "sha256:abc123".to_string();
        let card = parse_ccv3_json(json, hash.clone()).unwrap();

        assert_eq!(card.name, "TestChar");
        assert_eq!(card.description, "A test character");
        assert_eq!(card.personality, "Friendly");
        assert_eq!(card.scenario, "In a tavern");
        assert_eq!(card.first_mes, "Hello there!");
        assert_eq!(card.alternate_greetings, vec!["Hey!", "Hi!"]);
        assert_eq!(card.system_prompt, "You are TestChar.");
        assert_eq!(card.post_history_instructions, "Stay in character.");
        assert_eq!(card.creator_notes, "Test notes");
        assert_eq!(card.mes_example, "<START>\nTest exchange");
        assert_eq!(card.creator, "TestCreator");
        assert_eq!(card.character_version, "1.0");
        assert_eq!(card.tags, vec!["test", "fantasy"]);
        assert_eq!(card.spec, "chara_card_v2");
        assert_eq!(card.avatar, "test.png");
        assert_eq!(card.source_format.to_string(), "png_ccv3");
        assert_eq!(card.source_hash, hash);
    }

    #[test]
    fn test_parse_ccv3_json_missing_data() {
        let json = serde_json::json!({
            "spec": "chara_card_v2"
        });
        let result = parse_ccv3_json(json, "sha256:abc".to_string());
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_chara_json() {
        let json = serde_json::json!({
            "name": "V2Char",
            "description": "A v2 character",
            "personality": "Calm",
            "scenario": "In a forest",
            "first_mes": "Greetings.",
            "alternate_greetings": ["Hey"],
            "system_prompt": "Be V2Char.",
            "post_history_instructions": "Keep going.",
            "creator_notes": "Notes here",
            "mes_example": "Example",
            "creator": "Creator2",
            "character_version": "2.0",
            "tags": ["v2"],
            "extensions": {},
            "avatar": "v2.png"
        });

        let hash = "sha256:def456".to_string();
        let card = parse_chara_json(json, hash.clone()).unwrap();

        assert_eq!(card.name, "V2Char");
        assert_eq!(card.description, "A v2 character");
        assert_eq!(card.source_format.to_string(), "png_chara");
        assert_eq!(card.spec, "chara_card_v2");
        assert_eq!(card.source_hash, hash);
    }

    #[test]
    fn test_parse_chara_json_with_data_wrapper() {
        let json = serde_json::json!({
            "name": "WrappedChar",
            "data": {
                "name": "WrappedChar",
                "description": "Inside data",
                "first_mes": "Hi from data"
            }
        });

        let card = parse_chara_json(json, "sha256:abc".to_string()).unwrap();
        assert_eq!(card.name, "WrappedChar");
        assert_eq!(card.description, "Inside data");
        assert_eq!(card.first_mes, "Hi from data");
    }

    #[test]
    fn test_parse_chara_json_empty_name() {
        let json = serde_json::json!({
            "description": "No name"
        });
        let result = parse_chara_json(json, "sha256:abc".to_string());
        assert!(result.is_err());
    }

    #[test]
    fn test_invalid_png_signature() {
        let result = parse_png(b"not a png file at all");
        assert!(result.is_err());
    }

    #[test]
    fn test_too_short_data() {
        let result = parse_png(b"\x89PNG");
        assert!(result.is_err());
    }

    /// Helper to build a minimal valid PNG with a tEXt chunk.
    /// This creates a PNG with just the IHDR-like structure skipped but
    /// with a tEXt chunk containing ccv3 data.
    #[test]
    fn test_extract_png_text_chunks() {
        // Build a minimal PNG byte sequence with a tEXt chunk
        let mut png = Vec::new();
        // Signature
        png.extend_from_slice(&PNG_SIGNATURE);

        // Build a tEXt chunk with keyword "ccv3" and a base64-encoded JSON value
        let card_json = serde_json::json!({
            "spec": "chara_card_v2",
            "data": {
                "name": "PngTestChar",
                "description": "From PNG"
            }
        });
        let b64 =
            base64::engine::general_purpose::STANDARD.encode(card_json.to_string().as_bytes());

        let mut chunk_data = Vec::new();
        chunk_data.extend_from_slice(b"ccv3");
        chunk_data.push(0); // null separator
        chunk_data.extend_from_slice(b64.as_bytes());

        // Write tEXt chunk: length(4) + type(4) + data + crc(4)
        let length = chunk_data.len() as u32;
        png.extend_from_slice(&length.to_be_bytes());
        png.extend_from_slice(b"tEXt");
        png.extend_from_slice(&chunk_data);

        // Compute CRC over type + data
        let crc_input: Vec<u8> = [b"tEXt".as_slice(), &chunk_data].concat();
        let crc = crc32(&crc_input);
        png.extend_from_slice(&crc.to_be_bytes());

        // IEND chunk
        png.extend_from_slice(&0u32.to_be_bytes()); // length = 0
        png.extend_from_slice(b"IEND");
        let iend_crc = crc32(b"IEND");
        png.extend_from_slice(&iend_crc.to_be_bytes());

        let card = parse_png(&png).unwrap();
        assert_eq!(card.name, "PngTestChar");
        assert_eq!(card.description, "From PNG");
        assert_eq!(card.source_format.to_string(), "png_ccv3");
    }

    /// Simple CRC32 implementation for test PNG construction.
    fn crc32(data: &[u8]) -> u32 {
        let mut crc: u32 = 0xFFFFFFFF;
        for &byte in data {
            crc ^= byte as u32;
            for _ in 0..8 {
                if crc & 1 != 0 {
                    crc = (crc >> 1) ^ 0xEDB88320;
                } else {
                    crc >>= 1;
                }
            }
        }
        crc ^ 0xFFFFFFFF
    }
}
