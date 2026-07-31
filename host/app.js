// Film-Geek host display — vanilla JS, no build step.
// Reads the same clip library the admin-tagging tool writes to Firestore
// (clipLibrary/{id}) — that's the durable source of truth, with
// localStorage kept only as an offline fallback. Room/round state syncs
// to Firestore so player phones can join teams and submit guesses; the
// answer itself is written to a host-only "private" doc so it's never
// readable from a player's browser before reveal. Scoring is per-team,
// not per-player.

import { db, authReady } from "../shared/firebase.js";
import {
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  onSnapshot,
  collection,
  serverTimestamp,
  increment,
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";

const STORAGE_KEY = "filmgeek_clips";
const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1, easy to read aloud
const GUESS_WINDOW_MS = 60000;

const els = {
  playerWrap: document.getElementById("player-wrap"),
  hud: document.getElementById("hud"),
  timer: document.getElementById("timer"),
  stopEarlyBtn: document.getElementById("stop-early-btn"),

  cover: document.getElementById("cover"),
  roomCodeDisplay: document.getElementById("room-code-display"),
  playerCount: document.getElementById("player-count"),
  roundIndicator: document.getElementById("round-indicator"),
  turnIndicator: document.getElementById("turn-indicator"),

  idlePanel: document.getElementById("idle-panel"),
  queueStatus: document.getElementById("queue-status"),
  startBtn: document.getElementById("start-btn"),

  noClipsPanel: document.getElementById("no-clips-panel"),
  importInput: document.getElementById("import-input"),

  endedPanel: document.getElementById("ended-panel"),
  guessTimer: document.getElementById("guess-timer"),
  guessCount: document.getElementById("guess-count"),
  revealBtn: document.getElementById("reveal-btn"),

  answerPanel: document.getElementById("answer-panel"),
  answerTitle: document.getElementById("answer-title"),
  answerMeta: document.getElementById("answer-meta"),
  resultsList: document.getElementById("results-list"),
  nextBtn: document.getElementById("next-btn"),

  allDonePanel: document.getElementById("all-done-panel"),
  reshuffleBtn: document.getElementById("reshuffle-btn"),

  errorPanel: document.getElementById("error-panel"),
  errorMessage: document.getElementById("error-message"),
  errorSkipBtn: document.getElementById("error-skip-btn"),
};

let clips = [];
let queue = []; // indices into `clips` not yet shown this round
let currentClip = null;

let ytPlayer = null;
let playerReady = false; // true only after the player's onReady event fires
let endWatcher = null;

const PLAYER_ERROR_MESSAGES = {
  2: "Invalid YouTube video ID for this clip.",
  5: "This clip can't be played in an embedded player (browser/HTML5 issue).",
  100: "This video was removed or made private.",
  101: "The video owner has disabled embedding for this clip.",
  150: "The video owner has disabled embedding for this clip.",
};

// ---------- Room / Firestore sync ----------
// If Firebase has a problem (offline, rules misconfigured, etc.), local
// single-screen playback still works — every Firestore call below is
// guarded so a sync failure never blocks the host from running the game.

let roomCode = null;
let currentRoundIndex = 0;
let currentGuesses = {}; // uid -> { teamId, movieGuess, directorGuess, yearGuess, submittedAt }
let teamsMap = {}; // teamId -> { name, emoji, score, memberNames, createdAt }
let activeTeamId = null; // whose turn it is this round
let unsubscribeGuesses = null;
let guessCountdownInterval = null;
let autoRevealTimeout = null;
let roundRevealed = false;

// Points scale up sharply with how many of the 3 fields (movie/director/
// year) a team got right, rather than 1 point per field — rewards a full
// correct guess much more than a partial one.
const POINTS_BY_CORRECT_COUNT = { 0: 0, 1: 2, 2: 5, 3: 10 };

// Stable turn order: whoever's team doc was created earliest goes first.
// Rotates through teams currently in the room — if a team joins mid-game
// it's added to the rotation from its creation order, same as anyone else.
function getTeamOrder() {
  return Object.entries(teamsMap)
    .sort((a, b) => (a[1].createdAt?.toMillis?.() ?? 0) - (b[1].createdAt?.toMillis?.() ?? 0))
    .map(([id]) => id);
}

function generateRoomCode() {
  let code = "";
  for (let i = 0; i < 4; i++) code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  return code;
}

async function ensureRoom() {
  try {
    const user = await authReady;
    const hostUid = user.uid;
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generateRoomCode();
      const ref = doc(db, "rooms", candidate);
      const snap = await getDoc(ref);
      if (!snap.exists()) {
        await setDoc(ref, {
          hostUid,
          phase: "lobby",
          roundIndex: 0,
          revealedAnswer: null,
          guessDeadline: null,
          createdAt: serverTimestamp(),
        });
        roomCode = candidate;
        break;
      }
    }
    if (!roomCode) return;
    els.roomCodeDisplay.textContent = roomCode;

    await publishMovieIndex();

    onSnapshot(collection(db, "rooms", roomCode, "teams"), (snap) => {
      teamsMap = {};
      snap.forEach((d) => (teamsMap[d.id] = d.data()));
      const teamCount = Object.keys(teamsMap).length;
      const playerCount = Object.values(teamsMap).reduce((sum, t) => sum + (t.memberNames?.length || 0), 0);
      els.playerCount.textContent =
        teamCount === 0
          ? "0 teams joined"
          : `${teamCount} team${teamCount === 1 ? "" : "s"}, ${playerCount} player${playerCount === 1 ? "" : "s"} joined`;
    });
  } catch (err) {
    els.playerCount.textContent = "Room sync unavailable — playing local-only.";
    console.error("ensureRoom failed", err);
  }
}

