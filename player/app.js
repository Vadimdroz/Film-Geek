// Film-Geek player app — vanilla JS, no build step.
// Joins a TEAM (not just yourself) by room code, and the team submits one
// shared answer per round (first team member to submit locks it in — you're
// all in the same room, so you'll agree out loud before typing). Never has
// access to the answer until the host reveals it (Firestore rules enforce
// this, not just the UI). See /firestore.rules for the actual access control.

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
  arrayUnion,
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";

const ROOM_KEY = "filmgeek_player_room";
const TEAM_ID_KEY = "filmgeek_player_team_id";
const NAME_KEY = "filmgeek_player_name";

const EMOJI_SET = ["🍿", "🎬", "🕶️", "🦖", "🐉", "👽", "🤖", "🧙", "🥷", "🦸", "🎭", "🍕", "🐒", "🚀", "💀", "👑", "🎩", "🔫"];

const els = {
  topBar: document.getElementById("top-bar"),
  topRoom: document.getElementById("top-room"),
  topTeam: document.getElementById("top-team"),
  leaveRoomBtn: document.getElementById("leave-room-btn"),

  screens: {
    join: document.getElementById("join-screen"),
    waiting: document.getElementById("waiting-screen"),
    guessing: document.getElementById("guessing-screen"),
    locked: document.getElementById("locked-screen"),
    revealed: document.getElementById("revealed-screen"),
  },

  roomCodeInput: document.getElementById("room-code-input"),
  teamNameInput: document.getElementById("team-name-input"),
  nameInput: document.getElementById("name-input"),
  emojiGrid: document.getElementById("emoji-grid"),
  joinBtn: document.getElementById("join-btn"),
  joinError: document.getElementById("join-error"),

  waitingTitle: document.getElementById("waiting-title"),
  waitingMessage: document.getElementById("waiting-message"),

  playerTimer: document.getElementById("player-timer"),
  movieInput: document.getElementById("movie-input"),
  movieCorrection: document.getElementById("movie-correction"),
  directorInput: document.getElementById("director-input"),
  directorCorrection: document.getElementById("director-correction"),
  yearInput: document.getElementById("year-input"),
  submitGuessBtn: document.getElementById("submit-guess-btn"),

  lockedSummary: document.getElementById("locked-summary"),

  revealedTitle: document.getElementById("revealed-title"),
  revealedMeta: document.getElementById("revealed-meta"),
  revealedBreakdown: document.getElementById("revealed-breakdown"),

  leaderboard: document.getElementById("leaderboard"),
  leaderboardList: document.getElementById("leaderboard-list"),
};

let roomCode = null;
let myUid = null;
let teamId = null;
let teamName = null;
let teamEmoji = null;
let playerName = null;
let selectedEmoji = null;

let currentPhase = null;
let lastSeenRoundIndex = -1;
let myTeamGuessThisRound = null;
let movieIndex = { titles: [], directors: [] };
let teamsCache = {}; // teamId -> team data, for looking up whose turn it is
let currentActiveTeamId = null;

let unsubRoom = null;
let unsubGuesses = null;
let unsubTeams = null;
let countdownInterval = null;

function normalize(s) {
  return (s || "").trim().toLowerCase();
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

// ---------- Fuzzy match (Levenshtein) for director typo-correction ----------

function levenshtein(a, b) {
  a = a.toLowerCase();
  b = b.toLowerCase();
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function nearestMatch(input, candidates) {
  if (!input || candidates.length === 0) return null;
  let best = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = levenshtein(input, c);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  if (!best) return null;
  // Only offer a suggestion for genuinely close typos (up to 4 letters
  // off) — beyond that it's more likely a different name entirely, and
  // suggesting it would be more confusing than helpful.
  return bestDist <= 4 ? { match: best, distance: bestDist } : null;
}

// ---------- Screens ----------

function showScreen(name) {
  for (const [key, el] of Object.entries(els.screens)) {
    el.hidden = key !== name;
  }
}

function showJoinError(message) {
  els.joinError.textContent = message;
}

// ---------- Emoji picker ----------

function renderEmojiGrid() {
  els.emojiGrid.innerHTML = "";
  EMOJI_SET.forEach((emoji) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "emoji-btn";
    btn.textContent = emoji;
    btn.addEventListener("click", () => {
      selectedEmoji = emoji;
      [...els.emojiGrid.children].forEach((c) => c.classList.remove("selected"));
      btn.classList.add("selected");
    });
    els.emojiGrid.appendChild(btn);
  });
}
renderEmojiGrid();

// ---------- Suggestions ----------
// No live-as-you-type dropdown — suggestions only appear once the player
// finishes typing and presses Enter (or submits), and only as a "Did you
// mean X?" they must click to accept, never a silent auto-fill. This
// applies the same way to both the movie title and director fields.

function clearSuggestion(correctionEl) {
  correctionEl.hidden = true;
  correctionEl.innerHTML = "";
}

function checkForSuggestion(input, correctionEl, candidates) {
  clearSuggestion(correctionEl);
  const val = input.value.trim();
  if (!val || candidates.length === 0) return;

  const exact = candidates.find((c) => c.toLowerCase() === val.toLowerCase());
  if (exact) {
    input.value = exact; // just canonicalizing casing, not a real correction
    return;
  }

  const nearest = nearestMatch(val, candidates);
  if (nearest) {
    correctionEl.hidden = false;
    const label = document.createElement("span");
    label.textContent = "Did you mean ";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "suggestion-btn";
    btn.textContent = nearest.match;
    btn.addEventListener("click", () => {
      input.value = nearest.match;
      clearSuggestion(correctionEl);
    });
    const question = document.createElement("span");
    question.textContent = "?";
    correctionEl.appendChild(label);
    correctionEl.appendChild(btn);
    correctionEl.appendChild(question);
  }
}

function setupSuggestionCheck(input, correctionEl, getCandidates) {
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      checkForSuggestion(input, correctionEl, getCandidates());
    }
  });
}

