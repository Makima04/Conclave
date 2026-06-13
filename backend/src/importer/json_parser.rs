use crate::importer::types::*;

// ─── Public API ───

/// Parse a JSON character card (ST v2 or v3 format) into ExternalCard.
pub fn parse_json_card(bytes: &[u8]) -> Result<ExternalCard, ImportError> {
    // 1. Parse bytes as UTF-8 then JSON
    let json: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|e| ImportError::JsonParse(format!("Invalid JSON: {}", e)))?;

    // 2. Detect v2 vs v3
    let version = detect_json_version(&json);

    // 3. Compute sha256 hash of original bytes
    let source_hash = compute_hash(bytes);

    // 4. Extract fields based on version
    match version {
        SourceFormat::JsonV3 => parse_v3_json(json, source_hash),
        SourceFormat::JsonV2 => parse_v2_json(json, source_hash),
        _ => unreachable!(),
    }
}

/// Detect JSON card version.
fn detect_json_version(json: &serde_json::Value) -> SourceFormat {
    // v3: has "spec" field containing "chara_card_v2" or "chara_card_v3", and "data" sub-object
    if let Some(spec) = json.get("spec").and_then(|v| v.as_str()) {
        if (spec == "chara_card_v2" || spec == "chara_card_v3") && json.get("data").is_some() {
            return SourceFormat::JsonV3;
        }
    }
    // v2: direct fields at top level
    SourceFormat::JsonV2
}

/// Parse v3 JSON (fields wrapped in "data" sub-object).
fn parse_v3_json(
    json: serde_json::Value,
    source_hash: String,
) -> Result<ExternalCard, ImportError> {
    let spec = json
        .get("spec")
        .and_then(|v| v.as_str())
        .unwrap_or("chara_card_v2")
        .to_string();

    let data = json
        .get("data")
        .ok_or_else(|| ImportError::JsonParse("v3 card missing 'data' field".to_string()))?;

    let name = data
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    if name.is_empty() {
        return Err(ImportError::JsonParse("v3 card has empty name".to_string()));
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
        extensions: merge_extensions_with_character_book(data, &json),
        avatar: json
            .get("avatar")
            .and_then(|v| v.as_str())
            .unwrap_or("none")
            .to_string(),
        source_format: SourceFormat::JsonV3,
        source_hash,
    })
}

