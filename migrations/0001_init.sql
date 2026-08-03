-- Cairn v1 schema.
-- All timestamps are epoch milliseconds stored as INTEGER.
-- Foreign keys require `PRAGMA foreign_keys = ON` per connection (worker/db.ts).

CREATE TABLE boards (
  id TEXT PRIMARY KEY,
  context TEXT NOT NULL CHECK (context IN ('personal','work')),
  name TEXT NOT NULL,
  description TEXT,
  position TEXT NOT NULL,
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_boards_context ON boards(context, archived_at, position);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  notes TEXT,
  due_date TEXT,           -- 'YYYY-MM-DD'
  due_time TEXT,           -- 'HH:MM' 24h; only meaningful when due_date is set
  duration TEXT,           -- '15m'|'30m'|'1h'|'2h'|'4h'|'half-day'
  difficulty INTEGER,      -- 1..5, or NULL for unset
  priority INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0,
  position TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_tasks_board ON tasks(board_id, completed_at, position);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE login_attempts (
  ip TEXT PRIMARY KEY,
  fails INTEGER NOT NULL,
  first_fail_at INTEGER NOT NULL,
  locked_until INTEGER
);
