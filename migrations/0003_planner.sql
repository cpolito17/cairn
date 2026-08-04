-- V2 Planner foundations. PROJECT-SPEC-V2.md §3.
--
-- This migration is destructive and one-way: it converts `duration` to an
-- integer count of minutes and then drops the column. Apply it to the remote
-- database before deploying the Worker, per docs/DEPLOY.md — a Worker that
-- selects `duration_minutes` against an unmigrated database fails every read.
--
-- The conversion runs before the drop, in the same migration, so there is no
-- window in which a column has been removed and its data has not been carried
-- across.

-- 1. Duration becomes minutes.
--
-- A 15-minute resize grid cannot be expressed in a six-value enum (§2), so the
-- string set is replaced by an integer that is a multiple of 15 in [15, 720].
ALTER TABLE tasks ADD COLUMN duration_minutes INTEGER;

-- `half-day` collapses onto 240 alongside `4h`, deliberately: the two were
-- never distinguishable in use, and a preset list with a redundant entry is a
-- list people stop reading (§2). A NULL duration stays NULL — "the user has not
-- committed a length" is a real state and it is not the same as 0.
--
-- The CASE has no ELSE, so an unrecognised value would land as NULL rather than
-- as a wrong number. There should be none — the column was only ever written
-- through the validated boundary — and a NULL is the honest answer if there is.
UPDATE tasks SET duration_minutes = CASE duration
  WHEN '15m'      THEN 15
  WHEN '30m'      THEN 30
  WHEN '1h'       THEN 60
  WHEN '2h'       THEN 120
  WHEN '4h'       THEN 240
  WHEN 'half-day' THEN 240
END WHERE duration IS NOT NULL;

ALTER TABLE tasks DROP COLUMN duration;

-- 2. Scheduling.
--
-- Epoch milliseconds of the local wall-clock start of the task's block. No
-- timezone is stored: one user, one clock (§2). NULL means unscheduled, which
-- is most tasks, and the index is what keeps a day or week query off a full
-- scan once the table is mostly unscheduled rows.
ALTER TABLE tasks ADD COLUMN scheduled_at INTEGER;
CREATE INDEX idx_tasks_scheduled ON tasks(scheduled_at);

-- 3. Settings.
--
-- A key/value table holding one row — key 'settings', value a JSON document
-- (§3.2). A JSON blob rather than a column per value, deliberately: five values
-- read and written as a unit by one user, and a column per future planner
-- preference is a migration each.
--
-- No row is inserted here. An absent row is a valid state that the Worker
-- already has to handle — it means "defaults" — and seeding one would put a
-- second copy of the defaults in a place that cannot be kept in step with the
-- exported constant.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
