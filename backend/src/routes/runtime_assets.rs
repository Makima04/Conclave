use axum::Json;
use axum::extract::{Path, State};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::sync::Arc;

use crate::error::AppError;
use crate::routes::messages::AppState;
use crate::routes::sessions::SessionConfig;

#[derive(Debug, Serialize, Clone)]
pub struct RuntimeAssetSource {
    pub scope: String,
    pub id: Option<String>,
    pub name: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct RuntimeRegexScript {
    #[serde(flatten)]
    pub script: Value,
    pub source: RuntimeAssetSource,
}

#[derive(Debug, Serialize, Clone)]
pub struct RuntimeTavernHelperScript {
    #[serde(flatten)]
    pub script: Value,
    pub source: RuntimeAssetSource,
}

#[derive(Debug, Serialize, Clone)]
pub struct SessionRuntimeAssets {
    pub regex_scripts: Vec<RuntimeRegexScript>,
    pub tavern_helper_scripts: Vec<RuntimeTavernHelperScript>,
}

fn parse_json_object(source: &str) -> Value {
    serde_json::from_str(source).unwrap_or_else(|_| Value::Object(Default::default()))
}

fn extension_root(value: &Value) -> Option<&Value> {
    value
        .get("extensions")
        .or_else(|| value.get("data").and_then(|data| data.get("extensions")))
}

fn regex_scripts_from(value: &Value) -> Vec<Value> {
    extension_root(value)
        .and_then(|extensions| extensions.get("regex_scripts"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn tavern_helper_scripts_from(value: &Value) -> Vec<Value> {
    let Some(extensions) = extension_root(value) else {
        return Vec::new();
    };

    if let Some(items) = extensions
        .get("tavern_helper")
        .and_then(|helper| helper.get("scripts"))
        .and_then(Value::as_array)
    {
        return items.clone();
    }

    extensions
        .get("TavernHelper_scripts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

// Dedup key is intentionally scope-agnostic: the same script (by id/name) can be
// reachable from several asset scopes (e.g. a card's regex lives in both the
// worldbook `data.extensions` and the character card `extensions`). If the key
// included the scope, such a script would be applied once per scope — for
// full-page-injection regexes (a `[开局]`→428KB HTML page) this triples the
// rendered HTML and yields malformed, overlapping `<script>` documents that the
// frontend renderer then dumps as visible text. Deduping by id/name (falling
// back to full serialization for id-less scripts) collapses them to one.
fn source_key(script: &Value) -> String {
    let id = script
        .get("id")
        .or_else(|| script.get("uuid"))
        .or_else(|| script.get("script_id"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let name = script
        .get("scriptName")
        .or_else(|| script.get("script_name"))
        .or_else(|| script.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if !id.is_empty() || !name.is_empty() {
        return format!("{id}:{name}");
    }
    serde_json::to_string(script).unwrap_or_default()
}

fn push_regex_scripts(
    target: &mut Vec<RuntimeRegexScript>,
    seen: &mut HashSet<String>,
    source: RuntimeAssetSource,
    scripts: Vec<Value>,
) {
    for script in scripts {
        if !script.is_object() {
            continue;
        }
        let key = source_key(&script);
        if seen.insert(key) {
            target.push(RuntimeRegexScript {
                script,
                source: source.clone(),
            });
        }
    }
}

fn push_tavern_helper_scripts(
    target: &mut Vec<RuntimeTavernHelperScript>,
    seen: &mut HashSet<String>,
    source: RuntimeAssetSource,
    scripts: Vec<Value>,
) {
    for script in scripts {
        if !script.is_object() {
            continue;
        }
        let key = source_key(&script);
        if seen.insert(key) {
            target.push(RuntimeTavernHelperScript {
                script,
                source: source.clone(),
            });
        }
    }
}

async fn load_global_runtime_assets(state: &AppState) -> Result<Value, AppError> {
    let stored: Option<String> =
        sqlx::query_scalar("SELECT value FROM app_settings WHERE key = 'runtime_assets'")
            .fetch_optional(&state.pool)
            .await?;
    Ok(stored
        .as_deref()
        .map(parse_json_object)
        .unwrap_or_else(|| Value::Object(Default::default())))
}

pub async fn load_session_runtime_assets(
    state: &AppState,
    session_id: &str,
) -> Result<SessionRuntimeAssets, AppError> {
    let row = sqlx::query_as::<_, (Option<String>, String)>(
        "SELECT world_pack_id, config FROM sessions WHERE id = ? AND deleted_at IS NULL",
    )
    .bind(session_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Session not found".to_string()))?;

    let (world_pack_id, config_json) = row;
    let config: SessionConfig = serde_json::from_str(&config_json).unwrap_or_default();

    let mut regex_scripts = Vec::new();
    let mut tavern_helper_scripts = Vec::new();
    let mut seen_regex = HashSet::new();
    let mut seen_tavern_helper = HashSet::new();

    // Application order = load order (apply_scripts_for_stage iterates the vector
    // front-to-back), and dedup keeps the FIRST copy of a duplicated script. We
    // therefore push card-scope scripts (worldbook + character) BEFORE preset
    // scripts so that, on conflict, the card's regex wins. A card template that
    // consumes a marker (e.g. `<正文>…</正文>` → galaxy HTML) runs before a preset
    // cleanup that would strip the bare marker (`<正文>` → ``); the preset pass
    // then finds nothing left to strip instead of starving the card template.
    // Global runs first as the app-wide baseline; preset runs last as general
    // cleanup on already-rendered card output.
    let global = load_global_runtime_assets(&state).await?;
    push_regex_scripts(
        &mut regex_scripts,
        &mut seen_regex,
        RuntimeAssetSource {
            scope: "global".to_string(),
            id: None,
            name: Some("全局".to_string()),
        },
        regex_scripts_from(&global),
    );
    push_tavern_helper_scripts(
        &mut tavern_helper_scripts,
        &mut seen_tavern_helper,
        RuntimeAssetSource {
            scope: "global".to_string(),
            id: None,
            name: Some("全局".to_string()),
        },
        tavern_helper_scripts_from(&global),
    );

    if let Some(world_book_id) = world_pack_id.as_deref().filter(|value| !value.is_empty()) {
        if let Some((name, source_data)) = sqlx::query_as::<_, (String, String)>(
            "SELECT name, source_data FROM world_books WHERE id = ?",
        )
        .bind(world_book_id)
        .fetch_optional(&state.pool)
        .await?
        {
            let source = RuntimeAssetSource {
                scope: "worldbook".to_string(),
                id: Some(world_book_id.to_string()),
                name: Some(name),
            };
            let value = parse_json_object(&source_data);
            push_regex_scripts(
                &mut regex_scripts,
                &mut seen_regex,
                source.clone(),
                regex_scripts_from(&value),
            );
            push_tavern_helper_scripts(
                &mut tavern_helper_scripts,
                &mut seen_tavern_helper,
                source,
                tavern_helper_scripts_from(&value),
            );
        }

        if let Some((card_id, card_name, extensions)) =
            sqlx::query_as::<_, (String, String, String)>(
                "SELECT id, name, extensions FROM character_cards WHERE world_book_id = ?",
            )
            .bind(world_book_id)
            .fetch_optional(&state.pool)
            .await?
        {
            let source = RuntimeAssetSource {
                scope: "character".to_string(),
                id: Some(card_id),
                name: Some(card_name),
            };
            let value = serde_json::json!({ "extensions": parse_json_object(&extensions) });
            push_regex_scripts(
                &mut regex_scripts,
                &mut seen_regex,
                source.clone(),
                regex_scripts_from(&value),
            );
            push_tavern_helper_scripts(
                &mut tavern_helper_scripts,
                &mut seen_tavern_helper,
                source,
                tavern_helper_scripts_from(&value),
            );
        }
    }

    if let Some(preset_id) = config
        .active_preset_id
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        if let Some((name, raw_json)) =
            sqlx::query_as::<_, (String, String)>("SELECT name, raw_json FROM presets WHERE id = ?")
                .bind(preset_id)
                .fetch_optional(&state.pool)
                .await?
        {
            let source = RuntimeAssetSource {
                scope: "preset".to_string(),
                id: Some(preset_id.to_string()),
                name: Some(name),
            };
            let value = parse_json_object(&raw_json);
            push_regex_scripts(
                &mut regex_scripts,
                &mut seen_regex,
                source.clone(),
                regex_scripts_from(&value),
            );
            push_tavern_helper_scripts(
                &mut tavern_helper_scripts,
                &mut seen_tavern_helper,
                source,
                tavern_helper_scripts_from(&value),
            );
        }
    }

    Ok(SessionRuntimeAssets {
        regex_scripts,
        tavern_helper_scripts,
    })
}

pub async fn get_session_runtime_assets(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> Result<Json<SessionRuntimeAssets>, AppError> {
    Ok(Json(
        load_session_runtime_assets(&state, &session_id).await?,
    ))
}
