use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use std::str::FromStr;

pub async fn create_pool(database_url: &str) -> Result<SqlitePool, sqlx::Error> {
    tracing::info!(url = database_url, "Creating database pool");

    let options = SqliteConnectOptions::from_str(database_url)?
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .create_if_missing(true);

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await?;

    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&pool)
        .await?;

    tracing::info!("Database pool created (WAL mode, max_connections=5)");
    Ok(pool)
}

pub async fn run_migrations(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    tracing::info!("Running database migrations");

    sqlx::raw_sql(include_str!("../migrations/001_initial.sql"))
        .execute(pool)
        .await?;
    tracing::debug!("Migration 001_initial.sql applied");

    // Add variants columns if they don't exist (ALTER TABLE ADD COLUMN IF NOT EXISTS
    // requires SQLite 3.35+, so we check manually)
    let has_variants: bool = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM pragma_table_info('messages') WHERE name = 'variants'",
    )
    .fetch_one(pool)
    .await?
        > 0;

    if !has_variants {
        tracing::debug!("Adding variants columns to messages table");
        sqlx::raw_sql("ALTER TABLE messages ADD COLUMN variants TEXT NOT NULL DEFAULT '[]'")
            .execute(pool)
            .await?;
        sqlx::raw_sql("ALTER TABLE messages ADD COLUMN variant_index INTEGER NOT NULL DEFAULT -1")
            .execute(pool)
            .await?;
    }

    // Add title_source column if missing
    let has_title_source: bool = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name = 'title_source'",
    )
    .fetch_one(pool)
    .await?
        > 0;

    if !has_title_source {
        tracing::debug!("Adding title_source column to sessions table");
        sqlx::raw_sql("ALTER TABLE sessions ADD COLUMN title_source TEXT NOT NULL DEFAULT 'auto'")
            .execute(pool)
            .await?;
    }

    // Run proposals migration
    sqlx::raw_sql(include_str!("../migrations/003_proposals.sql"))
        .execute(pool)
        .await?;
    tracing::debug!("Migration 003_proposals.sql applied");

    // Run sub_agents migration
    sqlx::raw_sql(include_str!("../migrations/004_sub_agents.sql"))
        .execute(pool)
        .await?;
    tracing::debug!("Migration 004_sub_agents.sql applied");

    // Run structured_events migration
    sqlx::raw_sql(include_str!("../migrations/005_structured_events.sql"))
        .execute(pool)
        .await?;
    tracing::debug!("Migration 005_structured_events.sql applied");

    // Run visibility migration (idempotent — check columns first)
    let has_visibility_events: bool = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM pragma_table_info('memory_events') WHERE name = 'visibility'",
    )
    .fetch_one(pool)
    .await?
        > 0;

    if !has_visibility_events {
        sqlx::raw_sql(
            "ALTER TABLE memory_events ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'",
        )
        .execute(pool)
        .await?;
        tracing::debug!("Added visibility column to memory_events");
    }

    let has_visibility_foreshadowing: bool = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM pragma_table_info('foreshadowing') WHERE name = 'visibility'",
    )
    .fetch_one(pool)
    .await?
        > 0;

    if !has_visibility_foreshadowing {
        sqlx::raw_sql(
            "ALTER TABLE foreshadowing ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'",
        )
        .execute(pool)
        .await?;
        tracing::debug!("Added visibility column to foreshadowing");
    }

    // Add session status column if missing
    let has_status: bool = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name = 'status'",
    )
    .fetch_one(pool)
    .await?
        > 0;

    if !has_status {
        sqlx::raw_sql("ALTER TABLE sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'idle'")
            .execute(pool)
            .await?;
        tracing::debug!("Added status column to sessions");
    }

    // Reset stale sessions from previous crash (any non-terminal state)
    let stale = sqlx::query("UPDATE sessions SET status = 'idle' WHERE status IN ('processing', 'compressing', 'failed_generation', 'failed_compression')")
        .execute(pool)
        .await?;
    if stale.rows_affected() > 0 {
        tracing::info!(
            count = stale.rows_affected(),
            "Reset stale sessions on startup"
        );
    }

    // Run world_books migration
    sqlx::raw_sql(include_str!("../migrations/008_world_books.sql"))
        .execute(pool)
        .await?;
    tracing::debug!("Migration 008_world_books.sql applied");

    // Run concurrency/reliability migration
    sqlx::raw_sql(include_str!(
        "../migrations/009_concurrency_reliability.sql"
    ))
    .execute(pool)
    .await?;
    tracing::debug!("Migration 009_concurrency_reliability.sql applied");

    // Run character_cards migration
    sqlx::raw_sql(include_str!("../migrations/010_character_cards.sql"))
        .execute(pool)
        .await?;
    tracing::debug!("Migration 010_character_cards.sql applied");

    // Run presets migration
    sqlx::raw_sql(include_str!("../migrations/011_presets.sql"))
        .execute(pool)
        .await?;
    tracing::debug!("Migration 011_presets.sql applied");

    sqlx::raw_sql(include_str!("../migrations/012_agent_knowledge.sql"))
        .execute(pool)
        .await?;
    tracing::debug!("Migration 012_agent_knowledge.sql applied");

    // Run card_import migration
    sqlx::raw_sql(include_str!("../migrations/013_card_import.sql"))
        .execute(pool)
        .await?;
    tracing::debug!("Migration 013_card_import.sql applied");

    // Run app settings migration
    sqlx::raw_sql(include_str!("../migrations/014_app_settings.sql"))
        .execute(pool)
        .await?;
    tracing::debug!("Migration 014_app_settings.sql applied");

    sqlx::raw_sql(include_str!("../migrations/015_agent_debug_snapshots.sql"))
        .execute(pool)
        .await?;
    tracing::debug!("Migration 015_agent_debug_snapshots.sql applied");

    sqlx::raw_sql(include_str!("../migrations/016_session_variables.sql"))
        .execute(pool)
        .await?;
    tracing::debug!("Migration 016_session_variables.sql applied");

    // Add cached_tokens column to agent debug snapshots if missing. (Conditional ALTER
    // because these migrations re-run on every boot — raw ADD COLUMN isn't idempotent.)
    let has_cached_tokens: bool = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM pragma_table_info('agent_call_debug_snapshots') WHERE name = 'cached_tokens'",
    )
    .fetch_one(pool)
    .await?
        > 0;
    if !has_cached_tokens {
        sqlx::raw_sql(
            "ALTER TABLE agent_call_debug_snapshots ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0",
        )
        .execute(pool)
        .await?;
        tracing::debug!("Added cached_tokens column to agent_call_debug_snapshots");
    }

    // Add world_books parse columns if missing
    let has_parse_status: bool = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM pragma_table_info('world_books') WHERE name = 'parse_status'",
    )
    .fetch_one(pool)
    .await?
        > 0;

    if !has_parse_status {
        sqlx::raw_sql(
            "ALTER TABLE world_books ADD COLUMN parse_status TEXT NOT NULL DEFAULT 'none'",
        )
        .execute(pool)
        .await?;
        sqlx::raw_sql(
            "ALTER TABLE world_books ADD COLUMN parsed_entries TEXT NOT NULL DEFAULT '[]'",
        )
        .execute(pool)
        .await?;
        tracing::debug!("Added parse_status and parsed_entries columns to world_books");
    }

    let has_single_agent_parse_status: bool = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM pragma_table_info('world_books') WHERE name = 'single_agent_parse_status'",
    )
    .fetch_one(pool)
    .await?
        > 0;

    if !has_single_agent_parse_status {
        sqlx::raw_sql(
            "ALTER TABLE world_books ADD COLUMN single_agent_parse_status TEXT NOT NULL DEFAULT 'none'",
        )
        .execute(pool)
        .await?;
        sqlx::raw_sql(
            "ALTER TABLE world_books ADD COLUMN single_agent_parsed_entries TEXT NOT NULL DEFAULT '[]'",
        )
        .execute(pool)
        .await?;
        tracing::debug!(
            "Added single_agent_parse_status and single_agent_parsed_entries columns to world_books"
        );
    }

    tracing::info!("All database migrations applied");
    Ok(())
}
