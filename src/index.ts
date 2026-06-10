/// <reference types="@cloudflare/workers-types" />

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_PASSWORD: string;
}

// Tournament phases, in order.
const PHASES = ["signup", "group_stage", "r32_buyback", "r16_buyback", "closed", "finished"] as const;
type Phase = (typeof PHASES)[number];

// Buy-back cost per window.
const BUYBACK_AMOUNT: Record<string, number> = { r32_buyback: 10, r16_buyback: 15 };

// Rounds a team can be eliminated in.
const ROUNDS = ["group", "r32", "r16", "qf", "sf", "final"];

// Knockout bracket order + how a winner advances to the next round.
const KO_ROUNDS = ["r32", "r16", "qf", "sf", "final"];
const NEXT_ROUND: Record<string, string> = { r32: "r16", r16: "qf", qf: "sf", sf: "final" };

const SIGNUP_AMOUNT = 5;
const MAX_AVATAR_CHARS = 300_000; // ~220 KB image as a data URL

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
function err(message: string, status = 400): Response {
  return json({ error: message }, status);
}

async function getPhase(env: Env): Promise<Phase> {
  const row = await env.DB.prepare("SELECT value FROM config WHERE key = 'phase'").first<{ value: string }>();
  return (row?.value as Phase) ?? "signup";
}

