-- Many prerequisites per task.
--
-- `tasks.depends_on` held at most one link, which made every board's dependency
-- structure a forest and was the assumption the Blockers view was built on
-- (PROJECT-SPEC-V2.md §2, §7.1). A task can now wait on any number of others,
-- which makes it a directed acyclic graph — see the §14 addendum.
--
-- **This migration is one-way.** The column is dropped at the end. Reversing it
-- is impossible in general: a task with three prerequisites has no single value
-- to put back. Take a backup before applying it to the remote database, exactly
-- as `0003_planner.sql` requires:
--
--   npx wrangler d1 export cairn --remote --output cairn-pre-0007.sql

-- 1. The edges.
--
-- A row is one "task_id waits on depends_on". The composite primary key is what
-- makes adding the same prerequisite twice a no-op rather than a duplicate edge
-- the layout would then draw twice.
--
-- Both foreign keys cascade, and they mean different things:
--
--   * deleting the *dependent* removes the links it owned, which is ordinary
--     cleanup;
--   * deleting a *prerequisite* removes the links pointing at it, which
--     releases everything that was waiting on it. §6.4 requires exactly that —
--     "deleting a prerequisite releases its dependents rather than deleting
--     them" — and it is the same behaviour `ON DELETE SET NULL` gave the old
--     column, expressed for a set.
CREATE TABLE task_dependencies (
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, depends_on)
);

-- Dependents are looked up by prerequisite as often as the other way round —
-- "what does completing this release" is the question the Blockers view is for.
CREATE INDEX task_dependencies_depends_on ON task_dependencies(depends_on);

-- 2. Carry the existing links over.
--
-- `created_at` is the dependent's own, not the moment of this migration: the
-- link has existed since the task did, as far as anything that reads it is
-- concerned, and stamping them all with the deploy time would sort every
-- pre-existing prerequisite into one indistinguishable batch.
--
-- The self-link guard is defensive. The Worker has always refused one, but this
-- is the last moment a bad row could be carried into a schema whose whole point
-- is that the graph is acyclic.
INSERT INTO task_dependencies (task_id, depends_on, created_at)
SELECT id, depends_on, created_at
FROM tasks
WHERE depends_on IS NOT NULL
  AND depends_on <> id
  AND depends_on IN (SELECT id FROM tasks);

-- 3. Drop the column.
--
-- Left in place it would be a second, immediately-stale answer to the same
-- question, and the first bug it caused would be a dependency that appears on
-- one screen and not another.
--
-- The index goes first and it is not optional: SQLite refuses to drop a column
-- that an index still names, with `error in index idx_tasks_depends_on after
-- drop column`. Verified against a database built from 0001–0006.
DROP INDEX idx_tasks_depends_on;
ALTER TABLE tasks DROP COLUMN depends_on;
