CREATE TABLE IF NOT EXISTS pedidos (
    uid TEXT PRIMARY KEY,
    youtube_url TEXT NOT NULL,
    status TEXT NOT NULL,
    r2_url TEXT,
    error_msg TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
