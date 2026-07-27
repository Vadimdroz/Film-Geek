// Film-Geek host display — vanilla JS, no build step.
// Reads the same clip library the admin-tagging tool writes to (same-origin
// localStorage). Room/round state syncs to Firestore so player phones can
// join and submit guesses; the answer itself is written to a host-only
// "private" doc so it's never readable from a player's browser before reveal.

import { db, authReady } from "../shared/firebase.js";
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  onSnapshot,
  collection,
  serverTimestamp,
  increment,
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";

const STORAGE_KEY = "filmgeek_clips";
const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1, easy to read aloud

const els = {
  playerWrap: document.getElementById("player-wrap"),
  hud: document.getElementById("hud"),
  timer: document.getElementById("timer"),
  stopEarlyBtn: document.getElementById("stop-early-btn"),

  cover: document.getElementById("cover"),
  roomCodeDisplay: document.getElementById("room-code-display"),
  playerCount: document.getElementById("player-count"),

  idlePanel: document.getElementById("idle-panel"),
  queueStatus: document.getElementById("queue-status"),
  startBtn: document.getElementById("start-btn"),

  noClipsPanel: document.getElementById("no-clips-panel"),
  importInput: document.getElementById("import-input"),

  endedPanel: document.getElementById("ended-panel"),
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
let currentGuesses = {}; // uid -> { choice, submittedAt }
let playersMap = {}; // uid -> { name, score }
let unsubscribeGuesses = null;

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
          currentOptions: [],
          createdAt: serverTimestamp(),
        });
        roomCode = candidate;
        break;
      }
    }
    if (!roomCode) return;
    els.roomCodeDisplay.textContent = roomCode;

    onSnapshot(collection(db, "rooms", roomCode, "players"), (snap) => {
      playersMap = {};
      snap.forEach((d) => (playersMap[d.id] = d.data()));
      const n = Object.keys(playersMap).length;
      els.playerCount.textContent = n === 1 ? "1 player joined" : `${n} players joined`;
    });
  } catch (err) {
    els.playerCount.textContent = "Room sync unavailable — playing local-only.";
    console.error("ensureRoom failed", err);
  }
}

function pickDistractors(correctTitle, count) {
  const pool = [...new Set(clips.map((c) => c.movieTitle))].filter((t) => t !== correctTitle);
  return shuffle(pool).slice(0, count);
}

async function startRoundInFirestore(clip) {
  if (!roomCode) return;
  try {
    currentRoundIndex += 1;
    const options = shuffle([clip.movieTitle, ...pickDistractors(clip.movieTitle, 3)]);
    await setDoc(
      doc(db, "rooms", roomCode),
      { phase: "playing", roundIndex: currentRoundIndex, revealedAnswer: null, currentOptions: options },
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
    const n = Object.keys(currentGuesses).length;
    els.guessCount.textContent = n === 1 ? "1 player has answered" : `${n} players have answered`;
  });
}

async function revealInFirestore(clip) {
  if (!roomCode) return { rows: [] };
  const rows = [];
  try {
    for (const [uid, guess] of Object.entries(currentGuesses)) {
      const correct = guess.choice === clip.movieTitle;
      const name = (playersMap[uid] && playersMap[uid].name) || "Player";
      rows.push({ name, choice: guess.choice, correct });
      if (correct) {
        await updateDoc(doc(db, "rooms", roomCode, "players", uid), { score: increment(1) }).catch(() => {});
      }
    }
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
  await updateDoc(doc(db, "rooms", roomCode), { phase: "lobby" }).catch(() => {});
}

// ---------- Clip library ----------

function loadClips() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveClips(list) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
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

function refreshLibrary() {
  clips = loadClips();
  if (clips.length === 0) {
    showPanel("no-clips");
    return;
  }
  initQueue();
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

function showIdle() {
  els.queueStatus.textContent = `${queue.length} of ${clips.length} clips left in this round`;
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

function playClip(clip) {
  currentClip = clip;
  els.cover.hidden = true;
  els.hud.hidden = false;

  ytPlayer.loadVideoById({ videoId: clip.youtubeId, startSeconds: clip.startSec });
  ytPlayer.playVideo();

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
  await startRoundInFirestore(clip); // fast (<1s typically); players need options before guessing
  playClip(clip);
});

els.revealBtn.addEventListener("click", async () => {
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
          (r) =>
            `<div class="${r.correct ? "result-correct" : "result-wrong"}">${escapeHtml(r.name)}: ${escapeHtml(r.choice)} ${r.correct ? "✓" : "✗"}</div>`
        )
        .join("")
    : '<div class="hint">No one answered this round.</div>';

  showPanel("answer");
});

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

    const existing = loadClips();
    imported.forEach((incoming) => {
      const dupeIndex = existing.findIndex(
        (c) => c.youtubeId === incoming.youtubeId && c.startSec === incoming.startSec && c.endSec === incoming.endSec
      );
      if (dupeIndex >= 0) {
        existing[dupeIndex] = incoming;
      } else {
        existing.push(incoming);
      }
    });
    saveClips(existing);
    refreshLibrary();
  } catch (err) {
    alert(`Import failed: ${err.message}`);
  } finally {
    e.target.value = "";
  }
});

// ---------- Init ----------

refreshLibrary();
ensureRoom();