// Players never see which clip is playing, but they do need to know what
// movie titles/directors exist in the library to autocomplete/correct
// against — that's safe to publish since it doesn't reveal THIS round's
// answer, just the word bank.
async function publishMovieIndex() {
  if (!roomCode) return;
  const titles = [...new Set(clips.map((c) => c.movieTitle).filter(Boolean))].sort();
  const directors = [...new Set(clips.map((c) => c.director).filter(Boolean))].sort();
  await setDoc(doc(db, "rooms", roomCode, "public", "movieIndex"), { titles, directors }).catch((err) =>
    console.error("publishMovieIndex failed", err)
  );
}

async function startRoundInFirestore(clip) {
  if (!roomCode) return;
  try {
    currentRoundIndex += 1;
    roundRevealed = false;
    updateRoundIndicator();

    const teamOrder = getTeamOrder();
    activeTeamId = teamOrder.length ? teamOrder[(currentRoundIndex - 1) % teamOrder.length] : null;
    updateTurnIndicator();

    await setDoc(
      doc(db, "rooms", roomCode),
      { phase: "playing", roundIndex: currentRoundIndex, revealedAnswer: null, guessDeadline: null, activeTeamId },
      { merge: true }
    );
    await setDoc(doc(db, "rooms", roomCode, "private", "answer"), {
      youtubeId: clip.youtubeId,
      startSec: clip.startSec,
      endSec: clip.endSec,
      movieTitle: clip.movieTitle,
      year: clip.year,
      director: clip.director,
      cast: clip.cast,
      genre: clip.genre,
    });
    attachGuessListener(currentRoundIndex);
  } catch (err) {
    console.error("startRoundInFirestore failed", err);
  }
}

function attachGuessListener(roundIndex) {
  if (unsubscribeGuesses) unsubscribeGuesses();
  currentGuesses = {};
  els.guessCount.textContent = "";
  if (!roomCode) return;
  const ref = collection(db, "rooms", roomCode, "rounds", String(roundIndex), "guesses");
  unsubscribeGuesses = onSnapshot(ref, (snap) => {
    currentGuesses = {};
    snap.forEach((d) => (currentGuesses[d.id] = d.data()));
    const teamsAnswered = new Set(Object.values(currentGuesses).map((g) => g.teamId)).size;
    els.guessCount.textContent = teamsAnswered === 1 ? "1 team has answered" : `${teamsAnswered} teams have answered`;
  });
}

function startGuessWindow() {
  const deadline = Date.now() + GUESS_WINDOW_MS;
  if (roomCode) {
    updateDoc(doc(db, "rooms", roomCode), { phase: "guessing", guessDeadline: deadline }).catch((err) =>
      console.error("startGuessWindow failed", err)
    );
  }

  if (guessCountdownInterval) clearInterval(guessCountdownInterval);
  guessCountdownInterval = setInterval(() => {
    const remaining = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    els.guessTimer.textContent = remaining;
    if (remaining <= 0) {
      clearInterval(guessCountdownInterval);
      guessCountdownInterval = null;
    }
  }, 250);

  if (autoRevealTimeout) clearTimeout(autoRevealTimeout);
  autoRevealTimeout = setTimeout(() => {
    if (!roundRevealed) performReveal();
  }, GUESS_WINDOW_MS);
}

