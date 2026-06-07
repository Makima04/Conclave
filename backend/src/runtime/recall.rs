use crate::error::AppError;
use crate::runtime::types::AgentConfig;
use sqlx::SqlitePool;

/// Structured event as returned from the database
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct RecalledEvent {
    pub id: String,
    pub turn_number: i32,
    pub characters: String,
    pub scene_type: String,
    pub importance: i32,
    pub raw_text: String,
}

/// Result of a recall operation
#[derive(Debug, Clone)]
pub struct RecalledContext {
    pub events: Vec<RecalledEvent>,
}

/// Main recall entry point
pub async fn recall_context(
    pool: &SqlitePool,
    session_id: &str,
    user_input: &str,
    agent_config: &AgentConfig,
    current_turn: i32,
) -> Result<RecalledContext, AppError> {
    let max_events = agent_config.max_recall_events.unwrap_or(10);
    let mode = agent_config.recall_mode.as_deref().unwrap_or("keyword");

    match mode {
        "embedding" => {
            recall_by_embedding(pool, session_id, user_input, max_events, current_turn).await
        }
        _ => recall_by_keyword(pool, session_id, user_input, max_events, current_turn).await,
    }
}

/// Extract keywords from user input for recall matching.
fn extract_keywords(user_input: &str) -> Vec<String> {
    user_input
        .split(|c: char| {
            c.is_whitespace()
                || c == ','
                || c == '，'
                || c == '。'
                || c == '！'
                || c == '？'
                || c == '、'
                || c == '；'
                || c == '：'
                || c == '"'
                || c == '"'
                || c == '（'
                || c == '）'
        })
        .filter(|w| w.len() >= 2)
        .map(|w| w.to_string())
        .collect()
}

/// Keyword-based recall: LIKE search on structured_events + recent fallback
async fn recall_by_keyword(
    pool: &SqlitePool,
    session_id: &str,
    user_input: &str,
    max_events: usize,
    _current_turn: i32,
) -> Result<RecalledContext, AppError> {
    let keywords = extract_keywords(user_input);

    // Keyword matches
    let mut keyword_events: Vec<RecalledEvent> = Vec::new();

    if !keywords.is_empty() {
        let like_clauses: Vec<String> = keywords
            .iter()
            .map(|_| {
                "(raw_text LIKE ? OR characters LIKE ? OR location LIKE ? OR action LIKE ?)"
                    .to_string()
            })
            .collect();

        let sql = format!(
            "SELECT id, session_id, turn_number, characters, location, action, scene_type, importance, raw_text \
             FROM structured_events WHERE session_id = ? AND ({}) \
             ORDER BY importance DESC, turn_number DESC LIMIT ?",
            like_clauses.join(" OR ")
        );

        let mut query = sqlx::query_as::<_, RecalledEvent>(&sql).bind(session_id);
        let patterns: Vec<String> = keywords.iter().map(|kw| format!("%{}%", kw)).collect();
        for pattern in &patterns {
            query = query
                .bind(pattern)
                .bind(pattern)
                .bind(pattern)
                .bind(pattern);
        }
        query = query.bind(max_events as i32);

        keyword_events = query.fetch_all(pool).await.unwrap_or_default();
    }

    // Recent N events as fallback
    let recent_events: Vec<RecalledEvent> = sqlx::query_as::<_, RecalledEvent>(
        "SELECT id, session_id, turn_number, characters, location, action, scene_type, importance, raw_text \
         FROM structured_events WHERE session_id = ? \
         ORDER BY turn_number DESC LIMIT ?",
    )
    .bind(session_id)
    .bind(max_events as i32)
    .fetch_all(pool)
    .await
    .unwrap_or_default();

    // Merge: keyword matches first, then fill with recent, dedup by id
    let mut seen = std::collections::HashSet::new();
    let mut merged = Vec::new();
    for e in keyword_events.into_iter().chain(recent_events.into_iter()) {
        if seen.insert(e.id.clone()) {
            merged.push(e);
        }
    }

    // Sort by importance desc, then turn_number desc
    merged.sort_by(|a, b| {
        b.importance
            .cmp(&a.importance)
            .then(b.turn_number.cmp(&a.turn_number))
    });
    merged.truncate(max_events);

    tracing::debug!(
        session = session_id,
        keywords = keywords.len(),
        recalled = merged.len(),
        "Context recall completed (keyword mode)"
    );

    Ok(RecalledContext { events: merged })
}

/// Embedding-based recall (placeholder — falls back to keyword for now)
async fn recall_by_embedding(
    pool: &SqlitePool,
    session_id: &str,
    user_input: &str,
    max_events: usize,
    current_turn: i32,
) -> Result<RecalledContext, AppError> {
    tracing::debug!("Embedding recall not yet implemented, falling back to keyword");
    recall_by_keyword(pool, session_id, user_input, max_events, current_turn).await
}
