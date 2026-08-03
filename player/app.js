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
    audioChoice: document.getElementById("audio-choice-screen"),
    guessing: document.getElementById("guessing-screen"),
    locked: document.getElementById("locked-screen"),
    revealed: document.getElementById("revealed-screen"),
    trivia: document.getElementById("trivia-screen"),
  },

  roomCodeInput: document.getElementById("room-code-input"),
  teamNameInput: document.getElementById("team-name-input"),
  nameInput: document.getElementById("name-input"),
  emojiGrid: document.getElementById("emoji-grid"),
  joinBtn: document.getElementById("join-btn"),
  joinError: document.getElementById("join-error"),

  waitingTitle: document.getElementById("waiting-title"),
  waitingMessage: document.getElementById("waiting-message"),

  audioPlayerTimer: document.getElementById("audio-player-timer"),
  answerNowBtn: document.getElementById("answer-now-btn"),

  playerTimer: document.getElementById("player-timer"),
  movieInput: document.getElementById("movie-input"),
  movieCorrection: document.getElementById("movie-correction"),
  yearInput: document.getElementById("year-input"),
  actor1Input: document.getElementById("actor1-input"),
  actor2Input: document.getElementById("actor2-input"),
  submitGuessBtn: document.getElementById("submit-guess-btn"),

  lockedSummary: document.getElementById("locked-summary"),

  revealedTitle: document.getElementById("revealed-title"),
  revealedMeta: document.getElementById("revealed-meta"),
  revealedBreakdown: document.getElementById("revealed-breakdown"),

  leaderboard: document.getElementById("leaderboard"),
  leaderboardList: document.getElementById("leaderboard-list"),

  triviaQuestionText: document.getElementById("trivia-question-text"),
  triviaTimer: document.getElementById("trivia-timer"),
  triviaButtons: [...document.querySelectorAll(".trivia-btn")],
  triviaLockedMessage: document.getElementById("trivia-locked-message"),
  triviaResultMessage: document.getElementById("trivia-result-message"),
};

const TRIVIA_SHAPES = ["🔺", "♦️", "⬤", "◼️"];
const ANSWER_NOW_DEFAULT_LABEL = els.answerNowBtn.textContent;

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
let movieIndex = { titles: [] };
let teamsCache = {}; // teamId -> team data, so the "waiting" screen can name whoever won the audio-only race
let lastRoomData = null; // cached so the guesses listener can re-derive the right screen without waiting for the next room update

let unsubRoom = null;
let unsubGuesses = null;
let unsubTeams = null;
let unsubTriviaAnswer = null;
let myTriviaAnswer = null;
let countdownInterval = null;
let buzzInWatchdog = null;

function normalize(s) {
  return (s || "").trim().toLowerCase();
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

// ---------- Fuzzy match (Levenshtein) for movie-title typo-correction ----------

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
// No live-as-you-type dropdown — a suggestion only appears once the
// player finishes typing the movie title and presses Enter (or submits),
// and only as a "Did you mean X?" they must click to accept, never a
// silent auto-fill.

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
  // Nothing below here had a timeout — a stalled sign-in or Firestore
  // call would leave the button on "Joining…" forever with zero
  // feedback. This at least tells the team something's wrong instead of
  // silence, even though it can't fix a bad connection for them.
  const slowJoinNotice = setTimeout(() => {
    els.joinBtn.textContent = "Still working — check your connection…";
  }, 8000);
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
    clearTimeout(slowJoinNotice);
    els.joinBtn.disabled = false;
    els.joinBtn.textContent = "Join";
  }
});

async function loadMovieIndex() {
  const snap = await getDoc(doc(db, "rooms", roomCode, "public", "movieIndex"));
  movieIndex = snap.exists() ? snap.data() : { titles: [] };
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
    if (data) {
      lastRoomData = data;
      handleRoomUpdate(data);
    }
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
  els.yearInput.value = "";
  els.actor1Input.value = "";
  els.actor2Input.value = "";
  clearSuggestion(els.movieCorrection);

  const ref = collection(db, "rooms", roomCode, "rounds", String(roundIndex), "guesses");
  unsubGuesses = onSnapshot(ref, (snap) => {
    myTeamGuessThisRound = null;
    snap.forEach((d) => {
      const g = d.data();
      if (g.teamId === teamId) myTeamGuessThisRound = g;
    });
    // Re-derive the screen from the latest room state whenever our own
    // guess status changes — matters most right after we submit, so we
    // flip to "locked" immediately instead of waiting on the next room
    // update (which may not arrive until other teams finish too).
    const relevantPhase = currentPhase === "audio-claimed" || currentPhase === "playing" || currentPhase === "guessing";
    if (relevantPhase && lastRoomData) handleRoomUpdate(lastRoomData);
  });
}

