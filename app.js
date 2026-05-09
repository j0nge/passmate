"use strict";

const STORAGE_KEY = "passmate-state-v2";
const DEFAULT_QUARTER_SECONDS = 8 * 60;
const COLOR_PALETTE = ["#ff7a18", "#5b8def", "#38d39f", "#ff5560", "#a86bff", "#f7c948", "#41d3ff", "#ff8fb1"];

const state = loadState() || createDefaultState();
ensureRotation();
ensureCurrentMatch();

function uid(prefix = "id") {
  return prefix + "_" + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
}

function makeTeam(name, color) {
  return { id: uid("t"), name, color, players: [] };
}

function createDefaultState() {
  return {
    teams: [
      makeTeam("1팀", COLOR_PALETTE[0]),
      makeTeam("2팀", COLOR_PALETTE[1]),
      makeTeam("3팀", COLOR_PALETTE[2]),
    ],
    matches: [],
    rotation: [],
    rotationIdx: 0,
    quarterDurationSeconds: DEFAULT_QUARTER_SECONDS,
    timerSecondsLeft: DEFAULT_QUARTER_SECONDS,
    timerRunning: false,
    history: [],
    editMode: false,
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.teams)) return null;
    parsed.timerRunning = false;
    parsed.editMode = false;
    parsed.history = Array.isArray(parsed.history) ? parsed.history : [];
    parsed.matches = Array.isArray(parsed.matches) ? parsed.matches : [];
    parsed.rotation = Array.isArray(parsed.rotation) ? parsed.rotation : [];
    parsed.rotationIdx = typeof parsed.rotationIdx === "number" ? parsed.rotationIdx : 0;
    return parsed;
  } catch (e) {
    return null;
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {}
  syncMarkLocal();
  syncPush();
}

// ====== Cloud sync (Vercel KV) ======

const SYNC_URL = "/api/state";
let syncEnabled = false;
let syncPullTimer = null;
let syncPushDebounce = null;
let syncLastHash = "";

function syncableFields() {
  return {
    teams: state.teams,
    matches: state.matches,
    rotation: state.rotation,
    rotationIdx: state.rotationIdx,
    history: state.history,
    quarterDurationSeconds: state.quarterDurationSeconds,
  };
}

function hashFields(v) { try { return JSON.stringify(v); } catch (e) { return ""; } }

function syncMarkLocal() {
  syncLastHash = hashFields(syncableFields());
}

function setSyncIndicator(connected) {
  let el = document.getElementById("syncDot");
  if (!el) {
    el = document.createElement("span");
    el.id = "syncDot";
    el.className = "sync-dot";
    const brand = document.querySelector(".brand");
    if (brand) brand.insertBefore(el, brand.firstChild);
  }
  el.classList.toggle("connected", !!connected);
  el.title = connected ? "다른 디바이스와 실시간 동기화 중" : "동기화 비활성 — 로컬에만 저장";
}

async function syncBoot() {
  try {
    const r = await fetch(SYNC_URL, { cache: "no-store" });
    if (!r.ok) {
      syncEnabled = false;
      setSyncIndicator(false);
      return;
    }
    const data = await r.json();
    syncEnabled = true;
    setSyncIndicator(true);
    if (data.state) {
      const h = hashFields(data.state);
      if (h !== hashFields(syncableFields())) applyRemoteState(data.state);
      syncLastHash = h;
    } else {
      // 아무도 아직 push 안 함 → 우리가 첫 푸시
      syncMarkLocal();
      syncPush(true);
    }
    if (!syncPullTimer) syncPullTimer = setInterval(syncPull, 1000);
  } catch (e) {
    syncEnabled = false;
    setSyncIndicator(false);
  }
}

async function syncPull() {
  if (!syncEnabled) return;
  try {
    const r = await fetch(SYNC_URL, { cache: "no-store" });
    if (!r.ok) return;
    const data = await r.json();
    if (!data.state) return;
    const h = hashFields(data.state);
    if (h === syncLastHash) return;
    syncLastHash = h;
    applyRemoteState(data.state);
  } catch (e) {}
}

