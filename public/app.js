// Player-facing page logic.
const $ = (id) => document.getElementById(id);

const PHASE_LABELS = {
  signup: "Sign-ups open",
  group_stage: "Group stage",
  r32_buyback: "Round of 32 — buy-backs open",
  r16_buyback: "Round of 16 — buy-backs open",
  closed: "Bets closed",
  finished: "Finished",
};

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong");
  return data;
}

function showMsg(text, ok) {
  const m = $("msg");
  m.textContent = text;
  m.className = "msg show " + (ok ? "ok" : "bad");
  if (ok) setTimeout(() => (m.className = "msg"), 4000);
}

function money(n) { return "$" + n; }

function render(state) {
  // Phase + pot
  $("phaseLabel").textContent = PHASE_LABELS[state.phase] || state.phase;
  $("potTotal").textContent = money(state.pot.total);
  $("potPaid").textContent = money(state.pot.paid);
  $("playerCount").textContent = state.players.filter((p) => p.status === "in").length;

  // Winner banner
  const wb = $("winnerBanner");
  if (state.phase === "finished" && state.champion) {
    const names = state.winners.map((w) => w.name).join(", ");
    const w0 = state.winners[0];
    const plural = state.winners.length > 1;
    let line;
    if (!state.winners.length) {
      line = "No winner could be determined yet — knock out the remaining teams in the admin panel.";
    } else if (state.winBy === "champion") {
      line = `Winner${plural ? "s" : ""}: <b>${names}</b> — held the champions and take${plural ? "" : "s"} ${money(state.pot.total)}.`;
    } else {
      const t = w0 && w0.team_name ? `${w0.flag} ${w0.team_name}` : "their team";
      line = `Nobody picked the champions, so the farthest team wins: <b>${names}</b> (${t}) take${plural ? "" : "s"} ${money(state.pot.total)}.`;
    }
    wb.innerHTML =
      `<div class="winner-banner"><h2>🏆 ${state.champion.flag} ${state.champion.name} are champions!</h2><div>${line}</div></div>`;
  } else {
    wb.innerHTML = "";
  }

  // Action area depends on phase
  const joinBox = $("joinBox"), buybackBox = $("buybackBox"), closedBox = $("closedBox");
  joinBox.style.display = buybackBox.style.display = closedBox.style.display = "none";

  if (state.phase === "signup") {
    joinBox.style.display = "";
    const sel = $("teamSelect");
    sel.innerHTML = state.teams
      .filter((t) => t.status === "alive")
      .map((t) => `<option value="${t.id}">${t.flag} ${t.name} (Group ${t.grp})</option>`)
      .join("");
  } else if (state.phase === "r32_buyback" || state.phase === "r16_buyback") {
    buybackBox.style.display = "";
    $("buybackTitle").textContent = `Buy back in — ${money(state.buybackAmount)}`;
    $("buybackHint").textContent =
      `Your team got knocked out? Rejoin for ${money(state.buybackAmount)} by claiming any still-alive team that no surviving player holds.`;
    const sel = $("bbTeamSelect");
    sel.innerHTML = state.availableTeams.length
      ? state.availableTeams.map((t) => `<option value="${t.id}">${t.flag} ${t.name} (Group ${t.grp})</option>`).join("")
      : `<option value="">No teams available</option>`;
  } else {
    closedBox.style.display = "";
  }

  // Standings
  $("standings").innerHTML = state.players.length
    ? state.players
        .map((p) => {
          const cur = p.current;
          const team = cur ? `${cur.flag} ${cur.team_name}` : "—";
          const champ = cur && cur.is_champion ? ` <span class="tag champ">CHAMP</span>` : "";
          const status = p.status === "in"
            ? `<span class="tag in">In</span>`
            : `<span class="tag out">Out</span>`;
          const paid = p.total_owed === 0
            ? `<span class="tag paid">Paid</span>`
            : `<span class="tag unpaid">Owes ${money(p.total_owed)}</span>`;
          return `<tr><td>${p.name}</td><td>${team}${champ}</td><td>${status}</td><td>${paid}</td><td>${money(p.total_paid + p.total_owed)}</td></tr>`;
        })
        .join("")
    : `<tr><td colspan="5" class="muted center">No one has joined yet — be first!</td></tr>`;

  // Teams by group
  const groups = {};
  for (const t of state.teams) (groups[t.grp] = groups[t.grp] || []).push(t);
  $("teamsByGroup").innerHTML = Object.keys(groups)
    .sort()
    .map((g) => {
      const rows = groups[g]
        .map((t) => {
          const dead = t.status !== "alive";
          const champ = t.is_champion ? ` <span class="tag champ">CHAMP</span>` : "";
          return `<span class="tag ${dead ? "out" : "in"}" style="margin:3px;display:inline-block;${dead ? "opacity:.6;text-decoration:line-through;" : ""}">${t.flag} ${t.name}${champ}</span>`;
        })
        .join(" ");
      return `<h3>Group ${g || "?"}</h3><div>${rows}</div>`;
    })
    .join("");
}

async function load() {
  try {
    const state = await api("/api/state");
    render(state);
  } catch (e) {
    showMsg(e.message, false);
  }
}

$("joinBtn").addEventListener("click", async () => {
  try {
    await api("/api/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: $("name").value,
        email: $("email").value,
        teamId: Number($("teamSelect").value),
      }),
    });
    showMsg("You're in! Good luck. ⚽", true);
    $("name").value = $("email").value = "";
    load();
  } catch (e) {
    showMsg(e.message, false);
  }
});

$("buybackBtn").addEventListener("click", async () => {
  try {
    await api("/api/buyback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: $("bbEmail").value,
        teamId: Number($("bbTeamSelect").value),
      }),
    });
    showMsg("You're back in! 🔁", true);
    $("bbEmail").value = "";
    load();
  } catch (e) {
    showMsg(e.message, false);
  }
});

load();