function handleRoomUpdate(data) {
  currentPhase = data.phase;

  if (data.roundIndex !== lastSeenRoundIndex) {
    lastSeenRoundIndex = data.roundIndex;
    attachRoundGuessListener(data.roundIndex);
  }

  if (data.phase === "audio") {
    if (buzzInWatchdog) {
      clearTimeout(buzzInWatchdog);
      buzzInWatchdog = null;
    }
    startCountdown(data.audioDeadline, els.audioPlayerTimer);
    els.answerNowBtn.disabled = false;
    els.answerNowBtn.textContent = ANSWER_NOW_DEFAULT_LABEL;
    showScreen("audioChoice");
  } else if (data.phase === "audio-claimed") {
    if (buzzInWatchdog) {
      clearTimeout(buzzInWatchdog);
      buzzInWatchdog = null;
    }
    stopCountdown();
    if (data.audioClaimedTeamId === teamId) {
      if (myTeamGuessThisRound) {
        showLocked(myTeamGuessThisRound);
      } else {
        startCountdown(data.audioClaimedDeadline, els.playerTimer);
        showScreen("guessing");
      }
    } else {
      const claimedTeam = teamsCache[data.audioClaimedTeamId];
      const label = claimedTeam ? `${claimedTeam.emoji || ""} ${claimedTeam.name}`.trim() : "Another team";
      els.waitingTitle.textContent = "🔊 Audio's over!";
      els.waitingMessage.textContent = `${label} buzzed in first — video's up next.`;
      showScreen("waiting");
    }
  } else if (data.phase === "playing") {
    stopCountdown();
    if (myTeamGuessThisRound) {
      showLocked(myTeamGuessThisRound);
    } else {
      els.waitingTitle.textContent = "🎬 Watch the TV!";
      els.waitingMessage.textContent = "Get ready to answer once the clip ends.";
      showScreen("waiting");
    }
  } else if (data.phase === "guessing") {
    startCountdown(data.guessDeadline);
    renderGuessingOrLocked();
  } else if (data.phase === "revealed") {
    stopCountdown();
    renderRevealed(data.revealedAnswer);
  } else if (data.phase === "trivia") {
    stopCountdown();
    renderTriviaQuestion(data.triviaQuestion);
    attachTriviaAnswerListener(data.roundIndex);
    startCountdown(data.triviaDeadline, els.triviaTimer);
    showScreen("trivia");
  } else if (data.phase === "trivia-revealed") {
    stopCountdown();
    renderTriviaRevealed(data.triviaResult);
  } else {
    stopCountdown();
    els.waitingTitle.textContent = "You're in!";
    els.waitingMessage.textContent = "Waiting for the host to start the next round…";
    showScreen("waiting");
  }
}

// ---------- Audio-only choice ----------
// It's a race, not an independent per-team choice — first team to buzz
// in claims the double-points bonus and the host stops the audio for
// everyone else. There's no separate "wait for video" action to take;
// not buzzing in just means waiting.

els.answerNowBtn.addEventListener("click", buzzIn);

