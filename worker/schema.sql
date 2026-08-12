-- One push subscription per device. deviceId is a random UUID generated and
-- persisted client-side (localStorage) — the closest thing to an account
-- identity this single-user app has.
CREATE TABLE IF NOT EXISTS subscriptions (
  device_id  TEXT PRIMARY KEY,
  endpoint   TEXT NOT NULL,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- One row per scheduled alarm (reminder or calendar event). The cron trigger
-- scans for fire_at <= now and pushes; repeating reminders get their row
-- updated in place with the next fire_at instead of a new row.
CREATE TABLE IF NOT EXISTS reminders (
  id         TEXT PRIMARY KEY,
  device_id  TEXT NOT NULL,
  title      TEXT NOT NULL,
  note       TEXT,
  fire_at    INTEGER NOT NULL,
  repeat     TEXT NOT NULL DEFAULT 'once', -- once | daily | weekdays | custom
  days       TEXT,                          -- JSON array of weekday numbers (0=Sun), only for repeat='custom'
  time       TEXT,                          -- local clock time 'HH:MM', so the server can recompute in the user's zone
  tz         TEXT,                          -- IANA zone from the phone, e.g. 'Europe/Sarajevo'
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reminders_fire ON reminders(fire_at);
CREATE INDEX IF NOT EXISTS idx_reminders_device ON reminders(device_id);
