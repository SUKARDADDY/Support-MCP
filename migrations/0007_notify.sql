-- Notifications for the technician app (PR 8). One new table and one new column.
--
-- A notification is one row per person per event. The relay writes the rows when
-- the event happens, in the same batch as the change that caused it when there is
-- one (src/notify.js), and the app reads them from a feed that waits for new ones.
-- Rows are kept 30 days: the hourly run deletes older ones. They are not part of
-- the team log, which stays as it was.
--
-- id counts up, so a reader asks for "after" the last id it saw. recipient is a
-- member's identity (a person, never a service token). event is one of
-- task_finished, task_problem, session_declined, device_online, device_missing and
-- device_waiting. device_id, task_id and session_id say what it is about. title and
-- body are short plain text and may repeat text from a customer's PC, so a reader
-- shows them as text. dedupe names the occurrence ("task <id> ended"), so a retried
-- write or a second run of the hourly check adds nothing: it is unique per person.
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace TEXT NOT NULL,
  recipient TEXT NOT NULL,
  event TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  device_id TEXT,
  task_id TEXT,
  session_id TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  dedupe TEXT NOT NULL
);
CREATE UNIQUE INDEX notifications_dedupe ON notifications (workspace, recipient, dedupe);
-- The feed reads one person's rows after an id.
CREATE INDEX notifications_feed ON notifications (workspace, recipient, id);
-- The hourly run deletes by age.
CREATE INDEX notifications_by_age ON notifications (created_at);

-- A member's notification settings as JSON text, or NULL for the defaults (every
-- event on, no watched PCs):
--   {"events":{"<event>":true|false},"watch":["<device id>"]}
-- "watch" lists the PCs they want "came online" and "missing" for.
ALTER TABLE members ADD COLUMN notify TEXT;
