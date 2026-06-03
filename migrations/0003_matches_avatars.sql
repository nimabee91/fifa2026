-- Profile picture (small data URL) per player.
ALTER TABLE players ADD COLUMN avatar TEXT;

-- Matches: group round-robin fixtures + knockout bracket slots.
CREATE TABLE IF NOT EXISTS matches (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  round          TEXT NOT NULL,            -- 'group' | 'r32' | 'r16' | 'qf' | 'sf' | 'final'
  slot           INTEGER NOT NULL DEFAULT 0,  -- position within the round (bracket order)
  grp            TEXT DEFAULT '',          -- group letter, for group matches
  home_team_id   INTEGER,
  away_team_id   INTEGER,
  home_score     INTEGER,
  away_score     INTEGER,
  winner_team_id INTEGER,
  played         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_matches_round ON matches(round, slot);

-- Group fixtures: every pairing within each group (6 per group = 72 total).
INSERT INTO matches (round, grp, home_team_id, away_team_id, slot)
SELECT 'group', a.grp, a.id, b.id, 0
FROM teams a
JOIN teams b ON a.grp = b.grp AND a.id < b.id
WHERE a.grp <> '';

-- Empty knockout slots — admin fills the R32 teams; later rounds auto-advance.
INSERT INTO matches (round, slot) VALUES
  ('r32', 0), ('r32', 1), ('r32', 2), ('r32', 3),
  ('r32', 4), ('r32', 5), ('r32', 6), ('r32', 7),
  ('r32', 8), ('r32', 9), ('r32', 10), ('r32', 11),
  ('r32', 12), ('r32', 13), ('r32', 14), ('r32', 15),
  ('r16', 0), ('r16', 1), ('r16', 2), ('r16', 3),
  ('r16', 4), ('r16', 5), ('r16', 6), ('r16', 7),
  ('qf', 0), ('qf', 1), ('qf', 2), ('qf', 3),
  ('sf', 0), ('sf', 1),
  ('final', 0);
