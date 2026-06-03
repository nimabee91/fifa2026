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

const SIGNUP_AMOUNT = 5;

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
  // Constant-ish comparison; fine for an internal tool.
  return !!env.ADMIN_PASSWORD && supplied === env.ADMIN_PASSWORD;
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith("/api/")) {
      try {
        return await handleApi(request, env, path);
      } catch (e) {
        return err((e as Error).message || "Server error", 500);
      }
    }

    // Everything else is a static asset (the HTML/JS/CSS pages).
    return env.ASSETS.fetch(request);
  },
};

async function handleApi(request: Request, env: Env, path: string): Promise<Response> {
  const method = request.method;

  // ---- Public ----
  if (path === "/api/state" && method === "GET") return getState(env);
  if (path === "/api/join" && method === "POST") return join(request, env);
  if (path === "/api/buyback" && method === "POST") return buyback(request, env);

  // ---- Admin (all require the admin password header) ----
  if (path.startsWith("/api/admin/")) {
    if (!isAdmin(request, env)) return err("Unauthorized", 401);

    if (path === "/api/admin/check" && method === "POST") return json({ ok: true });
    if (path === "/api/admin/phase" && method === "POST") return setPhase(request, env);
    if (path === "/api/admin/eliminate" && method === "POST") return eliminate(request, env);
    if (path === "/api/admin/revive" && method === "POST") return revive(request, env);
    if (path === "/api/admin/paid" && method === "POST") return setPaid(request, env);
    if (path === "/api/admin/champion" && method === "POST") return setChampion(request, env);
    if (path === "/api/admin/team" && method === "POST") return upsertTeam(request, env);
    if (path === "/api/admin/team/delete" && method === "POST") return deleteTeam(request, env);
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

  const entries = (
    await env.DB.prepare(
      `SELECT e.id AS entry_id, e.player_id, e.team_id, e.round_entered, e.amount, e.paid, e.active,
              e.created_at, p.name AS player_name, p.email,
              t.name AS team_name, t.flag, t.grp, t.status AS team_status, t.is_champion
       FROM entries e
       JOIN players p ON p.id = e.player_id
       JOIN teams t ON t.id = e.team_id
       ORDER BY e.created_at ASC`
    ).all()
  ).results as any[];

  // Group entries by player.
  const playersById = new Map<number, any>();
  for (const e of entries) {
    let p = playersById.get(e.player_id);
    if (!p) {
      p = {
        id: e.player_id,
        name: e.player_name,
        email: e.email,
        total_paid: 0,
        total_owed: 0,
        history: [] as any[],
        current: null as any,
        status: "out",
      };
      playersById.set(e.player_id, p);
    }
    if (e.paid) p.total_paid += e.amount;
    else p.total_owed += e.amount;

    p.history.push({
      entry_id: e.entry_id,
      team_id: e.team_id,
      team_name: e.team_name,
      flag: e.flag,
      round_entered: e.round_entered,
      amount: e.amount,
      paid: !!e.paid,
      active: !!e.active,
    });

    if (e.active) {
      p.current = {
        entry_id: e.entry_id,
        team_id: e.team_id,
        team_name: e.team_name,
        flag: e.flag,
        round_entered: e.round_entered,
        amount: e.amount,
        paid: !!e.paid,
        team_status: e.team_status,
        is_champion: !!e.is_champion,
      };
      p.status = "in";
    }
  }
  const players = [...playersById.values()].sort((a, b) => a.name.localeCompare(b.name));

  // Pot = sum of every stake ever taken (what's owed to the pool).
  let potTotal = 0;
  let potPaid = 0;
  for (const e of entries) {
    potTotal += e.amount;
    if (e.paid) potPaid += e.amount;
  }

  // Teams currently held by an active stake — unavailable for buy-back.
  const heldTeamIds = new Set(entries.filter((e) => e.active).map((e) => e.team_id));
  const availableTeams = teams.filter((t) => t.status === "alive" && !heldTeamIds.has(t.id));

  // Winners. The holder of the champion wins. If nobody holds the champion,
  // the pot goes to whoever's team made it the farthest (split on a tie).
  const champion = teams.find((t) => t.is_champion) ?? null;
  const teamById = new Map<number, any>(teams.map((t) => [t.id, t]));
  const ROUND_DEPTH: Record<string, number> = { final: 6, sf: 5, qf: 4, r16: 3, r32: 2, group: 1 };
  const teamDepth = (t: any): number => {
    if (!t) return 0;
    if (t.is_champion) return 100; // won it all
    if (t.status === "alive") return 50; // still in (shouldn't happen once finished)
    return ROUND_DEPTH[t.eliminated_round] ?? 0;
  };

  let winners: any[] = [];
  let winBy: "champion" | "farthest" | null = null;
  if (phase === "finished") {
    // Each player rides their most recent team (last entry by time).
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
    phase,
    phases: PHASES,
    rounds: ROUNDS,
    signupAmount: SIGNUP_AMOUNT,
    buybackAmount: BUYBACK_AMOUNT[phase] ?? null,
    teams,
    players,
    availableTeams,
    pot: { total: potTotal, paid: potPaid, pending: potTotal - potPaid },
    champion,
    winners,
    winBy,
  });
}

