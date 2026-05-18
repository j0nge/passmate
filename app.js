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
  return { id: uid("t"), name, color };
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
    sideSwapped: false,
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
    parsed.sideSwapped = !!parsed.sideSwapped;
    // Drop legacy `players` array from each team — player feature removed
    parsed.teams.forEach((t) => { delete t.players; });
    // Strip player references from history
    parsed.history = parsed.history.filter((h) => !h.playerId);
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
let syncPushInFlight = false;
let syncLastHash = "";

function syncableFields() {
  return {
    teams: state.teams,
    matches: state.matches,
    rotation: state.rotation,
    rotationIdx: state.rotationIdx,
    history: state.history,
    quarterDurationSeconds: state.quarterDurationSeconds,
    sideSwapped: state.sideSwapped,
  };
}

function hashFields(v) { try { return JSON.stringify(v); } catch (e) { return ""; } }

function syncMarkLocal() {
  syncLastHash = hashFields(syncableFields());
}

function setSyncIndicator() { /* sync dot removed per user request */ }

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
  // Don't apply remote while we have an unsynced local change in flight —
  // otherwise the server's stale view would clobber the user's just-made +1.
  if (syncPushDebounce || syncPushInFlight) return;
  try {
    const r = await fetch(SYNC_URL, { cache: "no-store" });
    if (!r.ok) return;
    const data = await r.json();
    if (!data.state) return;
    // Re-check: a local change may have happened during the network round-trip.
    if (syncPushDebounce || syncPushInFlight) return;
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
    syncPushInFlight = true;
    try {
      const body = syncableFields();
      syncLastHash = hashFields(body);
      await fetch(SYNC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
    } finally {
      syncPushInFlight = false;
    }
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
  if (typeof remote.sideSwapped === "boolean") state.sideSwapped = remote.sideSwapped;
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

function addScore(teamId) {
  const m = currentMatch();
  if (!m) { showToast("매치업을 먼저 선택하세요"); return; }
  if (m.teamAId !== teamId && m.teamBId !== teamId) return;
  if (m.teamAId === teamId) m.scoreA += 1;
  else m.scoreB += 1;
  state.history.push({
    type: "score",
    matchIdx: currentMatchIndex(),
    teamId,
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
  if (state.teams.length < 2) {
    showToast("팀이 2개 이상 필요합니다");
    return;
  }
  // User explicitly picks white/black for every new quarter.
  showMatchupModal({ mode: "next" });
}

function commitNewMatch(whiteId, blackId) {
  if (whiteId === blackId) return;
  state.matches.push({
    teamAId: whiteId, // teamA = white-jersey team this quarter
    teamBId: blackId, // teamB = black-jersey team this quarter
    scoreA: 0,
    scoreB: 0,
  });
  state.timerSecondsLeft = state.quarterDurationSeconds;
  state.timerRunning = false;
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
  const idx = state.rotation.findIndex(
    (p) =>
      (p.teamAId === whiteId && p.teamBId === blackId) ||
      (p.teamAId === blackId && p.teamBId === whiteId)
  );
  if (idx !== -1) state.rotationIdx = idx;
  saveState();
  renderAll();
  showToast(`Q${state.matches.length} 매치업 준비`);
}

function setCurrentMatchTeams(whiteId, blackId) {
  if (whiteId === blackId) return;
  const m = currentMatch();
  if (!m) return;
  m.teamAId = whiteId;
  m.teamBId = blackId;
  m.scoreA = 0;
  m.scoreB = 0;
  // history에서 이 매치 관련 점수 항목들도 정리(점수 0이라 의미 X)
  state.history = state.history.filter((h) => h.matchIdx !== currentMatchIndex());
  const idx = state.rotation.findIndex(
    (p) =>
      (p.teamAId === whiteId && p.teamBId === blackId) ||
      (p.teamAId === blackId && p.teamBId === whiteId)
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

// Synthesize a "pea whistle" referee whistle: high-pitched square with
// fast vibrato for the characteristic warble, short sharp envelope.
function playWhistle() {
  try {
    ensureAudio();
    if (!audioCtx) return;
    const now = audioCtx.currentTime;
    const dur = 0.5;

    // Main tone — square wave at ~3.1kHz
    const osc = audioCtx.createOscillator();
    osc.type = "square";
    osc.frequency.setValueAtTime(3100, now);

    // Vibrato LFO — modulates the main oscillator's frequency
    const lfo = audioCtx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 24; // warble rate
    const lfoGain = audioCtx.createGain();
    lfoGain.gain.value = 140; // warble depth in Hz
    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);

    // Loud, fast-attack envelope
    const env = audioCtx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(0.4, now + 0.015);
    env.gain.setValueAtTime(0.4, now + dur - 0.05);
    env.gain.linearRampToValueAtTime(0, now + dur);

    // Bandpass to soften the hard edges of square wave
    const bp = audioCtx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 3100;
    bp.Q.value = 4;

    osc.connect(bp);
    bp.connect(env);
    env.connect(audioCtx.destination);

    lfo.start(now);
    osc.start(now);
    lfo.stop(now + dur + 0.05);
    osc.stop(now + dur + 0.05);
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
  // The standalone matchup pill is gone; team identity now lives in each
  // card header. Kept as a no-op so other render paths that call it don't
  // break, and so any future header summary can plug in here.
}

const JERSEY_SVG = `<svg class="jersey" viewBox="0 0 32 32" aria-hidden="true">
  <path d="M11 4 L4 7.5 L6.5 14 L10 12.5 V27 H22 V12.5 L25.5 14 L28 7.5 L21 4 L19 5.5 C18.2 6.3 17.2 6.7 16 6.7 C14.8 6.7 13.8 6.3 13 5.5 L11 4 Z"
    fill="var(--jersey-fill)" stroke="var(--jersey-stroke)" stroke-width="1.4" stroke-linejoin="round"/>
</svg>`;

function renderTeams() {
  const root = document.getElementById("teamsSection");
  root.innerHTML = "";

  if (state.editMode) {
    renderEditModeTeams(root);
    document.body.classList.add("edit-mode");
    return;
  }
  document.body.classList.remove("edit-mode");

  const m = currentMatch();
  if (!m) {
    root.innerHTML = `<div class="empty-match">매치업이 없습니다 — '다음 쿼터'로 시작하세요</div>`;
    return;
  }
  const whiteTeam = findTeam(m.teamAId);
  const blackTeam = findTeam(m.teamBId);
  if (!whiteTeam || !blackTeam) {
    // Match references a deleted team — drop it and recover
    state.matches.pop();
    ensureCurrentMatch();
    renderAll();
    return;
  }
  const tot = pairingTotal(whiteTeam.id, blackTeam.id);
  const whiteCard = buildPlayCard({
    side: "white", team: whiteTeam, opponent: blackTeam,
    score: m.scoreA, pairScore: tot.a,
  });
  const blackCard = buildPlayCard({
    side: "black", team: blackTeam, opponent: whiteTeam,
    score: m.scoreB, pairScore: tot.b,
  });
  if (state.sideSwapped) {
    root.appendChild(blackCard);
    root.appendChild(whiteCard);
  } else {
    root.appendChild(whiteCard);
    root.appendChild(blackCard);
  }
}

function buildPlayCard({ side, team, opponent, score, pairScore }) {
  const card = document.createElement("div");
  card.className = `team-card team-card-${side}`;
  card.dataset.teamId = team.id;
  card.dataset.side = side;
  card.innerHTML = `
    <button class="team-header" type="button" data-action="change-matchup" aria-label="매치업 팀 변경">
      ${JERSEY_SVG}
      <div class="team-meta">
        <div class="team-side-label">${side === "white" ? "화이트" : "블랙"}</div>
        <div class="team-name-display">${escapeHtml(team.name)}</div>
      </div>
      <svg class="team-edit-hint" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3 17.5 V21 H6.5 L17 10.5 L13.5 7 L3 17.5 Z" fill="var(--jersey-fill)" stroke="var(--jersey-stroke)" stroke-width="1.4" stroke-linejoin="round"/>
        <path d="M14.5 5.5 L17 3 L21 7 L18.5 9.5 L14.5 5.5 Z" fill="var(--jersey-fill)" stroke="var(--jersey-stroke)" stroke-width="1.4" stroke-linejoin="round"/>
      </svg>
    </button>
    <div class="score-area" data-team-id="${team.id}">
      <div class="score-current">${score}</div>
      <div class="score-foot">vs ${escapeHtml(opponent.name)} 누적 <strong>${pairScore}</strong></div>
    </div>
    <div class="score-controls">
      <button class="btn small minus" data-team-id="${team.id}">−1</button>
    </div>
  `;
  return card;
}

function renderEditModeTeams(root) {
  const list = document.createElement("div");
  list.className = "team-edit-list";
  state.teams.forEach((team) => {
    const row = document.createElement("div");
    row.className = "team-edit-row";
    row.dataset.teamId = team.id;
    row.innerHTML = `
      <input class="team-name" value="${escapeHtml(team.name)}" />
      <button class="btn small ghost danger del-team" type="button">삭제</button>
    `;
    list.appendChild(row);
  });
  root.appendChild(list);
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
    const card = document.createElement("div");
    card.className = `pairing-card ${isActive ? "active" : ""}`;
    card.innerHTML = `
      <div class="pairing-side left">
        <div class="pname">${escapeHtml(a.name)}</div>
        <div class="pscore">${total.a}</div>
      </div>
      <div class="pairing-divider">:</div>
      <div class="pairing-side right">
        <div class="pname">${escapeHtml(b.name)}</div>
        <div class="pscore">${total.b}</div>
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

function showMatchupModal({ mode = "replace" } = {}) {
  if (state.teams.length < 2) { showToast("팀이 2개 이상 필요합니다"); return; }
  const m = currentMatch();
  // 'next' mode → start empty so the user MUST pick fresh every quarter.
  // 'replace' mode → seed with current match so a small tweak is one tap.
  let selWhite = null;
  let selBlack = null;
  if (mode === "replace" && m) {
    selWhite = m.teamAId;
    selBlack = m.teamBId;
  }

  const titleEl = document.getElementById("matchupModalTitle");
  if (titleEl) {
    titleEl.textContent = mode === "next"
      ? `Q${state.matches.length + 1} 매치업 — 옷 색깔 선택`
      : "이번 쿼터 매치업 변경";
  }

  const renderPickers = () => {
    const renderColumn = (containerId, selected, otherSelected, onPick) => {
      const root = document.getElementById(containerId);
      root.innerHTML = "";
      state.teams.forEach((t) => {
        const btn = document.createElement("button");
        btn.className = "picker-option" + (t.id === selected ? " selected" : "");
        btn.disabled = t.id === otherSelected;
        btn.textContent = t.name;
        btn.addEventListener("click", () => { onPick(t.id); });
        root.appendChild(btn);
      });
    };
    renderColumn("pickerA", selWhite, selBlack, (id) => { selWhite = id; renderPickers(); });
    renderColumn("pickerB", selBlack, selWhite, (id) => { selBlack = id; renderPickers(); });
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
    if (!selWhite || !selBlack) { showToast("화이트와 블랙 모두 선택해주세요"); return; }
    if (selWhite === selBlack) { showToast("서로 다른 두 팀을 선택하세요"); return; }
    cleanup();
    if (mode === "next") commitNewMatch(selWhite, selBlack);
    else setCurrentMatchTeams(selWhite, selBlack);
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
  const matchupBtn = document.getElementById("matchupBtn");
  if (matchupBtn) matchupBtn.addEventListener("click", () => {
    if (state.editMode) return;
    showMatchupModal({ mode: "replace" });
  });
  const changeMatchupBtn = document.getElementById("changeMatchupBtn");
  if (changeMatchupBtn) changeMatchupBtn.addEventListener("click", () => {
    if (state.editMode) return;
    showMatchupModal({ mode: "replace" });
  });

  const whistleBtn = document.getElementById("whistleBtn");
  if (whistleBtn) {
    whistleBtn.addEventListener("click", () => {
      ensureAudio();
      playWhistle();
      whistleBtn.classList.add("whistle-flash");
      setTimeout(() => whistleBtn.classList.remove("whistle-flash"), 250);
    });
  }

  const swapBtn = document.getElementById("swapSidesBtn");
  if (swapBtn) {
    swapBtn.addEventListener("click", () => {
      state.sideSwapped = !state.sideSwapped;
      saveState();
      renderTeams();
    });
  }

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
    // Generic cancel handler — closes parent modal. showConfirm/showPrompt/
    // showMatchupModal also register their own to clean up their OK listener,
    // both fire on cancel which is idempotent.
    const cancelBtn = modal.querySelector(".modal-cancel");
    if (cancelBtn) {
      cancelBtn.addEventListener("click", () => modal.classList.add("hidden"));
    }
  });

  const brand = document.getElementById("brandReload");
  if (brand) {
    const doReload = () => {
      // Push any pending change immediately so we don't lose unsynced state
      if (typeof syncPushDebounce !== "undefined" && syncPushDebounce) {
        clearTimeout(syncPushDebounce);
        syncPushDebounce = null;
        syncPush(true);
      }
      // Small delay to let the push start before navigation
      setTimeout(() => window.location.reload(), 80);
    };
    brand.addEventListener("click", doReload);
    brand.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); doReload(); }
    });
  }

  document.getElementById("toggleEdit").addEventListener("click", (e) => {
    state.editMode = !state.editMode;
    e.target.textContent = state.editMode ? "완료" : "편집";
    saveState();
    renderAll();
  });

  document.getElementById("resetAllBtn").addEventListener("click", () => {
    showConfirm(
      "전체 초기화",
      "모든 매치 점수와 페어링 누적이 0으로 리셋됩니다. 팀 명단은 유지됩니다. 진행할까요?",
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
    if (state.editMode) {
      // Only handle team delete in edit mode; score taps are disabled.
      const delTeam = e.target.closest(".del-team");
      if (delTeam) {
        const row = delTeam.closest("[data-team-id]");
        const teamId = row.dataset.teamId;
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
      }
      return;
    }

    // Play mode
    const headerBtn = e.target.closest('[data-action="change-matchup"]');
    if (headerBtn) {
      ensureAudio();
      showMatchupModal({ mode: "replace" });
      return;
    }
    const scoreArea = e.target.closest(".score-area");
    if (scoreArea) {
      ensureAudio();
      addScore(scoreArea.dataset.teamId);
      return;
    }
    const minus = e.target.closest(".minus");
    if (minus) {
      manualSubtract(minus.dataset.teamId);
      return;
    }
  });

  teamsSection.addEventListener("change", (e) => {
    if (e.target.classList.contains("team-name")) {
      const row = e.target.closest("[data-team-id]");
      const team = findTeam(row.dataset.teamId);
      if (team) {
        const v = e.target.value.trim();
        if (v) team.name = v; else e.target.value = team.name;
        saveState();
        renderMatchupBar();
        renderTables();
      }
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.timerRunning) {
      timerLastTick = Date.now();
      loopTimer();
    }
  });
}

bindEvents();
bindScrollHide();
bindA2hs();
renderAll();
syncBoot();
maybeShowA2hs();

// ====== A2HS (Add to Home Screen) guide ======

const A2HS_DISMISS_KEY = "passmate-a2hs-dismissed-v1";

function isMobileOrTabletDevice() {
  const narrow = window.matchMedia("(max-width: 1023px)").matches;
  const touchUA = /Mobi|Tablet|iPad|iPhone|Android/i.test(navigator.userAgent);
  // Some iPads identify as Mac — also check touchpoints
  const iPadOnMac = /Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1;
  return narrow && (touchUA || iPadOnMac);
}

function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true
  );
}

function detectPlatform() {
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return "ios";
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return "ios";
  return "android";
}

function selectA2hsTab(platform) {
  document.querySelectorAll(".a2hs-tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.platform === platform);
  });
  document.querySelectorAll(".a2hs-panel").forEach((p) => {
    p.classList.toggle("hidden", p.dataset.panel !== platform);
  });
}

function showA2hsModal() {
  const modal = document.getElementById("a2hsModal");
  if (!modal) return;
  selectA2hsTab(detectPlatform());
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
}

function hideA2hsModal() {
  const modal = document.getElementById("a2hsModal");
  if (!modal) return;
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
}

function maybeShowA2hs() {
  if (isStandalone()) return;
  if (!isMobileOrTabletDevice()) return;
  if (localStorage.getItem(A2HS_DISMISS_KEY) === "yes") return;
  // small delay so the modal doesn't slam in on first paint
  setTimeout(showA2hsModal, 900);
}

function bindA2hs() {
  document.querySelectorAll(".a2hs-tab").forEach((t) => {
    t.addEventListener("click", () => selectA2hsTab(t.dataset.platform));
  });
  const closeBtn = document.getElementById("a2hsCloseBtn");
  const dismissBtn = document.getElementById("a2hsDismissBtn");
  const openBtn = document.getElementById("a2hsBtn");
  if (closeBtn) closeBtn.addEventListener("click", hideA2hsModal);
  if (dismissBtn) {
    dismissBtn.addEventListener("click", () => {
      try { localStorage.setItem(A2HS_DISMISS_KEY, "yes"); } catch (e) {}
      hideA2hsModal();
    });
  }
  if (openBtn) openBtn.addEventListener("click", showA2hsModal);
}

function bindScrollHide() {
  const bar = document.querySelector(".topbar");
  if (!bar) return;
  let lastY = window.scrollY;
  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const y = window.scrollY;
      const dy = y - lastY;
      if (Math.abs(dy) > 4) {
        if (dy > 0 && y > 40) bar.classList.add("hidden-bar");
        else if (dy < 0) bar.classList.remove("hidden-bar");
        lastY = y;
      }
      if (y < 8) bar.classList.remove("hidden-bar");
      ticking = false;
    });
  };
  window.addEventListener("scroll", onScroll, { passive: true });
}
