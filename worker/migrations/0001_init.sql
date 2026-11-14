PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS weekly_schedule (
  weekday INTEGER PRIMARY KEY CHECK (weekday BETWEEN 0 AND 6),
  windows_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS date_overrides (
  local_date TEXT PRIMARY KEY,
  windows_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  price_byn INTEGER NOT NULL CHECK (price_byn >= 0),
  duration_minutes INTEGER NOT NULL DEFAULT 0 CHECK (duration_minutes >= 0),
  requires_duration INTEGER NOT NULL DEFAULT 0 CHECK (requires_duration IN (0, 1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  local_date TEXT NOT NULL,
  start_minute INTEGER NOT NULL,
  end_minute INTEGER NOT NULL,
  duration_minutes INTEGER NOT NULL,
  services_json TEXT NOT NULL,
  total_price_byn INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(local_date, start_minute);

CREATE TABLE IF NOT EXISTS appointment_slots (
  local_date TEXT NOT NULL,
  start_minute INTEGER NOT NULL,
  appointment_id TEXT NOT NULL,
  PRIMARY KEY (local_date, start_minute),
  FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS admin_state (
  admin_id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_outbox (
  id TEXT PRIMARY KEY,
  appointment_id TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  deliver_after INTEGER NOT NULL DEFAULT 0,
  delivered_at TEXT,
  FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS rate_limits (
  rate_key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL
);

INSERT OR IGNORE INTO weekly_schedule (weekday, windows_json) VALUES
  (0, '[]'), (1, '[]'), (2, '[]'), (3, '[]'),
  (4, '[]'), (5, '[]'), (6, '[]');

INSERT OR IGNORE INTO services (id, label, price_byn, duration_minutes, requires_duration, active, sort_order) VALUES
  ('haircut', 'Стрижка', 100, 75, 0, 1, 10),
  ('bangs', 'Чёлка', 25, 20, 0, 1, 20),
  ('wash-style', 'Мытьё головы с уходом и укладкой', 75, 0, 1, 1, 30),
  ('scalp-peel', 'Пилинг кожи головы', 15, 15, 0, 1, 40),
  ('care-consult', 'Консультация по домашнему уходу', 90, 0, 1, 1, 50),
  ('milk-shake', 'Уход Milk Shake', 120, 90, 0, 1, 60),
  ('maraes-color-care', 'Уход Maraes Color Care', 120, 90, 0, 1, 70),
  ('anti-hair-loss', 'Уход Anti Hair Loss', 120, 90, 0, 1, 80),
  ('last-hope', 'Уход «Последняя надежда»', 300, 120, 0, 1, 90),
  ('premium-max', 'Уход Premium Max', 320, 120, 0, 1, 100),
  ('package-last-hope', 'Стрижка + «Последняя надежда»', 320, 150, 0, 1, 110),
  ('package-care-peel', 'Стрижка + уход + пилинг', 180, 120, 0, 1, 120),
  ('package-premium', 'Стрижка + Premium Max', 360, 150, 0, 1, 130),
  ('hairstyle-basic', 'Прическа basic', 120, 60, 0, 1, 140),
  ('hairstyle-kids', 'Детская прическа', 60, 60, 0, 1, 150),
  ('early-departure', 'Ранний выезд', 50, 0, 0, 1, 160),
  ('outcall', 'Выезд на локацию', 70, 0, 0, 1, 170),
  ('early-outcall', 'Ранний выезд + локация', 100, 0, 0, 1, 180),
  ('homecare-selection', 'Подбор домашнего ухода', 100, 0, 1, 1, 190);