// ---------------------------------------------------------------------------
// Player: join with the initial $5 pick.
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
  const playerId = ins.meta.last_row_id;

  await env.DB.prepare(
    "INSERT INTO entries (player_id, team_id, round_entered, amount, paid, active) VALUES (?, ?, 'signup', ?, 0, 1)"
  )
    .bind(playerId, teamId, SIGNUP_AMOUNT)
    .run();

  return json({ ok: true, playerId });
}

// ---------------------------------------------------------------------------
// Player: buy back in (Round of 32 = $10, Round of 16 = $15).
// ---------------------------------------------------------------------------
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

  const active = await env.DB
    .prepare("SELECT id FROM entries WHERE player_id = ? AND active = 1")
    .bind(player.id)
    .first();
  if (active) return err("You're still in — your team hasn't been knocked out.");

  const team = await env.DB.prepare("SELECT id, status FROM teams WHERE id = ?").bind(teamId).first<any>();
  if (!team) return err("That team doesn't exist.");
  if (team.status !== "alive") return err("That team is already out — pick one that's still alive.");

  const held = await env.DB
    .prepare("SELECT id FROM entries WHERE team_id = ? AND active = 1")
    .bind(teamId)
    .first();
  if (held) return err("That team is already taken by someone still in. Pick another.");

  await env.DB.prepare(
    "INSERT INTO entries (player_id, team_id, round_entered, amount, paid, active) VALUES (?, ?, ?, ?, 0, 1)"
  )
    .bind(player.id, teamId, phase === "r32_buyback" ? "r32" : "r16", amount)
    .run();

  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Admin actions
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
    // Anyone holding this team is now out.
    env.DB.prepare("UPDATE entries SET active = 0 WHERE team_id = ? AND active = 1").bind(teamId),
  ]);
  return json({ ok: true });
}

async function revive(request: Request, env: Env): Promise<Response> {
  // Undo a mistaken elimination.
  const body = (await request.json().catch(() => ({}))) as any;
  const teamId = Number(body.teamId);
  if (!teamId) return err("Missing team.");

  await env.DB.prepare("UPDATE teams SET status = 'alive', eliminated_round = NULL, is_champion = 0 WHERE id = ?")
    .bind(teamId)
    .run();

  // Reactivate stakes on this team for players who have no other active stake.
  await env.DB.prepare(
    `UPDATE entries SET active = 1
     WHERE team_id = ?1 AND active = 0
       AND player_id NOT IN (SELECT player_id FROM entries WHERE active = 1)`
  )
    .bind(teamId)
    .run();
  return json({ ok: true });
}

async function setPaid(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as any;
  const entryId = Number(body.entryId);
  const paid = body.paid ? 1 : 0;
  if (!entryId) return err("Missing entry.");
  await env.DB.prepare("UPDATE entries SET paid = ? WHERE id = ?").bind(paid, entryId).run();
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

  if (id) {
    await env.DB.prepare("UPDATE teams SET name = ?, flag = ?, grp = ? WHERE id = ?")
      .bind(name, flag, grp, id)
      .run();
  } else {
    await env.DB.prepare("INSERT INTO teams (name, flag, grp) VALUES (?, ?, ?)").bind(name, flag, grp).run();
  }
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

async function resetPool(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as any;
  if (body.confirm !== "RESET") return err('Send {"confirm":"RESET"} to wipe the pool.');
  await env.DB.batch([
    env.DB.prepare("DELETE FROM entries"),
    env.DB.prepare("DELETE FROM players"),
    env.DB.prepare("UPDATE teams SET status = 'alive', eliminated_round = NULL, is_champion = 0"),
    env.DB.prepare("UPDATE config SET value = 'signup' WHERE key = 'phase'"),
  ]);
  return json({ ok: true });
}
