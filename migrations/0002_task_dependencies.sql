-- Task dependencies: "this task is waiting on that one".
--
-- One nullable self-reference rather than a join table. A task waits on at most
-- one other, which is what the composer offers — a single dropdown — and a
-- second table would buy a many-to-many the UI cannot express.
--
-- ON DELETE SET NULL, deliberately: deleting a prerequisite must not delete the
-- work that was waiting on it. The dependent survives and becomes unblocked,
-- which is the same end state as completing the prerequisite.
--
-- SQLite allows a REFERENCES clause on an added column only when its default is
-- NULL. It is.
ALTER TABLE tasks ADD COLUMN depends_on TEXT REFERENCES tasks(id) ON DELETE SET NULL;

CREATE INDEX idx_tasks_depends_on ON tasks(depends_on);
