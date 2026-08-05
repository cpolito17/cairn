CREATE TABLE planner_events (
  id TEXT PRIMARY KEY,
  context TEXT NOT NULL CHECK (context IN ('personal', 'work')),
  name TEXT NOT NULL,
  weekdays TEXT NOT NULL,
  frequency_weeks INTEGER NOT NULL CHECK (frequency_weeks IN (1, 2, 4)),
  starts_on TEXT NOT NULL,
  start_minutes INTEGER NOT NULL CHECK (start_minutes >= 0 AND start_minutes < 1440),
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes >= 15 AND duration_minutes <= 720),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX planner_events_context ON planner_events(context, start_minutes, id);