async function buzzIn() {
  els.answerNowBtn.disabled = true;
  els.answerNowBtn.textContent = "Buzzing in…";
  try {
    await updateDoc(doc(db, "rooms", roomCode, "teams", teamId), {
      audioChoice: "answer_now",
      audioChoiceRound: lastSeenRoundIndex,
      audioChoiceAt: serverTimestamp(),
    });
    // The host decides who actually won the race (earliest timestamp) and
    // updates the room's phase to "audio-claimed" — our own screen only
    // moves on once that comes back through handleRoomUpdate, so a team
    // that buzzed a beat too late doesn't get stuck thinking it's their turn.
    // If that confirmation never arrives (host lost connection, stuck on
    // a stale tab, etc.), don't leave the button disabled forever with no
    // explanation — let the team know and give them a way to retry.
    if (buzzInWatchdog) clearTimeout(buzzInWatchdog);
    buzzInWatchdog = setTimeout(() => {
      if (currentPhase === "audio") {
        els.answerNowBtn.disabled = false;
        els.answerNowBtn.textContent = "Still waiting on the host — tap to try again";
      }
    }, 10000);
  } catch (err) {
    alert(`Couldn't buzz in: ${err.message}`);
    els.answerNowBtn.disabled = false;
    els.answerNowBtn.textContent = ANSWER_NOW_DEFAULT_LABEL;
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
  els.lockedSummary.innerHTML = `Movie: <strong>${escapeHtml(guess.movieGuess || "—")}</strong><br>Year: <strong>${escapeHtml(String(guess.yearGuess || "—"))}</strong><br>Actor 1: <strong>${escapeHtml(guess.actor1Guess || "—")}</strong><br>Actor 2: <strong>${escapeHtml(guess.actor2Guess || "—")}</strong>`;
}

// ---------- Countdown ----------

function startCountdown(deadline, targetEl = els.playerTimer) {
  stopCountdown();
  const tick = () => {
    const remaining = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    targetEl.textContent = remaining;
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
// Blank fields are allowed (they just score 0 for that field) — a team
// that only knows the movie shouldn't be blocked from locking that in.
// We just confirm once so a blank isn't an accidental empty tap.

els.submitGuessBtn.addEventListener("click", async () => {
  const movieGuess = els.movieInput.value.trim();
  const yearGuess = els.yearInput.value.trim();
  const actor1Guess = els.actor1Input.value.trim();
  const actor2Guess = els.actor2Input.value.trim();

  if (!movieGuess && !yearGuess && !actor1Guess && !actor2Guess) {
    alert("Type at least something before locking in!");
    return;
  }

  const blankFields = [];
  if (!movieGuess) blankFields.push("Movie");
  if (!yearGuess) blankFields.push("Year");
  if (!actor1Guess) blankFields.push("Actor 1");
  if (!actor2Guess) blankFields.push("Actor 2");
  if (blankFields.length > 0 && !confirm(`No answer for ${blankFields.join(", ")} — submit anyway?`)) {
    return;
  }

  els.submitGuessBtn.disabled = true;
  els.submitGuessBtn.textContent = "Locking in…";
  try {
    await setDoc(doc(db, "rooms", roomCode, "rounds", String(lastSeenRoundIndex), "guesses", myUid), {
      teamId,
      movieGuess,
      yearGuess,
      actor1Guess,
      actor2Guess,
      audioOnly: currentPhase === "audio-claimed" && lastRoomData?.audioClaimedTeamId === teamId,
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

// Matches host/app.js's own copy of this logic (see revealInFirestore /
// namesAreClose there) — duplicated because each player renders its own
// preview of the breakdown from the publicly revealed answer, but the
// host's copy (plus its reveal-screen override) is what actually decides
// points. Keep both in sync if this ever changes.
function normalizeName(s) {
  return (s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function namesAreClose(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const lastA = na.split(" ").pop();
  const lastB = nb.split(" ").pop();
  if (lastA.length > 2 && lastA === lastB) return true;
  const threshold = Math.max(1, Math.round(Math.max(na.length, nb.length) * 0.25));
  return levenshtein(na, nb) <= threshold;
}

function isActorMatch(guess, cast) {
  if (!guess) return false;
  return (cast || []).some((name) => namesAreClose(guess, name));
}

function renderRevealed(answer) {
  showScreen("revealed");
  if (!answer) return;

  els.revealedTitle.textContent = `${answer.movieTitle}${answer.year ? ` (${answer.year})` : ""}`;
  els.revealedMeta.textContent = answer.director ? `Directed by ${answer.director}` : "";

  const guess = myTeamGuessThisRound;
  if (guess) {
    const movieOk = normalize(guess.movieGuess) === normalize(answer.movieTitle);
    const yearOk = String(guess.yearGuess || "").trim() === String(answer.year || "").trim();
    const actor1Ok = isActorMatch(guess.actor1Guess, answer.cast);
    const actor2Ok = isActorMatch(guess.actor2Guess, answer.cast);
    els.revealedBreakdown.innerHTML = `
      <div class="${movieOk ? "result-correct" : "result-wrong"}">Movie: ${escapeHtml(guess.movieGuess || "—")} ${movieOk ? "✓" : "✗"} (3 pts)</div>
      <div class="${yearOk ? "result-correct" : "result-wrong"}">Year: ${escapeHtml(String(guess.yearGuess || "—"))} ${yearOk ? "✓" : "✗"} (2 pts)</div>
      <div class="${actor1Ok ? "result-correct" : "result-wrong"}">Actor 1: ${escapeHtml(guess.actor1Guess || "—")} ${actor1Ok ? "✓" : "✗"} (1 pt)</div>
      <div class="${actor2Ok ? "result-correct" : "result-wrong"}">Actor 2: ${escapeHtml(guess.actor2Guess || "—")} ${actor2Ok ? "✓" : "✗"} (1 pt)</div>
    `;
  } else {
    els.revealedBreakdown.innerHTML = '<div class="hint">Your team didn\'t answer this round.</div>';
  }
}

// ---------- Bonus trivia ----------
// Every team races to answer — first correct submission (earliest
// per-team, same "collaborate then submit" model as the main guess) wins
// the points.

function attachTriviaAnswerListener(roundIndex) {
  if (unsubTriviaAnswer) unsubTriviaAnswer();
  myTriviaAnswer = null;
  const ref = collection(db, "rooms", roomCode, "rounds", String(roundIndex), "trivia");
  unsubTriviaAnswer = onSnapshot(ref, (snap) => {
    myTriviaAnswer = null;
    snap.forEach((d) => {
      if (d.id === myUid) myTriviaAnswer = d.data();
    });
    renderTriviaButtonsState();
  });
}

function renderTriviaQuestion(q) {
  if (!q) return;
  els.triviaQuestionText.textContent = q.question;
  els.triviaResultMessage.hidden = true;
  els.triviaButtons.forEach((btn, i) => {
    btn.textContent = `${TRIVIA_SHAPES[i]} ${q.options[i] || ""}`;
    btn.classList.remove("correct-answer");
  });
  renderTriviaButtonsState();
}

function renderTriviaButtonsState() {
  const locked = !!myTriviaAnswer;
  els.triviaButtons.forEach((btn, i) => {
    btn.disabled = locked;
    btn.classList.toggle("selected", locked && myTriviaAnswer.selectedIndex === i);
  });
  els.triviaLockedMessage.hidden = !locked;
}

els.triviaButtons.forEach((btn, i) => {
  btn.addEventListener("click", () => submitTriviaAnswer(i));
});

async function submitTriviaAnswer(index) {
  if (myTriviaAnswer) return;
  try {
    await setDoc(doc(db, "rooms", roomCode, "rounds", String(lastSeenRoundIndex), "trivia", myUid), {
      teamId,
      selectedIndex: index,
      submittedAt: serverTimestamp(),
    });
    // The trivia-answer listener picks this up and locks the buttons —
    // same pattern as the main guess submit.
  } catch (err) {
    alert(`Couldn't submit: ${err.message}`);
  }
}

function renderTriviaRevealed(result) {
  if (!result) return;
  els.triviaButtons.forEach((btn, i) => {
    btn.disabled = true;
    btn.classList.toggle("correct-answer", i === result.correctIndex);
  });
  els.triviaLockedMessage.hidden = true;
  els.triviaResultMessage.hidden = false;
  if (result.winnerTeamId === teamId) {
    els.triviaResultMessage.textContent = "🏆 Your team got it first! +5 points";
  } else if (result.winnerTeamId) {
    els.triviaResultMessage.textContent = `${result.winnerEmoji || ""} ${result.winnerName || "Another team"} answered first.`;
  } else {
    els.triviaResultMessage.textContent = "Nobody got it right this time.";
  }
  showScreen("trivia");
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
  if (unsubTriviaAnswer) {
    unsubTriviaAnswer();
    unsubTriviaAnswer = null;
  }
  if (buzzInWatchdog) {
    clearTimeout(buzzInWatchdog);
    buzzInWatchdog = null;
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
  lastRoomData = null;
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
