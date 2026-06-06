-- Add status column to sessions for tracking processing state
ALTER TABLE sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'idle';