function setupAutocompletes() {
  setupSuggestionCheck(els.movieInput, els.movieCorrection, () => movieIndex.titles);
  setupSuggestionCheck(els.directorInput, els.directorCorrection, () => movieIndex.directors);
}

// ---------- Join ----------

els.joinBtn.addEventListener("click", async () => {
  const code = els.roomCodeInput.value.trim().toUpperCase();
  const teamNameInput = els.teamNameInput.value.trim();
  const name = els.nameInput.value.trim();
  showJoinError("");

  if (code.length !== 4) {
    showJoinError("Room codes are 4 characters.");
    return;
  }
  if (!teamNameInput) {
    showJoinError("Pick a team name.");
    return;
  }
  if (!name) {
    showJoinError("Enter your name.");
    return;
  }
  if (!selectedEmoji) {
    showJoinError("Pick a team avatar below.");
    return;
  }

  els.joinBtn.disabled = true;
  els.joinBtn.textContent = "Joining…";
  try {
    const user = await authReady;
    myUid = user.uid;

    const roomSnap = await getDoc(doc(db, "rooms", code));
    if (!roomSnap.exists()) {
      showJoinError("Room not found — double check the code with the host.");
      return;
    }

    const teamsSnap = await getDocs(collection(db, "rooms", code, "teams"));
    let matchedId = null;
    let matchedData = null;
    teamsSnap.forEach((d) => {
      if (!matchedId && normalize(d.data().name) === normalize(teamNameInput)) {
        matchedId = d.id;
        matchedData = d.data();
      }
    });

    if (matchedId) {
      teamId = matchedId;
      teamName = matchedData.name;
      teamEmoji = matchedData.emoji;
      await updateDoc(doc(db, "rooms", code, "teams", teamId), { memberNames: arrayUnion(name) });
    } else {
      teamId = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}${Math.random()}`).slice(0, 8);
      teamName = teamNameInput;
      teamEmoji = selectedEmoji;
      await setDoc(doc(db, "rooms", code, "teams", teamId), {
        name: teamName,
        emoji: teamEmoji,
        score: 0,
        memberNames: [name],
        createdAt: serverTimestamp(),
      });
    }

    roomCode = code;
    playerName = name;
    localStorage.setItem(ROOM_KEY, code);
    localStorage.setItem(TEAM_ID_KEY, teamId);
    localStorage.setItem(NAME_KEY, name);

    await loadMovieIndex();
    startSession();
  } catch (err) {
    showJoinError(`Couldn't join: ${err.message}`);
  } finally {
    els.joinBtn.disabled = false;
    els.joinBtn.textContent = "Join";
  }
});

async function loadMovieIndex() {
  const snap = await getDoc(doc(db, "rooms", roomCode, "public", "movieIndex"));
  movieIndex = snap.exists() ? snap.data() : { titles: [], directors: [] };
  setupAutocompletes();
}

// ---------- Live session ----------

function startSession() {
  els.topBar.hidden = false;
  els.topRoom.textContent = `Room ${roomCode}`;
  showScreen("waiting");
  attachRoomListener();
  attachTeamsListener();
}

function attachRoomListener() {
  if (unsubRoom) unsubRoom();
  unsubRoom = onSnapshot(doc(db, "rooms", roomCode), (snap) => {
    const data = snap.data();
    if (data) handleRoomUpdate(data);
  });
}

