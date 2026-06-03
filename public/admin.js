// Admin page logic. The password is kept in sessionStorage and sent as a header.
const $ = (id) => document.getElementById(id);
let PW = sessionStorage.getItem("adminPw") || "";

const PHASE_LABELS = {
  signup: "Sign-ups open",
  group_stage: "Group stage",
  r32_buyback: "Round of 32 — buy-backs open ($10)",
  r16_buyback: "Round of 16 — buy-backs open ($15)",
  closed: "Bets closed",
  finished: "Finished",
};
const ROUND_LABELS = { group: "Group stage", r32: "Round of 32", r16: "Round of 16", qf: "Quarterfinal", sf: "Semifinal", final: "Final" };
const KO_LABELS = { r32: "Round of 32", r16: "Round of 16", qf: "Quarterfinals", sf: "Semifinals", final: "Final" };

async function api(path, body, isAdmin) {
  const headers = { "content-type": "application/json" };
  if (isAdmin) headers["x-admin-password"] = PW;
  const res = await fetch(path, { method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong");
  return data;
}

function showMsg(text, ok) {
  const m = $("msg");
  m.textContent = text;
  m.className = "msg show " + (ok ? "ok" : "bad");
  if (ok) setTimeout(() => (m.className = "msg"), 3000);
}

function money(n) { return "$" + n; }

async function unlock() {
  try {
    await api("/api/admin/check", {}, true);
    sessionStorage.setItem("adminPw", PW);
    $("loginCard").style.display = "none";
    $("adminBody").style.display = "";
    refresh();
  } catch (e) {
    const m = $("loginMsg");
    m.textContent = "Wrong password.";
    m.className = "msg show bad";
  }
}

$("loginBtn").addEventListener("click", () => { PW = $("pw").value; unlock(); });
$("pw").addEventListener("keydown", (e) => { if (e.key === "Enter") { PW = $("pw").value; unlock(); } });

// Phase buttons
document.querySelectorAll("[data-phase]").forEach((btn) =>
  btn.addEventListener("click", async () => {
    try {
      await api("/api/admin/phase", { phase: btn.dataset.phase }, true);
      showMsg("Phase updated.", true);
      refresh();
    } catch (e) { showMsg(e.message, false); }
  })
);

$("addTeamBtn").addEventListener("click", async () => {
  try {
    await api("/api/admin/team", { name: $("tName").value, flag: $("tFlag").value, grp: $("tGrp").value }, true);
    $("tName").value = $("tFlag").value = $("tGrp").value = "";
    showMsg("Team added.", true);
    refresh();
  } catch (e) { showMsg(e.message, false); }
});

$("resetBtn").addEventListener("click", async () => {
  if (!confirm("This wipes ALL players and stakes. Are you sure?")) return;
  try {
    await api("/api/admin/reset", { confirm: "RESET" }, true);
    showMsg("Pool reset.", true);
    refresh();
  } catch (e) { showMsg(e.message, false); }
});

async function togglePaid(entryId, paid) {
  try { await api("/api/admin/paid", { entryId, paid }, true); refresh(); }
  catch (e) { showMsg(e.message, false); }
}
async function eliminate(teamId, round) {
  if (!round) return;
  try { await api("/api/admin/eliminate", { teamId, round }, true); showMsg("Team eliminated.", true); refresh(); }
  catch (e) { showMsg(e.message, false); }
}
async function revive(teamId) {
  try { await api("/api/admin/revive", { teamId }, true); refresh(); }
  catch (e) { showMsg(e.message, false); }
}
async function champion(teamId) {
  if (!confirm("Crown this team as champion and finish the pool?")) return;
  try { await api("/api/admin/champion", { teamId }, true); showMsg("Champion set!", true); refresh(); }
  catch (e) { showMsg(e.message, false); }
}
async function delTeam(teamId) {
  if (!confirm("Delete this team?")) return;
  try { await api("/api/admin/team/delete", { teamId }, true); refresh(); }
  catch (e) { showMsg(e.message, false); }
}
async function saveMatchTeams(id) {
  const home = $(`mh-${id}`).value, away = $(`ma-${id}`).value;
  try {
    await api("/api/admin/match/teams", { matchId: id, homeTeamId: home ? Number(home) : null, awayTeamId: away ? Number(away) : null }, true);
    showMsg("Matchup set.", true); refresh();
  } catch (e) { showMsg(e.message, false); }
}
async function saveMatchScore(id) {
  const hEl = $(`hs-${id}`), aEl = $(`as-${id}`);
  if (hEl.value === "" || aEl.value === "") { showMsg("Enter both scores.", false); return; }
  const hs = Number(hEl.value), as = Number(aEl.value);
  let winnerTeamId = null;
  if (hs === as) {
    const home = $(`mh-${id}`), away = $(`ma-${id}`);
    const hName = home.options[home.selectedIndex]?.text || "home";
    const aName = away.options[away.selectedIndex]?.text || "away";
    const homeWon = confirm(`Level at ${hs}-${as}. Click OK if ${hName} won the penalty shootout, Cancel if ${aName} did.`);
    winnerTeamId = homeWon ? Number(home.value) : Number(away.value);
  }
  try { await api("/api/admin/match/score", { matchId: id, homeScore: hs, awayScore: as, winnerTeamId }, true); showMsg("Result saved.", true); refresh(); }
  catch (e) { showMsg(e.message, false); }
}
async function saveGroupScore(id) {
  const hEl = $(`ghs-${id}`), aEl = $(`gas-${id}`);
  if (hEl.value === "" || aEl.value === "") { showMsg("Enter both scores.", false); return; }
  try { await api("/api/admin/match/score", { matchId: id, homeScore: Number(hEl.value), awayScore: Number(aEl.value) }, true); showMsg("Score saved.", true); refresh(); }
  catch (e) { showMsg(e.message, false); }
}
// expose for inline handlers
Object.assign(window, { togglePaid, eliminate, revive, champion, delTeam, saveMatchTeams, saveMatchScore, saveGroupScore });

function teamOptions(teams, selectedId) {
  return `<option value="">— team —</option>` +
    teams.map((t) => `<option value="${t.id}" ${t.id === selectedId ? "selected" : ""}>${t.flag} ${t.name}</option>`).join("");
}

function renderKoAdmin(state) {
  const el = $("koAdmin");
  const teams = [...state.teams].sort((a, b) => (a.grp || "").localeCompare(b.grp || "") || a.name.localeCompare(b.name));
  el.innerHTML = (state.koRounds || []).map((r) => {
    const ms = state.bracket[r] || [];
    if (!ms.length) return "";
    const rows = ms.map((m) => {
      const hSel = m.home ? m.home.id : 0, aSel = m.away ? m.away.id : 0;
      const hs = m.home_score != null ? m.home_score : "";
      const as = m.away_score != null ? m.away_score : "";
      return `<div style="display:flex;gap:5px;align-items:center;flex-wrap:wrap;border:1px solid var(--line);border-radius:8px;padding:6px;margin:4px 0;">
        <select id="mh-${m.id}" style="width:auto;flex:1;min-width:110px;">${teamOptions(teams, hSel)}</select>
        <input id="hs-${m.id}" type="number" min="0" value="${hs}" style="width:46px;text-align:center;" />
        <span class="muted">-</span>
        <input id="as-${m.id}" type="number" min="0" value="${as}" style="width:46px;text-align:center;" />
        <select id="ma-${m.id}" style="width:auto;flex:1;min-width:110px;">${teamOptions(teams, aSel)}</select>
        <button class="small secondary" onclick="saveMatchTeams(${m.id})">Set</button>
        <button class="small" onclick="saveMatchScore(${m.id})">${m.played ? "Update" : "Score"}</button>
        ${m.played ? '<span class="tag in">✓</span>' : ""}
      </div>`;
    }).join("");
    return `<div style="margin-bottom:8px;"><div class="muted" style="font-size:.78rem;text-transform:uppercase;letter-spacing:.04em;margin:8px 0 2px;">${KO_LABELS[r]}</div>${rows}</div>`;
  }).join("");
}

function renderGroupAdmin(state) {
  const el = $("groupAdmin");
  const gf = state.groupFixtures || {};
  el.innerHTML = Object.keys(gf).sort().map((g) => {
    const rows = gf[g].map((m) => {
      const hs = m.home_score != null ? m.home_score : "";
      const as = m.away_score != null ? m.away_score : "";
      const hn = m.home ? `${m.home.flag} ${m.home.name}` : "?";
      const an = m.away ? `${m.away.flag} ${m.away.name}` : "?";
      return `<div style="display:flex;gap:6px;align-items:center;margin:4px 0;font-size:.85rem;">
        <span style="flex:1;text-align:right;">${hn}</span>
        <input id="ghs-${m.id}" type="number" min="0" value="${hs}" style="width:44px;text-align:center;" />
        <span class="muted">-</span>
        <input id="gas-${m.id}" type="number" min="0" value="${as}" style="width:44px;text-align:center;" />
        <span style="flex:1;">${an}</span>
        <button class="small" onclick="saveGroupScore(${m.id})">${m.played ? "Update" : "Save"}</button>
      </div>`;
    }).join("");
    return `<details style="margin:4px 0;"><summary style="cursor:pointer;color:var(--accent-2);font-weight:600;">Group ${g}</summary>${rows}</details>`;
  }).join("");
}

function render(state) {
  $("curPhase").textContent = PHASE_LABELS[state.phase] || state.phase;

  // Players + payment toggles
  $("playersTbl").innerHTML = state.players.length
    ? state.players
        .map((p) => {
          const stakes = p.history
            .map((h) => {
              const cls = h.paid ? "paid" : "unpaid";
              const lbl = h.paid ? "Paid" : "Mark paid";
              const note = h.active ? "" : " (out)";
              return `<div style="margin:3px 0;">${h.flag} ${h.team_name} · ${money(h.amount)}${note}
                <button class="small ${h.paid ? "secondary" : ""}" onclick="togglePaid(${h.entry_id}, ${h.paid ? 0 : 1})">${lbl}</button></div>`;
            })
            .join("");
          const status = p.status === "in" ? `<span class="tag in">In</span>` : `<span class="tag out">Out</span>`;
          const owe = p.total_owed > 0 ? `<div class="muted" style="font-size:.8rem;">Owes ${money(p.total_owed)}</div>` : "";
          return `<tr><td>${p.name}<div class="muted" style="font-size:.78rem;">${p.email}</div></td><td>${stakes}</td><td>${status}${owe}</td></tr>`;
        })
        .join("")
    : `<tr><td colspan="3" class="muted center">No players yet.</td></tr>`;

  // Teams admin
  const roundOpts = state.rounds.map((r) => `<option value="${r}">${ROUND_LABELS[r] || r}</option>`).join("");
  const groups = {};
  for (const t of state.teams) (groups[t.grp] = groups[t.grp] || []).push(t);
  $("teamsAdmin").innerHTML = Object.keys(groups)
    .sort()
    .map((g) => {
      const rows = groups[g]
        .map((t) => {
          if (t.status === "alive") {
            return `<tr>
              <td>${t.flag} ${t.name} ${t.is_champion ? '<span class="tag champ">CHAMP</span>' : ""}</td>
              <td>
                <select id="rnd-${t.id}" style="width:auto;display:inline-block;">${roundOpts}</select>
                <button class="small danger" onclick="eliminate(${t.id}, document.getElementById('rnd-${t.id}').value)">Knock out</button>
                <button class="small secondary" onclick="champion(${t.id})">🏆 Champion</button>
              </td></tr>`;
          }
          return `<tr style="opacity:.65;">
            <td style="text-decoration:line-through;">${t.flag} ${t.name}</td>
            <td><span class="tag out">Out · ${ROUND_LABELS[t.eliminated_round] || t.eliminated_round || "?"}</span>
              <button class="small secondary" onclick="revive(${t.id})">Undo</button></td></tr>`;
        })
        .join("");
      return `<h3>Group ${g || "?"}</h3><table>${rows}</table>`;
    })
    .join("");

  renderKoAdmin(state);
  renderGroupAdmin(state);
}

async function refresh() {
  try { render(await api("/api/state")); }
  catch (e) { showMsg(e.message, false); }
}

// Auto-unlock if we already have a stored password.
if (PW) unlock();
