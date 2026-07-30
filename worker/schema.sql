DROP TABLE IF EXISTS videos;
DROP TABLE IF EXISTS cuts;

CREATE TABLE IF NOT EXISTS cuts (
    job_id TEXT PRIMARY KEY,
    youtube_id TEXT NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    title TEXT,
    status TEXT NOT NULL,
    error_msg TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