function attachTeamsListener() {
  if (unsubTeams) unsubTeams();
  unsubTeams = onSnapshot(collection(db, "rooms", roomCode, "teams"), (snap) => {
    const teams = [];
    teamsCache = {};
    snap.forEach((d) => {
      const t = { id: d.id, ...d.data() };
      teams.push(t);
      teamsCache[d.id] = t;
    });
    teams.sort((a, b) => (b.score || 0) - (a.score || 0));

    els.leaderboard.hidden = teams.length === 0;
    els.leaderboardList.innerHTML = teams
      .map(
        (t) =>
          `<div class="leaderboard-row"><span class="lb-name">${t.emoji || "❓"} ${escapeHtml(t.name || "Team")}</span><span class="lb-score">${t.score || 0}</span></div>`
      )
      .join("");

    const mine = teams.find((t) => t.id === teamId);
    els.topTeam.textContent = mine ? `${mine.emoji} ${mine.name} — ${mine.score || 0} pts` : "—";
  });
}

function attachRoundGuessListener(roundIndex) {
  if (unsubGuesses) unsubGuesses();
  myTeamGuessThisRound = null;
  els.movieInput.value = "";
  els.directorInput.value = "";
  els.yearInput.value = "";
  clearSuggestion(els.movieCorrection);
  clearSuggestion(els.directorCorrection);

  const ref = collection(db, "rooms", roomCode, "rounds", String(roundIndex), "guesses");
  unsubGuesses = onSnapshot(ref, (snap) => {
    myTeamGuessThisRound = null;
    snap.forEach((d) => {
      const g = d.data();
      if (g.teamId === teamId) myTeamGuessThisRound = g;
    });
    if (currentPhase === "guessing") renderGuessingOrLocked();
  });
}

function isMyTurn() {
  return currentActiveTeamId && currentActiveTeamId === teamId;
}

function activeTeamLabel() {
  const t = currentActiveTeamId && teamsCache[currentActiveTeamId];
  return t ? `${t.emoji} ${t.name}` : "another team";
}

function handleRoomUpdate(data) {
  currentPhase = data.phase;
  currentActiveTeamId = data.activeTeamId || null;

  if (data.roundIndex !== lastSeenRoundIndex) {
    lastSeenRoundIndex = data.roundIndex;
    attachRoundGuessListener(data.roundIndex);
  }

  if (data.phase === "playing") {
    stopCountdown();
    if (isMyTurn()) {
      els.waitingTitle.textContent = "🎬 Your turn!";
      els.waitingMessage.textContent = "Watch the TV — get ready to answer once the clip ends.";
    } else {
      els.waitingTitle.textContent = "🎬 Watch the TV!";
      els.waitingMessage.textContent = `It's ${activeTeamLabel()}'s turn to answer — you're just watching this round.`;
    }
    showScreen("waiting");
  } else if (data.phase === "guessing") {
    if (isMyTurn()) {
      startCountdown(data.guessDeadline);
      renderGuessingOrLocked();
    } else {
      stopCountdown();
      els.waitingTitle.textContent = "⏳ Not your turn";
      els.waitingMessage.textContent = `${activeTeamLabel()} is answering this round. Hang tight for the reveal!`;
      showScreen("waiting");
    }
  } else if (data.phase === "revealed") {
    stopCountdown();
    renderRevealed(data.revealedAnswer);
  } else {
    stopCountdown();
    els.waitingTitle.textContent = "You're in!";
    els.waitingMessage.textContent = "Waiting for the host to start the next round…";
    showScreen("waiting");
  }
}

function renderGuessingOrLocked() {
  if (myTeamGuessThisRound) {
    showLocked(myTeamGuessThisRound);
  } else {
    showScreen("guessing");
  }
}

function showLocked(guess) {
  showScreen("locked");
  els.lockedSummary.innerHTML = `Movie: <strong>${escapeHtml(guess.movieGuess || "—")}</strong><br>Director: <strong>${escapeHtml(guess.directorGuess || "—")}</strong><br>Year: <strong>${escapeHtml(String(guess.yearGuess || "—"))}</strong>`;
}

// ---------- Countdown ----------

function startCountdown(deadline) {
  stopCountdown();
  const tick = () => {
    const remaining = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    els.playerTimer.textContent = remaining;
    if (remaining <= 0 && countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
  };
  tick();
  countdownInterval = setInterval(tick, 250);
}

function stopCountdown() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
}

// ---------- Submit guess ----------