function syncPush(immediate) {
  if (!syncEnabled) return;
  if (syncPushDebounce) { clearTimeout(syncPushDebounce); syncPushDebounce = null; }
  const doPush = async () => {
    syncPushDebounce = null;
    try {
      const body = syncableFields();
      syncLastHash = hashFields(body);
      await fetch(SYNC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {}
  };
  if (immediate) doPush();
  else syncPushDebounce = setTimeout(doPush, 250);
}

function applyRemoteState(remote) {
  const prevMatchCount = state.matches.length;
  state.teams = Array.isArray(remote.teams) ? remote.teams : state.teams;
  state.matches = Array.isArray(remote.matches) ? remote.matches : state.matches;
  state.rotation = Array.isArray(remote.rotation) ? remote.rotation : state.rotation;
  state.rotationIdx = typeof remote.rotationIdx === "number" ? remote.rotationIdx : state.rotationIdx;
  state.history = Array.isArray(remote.history) ? remote.history : state.history;
  state.quarterDurationSeconds = typeof remote.quarterDurationSeconds === "number" ? remote.quarterDurationSeconds : state.quarterDurationSeconds;
  if (state.matches.length !== prevMatchCount) {
    state.timerRunning = false;
    state.timerSecondsLeft = state.quarterDurationSeconds;
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  }
  if (state.timerSecondsLeft > state.quarterDurationSeconds) {
    state.timerSecondsLeft = state.quarterDurationSeconds;
  }
  ensureRotation();
  ensureCurrentMatch();
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
  renderAll();
}

// ====== Rotation ======

function generateRotation(teamIds) {
  const rotation = [];
  for (let i = 0; i < teamIds.length; i++) {
    for (let j = i + 1; j < teamIds.length; j++) {
      rotation.push({ teamAId: teamIds[i], teamBId: teamIds[j] });
    }
  }
  return rotation;
}

function ensureRotation() {
  const ids = state.teams.map((t) => t.id);
  const expected = (ids.length * (ids.length - 1)) / 2;
  const valid = state.rotation.every(
    (p) => ids.includes(p.teamAId) && ids.includes(p.teamBId)
  );
  if (!valid || state.rotation.length !== expected) {
    state.rotation = generateRotation(ids);
    state.rotationIdx = 0;
  }
}

function ensureCurrentMatch() {
  if (state.matches.length === 0 && state.teams.length >= 2) {
    const next = state.rotation[0] || { teamAId: state.teams[0].id, teamBId: state.teams[1].id };
    state.matches.push({ teamAId: next.teamAId, teamBId: next.teamBId, scoreA: 0, scoreB: 0 });
  }
}

function currentMatch() {
  return state.matches[state.matches.length - 1] || null;
}
function currentMatchIndex() {
  return state.matches.length - 1;
}

// ====== Score ======

function addScore(teamId, playerId) {
  const m = currentMatch();
  if (!m) { showToast("팀이 부족합니다 (최소 2팀)"); return; }
  if (m.teamAId !== teamId && m.teamBId !== teamId) {
    showToast("이 팀은 이번 매치에 뛰지 않습니다");
    return;
  }
  if (m.teamAId === teamId) m.scoreA += 1;
  else m.scoreB += 1;
  if (playerId) {
    const team = state.teams.find((t) => t.id === teamId);
    const player = team && team.players.find((p) => p.id === playerId);
    if (player) player.points = (player.points || 0) + 1;
  }
  state.history.push({
    type: "score",
    matchIdx: currentMatchIndex(),
    teamId,
    playerId: playerId || null,
    ts: Date.now(),
  });
  saveState();
  renderTeams();
  renderTables();
}

function manualSubtract(teamId) {
  const m = currentMatch();
  if (!m) return;
  if (m.teamAId === teamId) {
    if (m.scoreA <= 0) { showToast("이번 매치 점수가 0입니다"); return; }
    m.scoreA -= 1;
  } else if (m.teamBId === teamId) {
    if (m.scoreB <= 0) { showToast("이번 매치 점수가 0입니다"); return; }
    m.scoreB -= 1;
  } else return;
  state.history.push({ type: "subtract", matchIdx: currentMatchIndex(), teamId, ts: Date.now() });
  saveState();
  renderTeams();
  renderTables();
}

function undo() {
  const last = state.history.pop();
  if (!last) { showToast("되돌릴 작업이 없습니다"); return; }
  const m = state.matches[last.matchIdx];
  if (!m) { saveState(); renderAll(); return; }
  if (last.type === "score") {
    if (m.teamAId === last.teamId) m.scoreA = Math.max(0, m.scoreA - 1);
    else if (m.teamBId === last.teamId) m.scoreB = Math.max(0, m.scoreB - 1);
    if (last.playerId) {
      const team = state.teams.find((t) => t.id === last.teamId);
      const player = team && team.players.find((p) => p.id === last.playerId);
      if (player) player.points = Math.max(0, (player.points || 0) - 1);
    }
  } else if (last.type === "subtract") {
    if (m.teamAId === last.teamId) m.scoreA += 1;
    else if (m.teamBId === last.teamId) m.scoreB += 1;
  }
  saveState();
  renderTeams();
  renderTables();
}

// ====== Pairing total ======

function pairingTotal(teamAId, teamBId) {
  let a = 0, b = 0;
  state.matches.forEach((m) => {
    if (m.teamAId === teamAId && m.teamBId === teamBId) {
      a += m.scoreA; b += m.scoreB;
    } else if (m.teamAId === teamBId && m.teamBId === teamAId) {
      a += m.scoreB; b += m.scoreA;
    }
  });
  return { a, b };
}

// ====== Match flow ======

function nextMatch() {
  if (state.rotation.length === 0) {
    showToast("팀이 부족합니다 (최소 2팀)");
    return;
  }
  state.rotationIdx = (state.rotationIdx + 1) % state.rotation.length;
  const next = state.rotation[state.rotationIdx];
  state.matches.push({ teamAId: next.teamAId, teamBId: next.teamBId, scoreA: 0, scoreB: 0 });
  state.timerSecondsLeft = state.quarterDurationSeconds;
  state.timerRunning = false;
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
  saveState();
  renderAll();
  showToast(`Q${state.matches.length} 매치업 준비`);
}

function setCurrentMatchTeams(teamAId, teamBId) {
  if (teamAId === teamBId) return;
  const m = currentMatch();
  if (!m) return;
  m.teamAId = teamAId;
  m.teamBId = teamBId;
  m.scoreA = 0;
  m.scoreB = 0;
  // history에서 이 매치 관련 점수 항목들도 정리(점수 0이라 의미 X)
  state.history = state.history.filter((h) => h.matchIdx !== currentMatchIndex());
  const idx = state.rotation.findIndex(
    (p) =>
      (p.teamAId === teamAId && p.teamBId === teamBId) ||
      (p.teamAId === teamBId && p.teamBId === teamAId)
  );
  if (idx !== -1) state.rotationIdx = idx;
  saveState();
  renderAll();
}

// ====== Reset ======

function resetAll() {
  state.matches = [];
  state.history = [];
  state.rotationIdx = 0;
  state.timerSecondsLeft = state.quarterDurationSeconds;
  state.timerRunning = false;
  state.teams.forEach((t) => t.players.forEach((p) => (p.points = 0)));
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
  ensureRotation();
  ensureCurrentMatch();
  saveState();
  renderAll();
}

// ====== Timer ======

let timerInterval = null;
let timerLastTick = null;

function startTimer() {
  if (state.timerRunning) return;
  if (!currentMatch()) { showToast("팀이 부족합니다 (최소 2팀)"); return; }
  if (state.timerSecondsLeft <= 0) state.timerSecondsLeft = state.quarterDurationSeconds;
  ensureAudio();
  state.timerRunning = true;
  timerLastTick = Date.now();
  saveState();
  loopTimer();
  renderTimer();
}

function stopTimer() {
  state.timerRunning = false;
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
  timerLastTick = null;
  saveState();
  renderTimer();
}

function loopTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    if (!state.timerRunning) {
      clearInterval(timerInterval);
      timerInterval = null;
      return;
    }
    const now = Date.now();
    const elapsed = (now - timerLastTick) / 1000;
    if (elapsed < 1) return;
    const elapsedSec = Math.floor(elapsed);
    state.timerSecondsLeft -= elapsedSec;
    timerLastTick = now - (elapsed - elapsedSec) * 1000;
    if (state.timerSecondsLeft <= 0) {
      state.timerSecondsLeft = 0;
      state.timerRunning = false;
      clearInterval(timerInterval);
      timerInterval = null;
      saveState();
      onTimerExpired();
      renderTimer();
      return;
    }
    saveState();
    renderTimer();
  }, 250);
}