function isAdmin(request: Request, env: Env): boolean {
  const supplied = request.headers.get("x-admin-password") ?? "";
  return !!env.ADMIN_PASSWORD && supplied === env.ADMIN_PASSWORD;
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url.pathname);
      } catch (e) {
        return err((e as Error).message || "Server error", 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};

async function handleApi(request: Request, env: Env, path: string): Promise<Response> {
  const method = request.method;

  // ---- Public ----
  if (path === "/api/state" && method === "GET") return getState(env);
  if (path === "/api/join" && method === "POST") return join(request, env);
  if (path === "/api/buyback" && method === "POST") return buyback(request, env);
  if (path === "/api/avatar" && method === "POST") return setAvatar(request, env);

  // ---- Admin ----
  if (path.startsWith("/api/admin/")) {
    if (!isAdmin(request, env)) return err("Unauthorized", 401);

    if (path === "/api/admin/check" && method === "POST") return json({ ok: true });
    if (path === "/api/admin/phase" && method === "POST") return setPhase(request, env);
    if (path === "/api/admin/eliminate" && method === "POST") return eliminate(request, env);
    if (path === "/api/admin/revive" && method === "POST") return revive(request, env);
    if (path === "/api/admin/paid" && method === "POST") return setPaid(request, env);
    if (path === "/api/admin/player/delete" && method === "POST") return deletePlayer(request, env);
    if (path === "/api/admin/entry/delete" && method === "POST") return deleteEntry(request, env);
    if (path === "/api/admin/champion" && method === "POST") return setChampion(request, env);
    if (path === "/api/admin/team" && method === "POST") return upsertTeam(request, env);
    if (path === "/api/admin/team/delete" && method === "POST") return deleteTeam(request, env);
    if (path === "/api/admin/match/teams" && method === "POST") return setMatchTeams(request, env);
    if (path === "/api/admin/match/score" && method === "POST") return setMatchScore(request, env);
    if (path === "/api/admin/reset" && method === "POST") return resetPool(request, env);
  }

  return err("Not found", 404);
}

// ---------------------------------------------------------------------------
// State: everything the UI needs in one call.
// ---------------------------------------------------------------------------
async function getState(env: Env): Promise<Response> {
  const phase = await getPhase(env);

  const teams = (
    await env.DB.prepare(
      "SELECT id, name, flag, grp, status, eliminated_round, is_champion FROM teams ORDER BY grp, name"
    ).all()
  ).results as any[];
  const teamById = new Map<number, any>(teams.map((t) => [t.id, t]));

  const entries = (
    await env.DB.prepare(
      `SELECT e.id AS entry_id, e.player_id, e.team_id, e.round_entered, e.amount, e.paid, e.active,
              e.created_at, p.name AS player_name, p.email, p.avatar,
              t.name AS team_name, t.flag, t.status AS team_status, t.is_champion
       FROM entries e
       JOIN players p ON p.id = e.player_id
       JOIN teams t ON t.id = e.team_id
       ORDER BY e.created_at ASC`
    ).all()
  ).results as any[];

  // Group entries by player.
  const playersById = new Map<number, any>();
  // team_id -> [{ name, avatar }] of players actively riding that team.
  const holders = new Map<number, any[]>();
  for (const e of entries) {
    let p = playersById.get(e.player_id);
    if (!p) {
      p = {
        id: e.player_id, name: e.player_name, email: e.email, avatar: e.avatar || null,
        total_paid: 0, total_owed: 0, history: [], current: null, status: "out",
      };
      playersById.set(e.player_id, p);
    }
    if (e.paid) p.total_paid += e.amount;
    else p.total_owed += e.amount;
    p.history.push({
      entry_id: e.entry_id, team_id: e.team_id, team_name: e.team_name, flag: e.flag,
      round_entered: e.round_entered, amount: e.amount, paid: !!e.paid, active: !!e.active,
    });
    if (e.active) {
      p.current = {
        entry_id: e.entry_id, team_id: e.team_id, team_name: e.team_name, flag: e.flag,
        round_entered: e.round_entered, amount: e.amount, paid: !!e.paid,
        team_status: e.team_status, is_champion: !!e.is_champion,
      };
      p.status = "in";
      const arr = holders.get(e.team_id) || [];
      arr.push({ name: e.player_name, avatar: e.avatar || null });
      holders.set(e.team_id, arr);
    }
  }
  const players = [...playersById.values()].sort((a, b) => a.name.localeCompare(b.name));

  // Pot.
  let potTotal = 0, potPaid = 0;
  for (const e of entries) { potTotal += e.amount; if (e.paid) potPaid += e.amount; }

  const heldTeamIds = new Set(entries.filter((e) => e.active).map((e) => e.team_id));
  const availableTeams = teams.filter((t) => t.status === "alive" && !heldTeamIds.has(t.id));

  // ---- Matches: group tables + knockout bracket ----
  const matches = (
    await env.DB.prepare("SELECT * FROM matches ORDER BY round, slot").all()
  ).results as any[];

  const teamHolders = (id: number | null) => (id ? holders.get(id) || [] : []);
  const teamRef = (id: number | null) => {
    if (!id) return null;
    const t = teamById.get(id);
    if (!t) return null;
    return { id: t.id, name: t.name, flag: t.flag, status: t.status, is_champion: !!t.is_champion, holders: teamHolders(id) };
  };

  // Group standings, computed from played group matches.
  const groupTables: Record<string, any[]> = {};
  const byGroup: Record<string, any[]> = {};
  for (const t of teams) if (t.grp) (byGroup[t.grp] ||= []).push(t);
  for (const g of Object.keys(byGroup)) {
    const stat = new Map<number, any>();
    for (const t of byGroup[g]) stat.set(t.id, { id: t.id, name: t.name, flag: t.flag, status: t.status, holders: teamHolders(t.id), P: 0, W: 0, D: 0, L: 0, GF: 0, GA: 0, Pts: 0 });
    for (const m of matches) {
      if (m.round !== "group" || m.grp !== g || !m.played) continue;
      const h = stat.get(m.home_team_id), a = stat.get(m.away_team_id);
      if (!h || !a) continue;
      h.P++; a.P++; h.GF += m.home_score; h.GA += m.away_score; a.GF += m.away_score; a.GA += m.home_score;
      if (m.home_score > m.away_score) { h.W++; a.L++; h.Pts += 3; }
      else if (m.home_score < m.away_score) { a.W++; h.L++; a.Pts += 3; }
      else { h.D++; a.D++; h.Pts++; a.Pts++; }
    }
    const rows = [...stat.values()].map((s) => ({ ...s, GD: s.GF - s.GA }));
    rows.sort((x, y) => y.Pts - x.Pts || y.GD - x.GD || y.GF - x.GF || x.name.localeCompare(y.name));
    groupTables[g] = rows;
  }

  // Group fixtures (for showing scores under each group).
  const groupFixtures: Record<string, any[]> = {};
  for (const m of matches) {
    if (m.round !== "group") continue;
    (groupFixtures[m.grp] ||= []).push({
      id: m.id, home: teamRef(m.home_team_id), away: teamRef(m.away_team_id),
      home_score: m.home_score, away_score: m.away_score, played: !!m.played,
    });
  }

  // Knockout bracket, grouped by round.
  const bracket: Record<string, any[]> = {};
  for (const r of KO_ROUNDS) bracket[r] = [];
  for (const m of matches) {
    if (!KO_ROUNDS.includes(m.round)) continue;
    bracket[m.round].push({
      id: m.id, round: m.round, slot: m.slot,
      home: teamRef(m.home_team_id), away: teamRef(m.away_team_id),
      home_score: m.home_score, away_score: m.away_score,
      winner_team_id: m.winner_team_id, played: !!m.played,
    });
  }
  for (const r of KO_ROUNDS) bracket[r].sort((a, b) => a.slot - b.slot);

  // Winners.
  const champion = teams.find((t) => t.is_champion) ?? null;
  const ROUND_DEPTH: Record<string, number> = { final: 6, sf: 5, qf: 4, r16: 3, r32: 2, group: 1 };
  const teamDepth = (t: any): number => {
    if (!t) return 0;
    if (t.is_champion) return 100;
    if (t.status === "alive") return 50;
    return ROUND_DEPTH[t.eliminated_round] ?? 0;
  };
  let winners: any[] = [];
  let winBy: "champion" | "farthest" | null = null;
  if (phase === "finished") {
    const ranked = players.map((p) => {
      const last = p.history[p.history.length - 1];
      const t = last ? teamById.get(last.team_id) : null;
      return { p, t, depth: teamDepth(t) };
    });
    const best = ranked.reduce((m, r) => Math.max(m, r.depth), -1);
    if (best > 0) {
      const top = ranked.filter((r) => r.depth === best);
      winners = top.map((r) => ({ name: r.p.name, email: r.p.email, team_name: r.t?.name, flag: r.t?.flag }));
      winBy = best === 100 ? "champion" : "farthest";
    }
  }

  return json({
    phase, phases: PHASES, rounds: ROUNDS, koRounds: KO_ROUNDS,
    signupAmount: SIGNUP_AMOUNT, buybackAmount: BUYBACK_AMOUNT[phase] ?? null,
    teams, players, availableTeams,
    pot: { total: potTotal, paid: potPaid, pending: potTotal - potPaid },
    groupTables, groupFixtures, bracket,
    champion, winners, winBy,
  });
}

// ---------------------------------------------------------------------------
// Player: join, buy back, avatar
// ---------------------------------------------------------------------------
async function join(request: Request, env: Env): Promise<Response> {
  const phase = await getPhase(env);
  if (phase !== "signup") return err("Sign-ups are closed — the tournament has started.");
  const body = (await request.json().catch(() => ({}))) as any;
  const name = String(body.name ?? "").trim();
  const email = String(body.email ?? "").trim().toLowerCase();
  const teamId = Number(body.teamId);
  if (!name) return err("Please enter your name.");
  if (!email || !email.includes("@")) return err("Please enter a valid email.");
  if (!teamId) return err("Please pick a team.");

  const existing = await env.DB.prepare("SELECT id FROM players WHERE email = ?").bind(email).first();
  if (existing) return err("You've already joined with that email.");
  const team = await env.DB.prepare("SELECT id, status FROM teams WHERE id = ?").bind(teamId).first<any>();
  if (!team) return err("That team doesn't exist.");
  if (team.status !== "alive") return err("That team is already out.");

  const ins = await env.DB.prepare("INSERT INTO players (name, email) VALUES (?, ?)").bind(name, email).run();
  await env.DB.prepare(
    "INSERT INTO entries (player_id, team_id, round_entered, amount, paid, active) VALUES (?, ?, 'signup', ?, 0, 1)"
  ).bind(ins.meta.last_row_id, teamId, SIGNUP_AMOUNT).run();
  return json({ ok: true, playerId: ins.meta.last_row_id });
}

async function buyback(request: Request, env: Env): Promise<Response> {
  const phase = await getPhase(env);
  const amount = BUYBACK_AMOUNT[phase];
  if (!amount) return err("Buy-backs aren't open right now.");
  const body = (await request.json().catch(() => ({}))) as any;
  const email = String(body.email ?? "").trim().toLowerCase();
  const teamId = Number(body.teamId);
  if (!email) return err("Please enter the email you joined with.");
  if (!teamId) return err("Please pick a team.");

  const player = await env.DB.prepare("SELECT id FROM players WHERE email = ?").bind(email).first<any>();
  if (!player) return err("No player found with that email. Did you join during sign-up?");
  const active = await env.DB.prepare("SELECT id FROM entries WHERE player_id = ? AND active = 1").bind(player.id).first();
  if (active) return err("You're still in — your team hasn't been knocked out.");
  const team = await env.DB.prepare("SELECT id, status FROM teams WHERE id = ?").bind(teamId).first<any>();
  if (!team) return err("That team doesn't exist.");
  if (team.status !== "alive") return err("That team is already out — pick one that's still alive.");
  const held = await env.DB.prepare("SELECT id FROM entries WHERE team_id = ? AND active = 1").bind(teamId).first();
  if (held) return err("That team is already taken by someone still in. Pick another.");

  await env.DB.prepare(
    "INSERT INTO entries (player_id, team_id, round_entered, amount, paid, active) VALUES (?, ?, ?, ?, 0, 1)"
  ).bind(player.id, teamId, phase === "r32_buyback" ? "r32" : "r16", amount).run();
  return json({ ok: true });
}

async function setAvatar(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as any;
  const email = String(body.email ?? "").trim().toLowerCase();
  const avatar = String(body.avatar ?? "");
  if (!email) return err("Enter the email you joined with.");
  if (!avatar.startsWith("data:image/")) return err("That doesn't look like an image.");
  if (avatar.length > MAX_AVATAR_CHARS) return err("Image is too large — pick a smaller photo.");
  const player = await env.DB.prepare("SELECT id FROM players WHERE email = ?").bind(email).first<any>();
  if (!player) return err("No player with that email — join the pool first.");
  await env.DB.prepare("UPDATE players SET avatar = ? WHERE id = ?").bind(avatar, player.id).run();
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------
async function setPhase(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as any;
  const phase = String(body.phase ?? "");
  if (!(PHASES as readonly string[]).includes(phase)) return err("Unknown phase.");
  await env.DB.prepare("UPDATE config SET value = ? WHERE key = 'phase'").bind(phase).run();
  return json({ ok: true, phase });
}

async function eliminate(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as any;
  const teamId = Number(body.teamId);
  const round = String(body.round ?? "");
  if (!teamId) return err("Missing team.");
  if (!ROUNDS.includes(round)) return err("Unknown round.");
  await env.DB.batch([
    env.DB.prepare("UPDATE teams SET status = 'eliminated', eliminated_round = ? WHERE id = ?").bind(round, teamId),
    env.DB.prepare("UPDATE entries SET active = 0 WHERE team_id = ? AND active = 1").bind(teamId),
  ]);
  return json({ ok: true });
}

async function revive(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as any;
  const teamId = Number(body.teamId);
  if (!teamId) return err("Missing team.");
  await env.DB.prepare("UPDATE teams SET status = 'alive', eliminated_round = NULL, is_champion = 0 WHERE id = ?").bind(teamId).run();
  await env.DB.prepare(
    `UPDATE entries SET active = 1
     WHERE team_id = ?1 AND active = 0
       AND player_id NOT IN (SELECT player_id FROM entries WHERE active = 1)`
  ).bind(teamId).run();
  return json({ ok: true });
}

async function setPaid(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as any;
  const entryId = Number(body.entryId);
  if (!entryId) return err("Missing entry.");
  await env.DB.prepare("UPDATE entries SET paid = ? WHERE id = ?").bind(body.paid ? 1 : 0, entryId).run();
  return json({ ok: true });
}

// Remove a whole player and all their bets (frees their email to rejoin).
async function deletePlayer(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as any;
  const playerId = Number(body.playerId);
  if (!playerId) return err("Missing player.");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM entries WHERE player_id = ?").bind(playerId),
    env.DB.prepare("DELETE FROM players WHERE id = ?").bind(playerId),
  ]);
  return json({ ok: true });
}

