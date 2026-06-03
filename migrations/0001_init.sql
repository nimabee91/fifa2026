-- Helix World Cup 2026 pool — schema

-- Employees who join the pool. Identified by email (no password).
CREATE TABLE IF NOT EXISTS players (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  email      TEXT UNIQUE NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- The 48 World Cup teams.
CREATE TABLE IF NOT EXISTS teams (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL,
  flag             TEXT DEFAULT '',          -- emoji
  grp              TEXT DEFAULT '',          -- group letter A-L
  status           TEXT NOT NULL DEFAULT 'alive',  -- 'alive' | 'eliminated'
  eliminated_round TEXT,                     -- 'group' | 'r32' | 'r16' | 'qf' | 'sf' | 'final'
  is_champion      INTEGER NOT NULL DEFAULT 0
);

-- Each stake a player holds. A player can have several over time
-- (initial $5, then $10 / $15 buy-backs) but only one active at a time.
CREATE TABLE IF NOT EXISTS entries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id     INTEGER NOT NULL,
  team_id       INTEGER NOT NULL,
  round_entered TEXT NOT NULL,        -- 'signup' | 'r32' | 'r16'
  amount        INTEGER NOT NULL,     -- dollars: 5, 10, 15
  paid          INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,  -- 1 = current stake (team still alive)
  created_at    TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE,
  FOREIGN KEY (team_id) REFERENCES teams(id)
);

CREATE INDEX IF NOT EXISTS idx_entries_player ON entries(player_id);
CREATE INDEX IF NOT EXISTS idx_entries_team ON entries(team_id);
CREATE INDEX IF NOT EXISTS idx_entries_active ON entries(active);

-- Single-row-per-key settings (tournament phase, etc.)
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Phases: signup -> group_stage -> r32_buyback -> r16_buyback -> closed -> finished
INSERT OR IGNORE INTO config (key, value) VALUES ('phase', 'signup');
