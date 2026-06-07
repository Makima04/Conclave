use crate::importer::types::*;
use chrono::Utc;
use sqlx::SqlitePool;
use uuid::Uuid;

/// Update an existing world book's imported character card, or create one if none exists.
///
/// When `world_book_id` is provided:
/// - Finds or creates a character_card for that world_book
/// - Updates the character_card's source_data with the new import
/// - Upserts (insert or replace) the import_report for that character_card
/// - Updates the world_book's source_data with the original card data
/// - Does NOT create a new world_book
/// Returns (character_card_id, world_book_id).
pub async fn update_imported_card(
    pool: &SqlitePool,
    world_book_id: &str,
    package: &ConclaveCardPackage,
    original_card: &ExternalCard,
    import_report: &ImportReport,
) -> Result<(String, String), ImportError> {
    let now = Utc::now().to_rfc3339();

    let package_json =
        serde_json::to_string(package).map_err(|e| ImportError::Internal(e.to_string()))?;
    let extensions_json =
        serde_json::to_string(&original_card.extensions).unwrap_or_else(|_| "{}".to_string());
    let tags_json =
        serde_json::to_string(&original_card.tags).unwrap_or_else(|_| "[]".to_string());
    let greetings_json = serde_json::to_string(&original_card.alternate_greetings)
        .unwrap_or_else(|_| "[]".to_string());
    let source_data_json =
        serde_json::to_string(original_card).map_err(|e| ImportError::Internal(e.to_string()))?;
    let report_json =
        serde_json::to_string(import_report).map_err(|e| ImportError::Internal(e.to_string()))?;

    // 1. Verify the world_book exists
    let _wb_exists: String = sqlx::query_scalar("SELECT id FROM world_books WHERE id = ?")
        .bind(world_book_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| ImportError::Internal(format!("Failed to query world_book: {}", e)))?
        .ok_or_else(|| ImportError::Internal(format!("World book {} not found", world_book_id)))?;

    // 2. Find existing character_card for this world_book, or create one
    let existing_card_id: Option<String> =
        sqlx::query_scalar("SELECT id FROM character_cards WHERE world_book_id = ?")
            .bind(world_book_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| ImportError::Internal(format!("Failed to query character_card: {}", e)))?;

    let card_id = if let Some(cid) = existing_card_id {
        // UPDATE existing character_card
        sqlx::query(
            "UPDATE character_cards SET
                name = ?, description = ?, personality = ?, scenario = ?, first_mes = ?,
                avatar = ?, creator = ?, character_version = ?, tags = ?,
                alternate_greetings = ?, system_prompt = ?, post_history_instructions = ?,
                creator_notes = ?, mes_example = ?, extensions = ?, spec = ?,
                source_data = ?, updated_at = ?
             WHERE id = ?",
        )
        .bind(&original_card.name)
        .bind(&original_card.description)
        .bind(&original_card.personality)
        .bind(&original_card.scenario)
        .bind(&original_card.first_mes)
        .bind(&original_card.avatar)
        .bind(&original_card.creator)
        .bind(&original_card.character_version)
        .bind(&tags_json)
        .bind(&greetings_json)
        .bind(&original_card.system_prompt)
        .bind(&original_card.post_history_instructions)
        .bind(&original_card.creator_notes)
        .bind(&original_card.mes_example)
        .bind(&extensions_json)
        .bind(&original_card.spec)
        .bind(&source_data_json)
        .bind(&now)
        .bind(&cid)
        .execute(pool)
        .await
        .map_err(|e| ImportError::Internal(format!("Failed to update character_card: {}", e)))?;
        cid
    } else {
        // INSERT new character_card for this world_book
        let new_card_id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO character_cards
                (id, world_book_id, name, description, personality, scenario, first_mes,
                 avatar, creator, character_version, tags, alternate_greetings,
                 system_prompt, post_history_instructions, creator_notes, mes_example,
                 extensions, spec, source_data, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&new_card_id)
        .bind(world_book_id)
        .bind(&original_card.name)
        .bind(&original_card.description)
        .bind(&original_card.personality)
        .bind(&original_card.scenario)
        .bind(&original_card.first_mes)
        .bind(&original_card.avatar)
        .bind(&original_card.creator)
        .bind(&original_card.character_version)
        .bind(&tags_json)
        .bind(&greetings_json)
        .bind(&original_card.system_prompt)
        .bind(&original_card.post_history_instructions)
        .bind(&original_card.creator_notes)
        .bind(&original_card.mes_example)
        .bind(&extensions_json)
        .bind(&original_card.spec)
        .bind(&source_data_json)
        .bind(&now)
        .bind(&now)
        .execute(pool)
        .await
        .map_err(|e| ImportError::Internal(format!("Failed to insert character_card: {}", e)))?;
        new_card_id
    };

    // 3. Upsert import_report: delete old one for this card (if any), then insert new
    sqlx::query("DELETE FROM import_reports WHERE character_card_id = ?")
        .bind(&card_id)
        .execute(pool)
        .await
        .map_err(|e| ImportError::Internal(format!("Failed to delete old import_report: {}", e)))?;

    sqlx::query(
        "INSERT INTO import_reports (id, character_card_id, status, source_format, source_hash, report_json, package_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(&card_id)
    .bind(import_report.status.to_string())
    .bind(&import_report.source)
    .bind(&import_report.source_hash)
    .bind(&report_json)
    .bind(&package_json)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await
    .map_err(|e| ImportError::Internal(format!("Failed to insert import_report: {}", e)))?;

    // 4. Update world_book's source_data with the original card data
    sqlx::query("UPDATE world_books SET source_data = ?, updated_at = ? WHERE id = ?")
        .bind(&source_data_json)
        .bind(&now)
        .bind(world_book_id)
        .execute(pool)
        .await
        .map_err(|e| ImportError::Internal(format!("Failed to update world_book: {}", e)))?;

    Ok((card_id, world_book_id.to_string()))
}

/// Save an imported character card package to the database.
///
/// Creates a world_book entry (required by character_cards FK constraint),
/// inserts the character_card with raw source_data, and writes the import_report.
/// Returns (character_card_id, world_book_id).
pub async fn save_imported_card(
    pool: &SqlitePool,
    package: &ConclaveCardPackage,
    original_card: &ExternalCard,
    import_report: &ImportReport,
) -> Result<(String, String), ImportError> {
    let card_id = Uuid::new_v4().to_string();
    let world_book_id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();

    let package_json =
        serde_json::to_string(package).map_err(|e| ImportError::Internal(e.to_string()))?;
    let extensions_json =
        serde_json::to_string(&original_card.extensions).unwrap_or_else(|_| "{}".to_string());
    let tags_json = serde_json::to_string(&original_card.tags).unwrap_or_else(|_| "[]".to_string());
    let greetings_json = serde_json::to_string(&original_card.alternate_greetings)
        .unwrap_or_else(|_| "[]".to_string());
    // Store the ORIGINAL raw card data in source_data (not the converted package)
    let source_data_json =
        serde_json::to_string(original_card).map_err(|e| ImportError::Internal(e.to_string()))?;
    let report_json =
        serde_json::to_string(import_report).map_err(|e| ImportError::Internal(e.to_string()))?;

    // 1. Create a world_book entry (required FK)
    sqlx::query(
        "INSERT INTO world_books (id, name, description, original_format, source_data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&world_book_id)
    .bind(&original_card.name)
    .bind(&original_card.description)
    .bind(original_card.source_format.to_string())
    .bind(&source_data_json)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await
    .map_err(|e| ImportError::Internal(format!("Failed to create world_book: {}", e)))?;

    // 2. Insert character_card (source_data = raw original card)
    sqlx::query(
        "INSERT INTO character_cards
            (id, world_book_id, name, description, personality, scenario, first_mes,
             avatar, creator, character_version, tags, alternate_greetings,
             system_prompt, post_history_instructions, creator_notes, mes_example,
             extensions, spec, source_data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&card_id)
    .bind(&world_book_id)
    .bind(&original_card.name)
    .bind(&original_card.description)
    .bind(&original_card.personality)
    .bind(&original_card.scenario)
    .bind(&original_card.first_mes)
    .bind(&original_card.avatar)
    .bind(&original_card.creator)
    .bind(&original_card.character_version)
    .bind(&tags_json)
    .bind(&greetings_json)
    .bind(&original_card.system_prompt)
    .bind(&original_card.post_history_instructions)
    .bind(&original_card.creator_notes)
    .bind(&original_card.mes_example)
    .bind(&extensions_json)
    .bind(&original_card.spec)
    .bind(&source_data_json)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await
    .map_err(|e| ImportError::Internal(format!("Failed to insert character_card: {}", e)))?;

    // 3. Insert import_report
    sqlx::query(
        "INSERT INTO import_reports (id, character_card_id, status, source_format, source_hash, report_json, package_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(&card_id)
    .bind(import_report.status.to_string())
    .bind(&import_report.source)
    .bind(&import_report.source_hash)
    .bind(&report_json)
    .bind(&package_json)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await
    .map_err(|e| ImportError::Internal(format!("Failed to insert import_report: {}", e)))?;

    Ok((card_id, world_book_id))
}

/// Save a failure sample for debugging/training purposes.
/// Returns the sample_id.
pub async fn save_failure_sample(
    pool: &SqlitePool,
    _import_id: &str,
    original_card: &ExternalCard,
    metadata: &serde_json::Value,
) -> Result<String, ImportError> {
    let sample_id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let report_json =
        serde_json::to_string(metadata).map_err(|e| ImportError::Internal(e.to_string()))?;

    sqlx::query(
        "INSERT INTO import_failure_samples (id, source_hash, filename, report_json, user_notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&sample_id)
    .bind(&original_card.source_hash)
    .bind(&original_card.source_hash) // use source_hash as filename identifier
    .bind(&report_json)
    .bind(
        metadata
            .get("user_notes")
            .and_then(|v| v.as_str())
            .unwrap_or(""),
    )
    .bind(&now)
    .execute(pool)
    .await
    .map_err(|e| ImportError::Internal(format!("Failed to insert failure sample: {}", e)))?;

    Ok(sample_id)
}

/// Implement Display for ImportStatus to use in DB storage.
impl std::fmt::Display for ImportStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ImportStatus::Success => write!(f, "success"),
            ImportStatus::Warning => write!(f, "warning"),
            ImportStatus::Fallback => write!(f, "fallback"),
            ImportStatus::Blocked => write!(f, "blocked"),
        }
    }
}
