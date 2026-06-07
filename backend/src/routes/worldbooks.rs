use axum::Json;
use axum::extract::{Path, State};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::error::AppError;
use crate::routes::messages::AppState;

// ── Response types ──

#[derive(Serialize)]
pub struct WorldBookDetailResponse {
    pub id: String,
    pub name: String,
    pub description: String,
    pub original_format: String,
    pub source_data: String,
    pub parse_status: String,
    pub single_agent_parse_status: String,
    pub entries: Vec<WorldBookEntryResponse>,
    pub parsed_entries: Vec<crate::runtime::worldbook_parser::ParsedWorldBookEntry>,
    pub single_agent_parsed_entries: Vec<crate::runtime::worldbook_parser::ParsedWorldBookEntry>,
    pub has_character_card: bool,
    pub character_card_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Clone)]
pub struct WorldBookEntryResponse {
    pub id: String,
    pub world_book_id: String,
    pub keys: Vec<String>,
    pub content: String,
    pub comment: String,
    pub constant: bool,
    pub priority: i32,
    pub enabled: bool,
    pub position: String,
    pub selective: bool,
    pub secondary_keys: Vec<String>,
    pub selective_logic: i32,
    pub created_at: String,
    pub updated_at: String,
}

// ── Request types ──

#[derive(Deserialize)]
pub struct ImportRequest {
    pub data: serde_json::Value,
}

#[derive(Deserialize)]
pub struct UpdateWorldBook {
    pub name: Option<String>,
    pub description: Option<String>,
}

#[derive(Deserialize)]
pub struct UpdateEntry {
    pub keys: Option<Vec<String>>,
    pub content: Option<String>,
    pub comment: Option<String>,
    pub constant: Option<bool>,
    pub priority: Option<i32>,
    pub enabled: Option<bool>,
    pub position: Option<String>,
    pub selective: Option<bool>,
    pub secondary_keys: Option<Vec<String>>,
    pub selective_logic: Option<i32>,
}

// ── Converter ──

/// Metadata extracted from a Character Card V2/V3 during import.
pub struct CharacterCardMeta {
    pub name: String,
    pub description: String,
    pub personality: String,
    pub scenario: String,
    pub first_mes: String,
    pub avatar: String,
    pub creator: String,
    pub character_version: String,
    pub tags: Vec<String>,
    pub alternate_greetings: Vec<String>,
    pub system_prompt: String,
    pub post_history_instructions: String,
    pub creator_notes: String,
    pub mes_example: String,
    pub extensions: serde_json::Value,
    pub spec: String,
}

struct ConvertedEntry {
    keys: Vec<String>,
    content: String,
    comment: String,
    constant: bool,
    priority: i32,
    enabled: bool,
    position: String,
    selective: bool,
    secondary_keys: Vec<String>,
    selective_logic: i32,
}

fn detect_and_convert(
    data: &serde_json::Value,
) -> Result<
    (
        String,
        String,
        Vec<ConvertedEntry>,
        Option<CharacterCardMeta>,
    ),
    AppError,
> {
    // 1. Character Card V2/V3: has top-level "character_book" with entries as array
    //    OR character card PNG export: {"name":..., "data": {"character_book": ...}}
    let book = data
        .get("character_book")
        .or_else(|| data.get("data").and_then(|d| d.get("character_book")));
    if let Some(book) = book {
        let name = book
            .get("name")
            .or_else(|| data.get("name"))
            .and_then(|v| v.as_str())
            .unwrap_or("Untitled")
            .to_string();
        let entries = convert_ccv2_entries(book)?;
        let card_meta = extract_character_card_meta(data);
        return Ok((name, "ccv2".to_string(), entries, card_meta));
    }

    // 2. SillyTavern native: has top-level "entries" as object (UID-keyed)
    if let Some(entries_val) = data.get("entries") {
        if entries_val.is_object() {
            let name = data
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("Untitled")
                .to_string();
            let entries = convert_st_entries(entries_val)?;
            return Ok((name, "sillytavern".to_string(), entries, None));
        }
    }

    Err(AppError::BadRequest(
        "Unrecognized world book format. Expected SillyTavern or Character Card V2 JSON."
            .to_string(),
    ))
}

