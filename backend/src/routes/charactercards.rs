use axum::Json;
use axum::extract::{Path, State};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::error::AppError;
use crate::routes::messages::AppState;

// ── Response types ──

#[derive(Serialize)]
pub struct CharacterCardResponse {
    pub id: String,
    pub world_book_id: String,
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
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conclave_package: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub import_report: Option<serde_json::Value>,
}

// ── DB row struct ──

#[derive(sqlx::FromRow)]
struct CharacterCardRow {
    id: String,
    world_book_id: String,
    name: String,
    description: String,
    personality: String,
    scenario: String,
    first_mes: String,
    avatar: String,
    creator: String,
    character_version: String,
    tags: String,
    alternate_greetings: String,
    system_prompt: String,
    post_history_instructions: String,
    creator_notes: String,
    mes_example: String,
    extensions: String,
    spec: String,
    created_at: String,
    updated_at: String,
}

// ── Request types ──

#[derive(Deserialize)]
pub struct UpdateCharacterCard {
    pub name: Option<String>,
    pub description: Option<String>,
    pub personality: Option<String>,
    pub scenario: Option<String>,
    pub first_mes: Option<String>,
    pub system_prompt: Option<String>,
    pub post_history_instructions: Option<String>,
    pub creator_notes: Option<String>,
    pub mes_example: Option<String>,
}

// ── Helpers ──

fn parse_json_array(s: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(s).unwrap_or_default()
}

fn row_to_response(row: CharacterCardRow) -> CharacterCardResponse {
    CharacterCardResponse {
        id: row.id,
        world_book_id: row.world_book_id,
        name: row.name,
        description: row.description,
        personality: row.personality,
        scenario: row.scenario,
        first_mes: row.first_mes,
        avatar: row.avatar,
        creator: row.creator,
        character_version: row.character_version,
        tags: parse_json_array(&row.tags),
        alternate_greetings: parse_json_array(&row.alternate_greetings),
        system_prompt: row.system_prompt,
        post_history_instructions: row.post_history_instructions,
        creator_notes: row.creator_notes,
        mes_example: row.mes_example,
        extensions: serde_json::from_str(&row.extensions).unwrap_or(serde_json::json!({})),
        spec: row.spec,
        created_at: row.created_at,
        updated_at: row.updated_at,
        conclave_package: None,
        import_report: None,
    }
}

/// Fetch the latest import report for a character card and attach it to the response.
async fn attach_import_data(
    pool: &sqlx::SqlitePool,
    card_id: &str,
    response: &mut CharacterCardResponse,
) {
    let result = sqlx::query_as::<_, (String, String)>(
        "SELECT package_json, report_json FROM import_reports WHERE character_card_id = ?1 ORDER BY created_at DESC LIMIT 1",
    )
    .bind(card_id)
    .fetch_optional(pool)
    .await;

    if let Ok(Some((package_json, report_json))) = result {
        response.conclave_package = serde_json::from_str(&package_json).ok();
        response.import_report = serde_json::from_str(&report_json).ok();
    }
}

const SELECT_ALL: &str = "SELECT id, world_book_id, name, description, personality, scenario, first_mes, avatar, creator, character_version, tags, alternate_greetings, system_prompt, post_history_instructions, creator_notes, mes_example, extensions, spec, created_at, updated_at FROM character_cards";

// ── Handlers ──

/// GET /api/charactercards — list all character cards
pub async fn list_character_cards(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, AppError> {
    let rows = sqlx::query_as::<_, (String, String, String, String)>(
        "SELECT id, name, creator, created_at FROM character_cards ORDER BY created_at DESC",
    )
    .fetch_all(&state.pool)
    .await?;

    let items: Vec<serde_json::Value> = rows
        .iter()
        .map(|(id, name, creator, created)| {
            serde_json::json!({
                "id": id,
                "name": name,
                "creator": creator,
                "created_at": created,
            })
        })
        .collect();

    Ok(Json(serde_json::json!({ "items": items })))
}

/// GET /api/charactercards/{id} — get a single character card
pub async fn get_character_card(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<CharacterCardResponse>, AppError> {
    let row = sqlx::query_as::<_, CharacterCardRow>(&format!("{} WHERE id = ?", SELECT_ALL))
        .bind(&id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Character card not found".to_string()))?;

    let card_id = row.id.clone();
    let mut response = row_to_response(row);
    attach_import_data(&state.pool, &card_id, &mut response).await;

    Ok(Json(response))
}

/// GET /api/worldbooks/{wb_id}/character-card — get character card for a world book
pub async fn get_card_for_worldbook(
    State(state): State<Arc<AppState>>,
    Path(wb_id): Path<String>,
) -> Result<Json<CharacterCardResponse>, AppError> {
    let row =
        sqlx::query_as::<_, CharacterCardRow>(&format!("{} WHERE world_book_id = ?", SELECT_ALL))
            .bind(&wb_id)
            .fetch_optional(&state.pool)
            .await?
            .ok_or_else(|| {
                AppError::NotFound("No character card for this world book".to_string())
            })?;

    let card_id = row.id.clone();
    let mut response = row_to_response(row);
    attach_import_data(&state.pool, &card_id, &mut response).await;

    Ok(Json(response))
}

/// PATCH /api/charactercards/{id} — update editable fields
pub async fn update_character_card(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<UpdateCharacterCard>,
) -> Result<Json<serde_json::Value>, AppError> {
    let existing = sqlx::query_scalar::<_, String>("SELECT id FROM character_cards WHERE id = ?")
        .bind(&id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Character card not found".to_string()))?;

    let now = chrono::Utc::now().to_rfc3339();
    let mut updates = Vec::new();
    let mut params: Vec<String> = Vec::new();

    if let Some(v) = &body.name {
        updates.push("name = ?");
        params.push(v.clone());
    }
    if let Some(v) = &body.description {
        updates.push("description = ?");
        params.push(v.clone());
    }
    if let Some(v) = &body.personality {
        updates.push("personality = ?");
        params.push(v.clone());
    }
    if let Some(v) = &body.scenario {
        updates.push("scenario = ?");
        params.push(v.clone());
    }
    if let Some(v) = &body.first_mes {
        updates.push("first_mes = ?");
        params.push(v.clone());
    }
    if let Some(v) = &body.system_prompt {
        updates.push("system_prompt = ?");
        params.push(v.clone());
    }
    if let Some(v) = &body.post_history_instructions {
        updates.push("post_history_instructions = ?");
        params.push(v.clone());
    }
    if let Some(v) = &body.creator_notes {
        updates.push("creator_notes = ?");
        params.push(v.clone());
    }
    if let Some(v) = &body.mes_example {
        updates.push("mes_example = ?");
        params.push(v.clone());
    }

    if updates.is_empty() {
        return Err(AppError::BadRequest("No fields to update".to_string()));
    }

    updates.push("updated_at = ?");
    params.push(now.clone());
    params.push(existing); // WHERE id = ?

    let sql = format!(
        "UPDATE character_cards SET {} WHERE id = ?",
        updates.join(", ")
    );
    let mut query = sqlx::query(&sql);
    for param in &params {
        query = query.bind(param);
    }
    query.execute(&state.pool).await?;

    Ok(Json(serde_json::json!({ "id": id, "updated_at": now })))
}
