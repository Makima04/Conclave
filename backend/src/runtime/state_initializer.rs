use crate::error::AppError;
use crate::runtime::card_state_adapter;
use sqlx::SqlitePool;

/// Initialize a session's runtime state from a linked character card/world book.
///
/// SillyTavern + MVU cards commonly store the initial state in a disabled world
/// book entry whose comment is "[InitVar]". The platform treats that as raw card
/// state, converts it into canonical `platform_state`, then projects it back into
/// `variables` for card HTML/JS runtimes.
pub async fn initialize_session_state_from_world_book(
    pool: &SqlitePool,
    session_id: &str,
) -> Result<bool, AppError> {
    let Some(world_pack_id): Option<String> = sqlx::query_scalar(
        "SELECT world_pack_id FROM sessions WHERE id = ? AND deleted_at IS NULL",
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await?
    else {
        return Ok(false);
    };

    let Some(init_content): Option<String> = sqlx::query_scalar(
        "SELECT content FROM world_book_entries WHERE world_book_id = ? AND LOWER(TRIM(comment)) LIKE '%initvar%' ORDER BY created_at ASC LIMIT 1",
    )
    .bind(&world_pack_id)
    .fetch_optional(pool)
    .await?
    else {
        return Ok(false);
    };

    let Some(initial_variables) = parse_init_variables(&init_content) else {
        tracing::warn!(
            session = session_id,
            world_pack_id = %world_pack_id,
            "Found InitVar entry but could not parse it as JSON"
        );
        return Ok(false);
    };

    let mut current_state = latest_state(pool, session_id).await?;
    if has_initialized_state(&current_state) {
        return Ok(false);
    }

    let Some(contract) =
        card_state_adapter::load_session_contract(pool, session_id, Some(&initial_variables))
            .await?
    else {
        ensure_object(&mut current_state);
        if let Some(obj) = current_state.as_object_mut() {
            obj.insert("variables".to_string(), initial_variables);
        }
        commit_initialized_state(pool, session_id, &current_state).await?;
        return Ok(true);
    };

    let next_state = card_state_adapter::build_normalized_state(
        &current_state,
        &contract,
        Some(initial_variables),
    );

    commit_initialized_state(pool, session_id, &next_state).await?;
    tracing::info!(
        session = session_id,
        world_pack_id = %world_pack_id,
        source = %contract.source,
        "Initialized session state through card state adapter"
    );

    Ok(true)
}

pub fn parse_init_variables(content: &str) -> Option<serde_json::Value> {
    let value: serde_json::Value = serde_json::from_str(content.trim()).ok()?;
    match value {
        serde_json::Value::Object(mut map) => {
            if let Some(variables) = map.remove("variables") {
                Some(variables)
            } else {
                Some(serde_json::Value::Object(map))
            }
        }
        _ => None,
    }
}

fn has_initialized_state(state: &serde_json::Value) -> bool {
    state
        .get("platform_state")
        .and_then(|v| v.as_object())
        .map(|obj| !obj.is_empty())
        .unwrap_or(false)
        || state
            .get("variables")
            .and_then(|v| v.as_object())
            .map(|obj| !obj.is_empty())
            .unwrap_or(false)
}

fn ensure_object(value: &mut serde_json::Value) {
    if !value.is_object() {
        *value = serde_json::json!({});
    }
}

async fn latest_state(pool: &SqlitePool, session_id: &str) -> Result<serde_json::Value, AppError> {
    let state: Option<String> = sqlx::query_scalar(
        "SELECT state_json FROM state_snapshots WHERE session_id = ? ORDER BY version DESC LIMIT 1",
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await?;

    Ok(state
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({})))
}

async fn commit_initialized_state(
    pool: &SqlitePool,
    session_id: &str,
    state: &serde_json::Value,
) -> Result<(), AppError> {
    let max_version: Option<i32> =
        sqlx::query_scalar("SELECT MAX(version) FROM state_snapshots WHERE session_id = ?")
            .bind(session_id)
            .fetch_one(pool)
            .await?;

    let now = chrono::Utc::now().to_rfc3339();
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO state_snapshots (id, session_id, version, state_json, risk_level, committed_by, created_at) VALUES (?, ?, ?, ?, 'low', 'runtime', ?)"
    )
    .bind(&id)
    .bind(session_id)
    .bind(max_version.unwrap_or(0) + 1)
    .bind(state.to_string())
    .bind(&now)
    .execute(pool)
    .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_initvar_json_as_variables() {
        let parsed = parse_init_variables(r#"{"世界":{"当前日期":["2025年/03月/24日","说明"]}}"#)
            .expect("init vars");

        assert_eq!(
            parsed["世界"]["当前日期"][0],
            serde_json::json!("2025年/03月/24日")
        );
    }

    #[test]
    fn unwraps_variables_container_when_present() {
        let parsed = parse_init_variables(r#"{"variables":{"hp":10}}"#).expect("init vars");

        assert_eq!(parsed["hp"], serde_json::json!(10));
    }
}
