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
// expose for inline handlers
Object.assign(window, { togglePaid, eliminate, revive, champion, delTeam });

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
}

async function refresh() {
  try { render(await api("/api/state")); }
  catch (e) { showMsg(e.message, false); }
}

// Auto-unlock if we already have a stored password.
if (PW) unlock();