/// Extract character card metadata from CCv2/v3 JSON (top-level or data.* fields).
fn extract_character_card_meta(data: &serde_json::Value) -> Option<CharacterCardMeta> {
    // The card data lives either at top level or under "data"
    let d = data.get("data").unwrap_or(data);

    // Only extract if there's meaningful card data (at least a name)
    let name = d
        .get("name")
        .or_else(|| data.get("name"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if name.is_empty() {
        return None;
    }

    let get_str = |obj: &serde_json::Value, key: &str| -> String {
        obj.get(key)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    let get_arr_str = |obj: &serde_json::Value, key: &str| -> Vec<String> {
        obj.get(key)
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default()
    };

    let spec = data
        .get("spec")
        .and_then(|v| v.as_str())
        .or_else(|| data.get("spec_version").and_then(|v| v.as_str()))
        .unwrap_or("chara_card_v2")
        .to_string();

    Some(CharacterCardMeta {
        name,
        description: get_str(d, "description"),
        personality: get_str(d, "personality"),
        scenario: get_str(d, "scenario"),
        first_mes: get_str(d, "first_mes"),
        avatar: data
            .get("avatar")
            .and_then(|v| v.as_str())
            .unwrap_or("none")
            .to_string(),
        creator: d
            .get("creator")
            .and_then(|v| v.as_str())
            .or_else(|| data.get("creator").and_then(|v| v.as_str()))
            .unwrap_or("")
            .to_string(),
        character_version: d
            .get("character_version")
            .and_then(|v| v.as_str())
            .or_else(|| data.get("character_version").and_then(|v| v.as_str()))
            .unwrap_or("")
            .to_string(),
        tags: get_arr_str(d, "tags"),
        alternate_greetings: get_arr_str(d, "alternate_greetings"),
        system_prompt: get_str(d, "system_prompt"),
        post_history_instructions: get_str(d, "post_history_instructions"),
        creator_notes: d
            .get("creator_notes")
            .and_then(|v| v.as_str())
            .or_else(|| data.get("creatorcomment").and_then(|v| v.as_str()))
            .unwrap_or("")
            .to_string(),
        mes_example: get_str(d, "mes_example"),
        extensions: d
            .get("extensions")
            .cloned()
            .unwrap_or(serde_json::json!({})),
        spec,
    })
}

fn convert_ccv2_entries(book: &serde_json::Value) -> Result<Vec<ConvertedEntry>, AppError> {
    let arr = match book.get("entries").and_then(|v| v.as_array()) {
        Some(a) => a,
        None => return Ok(vec![]),
    };

    let mut entries = Vec::with_capacity(arr.len());
    for entry in arr {
        let keys = extract_string_array(entry, "keys")
            .or_else(|| extract_string_array(entry, "key"))
            .unwrap_or_default();
        let secondary_keys = extract_string_array(entry, "secondary_keys")
            .or_else(|| extract_string_array(entry, "keysecondary"))
            .unwrap_or_default();

        entries.push(ConvertedEntry {
            keys,
            content: entry
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            comment: entry
                .get("comment")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            constant: entry
                .get("constant")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            priority: entry
                .get("insertion_order")
                .and_then(|v| v.as_i64())
                .unwrap_or(100) as i32,
            enabled: entry
                .get("enabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(true),
            position: entry
                .get("position")
                .and_then(|v| v.as_str())
                .unwrap_or("before_char")
                .to_string(),
            selective: entry
                .get("selective")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            secondary_keys,
            selective_logic: extract_selective_logic(entry),
        });
    }
    Ok(entries)
}

fn convert_st_entries(entries_val: &serde_json::Value) -> Result<Vec<ConvertedEntry>, AppError> {
    let obj = match entries_val.as_object() {
        Some(o) => o,
        None => return Ok(vec![]),
    };

    let mut entries = Vec::with_capacity(obj.len());
    for (_uid_str, entry) in obj {
        if !entry.is_object() {
            continue;
        }

        let keys = extract_string_array(entry, "key").unwrap_or_default();
        let secondary_keys = extract_string_array(entry, "keysecondary").unwrap_or_default();
        let disable = entry
            .get("disable")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let position_num = entry.get("position").and_then(|v| v.as_i64()).unwrap_or(0);
        let position = match position_num {
            0 => "before_char",
            1 => "after_char",
            4 => "at_depth",
            _ => "before_char",
        };

        entries.push(ConvertedEntry {
            keys,
            content: entry
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            comment: entry
                .get("comment")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            constant: entry
                .get("constant")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            priority: entry.get("order").and_then(|v| v.as_i64()).unwrap_or(100) as i32,
            enabled: !disable,
            position: position.to_string(),
            selective: entry
                .get("selective")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            secondary_keys,
            selective_logic: extract_selective_logic(entry),
        });
    }
    Ok(entries)
}

fn extract_string_array(val: &serde_json::Value, key: &str) -> Option<Vec<String>> {
    val.get(key).and_then(|v| v.as_array()).map(|arr| {
        arr.iter()
            .filter_map(|item| item.as_str().map(String::from))
            .collect()
    })
}

fn extract_selective_logic(entry: &serde_json::Value) -> i32 {
    entry
        .get("selectiveLogic")
        .or_else(|| entry.get("selective_logic"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0) as i32
}

// ── Helpers ──

fn parse_json_array(s: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(s).unwrap_or_default()
}

fn entry_to_response(
    row_id: &str,
    row_wb_id: &str,
    keys_json: &str,
    content: &str,
    comment: &str,
    constant: i32,
    priority: i32,
    enabled: i32,
    position: &str,
    selective: i32,
    secondary_keys_json: &str,
    selective_logic: i32,
    created_at: &str,
    updated_at: &str,
) -> WorldBookEntryResponse {
    WorldBookEntryResponse {
        id: row_id.to_string(),
        world_book_id: row_wb_id.to_string(),
        keys: parse_json_array(keys_json),
        content: content.to_string(),
        comment: comment.to_string(),
        constant: constant != 0,
        priority,
        enabled: enabled != 0,
        position: position.to_string(),
        selective: selective != 0,
        secondary_keys: parse_json_array(secondary_keys_json),
        selective_logic,
        created_at: created_at.to_string(),
        updated_at: updated_at.to_string(),
    }
}

// ── Handlers ──

pub async fn import_worldbook(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ImportRequest>,
) -> Result<Json<WorldBookDetailResponse>, AppError> {
    let (name, format_tag, converted, card_meta) = detect_and_convert(&body.data)?;

    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let source_data = serde_json::to_string(&body.data)
        .map_err(|e| AppError::Internal(format!("Failed to serialize source data: {}", e)))?;

    let mut tx = state.pool.begin().await?;

    sqlx::query(
        "INSERT INTO world_books (id, name, description, original_format, source_data, created_at, updated_at) VALUES (?, ?, '', ?, ?, ?, ?)"
    )
    .bind(&id)
    .bind(&name)
    .bind(&format_tag)
    .bind(&source_data)
    .bind(&now)
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    // Insert character card metadata if present
    let mut character_card_id: Option<String> = None;
    if let Some(card) = &card_meta {
        let card_id = uuid::Uuid::new_v4().to_string();
        let tags_json = serde_json::to_string(&card.tags).unwrap_or_else(|_| "[]".to_string());
        let greetings_json =
            serde_json::to_string(&card.alternate_greetings).unwrap_or_else(|_| "[]".to_string());
        let extensions_json =
            serde_json::to_string(&card.extensions).unwrap_or_else(|_| "{}".to_string());

        sqlx::query(
            "INSERT INTO character_cards (id, world_book_id, name, description, personality, scenario, first_mes, avatar, creator, character_version, tags, alternate_greetings, system_prompt, post_history_instructions, creator_notes, mes_example, extensions, spec, source_data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(&card_id)
        .bind(&id)
        .bind(&card.name)
        .bind(&card.description)
        .bind(&card.personality)
        .bind(&card.scenario)
        .bind(&card.first_mes)
        .bind(&card.avatar)
        .bind(&card.creator)
        .bind(&card.character_version)
        .bind(&tags_json)
        .bind(&greetings_json)
        .bind(&card.system_prompt)
        .bind(&card.post_history_instructions)
        .bind(&card.creator_notes)
        .bind(&card.mes_example)
        .bind(&extensions_json)
        .bind(&card.spec)
        .bind(&source_data)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;

        character_card_id = Some(card_id);
    }

    let mut entry_responses = Vec::with_capacity(converted.len());
    for entry in &converted {
        let entry_id = uuid::Uuid::new_v4().to_string();
        let keys_json = serde_json::to_string(&entry.keys).unwrap_or_else(|_| "[]".to_string());
        let secondary_keys_json =
            serde_json::to_string(&entry.secondary_keys).unwrap_or_else(|_| "[]".to_string());

        sqlx::query(
            "INSERT INTO world_book_entries (id, world_book_id, keys, content, comment, constant, priority, enabled, position, selective, secondary_keys, selective_logic, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(&entry_id)
        .bind(&id)
        .bind(&keys_json)
        .bind(&entry.content)
        .bind(&entry.comment)
        .bind(if entry.constant { 1 } else { 0 })
        .bind(entry.priority)
        .bind(if entry.enabled { 1 } else { 0 })
        .bind(&entry.position)
        .bind(if entry.selective { 1 } else { 0 })
        .bind(&secondary_keys_json)
        .bind(entry.selective_logic)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;

        entry_responses.push(entry_to_response(
            &entry_id,
            &id,
            &keys_json,
            &entry.content,
            &entry.comment,
            if entry.constant { 1 } else { 0 },
            entry.priority,
            if entry.enabled { 1 } else { 0 },
            &entry.position,
            if entry.selective { 1 } else { 0 },
            &secondary_keys_json,
            entry.selective_logic,
            &now,
            &now,
        ));
    }

    tx.commit().await?;

    tracing::info!(
        book_id = %id, name = %name, format = %format_tag, entries = entry_responses.len(),
        has_card = card_meta.is_some(), "World book imported"
    );

    Ok(Json(WorldBookDetailResponse {
        id,
        name,
        description: String::new(),
        original_format: format_tag,
        source_data,
        parse_status: "none".to_string(),
        single_agent_parse_status: "none".to_string(),
        entries: entry_responses,
        parsed_entries: vec![],
        single_agent_parsed_entries: vec![],
        has_character_card: card_meta.is_some(),
        character_card_id,
        created_at: now.clone(),
        updated_at: now,
    }))
}

pub async fn list_worldbooks(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, AppError> {
    let rows = sqlx::query_as::<_, (String, String, String, String, String, String)>(
        "SELECT w.id, w.name, w.description, w.original_format, w.created_at, w.updated_at FROM world_books w ORDER BY w.created_at DESC"
    )
    .fetch_all(&state.pool)
    .await?;

    let count_rows = sqlx::query_as::<_, (String, i64)>(
        "SELECT world_book_id, COUNT(*) FROM world_book_entries GROUP BY world_book_id",
    )
    .fetch_all(&state.pool)
    .await?;

    // Check which world books have character cards and fetch card names/avatars
    let cc_rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT world_book_id, name, avatar FROM character_cards",
    )
    .fetch_all(&state.pool)
    .await?;

    let cc_map: std::collections::HashMap<String, (String, String)> =
        cc_rows.into_iter().map(|(wid, name, avatar)| (wid, (name, avatar))).collect();
    let count_map: std::collections::HashMap<String, i64> = count_rows.into_iter().collect();

    let items: Vec<serde_json::Value> = rows
        .iter()
        .map(|(id, name, desc, fmt, created, updated)| {
            let mut val = serde_json::json!({
                "id": id,
                "name": name,
                "description": desc,
                "original_format": fmt,
                "entry_count": count_map.get(id).copied().unwrap_or(0),
                "has_character_card": cc_map.contains_key(id),
                "created_at": created,
                "updated_at": updated,
            });
            if let Some((cc_name, cc_avatar)) = cc_map.get(id) {
                val["character_card_name"] = serde_json::json!(cc_name);
                val["character_card_avatar"] = serde_json::json!(cc_avatar);
            } else {
                val["character_card_name"] = serde_json::json!(null);
                val["character_card_avatar"] = serde_json::json!(null);
            }
            val
        })
        .collect();

    Ok(Json(serde_json::json!({ "items": items })))
}

pub async fn get_worldbook(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<WorldBookDetailResponse>, AppError> {
    let row = sqlx::query_as::<_, (String, String, String, String, String, String, String, String, String, String, String)>(
        "SELECT id, name, description, original_format, source_data, COALESCE(parse_status, 'none'), COALESCE(single_agent_parse_status, 'none'), COALESCE(parsed_entries, '[]'), COALESCE(single_agent_parsed_entries, '[]'), created_at, updated_at FROM world_books WHERE id = ?"
    )
    .bind(&id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("World book not found".to_string()))?;

    let (
        wb_id,
        name,
        description,
        original_format,
        source_data,
        parse_status,
        single_agent_parse_status,
        parsed_entries_json,
        single_agent_parsed_entries_json,
        created_at,
        updated_at,
    ) = row;

    let parsed_entries = serde_json::from_str(&parsed_entries_json).unwrap_or_else(|_| Vec::new());
    let single_agent_parsed_entries =
        serde_json::from_str(&single_agent_parsed_entries_json).unwrap_or_else(|_| Vec::new());

    // Check for character card
    let cc_id: Option<String> =
        sqlx::query_scalar("SELECT id FROM character_cards WHERE world_book_id = ?")
            .bind(&id)
            .fetch_optional(&state.pool)
            .await?;

    let entry_rows = sqlx::query_as::<_, (String, String, String, String, String, i32, i32, i32, String, i32, String, i32, String, String)>(
        "SELECT id, world_book_id, keys, content, comment, constant, priority, enabled, position, selective, secondary_keys, selective_logic, created_at, updated_at FROM world_book_entries WHERE world_book_id = ? ORDER BY priority DESC, created_at ASC"
    )
    .bind(&id)
    .fetch_all(&state.pool)
    .await?;

    let entries: Vec<WorldBookEntryResponse> = entry_rows
        .iter()
        .map(
            |(
                eid,
                wbid,
                keys,
                content,
                comment,
                constant,
                priority,
                enabled,
                position,
                selective,
                secondary_keys,
                selective_logic,
                ca,
                ua,
            )| {
                entry_to_response(
                    eid,
                    wbid,
                    keys,
                    content,
                    comment,
                    *constant,
                    *priority,
                    *enabled,
                    position,
                    *selective,
                    secondary_keys,
                    *selective_logic,
                    ca,
                    ua,
                )
            },
        )
        .collect();

    Ok(Json(WorldBookDetailResponse {
        id: wb_id,
        name,
        description,
        original_format,
        source_data,
        parse_status,
        single_agent_parse_status,
        entries,
        parsed_entries,
        single_agent_parsed_entries,
        has_character_card: cc_id.is_some(),
        character_card_id: cc_id,
        created_at,
        updated_at,
    }))
}

pub async fn update_worldbook(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<UpdateWorldBook>,
) -> Result<Json<serde_json::Value>, AppError> {
    let existing = sqlx::query_scalar::<_, String>("SELECT id FROM world_books WHERE id = ?")
        .bind(&id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| AppError::NotFound("World book not found".to_string()))?;

    let now = chrono::Utc::now().to_rfc3339();
    let mut updates = Vec::new();
    let mut params: Vec<String> = Vec::new();

    if let Some(name) = &body.name {
        updates.push("name = ?");
        params.push(name.clone());
    }
    if let Some(desc) = &body.description {
        updates.push("description = ?");
        params.push(desc.clone());
    }

    if updates.is_empty() {
        return Err(AppError::BadRequest("No fields to update".to_string()));
    }

    updates.push("updated_at = ?");
    params.push(now.clone());
    params.push(existing); // WHERE id = ?

    let sql = format!("UPDATE world_books SET {} WHERE id = ?", updates.join(", "));
    let mut query = sqlx::query(&sql);
    for param in &params {
        query = query.bind(param);
    }
    query.execute(&state.pool).await?;

    Ok(Json(serde_json::json!({ "id": id, "updated_at": now })))
}

pub async fn delete_worldbook(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result = sqlx::query("DELETE FROM world_books WHERE id = ?")
        .bind(&id)
        .execute(&state.pool)
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("World book not found".to_string()));
    }

    Ok(Json(serde_json::json!({ "deleted": true })))
}

pub async fn export_worldbook(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let row = sqlx::query_as::<_, (String, String, String)>(
        "SELECT name, description, original_format FROM world_books WHERE id = ?",
    )
    .bind(&id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("World book not found".to_string()))?;

    let (name, description, _original_format) = row;

    let entry_rows = sqlx::query_as::<_, (String, String, String, String, i32, i32, i32, String, i32, String, i32, String)>(
        "SELECT id, keys, content, comment, constant, priority, enabled, position, selective, secondary_keys, selective_logic, created_at FROM world_book_entries WHERE world_book_id = ? ORDER BY priority DESC, created_at ASC"
    )
    .bind(&id)
    .fetch_all(&state.pool)
    .await?;

    let entries: Vec<serde_json::Value> = entry_rows
        .iter()
        .map(
            |(
                eid,
                keys,
                content,
                comment,
                constant,
                priority,
                enabled,
                position,
                selective,
                secondary_keys,
                selective_logic,
                _created,
            )| {
                serde_json::json!({
                    "id": eid,
                    "keys": parse_json_array(keys),
                    "content": content,
                    "comment": comment,
                    "constant": *constant != 0,
                    "priority": priority,
                    "enabled": *enabled != 0,
                    "position": position,
                    "selective": *selective != 0,
                    "secondary_keys": parse_json_array(secondary_keys),
                    "selective_logic": selective_logic,
                })
            },
        )
        .collect();

    Ok(Json(serde_json::json!({
        "name": name,
        "description": description,
        "entries": entries,
    })))
}

pub async fn update_entry(
    State(state): State<Arc<AppState>>,
    Path((book_id, entry_id)): Path<(String, String)>,
    Json(body): Json<UpdateEntry>,
) -> Result<Json<serde_json::Value>, AppError> {
    // Verify entry exists and belongs to book
    let existing = sqlx::query_scalar::<_, String>(
        "SELECT id FROM world_book_entries WHERE id = ? AND world_book_id = ?",
    )
    .bind(&entry_id)
    .bind(&book_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Entry not found".to_string()))?;

    let now = chrono::Utc::now().to_rfc3339();
    let mut updates = Vec::new();
    let mut params: Vec<String> = Vec::new();

    if let Some(keys) = &body.keys {
        updates.push("keys = ?");
        params.push(serde_json::to_string(keys).unwrap_or_else(|_| "[]".to_string()));
    }
    if let Some(content) = &body.content {
        updates.push("content = ?");
        params.push(content.clone());
    }
    if let Some(comment) = &body.comment {
        updates.push("comment = ?");
        params.push(comment.clone());
    }
    if let Some(constant) = body.constant {
        updates.push("constant = ?");
        params.push(if constant {
            "1".to_string()
        } else {
            "0".to_string()
        });
    }
    if let Some(priority) = body.priority {
        updates.push("priority = ?");
        params.push(priority.to_string());
    }
    if let Some(enabled) = body.enabled {
        updates.push("enabled = ?");
        params.push(if enabled {
            "1".to_string()
        } else {
            "0".to_string()
        });
    }
    if let Some(position) = &body.position {
        updates.push("position = ?");
        params.push(position.clone());
    }
    if let Some(selective) = body.selective {
        updates.push("selective = ?");
        params.push(if selective {
            "1".to_string()
        } else {
            "0".to_string()
        });
    }
    if let Some(secondary_keys) = &body.secondary_keys {
        updates.push("secondary_keys = ?");
        params.push(serde_json::to_string(secondary_keys).unwrap_or_else(|_| "[]".to_string()));
    }
    if let Some(selective_logic) = body.selective_logic {
        updates.push("selective_logic = ?");
        params.push(selective_logic.to_string());
    }

    if updates.is_empty() {
        return Err(AppError::BadRequest("No fields to update".to_string()));
    }

    updates.push("updated_at = ?");
    params.push(now.clone());
    params.push(existing); // WHERE id = ?

    let sql = format!(
        "UPDATE world_book_entries SET {} WHERE id = ?",
        updates.join(", ")
    );
    let mut query = sqlx::query(&sql);
    for param in &params {
        query = query.bind(param);
    }
    query.execute(&state.pool).await?;

    Ok(Json(
        serde_json::json!({ "id": entry_id, "updated_at": now }),
    ))
}

pub async fn delete_entry(
    State(state): State<Arc<AppState>>,
    Path((book_id, entry_id)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result = sqlx::query("DELETE FROM world_book_entries WHERE id = ? AND world_book_id = ?")
        .bind(&entry_id)
        .bind(&book_id)
        .execute(&state.pool)
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Entry not found".to_string()));
    }

    Ok(Json(serde_json::json!({ "deleted": true })))
}

/// POST /api/worldbooks/{id}/parse — parse world book entries for multi-agent use
pub async fn parse_worldbook(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    parse_worldbook_with_mode(state, id, WorldBookParseMode::MultiAgent).await
}

/// POST /api/worldbooks/{id}/parse-single-agent — parse world book entries for single-agent routing
pub async fn parse_worldbook_single_agent(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    parse_worldbook_with_mode(state, id, WorldBookParseMode::SingleAgent).await
}

#[derive(Debug, Clone, Copy)]
enum WorldBookParseMode {
    MultiAgent,
    SingleAgent,
}

async fn parse_worldbook_with_mode(
    state: Arc<AppState>,
    id: String,
    mode: WorldBookParseMode,
) -> Result<Json<serde_json::Value>, AppError> {
    // Load entries
    let entry_rows = sqlx::query_as::<_, (String, String, String, String, String, i32, i32, i32, String, i32, String, i32, String, String)>(
        "SELECT id, world_book_id, keys, content, comment, constant, priority, enabled, position, selective, secondary_keys, selective_logic, created_at, updated_at FROM world_book_entries WHERE world_book_id = ? AND enabled = 1 ORDER BY priority DESC"
    )
    .bind(&id)
    .fetch_all(&state.pool)
    .await?;

    if entry_rows.is_empty() {
        return Err(AppError::BadRequest(
            "No enabled entries to parse".to_string(),
        ));
    }

    // Prepare entries for parsing: (id, keys, content, comment, constant)
    let entries_for_parse: Vec<(String, Vec<String>, String, String, bool)> = entry_rows
        .iter()
        .map(
            |(eid, _, keys_json, content, comment, constant, _, _, _, _, _, _, _, _)| {
                (
                    eid.clone(),
                    parse_json_array(keys_json),
                    content.clone(),
                    comment.clone(),
                    *constant != 0,
                )
            },
        )
        .collect();

    // Mark as parsing
    let now = chrono::Utc::now().to_rfc3339();
    match mode {
        WorldBookParseMode::MultiAgent => {
            sqlx::query(
                "UPDATE world_books SET parse_status = 'parsing', updated_at = ? WHERE id = ?",
            )
            .bind(&now)
            .bind(&id)
            .execute(&state.pool)
            .await?;
        }
        WorldBookParseMode::SingleAgent => {
            sqlx::query(
                "UPDATE world_books SET single_agent_parse_status = 'parsing', updated_at = ? WHERE id = ?",
            )
            .bind(&now)
            .bind(&id)
            .execute(&state.pool)
            .await?;
        }
    }

    // Load provider
    let provider = crate::runtime::executor::load_default_provider(&state.pool).await?;
    let model = crate::runtime::executor::load_provider_model(&state.pool).await?;

    let parsed_result = match mode {
        WorldBookParseMode::MultiAgent => {
            crate::runtime::worldbook_parser::parse_world_book_for_multi_agent(
                &provider,
                &model,
                &entries_for_parse,
            )
            .await
        }
        WorldBookParseMode::SingleAgent => {
            crate::runtime::worldbook_parser::parse_world_book_for_single_agent(
                &provider,
                &model,
                &entries_for_parse,
            )
            .await
        }
    };

    match parsed_result {
        Ok(parsed) => {
            let parsed_json = serde_json::to_string(&parsed).map_err(|e| {
                AppError::Internal(format!("Failed to serialize parsed entries: {}", e))
            })?;

            let now2 = chrono::Utc::now().to_rfc3339();
            match mode {
                WorldBookParseMode::MultiAgent => {
                    sqlx::query("UPDATE world_books SET parse_status = 'done', parsed_entries = ?, updated_at = ? WHERE id = ?")
                        .bind(&parsed_json)
                        .bind(&now2)
                        .bind(&id)
                        .execute(&state.pool)
                        .await?;
                }
                WorldBookParseMode::SingleAgent => {
                    sqlx::query("UPDATE world_books SET single_agent_parse_status = 'done', single_agent_parsed_entries = ?, updated_at = ? WHERE id = ?")
                        .bind(&parsed_json)
                        .bind(&now2)
                        .bind(&id)
                        .execute(&state.pool)
                        .await?;
                }
            }

            tracing::info!(book_id = %id, entries = parsed.len(), mode = ?mode, "World book parsed");

            Ok(Json(serde_json::json!({
                "status": "done",
                "entries": parsed,
                "mode": match mode {
                    WorldBookParseMode::MultiAgent => "multi_agent",
                    WorldBookParseMode::SingleAgent => "single_agent",
                },
            })))
        }
        Err(e) => {
            let now2 = chrono::Utc::now().to_rfc3339();
            match mode {
                WorldBookParseMode::MultiAgent => {
                    sqlx::query(
                        "UPDATE world_books SET parse_status = 'error', updated_at = ? WHERE id = ?",
                    )
                    .bind(&now2)
                    .bind(&id)
                    .execute(&state.pool)
                    .await?;
                }
                WorldBookParseMode::SingleAgent => {
                    sqlx::query(
                        "UPDATE world_books SET single_agent_parse_status = 'error', updated_at = ? WHERE id = ?",
                    )
                    .bind(&now2)
                    .bind(&id)
                    .execute(&state.pool)
                    .await?;
                }
            }

            tracing::error!(book_id = %id, error = %e, "World book parse failed");
            Err(e)
        }
    }
}