// Remove a single bet. If it was the player's only one, remove the player too.
async function deleteEntry(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as any;
  const entryId = Number(body.entryId);
  if (!entryId) return err("Missing bet.");
  const e = await env.DB.prepare("SELECT player_id FROM entries WHERE id = ?").bind(entryId).first<any>();
  if (!e) return err("Bet not found.");
  await env.DB.prepare("DELETE FROM entries WHERE id = ?").bind(entryId).run();
  const cnt = await env.DB.prepare("SELECT COUNT(*) AS n FROM entries WHERE player_id = ?").bind(e.player_id).first<any>();
  if (cnt && cnt.n === 0) await env.DB.prepare("DELETE FROM players WHERE id = ?").bind(e.player_id).run();
  return json({ ok: true });
}

async function setChampion(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as any;
  const teamId = Number(body.teamId);
  if (!teamId) return err("Missing team.");
  await env.DB.batch([
    env.DB.prepare("UPDATE teams SET is_champion = 0"),
    env.DB.prepare("UPDATE teams SET is_champion = 1, status = 'alive' WHERE id = ?").bind(teamId),
    env.DB.prepare("UPDATE config SET value = 'finished' WHERE key = 'phase'"),
  ]);
  return json({ ok: true });
}

async function upsertTeam(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as any;
  const id = body.id ? Number(body.id) : null;
  const name = String(body.name ?? "").trim();
  const flag = String(body.flag ?? "").trim();
  const grp = String(body.grp ?? "").trim().toUpperCase();
  if (!name) return err("Team name is required.");
  if (id) await env.DB.prepare("UPDATE teams SET name = ?, flag = ?, grp = ? WHERE id = ?").bind(name, flag, grp, id).run();
  else await env.DB.prepare("INSERT INTO teams (name, flag, grp) VALUES (?, ?, ?)").bind(name, flag, grp).run();
  return json({ ok: true });
}