function stopGuessWindow() {
  if (guessCountdownInterval) {
    clearInterval(guessCountdownInterval);
    guessCountdownInterval = null;
  }
  if (autoRevealTimeout) {
    clearTimeout(autoRevealTimeout);
    autoRevealTimeout = null;
  }
}

// One guess per team per round: the earliest submission among a team's
// members is treated as the team's official answer ("collaborate, then
// whoever types it first locks it in" — matches how they'll actually play
// sitting in the same room).
function earliestGuessPerTeam() {
  const byTeam = {};
  for (const guess of Object.values(currentGuesses)) {
    if (!guess.teamId) continue;
    const existing = byTeam[guess.teamId];
    const t = guess.submittedAt?.toMillis?.() ?? 0;
    if (!existing || t < existing._t) {
      byTeam[guess.teamId] = { ...guess, _t: t };
    }
  }
  return byTeam;
}

function normalize(s) {
  return (s || "").trim().toLowerCase();
}

async function revealInFirestore(clip) {
  if (!roomCode) return { rows: [] };
  const rows = [];
  try {
    // Only the active team's turn counts for scoring, even if a stray
    // guess from another team somehow made it into Firestore — the
    // player app already only shows the guess form to the active team,
    // this is just belt-and-suspenders.
    const byTeam = earliestGuessPerTeam();
    const eligibleEntries = activeTeamId ? Object.entries(byTeam).filter(([teamId]) => teamId === activeTeamId) : [];
    for (const [teamId, guess] of eligibleEntries) {
      const team = teamsMap[teamId] || { name: "Unknown team", emoji: "❓" };
      const movieOk = normalize(guess.movieGuess) === normalize(clip.movieTitle);
      const directorOk = normalize(guess.directorGuess) === normalize(clip.director);
      const yearOk = String(guess.yearGuess || "").trim() === String(clip.year || "").trim();
      const correctCount = (movieOk ? 1 : 0) + (directorOk ? 1 : 0) + (yearOk ? 1 : 0);
      const points = POINTS_BY_CORRECT_COUNT[correctCount];

      rows.push({
        teamId,
        name: team.name,
        emoji: team.emoji,
        movieGuess: guess.movieGuess,
        directorGuess: guess.directorGuess,
        yearGuess: guess.yearGuess,
        movieOk,
        directorOk,
        yearOk,
        points,
        newTotal: (team.score || 0) + points,
      });

      if (points > 0) {
        await updateDoc(doc(db, "rooms", roomCode, "teams", teamId), { score: increment(points) }).catch(() => {});
      }
    }
    rows.sort((a, b) => b.points - a.points);

    await updateDoc(doc(db, "rooms", roomCode), {
      phase: "revealed",
      revealedAnswer: {
        movieTitle: clip.movieTitle,
        year: clip.year,
        director: clip.director,
        cast: clip.cast,
        genre: clip.genre,
      },
    });
  } catch (err) {
    console.error("revealInFirestore failed", err);
  }
  return { rows };
}

async function returnToLobby() {
  if (!roomCode) return;
  await updateDoc(doc(db, "rooms", roomCode), { phase: "lobby", guessDeadline: null }).catch(() => {});
}

// ---------- Clip library ----------
// Firestore (clipLibrary/{id}) is the durable source of truth, written by
// the admin-tagging tool. localStorage is kept only as an offline/fallback
// mirror, refreshed every time the cloud fetch succeeds.

function loadClipsFromLocalStorage() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveClips(list) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