/// Parse v2 JSON (fields at top level).
fn parse_v2_json(
    json: serde_json::Value,
    source_hash: String,
) -> Result<ExternalCard, ImportError> {
    let data = json.get("data").unwrap_or(&json);

    let name = data
        .get("name")
        .or_else(|| json.get("name"))
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    if name.is_empty() {
        return Err(ImportError::JsonParse("v2 card has empty name".to_string()));
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
        extensions: merge_extensions_with_character_book(data, &json),
        avatar: json
            .get("avatar")
            .and_then(|v| v.as_str())
            .unwrap_or("none")
            .to_string(),
        source_format: SourceFormat::JsonV2,
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

fn merge_extensions_with_character_book(
    data: &serde_json::Value,
    root: &serde_json::Value,
) -> serde_json::Value {
    let mut extensions = data
        .get("extensions")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let character_book = data
        .get("character_book")
        .or_else(|| root.get("character_book"))
        .cloned();
    if let Some(book) = character_book {
        if let Some(obj) = extensions.as_object_mut() {
            obj.entry("__character_book".to_string()).or_insert(book);
        }
    }
    extensions
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

// ─── Tests ───

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_json_version_v3() {
        let json = serde_json::json!({
            "spec": "chara_card_v2",
            "data": {
                "name": "Test"
            }
        });
        assert!(matches!(detect_json_version(&json), SourceFormat::JsonV3));
    }

    #[test]
    fn test_detect_json_version_v3_alt_spec() {
        let json = serde_json::json!({
            "spec": "chara_card_v3",
            "data": {
                "name": "Test"
            }
        });
        assert!(matches!(detect_json_version(&json), SourceFormat::JsonV3));
    }

    #[test]
    fn test_detect_json_version_v2() {
        let json = serde_json::json!({
            "name": "Test",
            "description": "A test"
        });
        assert!(matches!(detect_json_version(&json), SourceFormat::JsonV2));
    }

    #[test]
    fn test_detect_json_version_v2_with_spec_no_data() {
        // Has spec but no "data" sub-object -> treated as v2
        let json = serde_json::json!({
            "spec": "chara_card_v2",
            "name": "Test"
        });
        assert!(matches!(detect_json_version(&json), SourceFormat::JsonV2));
    }

    #[test]
    fn test_parse_json_card_v3() {
        let json_bytes = serde_json::to_vec(&serde_json::json!({
            "spec": "chara_card_v2",
            "data": {
                "name": "V3JsonChar",
                "description": "A v3 JSON card",
                "personality": "Curious",
                "scenario": "In a library",
                "first_mes": "What are you reading?",
                "alternate_greetings": ["Hello!"],
                "system_prompt": "You are V3JsonChar.",
                "post_history_instructions": "Be curious.",
                "creator_notes": "V3 notes",
                "mes_example": "Example text",
                "creator": "JsonCreator",
                "character_version": "3.0",
                "tags": ["json", "v3"],
                "extensions": {
                    "regex_scripts": [{"script_name": "test"}]
                }
            },
            "avatar": "v3.png"
        }))
        .unwrap();

        let card = parse_json_card(&json_bytes).unwrap();
        assert_eq!(card.name, "V3JsonChar");
        assert_eq!(card.description, "A v3 JSON card");
        assert_eq!(card.personality, "Curious");
        assert_eq!(card.scenario, "In a library");
        assert_eq!(card.first_mes, "What are you reading?");
        assert_eq!(card.alternate_greetings, vec!["Hello!"]);
        assert_eq!(card.system_prompt, "You are V3JsonChar.");
        assert_eq!(card.post_history_instructions, "Be curious.");
        assert_eq!(card.creator_notes, "V3 notes");
        assert_eq!(card.mes_example, "Example text");
        assert_eq!(card.creator, "JsonCreator");
        assert_eq!(card.character_version, "3.0");
        assert_eq!(card.tags, vec!["json", "v3"]);
        assert_eq!(card.spec, "chara_card_v2");
        assert_eq!(card.avatar, "v3.png");
        assert_eq!(card.source_format.to_string(), "json_v3");
        assert!(card.source_hash.starts_with("sha256:"));
    }

    #[test]
    fn test_parse_json_card_v2() {
        let json_bytes = serde_json::to_vec(&serde_json::json!({
            "name": "V2JsonChar",
            "description": "A v2 JSON card",
            "personality": "Shy",
            "scenario": "At a market",
            "first_mes": "Um... hello.",
            "alternate_greetings": [],
            "system_prompt": "",
            "post_history_instructions": "",
            "creator_notes": "",
            "mes_example": "",
            "creator": "V2Creator",
            "character_version": "1.0",
            "tags": ["v2"],
            "extensions": {},
            "avatar": "v2.png"
        }))
        .unwrap();

        let card = parse_json_card(&json_bytes).unwrap();
        assert_eq!(card.name, "V2JsonChar");
        assert_eq!(card.description, "A v2 JSON card");
        assert_eq!(card.source_format.to_string(), "json_v2");
        assert_eq!(card.spec, "chara_card_v2");
        assert!(card.source_hash.starts_with("sha256:"));
    }

    #[test]
    fn test_parse_json_card_v2_with_creatorcomment() {
        let json_bytes = serde_json::to_vec(&serde_json::json!({
            "name": "LegacyChar",
            "description": "Has creatorcomment instead of creator_notes",
            "creatorcomment": "Legacy notes field",
            "personality": "",
            "scenario": "",
            "first_mes": "",
            "alternate_greetings": [],
            "system_prompt": "",
            "post_history_instructions": "",
            "mes_example": "",
            "creator": "",
            "character_version": "",
            "tags": [],
            "extensions": {}
        }))
        .unwrap();

        let card = parse_json_card(&json_bytes).unwrap();
        assert_eq!(card.name, "LegacyChar");
        assert_eq!(card.creator_notes, "Legacy notes field");
    }

    #[test]
    fn test_parse_json_card_missing_name() {
        let json_bytes = serde_json::to_vec(&serde_json::json!({
            "description": "No name"
        }))
        .unwrap();

        let result = parse_json_card(&json_bytes);
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_json_card_empty_name() {
        let json_bytes = serde_json::to_vec(&serde_json::json!({
            "name": "",
            "description": "Empty name"
        }))
        .unwrap();

        let result = parse_json_card(&json_bytes);
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_json_card_invalid_json() {
        let result = parse_json_card(b"this is not json {{{");
        assert!(result.is_err());
    }

    #[test]
    fn test_compute_hash() {
        let data = b"test data";
        let hash = compute_hash(data);
        assert!(hash.starts_with("sha256:"));
        // Same input produces same hash
        assert_eq!(hash, compute_hash(b"test data"));
        // Different input produces different hash
        assert_ne!(hash, compute_hash(b"different data"));
    }
}
