-- Initial database schema for Chorus feedback system

-- Core feedback table
CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  content TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_name TEXT,
  author_email TEXT,
  timestamp INTEGER NOT NULL,
  category TEXT,
  sentiment TEXT,
  priority TEXT,
  summary TEXT,
  metadata TEXT, -- JSON
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX idx_feedback_timestamp ON feedback(timestamp DESC);
CREATE INDEX idx_feedback_source ON feedback(source);
CREATE INDEX idx_feedback_category ON feedback(category);
CREATE INDEX idx_feedback_sentiment ON feedback(sentiment);

-- Theme associations (many-to-many)
CREATE TABLE themes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feedback_id TEXT NOT NULL,
  theme TEXT NOT NULL,
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY(feedback_id) REFERENCES feedback(id) ON DELETE CASCADE
);

CREATE INDEX idx_themes_feedback ON themes(feedback_id);
CREATE INDEX idx_themes_theme ON themes(theme);

-- Analysis reports
CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  timestamp INTEGER NOT NULL,
  overall_score REAL,
  feedback_count INTEGER,
  report_data TEXT NOT NULL, -- JSON
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX idx_reports_timestamp ON reports(timestamp DESC);

-- Embeddings metadata (vectors stored in Vectorize)
CREATE TABLE embeddings (
  feedback_id TEXT PRIMARY KEY,
  vector_id TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT 'text-embedding-3-small',
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY(feedback_id) REFERENCES feedback(id) ON DELETE CASCADE
);

-- Analysis sessions (for Durable Object tracking)
CREATE TABLE analysis_sessions (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL, -- pending, running, completed, failed
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  feedback_count INTEGER,
  report_id TEXT,
  error TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY(report_id) REFERENCES reports(id)
);

CREATE INDEX idx_sessions_status ON analysis_sessions(status);
CREATE INDEX idx_sessions_started ON analysis_sessions(started_at DESC);