async function deleteTeam(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as any;
  const teamId = Number(body.teamId);
  if (!teamId) return err("Missing team.");
  const used = await env.DB.prepare("SELECT id FROM entries WHERE team_id = ? LIMIT 1").bind(teamId).first();
  if (used) return err("Can't delete — someone has picked this team.");
  await env.DB.prepare("DELETE FROM teams WHERE id = ?").bind(teamId).run();
  return json({ ok: true });
}

// Assign (or clear) the two teams of a knockout match.
async function setMatchTeams(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as any;
  const matchId = Number(body.matchId);
  const home = body.homeTeamId ? Number(body.homeTeamId) : null;
  const away = body.awayTeamId ? Number(body.awayTeamId) : null;
  if (!matchId) return err("Missing match.");
  if (home && away && home === away) return err("A team can't play itself.");
  await env.DB.prepare("UPDATE matches SET home_team_id = ?, away_team_id = ? WHERE id = ?").bind(home, away, matchId).run();
  return json({ ok: true });
}

// Enter a score. For knockouts this auto-eliminates the loser, advances the
// winner to the next round, and (on the final) crowns the champion.
async function setMatchScore(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as any;
  const matchId = Number(body.matchId);
  const hs = Number(body.homeScore);
  const as = Number(body.awayScore);
  if (!matchId) return err("Missing match.");
  if (!Number.isInteger(hs) || !Number.isInteger(as) || hs < 0 || as < 0) return err("Enter valid scores.");

  const m = await env.DB.prepare("SELECT * FROM matches WHERE id = ?").bind(matchId).first<any>();
  if (!m) return err("Match not found.");
  if (!m.home_team_id || !m.away_team_id) return err("Set both teams for this match first.");

  const isKnockout = KO_ROUNDS.includes(m.round);
  let winner: number | null = null;
  if (hs > as) winner = m.home_team_id;
  else if (as > hs) winner = m.away_team_id;
  else if (isKnockout) {
    // Draw in a knockout — decided by penalties; admin says who advances.
    winner = body.winnerTeamId ? Number(body.winnerTeamId) : null;
    if (winner !== m.home_team_id && winner !== m.away_team_id)
      return err("Scores are level — pick who advances (penalty-shootout winner).");
  }

  await env.DB.prepare(
    "UPDATE matches SET home_score = ?, away_score = ?, winner_team_id = ?, played = 1 WHERE id = ?"
  ).bind(hs, as, winner, matchId).run();

  if (isKnockout && winner) {
    const loser = winner === m.home_team_id ? m.away_team_id : m.home_team_id;
    await env.DB.batch([
      env.DB.prepare("UPDATE teams SET status = 'eliminated', eliminated_round = ? WHERE id = ?").bind(m.round, loser),
      env.DB.prepare("UPDATE entries SET active = 0 WHERE team_id = ? AND active = 1").bind(loser),
    ]);

    if (m.round === "final") {
      await env.DB.batch([
        env.DB.prepare("UPDATE teams SET is_champion = 0"),
        env.DB.prepare("UPDATE teams SET is_champion = 1, status = 'alive' WHERE id = ?").bind(winner),
        env.DB.prepare("UPDATE config SET value = 'finished' WHERE key = 'phase'"),
      ]);
    } else {
      // Advance the winner into the next round's slot.
      const nextRound = NEXT_ROUND[m.round];
      const nextSlot = Math.floor(m.slot / 2);
      const col = m.slot % 2 === 0 ? "home_team_id" : "away_team_id";
      await env.DB.prepare(`UPDATE matches SET ${col} = ? WHERE round = ? AND slot = ?`).bind(winner, nextRound, nextSlot).run();
    }
  }
  return json({ ok: true });
}

async function resetPool(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as any;
  if (body.confirm !== "RESET") return err('Send {"confirm":"RESET"} to wipe the pool.');
  await env.DB.batch([
    env.DB.prepare("DELETE FROM entries"),
    env.DB.prepare("DELETE FROM players"),
    env.DB.prepare("UPDATE teams SET status = 'alive', eliminated_round = NULL, is_champion = 0"),
    env.DB.prepare("UPDATE config SET value = 'signup' WHERE key = 'phase'"),
    // Clear all match results; keep group fixtures, clear knockout teams.
    env.DB.prepare("UPDATE matches SET home_score = NULL, away_score = NULL, winner_team_id = NULL, played = 0"),
    env.DB.prepare("UPDATE matches SET home_team_id = NULL, away_team_id = NULL WHERE round <> 'group'"),
  ]);
  return json({ ok: true });
}