async function fetchClipsFromCloud() {
  const user = await authReady;
  void user;
  const snap = await getDocs(collection(db, "clipLibrary"));
  const list = [];
  snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
  list.sort((a, b) => (a.addedAt || "").localeCompare(b.addedAt || ""));
  return list;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function initQueue() {
  queue = shuffle(clips.map((_, i) => i));
}

async function refreshLibrary() {
  try {
    const cloudClips = await fetchClipsFromCloud();
    clips = cloudClips.length > 0 ? cloudClips : loadClipsFromLocalStorage();
    saveClips(clips); // keep the local mirror fresh
  } catch (err) {
    console.error("Cloud clip fetch failed, falling back to local cache", err);
    clips = loadClipsFromLocalStorage();
  }

  if (clips.length === 0) {
    showPanel("no-clips");
    return;
  }
  initQueue();
  await publishMovieIndex();
  showIdle();
}

// ---------- Panel switching ----------
// Exactly one of these is visible inside the cover at a time; the cover
// itself is hidden only while a clip is actively playing.

function showPanel(name) {
  els.idlePanel.hidden = name !== "idle";
  els.noClipsPanel.hidden = name !== "no-clips";
  els.endedPanel.hidden = name !== "ended";
  els.answerPanel.hidden = name !== "answer";
  els.allDonePanel.hidden = name !== "all-done";
  els.errorPanel.hidden = name !== "error";
  els.cover.hidden = false;
}

function updateTurnIndicator() {
  const team = activeTeamId ? teamsMap[activeTeamId] : null;
  els.turnIndicator.textContent = team ? `${team.emoji} ${team.name}'s turn!` : "";
}

function updateRoundIndicator() {
  const roundNumber = Math.min(currentRoundIndex + 1, clips.length);
  els.roundIndicator.textContent = clips.length ? `Round ${roundNumber} of ${clips.length}` : "";
}

function showIdle() {
  updateRoundIndicator();
  els.queueStatus.textContent = queue.length > 0 ? "Ready when you are" : "Last round!";
  showPanel("idle");
}

// ---------- YouTube player ----------
// playerReady only flips true once the player's onReady event fires —
// the constructor exists as soon as the API script loads, but calling
// methods like loadVideoById before onReady can silently no-op.
//
// window.onYouTubeIframeAPIReady is the API's own callback hook, but it's
// only reliable if it's registered before the API finishes loading — and
// since our code runs as a deferred module script, on a repeat visit with
// the API script already cached, the API can finish and skip calling it
// before we've even registered it. Polling for YT.Player directly instead
// can't miss that window.

function createYtPlayerWhenApiReady() {
  if (!(window.YT && window.YT.Player)) {
    setTimeout(createYtPlayerWhenApiReady, 100);
    return;
  }

  // Deliberately NOT using host: "https://www.youtube-nocookie.com" here —
  // it's a nice privacy-domain touch, but its cross-origin postMessage
  // handshake with the parent page can get silently blocked by ad-blockers
  // and browser privacy settings, leaving onReady never firing. The
  // playerVars below already do the actual identity-hiding work.
  ytPlayer = new YT.Player("yt-player", {
    playerVars: {
      controls: 0,
      modestbranding: 1,
      rel: 0,
      iv_load_policy: 3,
      disablekb: 1,
      fs: 0,
      playsinline: 1,
      cc_load_policy: 0, // don't auto-show YouTube's own captions (won't remove captions burned into the video itself, if any)
    },
    events: {
      onReady: () => {
        playerReady = true;
        els.startBtn.disabled = false;
        els.startBtn.textContent = "▶ Start round";
      },
      onError: (e) => handlePlayerError(e.data),
    },
  });

  setTimeout(() => {
    if (!playerReady) {
      els.startBtn.textContent = "Still loading — check your connection or an ad-blocker, then reload";
    }
  }, 8000);
}

createYtPlayerWhenApiReady();

function handlePlayerError(code) {
  if (endWatcher) {
    clearInterval(endWatcher);
    endWatcher = null;
  }
  els.hud.hidden = true;
  els.errorMessage.textContent =
    PLAYER_ERROR_MESSAGES[code] || `Player error (code ${code}) — this clip may need re-tagging.`;
  showPanel("error");
}

els.errorSkipBtn.addEventListener("click", async () => {
  await returnToLobby();
  if (queue.length === 0) {
    showPanel("all-done");
  } else {
    showIdle();
  }
});

// YouTube shows a brief title/info overlay for the first couple seconds
// whenever a video starts playing — this happens even with controls
// disabled, it's a separate "just started" overlay, not the normal
// control bar. Starting slightly before the tagged startSec (hidden
// behind our cover) and revealing only after this buffer means viewers
// never see it, and the visible window still matches exactly what was
// tagged. If startSec is smaller than the buffer, we lose a bit of the
// front of the clip instead — a fine trade next to leaking the title.
const TITLE_OVERLAY_BUFFER_SEC = 2.5;

function playClip(clip) {
  currentClip = clip;
  const bufferedStart = Math.max(0, clip.startSec - TITLE_OVERLAY_BUFFER_SEC);

  ytPlayer.loadVideoById({ videoId: clip.youtubeId, startSeconds: bufferedStart });
  ytPlayer.playVideo();

  setTimeout(() => {
    els.cover.hidden = true;
    els.hud.hidden = false;
  }, TITLE_OVERLAY_BUFFER_SEC * 1000);

  if (endWatcher) clearInterval(endWatcher);
  endWatcher = setInterval(() => {
    const t = ytPlayer.getCurrentTime();
    const remaining = Math.max(0, clip.endSec - t);
    els.timer.textContent = remaining.toFixed(0);
    if (t >= clip.endSec) {
      finishClip();
    }
  }, 150);
}

function finishClip() {
  if (endWatcher) {
    clearInterval(endWatcher);
    endWatcher = null;
  }
  ytPlayer.pauseVideo();
  els.hud.hidden = true;
  showPanel("ended");
  els.guessTimer.textContent = "60";
  startGuessWindow();
}

els.stopEarlyBtn.addEventListener("click", finishClip);

// ---------- Round flow ----------

els.startBtn.addEventListener("click", async () => {
  if (!playerReady) return; // guarded by disabled attribute too; belt-and-suspenders
  if (queue.length === 0) {
    showPanel("all-done");
    return;
  }
  const idx = queue.pop();
  const clip = clips[idx];
  await startRoundInFirestore(clip); // fast (<1s typically); players need this before guessing
  playClip(clip);
});

async function performReveal() {
  if (roundRevealed || !currentClip) return;
  roundRevealed = true;
  stopGuessWindow();

  const c = currentClip;
  els.answerTitle.textContent = `${c.movieTitle}${c.year ? ` (${c.year})` : ""}`;
  const parts = [];
  if (c.director) parts.push(`<strong>Director:</strong> ${escapeHtml(c.director)}`);
  if (c.cast && c.cast.length) parts.push(`<strong>Cast:</strong> ${escapeHtml(c.cast.join(", "))}`);
  if (c.genre) parts.push(`<strong>Genre:</strong> ${escapeHtml(c.genre)}`);
  els.answerMeta.innerHTML = parts.join("<br>");

  const { rows } = await revealInFirestore(c);
  els.resultsList.innerHTML = rows.length
    ? rows
        .map(
          (r) => `<div>
            ${r.emoji} <strong>${escapeHtml(r.name)}</strong> — +${r.points} this round (${r.newTotal} total)<br>
            <span class="${r.movieOk ? "result-correct" : "result-wrong"}">Movie: ${escapeHtml(r.movieGuess || "—")} ${r.movieOk ? "✓" : "✗"}</span> ·
            <span class="${r.directorOk ? "result-correct" : "result-wrong"}">Director: ${escapeHtml(r.directorGuess || "—")} ${r.directorOk ? "✓" : "✗"}</span> ·
            <span class="${r.yearOk ? "result-correct" : "result-wrong"}">Year: ${escapeHtml(String(r.yearGuess || "—"))} ${r.yearOk ? "✓" : "✗"}</span>
          </div>`
        )
        .join("")
    : '<div class="hint">No team answered this round.</div>';

  showPanel("answer");
}

els.revealBtn.addEventListener("click", performReveal);

els.nextBtn.addEventListener("click", async () => {
  await returnToLobby();
  if (queue.length === 0) {
    showPanel("all-done");
  } else {
    showIdle();
  }
});

els.reshuffleBtn.addEventListener("click", async () => {
  await returnToLobby();
  initQueue();
  showIdle();
});

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

// ---------- Import (fallback when no clips tagged in this browser yet) ----------

els.importInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const imported = JSON.parse(text);
    if (!Array.isArray(imported)) throw new Error("Expected a JSON array of clips.");

    for (const incoming of imported) {
      const id = `${incoming.youtubeId}_${incoming.startSec}_${incoming.endSec}`;
      await setDoc(doc(db, "clipLibrary", id), incoming);
    }
    await refreshLibrary();
  } catch (err) {
    alert(`Import failed: ${err.message}`);
  } finally {
    e.target.value = "";
  }
});

// ---------- Init ----------

await refreshLibrary();
ensureRoom();
