use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::str::FromStr;

pub async fn create_pool(database_url: &str) -> Result<SqlitePool, sqlx::Error> {
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

    Ok(pool)
}

pub async fn run_migrations(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    sqlx::raw_sql(include_str!("../migrations/001_initial.sql"))
        .execute(pool)
        .await?;

    // Add variants columns if they don't exist (ALTER TABLE ADD COLUMN IF NOT EXISTS
    // requires SQLite 3.35+, so we check manually)
    let has_variants: bool = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM pragma_table_info('messages') WHERE name = 'variants'"
    )
    .fetch_one(pool)
    .await? > 0;

    if !has_variants {
        sqlx::raw_sql("ALTER TABLE messages ADD COLUMN variants TEXT NOT NULL DEFAULT '[]'")
            .execute(pool)
            .await?;
        sqlx::raw_sql("ALTER TABLE messages ADD COLUMN variant_index INTEGER NOT NULL DEFAULT -1")
            .execute(pool)
            .await?;
    }

    // Add title_source column if missing
    let has_title_source: bool = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name = 'title_source'"
    )
    .fetch_one(pool)
    .await? > 0;

    if !has_title_source {
        sqlx::raw_sql("ALTER TABLE sessions ADD COLUMN title_source TEXT NOT NULL DEFAULT 'auto'")
            .execute(pool)
            .await?;
    }

    // Run proposals migration
    sqlx::raw_sql(include_str!("../migrations/003_proposals.sql"))
        .execute(pool)
        .await?;

    Ok(())
}