els.submitGuessBtn.addEventListener("click", async () => {
  const movieGuess = els.movieInput.value.trim();
  const directorGuess = els.directorInput.value.trim();
  const yearGuess = els.yearInput.value.trim();
  if (!movieGuess && !directorGuess && !yearGuess) {
    alert("Type at least something before locking in!");
    return;
  }

  els.submitGuessBtn.disabled = true;
  els.submitGuessBtn.textContent = "Locking in…";
  try {
    await setDoc(doc(db, "rooms", roomCode, "rounds", String(lastSeenRoundIndex), "guesses", myUid), {
      teamId,
      movieGuess,
      directorGuess,
      yearGuess,
      submittedAt: serverTimestamp(),
    });
    // The round-guess listener will pick this up and flip to the locked
    // screen automatically once Firestore confirms the write.
  } catch (err) {
    alert(`Couldn't submit your guess: ${err.message}`);
  } finally {
    els.submitGuessBtn.disabled = false;
    els.submitGuessBtn.textContent = "Lock in answer";
  }
});

// ---------- Reveal ----------

function renderRevealed(answer) {
  showScreen("revealed");
  if (!answer) return;

  els.revealedTitle.textContent = `${answer.movieTitle}${answer.year ? ` (${answer.year})` : ""}`;
  els.revealedMeta.textContent = answer.director ? `Directed by ${answer.director}` : "";

  const guess = myTeamGuessThisRound;
  if (guess) {
    const movieOk = normalize(guess.movieGuess) === normalize(answer.movieTitle);
    const directorOk = normalize(guess.directorGuess) === normalize(answer.director);
    const yearOk = String(guess.yearGuess || "").trim() === String(answer.year || "").trim();
    els.revealedBreakdown.innerHTML = `
      <div class="${movieOk ? "result-correct" : "result-wrong"}">Movie: ${escapeHtml(guess.movieGuess || "—")} ${movieOk ? "✓" : "✗"}</div>
      <div class="${directorOk ? "result-correct" : "result-wrong"}">Director: ${escapeHtml(guess.directorGuess || "—")} ${directorOk ? "✓" : "✗"}</div>
      <div class="${yearOk ? "result-correct" : "result-wrong"}">Year: ${escapeHtml(String(guess.yearGuess || "—"))} ${yearOk ? "✓" : "✗"}</div>
    `;
  } else if (isMyTurn()) {
    els.revealedBreakdown.innerHTML = '<div class="hint">Your team didn\'t answer in time.</div>';
  } else {
    els.revealedBreakdown.innerHTML = '<div class="hint">Not your team\'s turn this round.</div>';
  }
}

// ---------- Leave room ----------

function leaveRoom() {
  if (unsubRoom) {
    unsubRoom();
    unsubRoom = null;
  }
  if (unsubGuesses) {
    unsubGuesses();
    unsubGuesses = null;
  }
  if (unsubTeams) {
    unsubTeams();
    unsubTeams = null;
  }
  stopCountdown();

  localStorage.removeItem(ROOM_KEY);
  localStorage.removeItem(TEAM_ID_KEY);
  localStorage.removeItem(NAME_KEY);

  roomCode = null;
  teamId = null;
  teamName = null;
  teamEmoji = null;
  lastSeenRoundIndex = -1;
  myTeamGuessThisRound = null;
  currentPhase = null;

  els.topBar.hidden = true;
  els.leaderboard.hidden = true;
  els.roomCodeInput.value = "";
  els.teamNameInput.value = "";
  els.nameInput.value = "";
  selectedEmoji = null;
  [...els.emojiGrid.children].forEach((c) => c.classList.remove("selected"));
  showJoinError("");
  showScreen("join");
}

els.leaveRoomBtn.addEventListener("click", leaveRoom);

// ---------- Reconnect on load ----------

(async function initFromStorage() {
  const savedRoom = localStorage.getItem(ROOM_KEY);
  const savedTeamId = localStorage.getItem(TEAM_ID_KEY);
  const savedName = localStorage.getItem(NAME_KEY);
  if (!savedRoom || !savedTeamId || !savedName) {
    showScreen("join");
    return;
  }

  els.roomCodeInput.value = savedRoom;
  els.nameInput.value = savedName;

  try {
    const user = await authReady;
    myUid = user.uid;

    const roomSnap = await getDoc(doc(db, "rooms", savedRoom));
    if (!roomSnap.exists()) {
      showScreen("join");
      return;
    }
    const teamSnap = await getDoc(doc(db, "rooms", savedRoom, "teams", savedTeamId));
    if (!teamSnap.exists()) {
      showScreen("join");
      return;
    }

    roomCode = savedRoom;
    teamId = savedTeamId;
    playerName = savedName;
    teamName = teamSnap.data().name;
    teamEmoji = teamSnap.data().emoji;
    els.teamNameInput.value = teamName;

    await loadMovieIndex();
    startSession();
  } catch {
    showScreen("join");
  }
})();