function resetTimer() {
  state.timerRunning = false;
  state.timerSecondsLeft = state.quarterDurationSeconds;
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
  saveState();
  renderTimer();
}

function onTimerExpired() {
  playAlarm();
  if ("vibrate" in navigator) {
    try { navigator.vibrate([400, 180, 400, 180, 600]); } catch (e) {}
  }
  showToast(`Q${state.matches.length} 종료`);
}

// ====== Audio ======

let audioCtx = null;
function ensureAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch (e) {}
}
function playAlarm() {
  try {
    ensureAudio();
    if (!audioCtx) return;
    const beepAt = (when, freq, dur) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = freq;
      o.type = "square";
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(0.28, when + 0.01);
      g.gain.linearRampToValueAtTime(0, when + dur);
      o.connect(g);
      g.connect(audioCtx.destination);
      o.start(when);
      o.stop(when + dur + 0.05);
    };
    const t = audioCtx.currentTime;
    beepAt(t, 880, 0.28);
    beepAt(t + 0.4, 880, 0.28);
    beepAt(t + 0.8, 880, 0.28);
    beepAt(t + 1.4, 1320, 0.7);
  } catch (e) {}
}

// ====== Render ======

function fmtTime(s) {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
function findTeam(id) { return state.teams.find((t) => t.id === id); }

function renderTimer() {
  const el = document.getElementById("timerDisplay");
  el.textContent = fmtTime(state.timerSecondsLeft);
  el.classList.toggle("warning", state.timerSecondsLeft > 0 && state.timerSecondsLeft <= 30);
  el.classList.toggle("expired", state.timerSecondsLeft <= 0);
  document.getElementById("quarterValue").textContent = Math.max(state.matches.length, 1);
  document.getElementById("startStopBtn").textContent = state.timerRunning ? "정지" : "시작";
}

function renderMatchupBar() {
  const m = currentMatch();
  const teamA = m ? findTeam(m.teamAId) : null;
  const teamB = m ? findTeam(m.teamBId) : null;
  document.getElementById("muNameA").textContent = teamA ? teamA.name : "—";
  document.getElementById("muNameB").textContent = teamB ? teamB.name : "—";
  document.getElementById("muDotA").style.background = teamA ? teamA.color : "transparent";
  document.getElementById("muDotB").style.background = teamB ? teamB.color : "transparent";
}

function renderTeams() {
  const root = document.getElementById("teamsSection");
  root.innerHTML = "";
  const m = currentMatch();

  state.teams.forEach((team) => {
    const isPlaying = m && (m.teamAId === team.id || m.teamBId === team.id);
    if (!isPlaying && !state.editMode) return;

    const card = document.createElement("div");
    card.className = "team-card";
    if (!isPlaying) card.classList.add("resting");
    card.dataset.teamId = team.id;
    card.style.borderColor = team.color;

    const myScore = m && isPlaying ? (m.teamAId === team.id ? m.scoreA : m.scoreB) : 0;
    const oppId = m && isPlaying ? (m.teamAId === team.id ? m.teamBId : m.teamAId) : null;
    const opp = oppId ? findTeam(oppId) : null;
    const pairTotal = opp ? pairingTotal(team.id, opp.id) : null;

    const headerHtml = `
      <div class="team-header">
        <span class="team-color-dot" style="background:${team.color}"></span>
        <input class="team-name" value="${escapeHtml(team.name)}" ${state.editMode ? "" : "readonly"}>
        ${state.editMode ? `<button class="btn small ghost danger del-team">삭제</button>` : ""}
      </div>
    `;

    const scoreHtml = isPlaying
      ? `
        <div class="score-area" data-team-id="${team.id}">
          <div class="score-current" style="color:${team.color}">${myScore}</div>
          <div class="score-meta">
            <span>이번 매치</span>
            ${pairTotal ? `<span class="total">vs ${escapeHtml(opp.name)} 누적 ${pairTotal.a}점</span>` : ""}
          </div>
        </div>
        <div class="score-controls">
          <button class="btn small minus" data-team-id="${team.id}">−1</button>
        </div>
      `
      : `<div class="score-area resting-label">쉬는 중</div>`;

    card.innerHTML = headerHtml + scoreHtml + `<div class="players-area" data-team-id="${team.id}"></div>`;

    const playersArea = card.querySelector(".players-area");
    team.players.forEach((p) => {
      const btn = document.createElement("button");
      btn.className = "player-btn" + (isPlaying ? "" : " resting-player");
      btn.dataset.playerId = p.id;
      btn.dataset.teamId = team.id;
      btn.innerHTML = `<span class="pname">${escapeHtml(p.name)}</span><span class="ppoints">${p.points || 0}</span>`;
      playersArea.appendChild(btn);
    });

    const addBtn = document.createElement("button");
    addBtn.className = "add-player-btn";
    addBtn.textContent = "+ 선수 추가";
    addBtn.dataset.teamId = team.id;
    addBtn.dataset.action = "add-player";
    playersArea.appendChild(addBtn);

    root.appendChild(card);
  });

  document.body.classList.toggle("edit-mode", state.editMode);
  setupSortable();
}

function setupSortable() {
  if (!window.Sortable) return;
  document.querySelectorAll(".players-area").forEach((area) => {
    if (area._sortable) area._sortable.destroy();
    area._sortable = Sortable.create(area, {
      group: "players",
      animation: 150,
      disabled: !state.editMode,
      filter: ".add-player-btn",
      preventOnFilter: false,
      delay: 100,
      delayOnTouchOnly: true,
      onEnd: (evt) => {
        const playerId = evt.item.dataset.playerId;
        const fromTeamId = evt.from.dataset.teamId;
        const toTeamId = evt.to.dataset.teamId;
        if (!playerId || fromTeamId === toTeamId) {
          renderTeams();
          return;
        }
        movePlayer(playerId, fromTeamId, toTeamId);
      },
    });
  });
}

function movePlayer(playerId, fromTeamId, toTeamId) {
  const fromTeam = findTeam(fromTeamId);
  const toTeam = findTeam(toTeamId);
  if (!fromTeam || !toTeam) return;
  const idx = fromTeam.players.findIndex((p) => p.id === playerId);
  if (idx === -1) return;
  const [player] = fromTeam.players.splice(idx, 1);
  toTeam.players.push(player);
  saveState();
  renderTeams();
}

function renderPairings() {
  const root = document.getElementById("pairingsList");
  root.innerHTML = "";
  if (state.teams.length < 2) {
    root.innerHTML = `<div class="muted">팀이 2개 이상 필요합니다</div>`;
    return;
  }
  const m = currentMatch();
  const pairs = [];
  for (let i = 0; i < state.teams.length; i++) {
    for (let j = i + 1; j < state.teams.length; j++) {
      pairs.push([state.teams[i], state.teams[j]]);
    }
  }
  pairs.forEach(([a, b]) => {
    const total = pairingTotal(a.id, b.id);
    const isActive = m && ((m.teamAId === a.id && m.teamBId === b.id) || (m.teamAId === b.id && m.teamBId === a.id));
    const lead = total.a > total.b ? "lead-a" : total.b > total.a ? "lead-b" : "";
    const card = document.createElement("div");
    card.className = `pairing-card ${isActive ? "active" : ""} ${lead}`;
    card.innerHTML = `
      <div class="pairing-side left">
        <div class="pname"><span class="pdot" style="background:${a.color}"></span>${escapeHtml(a.name)}</div>
        <div class="pscore" style="color:${a.color}">${total.a}</div>
      </div>
      <div class="pairing-divider">:</div>
      <div class="pairing-side right">
        <div class="pname">${escapeHtml(b.name)}<span class="pdot" style="background:${b.color}"></span></div>
        <div class="pscore" style="color:${b.color}">${total.b}</div>
      </div>
    `;
    root.appendChild(card);
  });
}

function renderRecord() {
  const table = document.getElementById("recordTable");
  if (state.matches.length === 0) {
    table.innerHTML = `<tbody><tr><td colspan="3" style="text-align:center;color:var(--text-mute);padding:20px">아직 진행한 매치가 없습니다</td></tr></tbody>`;
    return;
  }
  const head = `<thead><tr><th>Q</th><th class="matchup-cell">매치업</th><th>점수</th></tr></thead>`;
  const lastIdx = state.matches.length - 1;
  let body = "<tbody>";
  state.matches.forEach((m, i) => {
    const a = findTeam(m.teamAId);
    const b = findTeam(m.teamBId);
    if (!a || !b) return;
    const winA = m.scoreA > m.scoreB;
    const winB = m.scoreB > m.scoreA;
    body += `<tr class="${i === lastIdx ? "current-row" : ""}">
      <td>Q${i + 1}</td>
      <td class="matchup-cell">${escapeHtml(a.name)} <span style="color:var(--text-mute)">vs</span> ${escapeHtml(b.name)}</td>
      <td class="score-cell">
        <span class="${winA ? "winner" : ""}">${m.scoreA}</span>
        <span style="color:var(--text-mute)"> : </span>
        <span class="${winB ? "winner" : ""}">${m.scoreB}</span>
      </td>
    </tr>`;
  });
  body += "</tbody>";
  table.innerHTML = head + body;
}

function renderTables() {
  renderPairings();
  renderRecord();
}

function renderAll() {
  renderTimer();
  renderMatchupBar();
  renderTeams();
  renderTables();
}

// ====== Modals ======

function showConfirm(title, msg, onOk) {
  document.getElementById("confirmTitle").textContent = title;
  document.getElementById("confirmMessage").textContent = msg;
  const modal = document.getElementById("confirmModal");
  const ok = document.getElementById("confirmOkBtn");
  modal.classList.remove("hidden");
  const cancel = modal.querySelector(".modal-cancel");
  const cleanup = () => {
    modal.classList.add("hidden");
    ok.removeEventListener("click", okHandler);
    cancel.removeEventListener("click", cleanup);
  };
  const okHandler = () => { cleanup(); onOk(); };
  ok.addEventListener("click", okHandler);
  cancel.addEventListener("click", cleanup);
}

function showPrompt(title, defaultValue, onOk) {
  document.getElementById("promptTitle").textContent = title;
  const input = document.getElementById("promptInput");
  input.value = defaultValue || "";
  const modal = document.getElementById("promptModal");
  const ok = document.getElementById("promptOkBtn");
  const cancel = modal.querySelector(".modal-cancel");
  modal.classList.remove("hidden");
  setTimeout(() => input.focus(), 50);
  const cleanup = () => {
    modal.classList.add("hidden");
    ok.removeEventListener("click", okHandler);
    input.removeEventListener("keydown", keyHandler);
    cancel.removeEventListener("click", cleanup);
  };
  const okHandler = () => { const v = input.value.trim(); cleanup(); onOk(v); };
  const keyHandler = (e) => { if (e.key === "Enter") okHandler(); };
  ok.addEventListener("click", okHandler);
  input.addEventListener("keydown", keyHandler);
  cancel.addEventListener("click", cleanup);
}

let toastTimer = null;
function showToast(msg) {
  let el = document.querySelector(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 1800);
}

function showMatchupModal() {
  if (state.teams.length < 2) { showToast("팀이 2개 이상 필요합니다"); return; }
  const m = currentMatch();
  let selA = m ? m.teamAId : state.teams[0].id;
  let selB = m ? m.teamBId : state.teams[1].id;

  const renderPickers = () => {
    const renderColumn = (containerId, selected, otherSelected, onPick) => {
      const root = document.getElementById(containerId);
      root.innerHTML = "";
      state.teams.forEach((t) => {
        const btn = document.createElement("button");
        btn.className = "picker-option" + (t.id === selected ? " selected" : "");
        btn.disabled = t.id === otherSelected;
        btn.innerHTML = `<span class="po-dot" style="background:${t.color}"></span>${escapeHtml(t.name)}`;
        btn.addEventListener("click", () => { onPick(t.id); });
        root.appendChild(btn);
      });
    };
    renderColumn("pickerA", selA, selB, (id) => { selA = id; renderPickers(); });
    renderColumn("pickerB", selB, selA, (id) => { selB = id; renderPickers(); });
  };
  renderPickers();

  const modal = document.getElementById("matchupModal");
  modal.classList.remove("hidden");
  const ok = document.getElementById("saveMatchupBtn");
  const cancel = modal.querySelector(".modal-cancel");
  const cleanup = () => {
    modal.classList.add("hidden");
    ok.removeEventListener("click", okHandler);
    cancel.removeEventListener("click", cleanup);
  };
  const okHandler = () => {
    if (selA === selB) { showToast("서로 다른 두 팀을 선택하세요"); return; }
    cleanup();
    setCurrentMatchTeams(selA, selB);
  };
  ok.addEventListener("click", okHandler);
  cancel.addEventListener("click", cleanup);
}

// ====== Events ======

function bindEvents() {
  document.getElementById("startStopBtn").addEventListener("click", () => {
    if (state.timerRunning) stopTimer(); else startTimer();
  });
  document.getElementById("resetTimerBtn").addEventListener("click", resetTimer);
  document.getElementById("nextQuarterBtn").addEventListener("click", nextMatch);
  document.getElementById("matchupBtn").addEventListener("click", () => {
    if (state.editMode) return;
    showMatchupModal();
  });
  document.getElementById("changeMatchupBtn").addEventListener("click", () => {
    if (state.editMode) return;
    showMatchupModal();
  });

  document.getElementById("editTimerBtn").addEventListener("click", () => {
    document.getElementById("minutesInput").value = Math.floor(state.quarterDurationSeconds / 60);
    document.getElementById("secondsInput").value = state.quarterDurationSeconds % 60;
    document.getElementById("timerModal").classList.remove("hidden");
  });
  document.getElementById("saveTimerBtn").addEventListener("click", () => {
    const m = parseInt(document.getElementById("minutesInput").value, 10) || 0;
    const s = parseInt(document.getElementById("secondsInput").value, 10) || 0;
    const total = m * 60 + s;
    if (total <= 0) { showToast("1초 이상 설정해주세요"); return; }
    state.quarterDurationSeconds = total;
    state.timerSecondsLeft = total;
    state.timerRunning = false;
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = null;
    saveState();
    document.getElementById("timerModal").classList.add("hidden");
    renderTimer();
  });

  document.querySelectorAll(".modal").forEach((modal) => {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) modal.classList.add("hidden");
    });
  });

  document.getElementById("toggleEdit").addEventListener("click", (e) => {
    state.editMode = !state.editMode;
    e.target.textContent = state.editMode ? "완료" : "편집";
    saveState();
    renderAll();
  });

  document.getElementById("resetAllBtn").addEventListener("click", () => {
    showConfirm(
      "전체 초기화",
      "모든 매치 점수, 페어링 누적, 선수 득점이 0으로 리셋됩니다. 팀과 선수 명단은 유지됩니다. 진행할까요?",
      () => { resetAll(); showToast("초기화 완료"); }
    );
  });

  document.getElementById("addTeamBtn").addEventListener("click", () => {
    if (state.teams.length >= 8) { showToast("최대 8팀까지"); return; }
    const color = COLOR_PALETTE[state.teams.length % COLOR_PALETTE.length];
    state.teams.push(makeTeam(`${state.teams.length + 1}팀`, color));
    ensureRotation();
    ensureCurrentMatch();
    saveState();
    renderAll();
  });

  document.getElementById("undoBtn").addEventListener("click", undo);

  const teamsSection = document.getElementById("teamsSection");

  teamsSection.addEventListener("click", (e) => {
    const playerBtn = e.target.closest(".player-btn");
    if (playerBtn && !state.editMode && !playerBtn.classList.contains("resting-player")) {
      ensureAudio();
      addScore(playerBtn.dataset.teamId, playerBtn.dataset.playerId);
      return;
    }
    const scoreArea = e.target.closest(".score-area");
    if (scoreArea && !state.editMode && !scoreArea.classList.contains("resting-label")) {
      ensureAudio();
      addScore(scoreArea.dataset.teamId);
      return;
    }
    const minus = e.target.closest(".minus");
    if (minus) {
      manualSubtract(minus.dataset.teamId);
      return;
    }
    const delTeam = e.target.closest(".del-team");
    if (delTeam) {
      const card = delTeam.closest(".team-card");
      const teamId = card.dataset.teamId;
      const team = findTeam(teamId);
      if (state.teams.length <= 2) { showToast("최소 2팀이 필요합니다"); return; }
      showConfirm("팀 삭제", `'${team.name}'을(를) 삭제할까요? 이 팀이 포함된 매치 기록이 함께 사라집니다.`, () => {
        state.teams = state.teams.filter((t) => t.id !== teamId);
        state.matches = state.matches.filter((m) => m.teamAId !== teamId && m.teamBId !== teamId);
        state.history = state.history.filter((h) => h.teamId !== teamId);
        ensureRotation();
        ensureCurrentMatch();
        saveState();
        renderAll();
      });
      return;
    }
    const addPlayer = e.target.closest('[data-action="add-player"]');
    if (addPlayer) {
      const teamId = addPlayer.dataset.teamId;
      const team = findTeam(teamId);
      showPrompt(`'${team.name}'에 선수 추가`, "", (name) => {
        if (!name) return;
        team.players.push({ id: uid("p"), name, points: 0 });
        saveState();
        renderTeams();
      });
      return;
    }
  });

  teamsSection.addEventListener("change", (e) => {
    if (e.target.classList.contains("team-name")) {
      const card = e.target.closest(".team-card");
      const team = findTeam(card.dataset.teamId);
      if (team) {
        const v = e.target.value.trim();
        if (v) team.name = v; else e.target.value = team.name;
        saveState();
        renderMatchupBar();
        renderTables();
      }
    }
  });

  let lastTap = { id: null, t: 0 };
  teamsSection.addEventListener("click", (e) => {
    if (!state.editMode) return;
    const playerBtn = e.target.closest(".player-btn");
    if (!playerBtn) return;
    const id = playerBtn.dataset.playerId;
    const now = Date.now();
    if (lastTap.id === id && now - lastTap.t < 400) {
      lastTap = { id: null, t: 0 };
      const teamId = playerBtn.dataset.teamId;
      const team = findTeam(teamId);
      const player = team.players.find((p) => p.id === id);
      showPrompt("선수 이름 (빈 칸으로 두면 삭제)", player.name, (newName) => {
        if (newName === "") {
          team.players = team.players.filter((p) => p.id !== id);
        } else {
          player.name = newName;
        }
        saveState();
        renderTeams();
      });
    } else {
      lastTap = { id, t: now };
    }
  }, true);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.timerRunning) {
      timerLastTick = Date.now();
      loopTimer();
    }
  });
}

bindEvents();
renderAll();
syncBoot();
