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
  deleteDoc,
  onSnapshot,
  collection,
  serverTimestamp,
  increment,
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";

const STORAGE_KEY = "filmgeek_clips";
const ACTIVE_ROOM_KEY = "filmgeek_active_room"; // which room (if any) this browser can resume
const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1, easy to read aloud
const GUESS_WINDOW_MS = 60000;
const AUDIO_ONLY_WINDOW_MS = 15000;

const els = {
  playerWrap: document.getElementById("player-wrap"),
  fullscreenBtn: document.getElementById("fullscreen-btn"),
  hud: document.getElementById("hud"),
  timer: document.getElementById("timer"),
  stopEarlyBtn: document.getElementById("stop-early-btn"),

  cover: document.getElementById("cover"),
  roomInfo: document.getElementById("room-info"),
  roomCodeDisplay: document.getElementById("room-code-display"),
  gameNameDisplay: document.getElementById("game-name-display"),
  playerCount: document.getElementById("player-count"),
  roundIndicator: document.getElementById("round-indicator"),
  turnIndicator: document.getElementById("turn-indicator"),

  setupPanel: document.getElementById("setup-panel"),
  resumeBlock: document.getElementById("resume-block"),
  resumeGameName: document.getElementById("resume-game-name"),
  resumeGameDetail: document.getElementById("resume-game-detail"),
  resumeBtn: document.getElementById("resume-btn"),
  startFreshBtn: document.getElementById("start-fresh-btn"),
  newGameBlock: document.getElementById("new-game-block"),
  gameNameInput: document.getElementById("game-name-input"),
  newGameBtn: document.getElementById("new-game-btn"),

  idlePanel: document.getElementById("idle-panel"),
  queueStatus: document.getElementById("queue-status"),
  startBtn: document.getElementById("start-btn"),
  finishGameBtn: document.getElementById("finish-game-btn"),
  finishGameBtnAllDone: document.getElementById("finish-game-btn-alldone"),

  noClipsPanel: document.getElementById("no-clips-panel"),
  importInput: document.getElementById("import-input"),

  audioPanel: document.getElementById("audio-panel"),
  audioTurnLabel: document.getElementById("audio-turn-label"),
  audioTimer: document.getElementById("audio-timer"),

  endedPanel: document.getElementById("ended-panel"),
  guessTimer: document.getElementById("guess-timer"),
  guessCount: document.getElementById("guess-count"),
  revealBtn: document.getElementById("reveal-btn"),

  answerPanel: document.getElementById("answer-panel"),
  answerTitle: document.getElementById("answer-title"),
  answerMeta: document.getElementById("answer-meta"),
  roundResultBanner: document.getElementById("round-result-banner"),
  roundBreakdown: document.getElementById("round-breakdown"),
  scoreboardList: document.getElementById("scoreboard-list"),
  nextBtn: document.getElementById("next-btn"),

  triviaPanel: document.getElementById("trivia-panel"),
  triviaQuestion: document.getElementById("trivia-question"),
  triviaOptions: document.getElementById("trivia-options"),
  triviaTimer: document.getElementById("trivia-timer"),
  triviaCount: document.getElementById("trivia-count"),

  triviaResultPanel: document.getElementById("trivia-result-panel"),
  triviaResultBanner: document.getElementById("trivia-result-banner"),
  triviaResultOptions: document.getElementById("trivia-result-options"),
  triviaScoreboardList: document.getElementById("trivia-scoreboard-list"),
  triviaContinueBtn: document.getElementById("trivia-continue-btn"),

  allDonePanel: document.getElementById("all-done-panel"),
  reshuffleBtn: document.getElementById("reshuffle-btn"),

  errorPanel: document.getElementById("error-panel"),
  errorMessage: document.getElementById("error-message"),
  errorSkipBtn: document.getElementById("error-skip-btn"),
};

let clips = [];
let clipsById = {}; // clip id -> clip, rebuilt whenever `clips` loads
let queue = []; // clip ids not yet shown this game
let usedClipIds = []; // clip ids already shown this game (any team) — never re-served
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

let roundAudioOnly = false; // true if the active team answered before ever seeing video this round
let audioChoiceHandled = false;
let audioCountdownInterval = null;
let audioTimeout = null;

// Points scale up sharply with how many of the 3 fields (movie/director/
// year) a team got right, rather than 1 point per field — rewards a full
// correct guess much more than a partial one. Doubled if they answered
// on audio alone, before ever seeing the video.
const POINTS_BY_CORRECT_COUNT = { 0: 0, 1: 2, 2: 5, 3: 10 };
const AUDIO_ONLY_MULTIPLIER = 2;

// Bonus trivia: after some reveals, instead of going straight to the next
// clip, a Kahoot-style multiple-choice question about the movie just
// revealed pops up — open to every team (not just the one whose turn it
// was), first correct answer wins. Only fires for clips that actually have
// trivia authored in admin-tagging, and even then only some of the time so
// it stays a surprise rather than a fixed extra step every round.
const TRIVIA_CHANCE = 0.5;
const TRIVIA_WINDOW_MS = 12000;
const TRIVIA_POINTS = 5;
const TRIVIA_SHAPES = ["🔺", "♦️", "⬤", "◼️"];
const TRIVIA_COLORS = ["trivia-red", "trivia-blue", "trivia-yellow", "trivia-green"];

let unsubscribeTrivia = null;
let triviaCountdownInterval = null;
let triviaAutoRevealTimeout = null;
let triviaAnswers = {}; // uid -> { teamId, selectedIndex, submittedAt }
let triviaCorrectIndex = null;
let triviaOptions = [];
let triviaRevealed = false;

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

// Creates a brand-new room doc for a fresh game. Resuming an existing game
// (see resumeGame below) skips this entirely and reuses the saved room code.
async function createRoom(gameName) {
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
          gameName: gameName || "",
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
    if (!roomCode) return false;
    localStorage.setItem(ACTIVE_ROOM_KEY, roomCode);
    els.roomInfo.hidden = false;
    els.roomCodeDisplay.textContent = roomCode;
    els.gameNameDisplay.textContent = gameName || "";
    return true;
  } catch (err) {
    els.playerCount.textContent = "Room sync unavailable — playing local-only.";
    console.error("createRoom failed", err);
    return false;
  }
}

// Shared by both a freshly-created room and a resumed one — subscribes to
// the teams subcollection for the roster/score display and for picking up
// the active team's audio-phase choice (see the comment inside).
function subscribeToRoomTeams() {
  onSnapshot(collection(db, "rooms", roomCode, "teams"), (snap) => {
    teamsMap = {};
    snap.forEach((d) => (teamsMap[d.id] = d.data()));
    const teamCount = Object.keys(teamsMap).length;
    const playerCount = Object.values(teamsMap).reduce((sum, t) => sum + (t.memberNames?.length || 0), 0);
    els.playerCount.textContent =
      teamCount === 0
        ? "0 teams joined"
        : `${teamCount} team${teamCount === 1 ? "" : "s"}, ${playerCount} player${playerCount === 1 ? "" : "s"} joined`;

    // The active team can't write the room doc directly (only the host
    // can), so they signal their audio-phase choice on their own team
    // doc instead — which they're already allowed to write — and the
    // host reacts to it here.
    if (!audioChoiceHandled && activeTeamId && currentClip) {
      const team = teamsMap[activeTeamId];
      if (team && team.audioChoiceRound === currentRoundIndex && team.audioChoice) {
        audioChoiceHandled = true;
        if (team.audioChoice === "answer_now") {
          skipToGuessing(currentClip);
        } else if (team.audioChoice === "go_to_video") {
          revealVideo(currentClip);
        }
      }
    }
  });
}

// Persists enough of the in-progress game (which clips are left/used, the
// round number) to Firestore that reopening the host page can pick back up
// where it left off — teams/scores already live in Firestore separately,
// so this doc only needs to cover the queue/round bookkeeping.
async function saveGameState() {
  if (!roomCode) return;
  try {
    await setDoc(doc(db, "rooms", roomCode, "private", "gameState"), {
      queueIds: queue,
      usedClipIds,
      roundIndex: currentRoundIndex,
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    console.error("saveGameState failed", err);
  }
}

// Checks whether the room this browser last played is still resumable
// (exists, still owned by this browser's anon-auth identity, has saved
// progress) — returns null rather than throwing so callers can just fall
// back to the new-game setup screen.
async function tryLoadResumableGame(code) {
  try {
    const user = await authReady;
    const roomSnap = await getDoc(doc(db, "rooms", code));
    if (!roomSnap.exists() || roomSnap.data().hostUid !== user.uid) return null;
    const gameStateSnap = await getDoc(doc(db, "rooms", code, "private", "gameState"));
    if (!gameStateSnap.exists()) return null;
    return { code, room: roomSnap.data(), gameState: gameStateSnap.data() };
  } catch (err) {
    console.error("tryLoadResumableGame failed", err);
    return null;
  }
}

async function resumeGame(resumable) {
  roomCode = resumable.code;
  currentRoundIndex = resumable.gameState.roundIndex || 0;
  usedClipIds = resumable.gameState.usedClipIds || [];
  // Drop any ids for clips that no longer exist in the library (deleted
  // since this game started) rather than let them jam up the queue.
  queue = (resumable.gameState.queueIds || []).filter((id) => clipsById[id]);

  localStorage.setItem(ACTIVE_ROOM_KEY, roomCode);
  els.roomInfo.hidden = false;
  els.roomCodeDisplay.textContent = roomCode;
  els.gameNameDisplay.textContent = resumable.room.gameName || "";

  await publishMovieIndex();
  subscribeToRoomTeams();
  showIdle();
}

async function startNewGame(gameName) {
  usedClipIds = [];
  const created = await createRoom(gameName);
  if (!created) return;
  initQueue();
  await saveGameState();
  await publishMovieIndex();
  subscribeToRoomTeams();
  showIdle();
}

// "Finish game" is the explicit, deliberate end of a game night — unlike
// just closing the tab, it deletes the room's Firestore data so old games
// don't pile up, and clears the local pointer so a reload lands on the
// new-game setup screen instead of trying to resume the deleted room.
async function finishGame() {
  if (!roomCode) return;
  if (!confirm("Finish this game and clear its history? This can't be undone.")) return;

  const codeToDelete = roomCode;
  const roundsToDelete = currentRoundIndex;

  localStorage.removeItem(ACTIVE_ROOM_KEY);
  roomCode = null;
  teamsMap = {};
  currentRoundIndex = 0;
  usedClipIds = [];
  queue = [];
  els.roomInfo.hidden = true;
  showNewGameSetup();

  await deleteRoomData(codeToDelete, roundsToDelete);
}

async function deleteRoomData(code, roundCount) {
  try {
    const teamsSnap = await getDocs(collection(db, "rooms", code, "teams"));
    await Promise.all(teamsSnap.docs.map((d) => deleteDoc(d.ref)));

    for (let i = 1; i <= roundCount; i++) {
      const guessesSnap = await getDocs(collection(db, "rooms", code, "rounds", String(i), "guesses"));
      await Promise.all(guessesSnap.docs.map((d) => deleteDoc(d.ref)));
      const triviaSnap = await getDocs(collection(db, "rooms", code, "rounds", String(i), "trivia"));
      await Promise.all(triviaSnap.docs.map((d) => deleteDoc(d.ref)));
    }

    await deleteDoc(doc(db, "rooms", code, "private", "answer")).catch(() => {});
    await deleteDoc(doc(db, "rooms", code, "private", "triviaAnswer")).catch(() => {});
    await deleteDoc(doc(db, "rooms", code, "private", "gameState")).catch(() => {});
    await deleteDoc(doc(db, "rooms", code, "public", "movieIndex")).catch(() => {});
    await deleteDoc(doc(db, "rooms", code));
  } catch (err) {
    console.error("deleteRoomData failed", err);
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
    roundAudioOnly = false;
    audioChoiceHandled = false;
    updateRoundIndicator();

    const teamOrder = getTeamOrder();
    activeTeamId = teamOrder.length ? teamOrder[(currentRoundIndex - 1) % teamOrder.length] : null;
    updateTurnIndicator();

    await setDoc(
      doc(db, "rooms", roomCode),
      {
        phase: "audio",
        roundIndex: currentRoundIndex,
        revealedAnswer: null,
        guessDeadline: null,
        audioDeadline: null,
        activeTeamId,
      },
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
      const points = POINTS_BY_CORRECT_COUNT[correctCount] * (roundAudioOnly ? AUDIO_ONLY_MULTIPLIER : 1);

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

// ---------- Bonus trivia ----------

function pickTriviaForClip(clip) {
  if (!clip || !clip.trivia || clip.trivia.length === 0) return null;
  return clip.trivia[Math.floor(Math.random() * clip.trivia.length)];
}

function renderTriviaOptions(targetEl, options, { dimWrong = false, correctIndex = null } = {}) {
  targetEl.innerHTML = options
    .map((opt, i) => {
      const classes = ["trivia-option", TRIVIA_COLORS[i]];
      if (dimWrong && i !== correctIndex) classes.push("trivia-dim");
      if (dimWrong && i === correctIndex) classes.push("trivia-correct");
      return `<div class="${classes.join(" ")}"><span class="trivia-shape">${TRIVIA_SHAPES[i]}</span>${escapeHtml(opt)}</div>`;
    })
    .join("");
}

function attachTriviaListener(roundIndex) {
  if (unsubscribeTrivia) unsubscribeTrivia();
  triviaAnswers = {};
  els.triviaCount.textContent = "";
  if (!roomCode) return;
  const ref = collection(db, "rooms", roomCode, "rounds", String(roundIndex), "trivia");
  unsubscribeTrivia = onSnapshot(ref, (snap) => {
    triviaAnswers = {};
    snap.forEach((d) => (triviaAnswers[d.id] = d.data()));
    const count = Object.keys(triviaAnswers).length;
    els.triviaCount.textContent = count === 0 ? "" : count === 1 ? "1 answer in" : `${count} answers in`;
  });
}

function stopTriviaTimers() {
  if (triviaCountdownInterval) {
    clearInterval(triviaCountdownInterval);
    triviaCountdownInterval = null;
  }
  if (triviaAutoRevealTimeout) {
    clearTimeout(triviaAutoRevealTimeout);
    triviaAutoRevealTimeout = null;
  }
  if (unsubscribeTrivia) {
    unsubscribeTrivia();
    unsubscribeTrivia = null;
  }
}

async function startTriviaRound(trivia) {
  triviaRevealed = false;
  triviaCorrectIndex = trivia.correctIndex;
  triviaOptions = trivia.options;
  els.triviaQuestion.textContent = trivia.question;
  renderTriviaOptions(els.triviaOptions, trivia.options);
  showPanel("trivia");

  if (roomCode) {
    await setDoc(doc(db, "rooms", roomCode, "private", "triviaAnswer"), { correctIndex: trivia.correctIndex }).catch(
      (err) => console.error("startTriviaRound (private) failed", err)
    );
    await updateDoc(doc(db, "rooms", roomCode), {
      phase: "trivia",
      triviaQuestion: { question: trivia.question, options: trivia.options },
      triviaDeadline: Date.now() + TRIVIA_WINDOW_MS,
      triviaResult: null,
    }).catch((err) => console.error("startTriviaRound failed", err));
  }

  attachTriviaListener(currentRoundIndex);

  const deadline = Date.now() + TRIVIA_WINDOW_MS;
  els.triviaTimer.textContent = Math.round(TRIVIA_WINDOW_MS / 1000);
  if (triviaCountdownInterval) clearInterval(triviaCountdownInterval);
  triviaCountdownInterval = setInterval(() => {
    const remaining = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    els.triviaTimer.textContent = remaining;
    if (remaining <= 0) {
      clearInterval(triviaCountdownInterval);
      triviaCountdownInterval = null;
    }
  }, 250);

  if (triviaAutoRevealTimeout) clearTimeout(triviaAutoRevealTimeout);
  triviaAutoRevealTimeout = setTimeout(() => {
    if (!triviaRevealed) performTriviaReveal();
  }, TRIVIA_WINDOW_MS);
}

// Same "collaborate then whoever submits first locks it in" model as the
// main guess — earliest submission per team counts, and among teams that
// answered correctly, the earliest one wins the points.
async function performTriviaReveal() {
  if (triviaRevealed) return;
  triviaRevealed = true;
  stopTriviaTimers();

  const byTeam = {};
  for (const ans of Object.values(triviaAnswers)) {
    if (!ans.teamId) continue;
    const existing = byTeam[ans.teamId];
    const t = ans.submittedAt?.toMillis?.() ?? 0;
    if (!existing || t < existing._t) byTeam[ans.teamId] = { ...ans, _t: t };
  }
  const correctSubs = Object.entries(byTeam)
    .filter(([, a]) => a.selectedIndex === triviaCorrectIndex)
    .sort((a, b) => a[1]._t - b[1]._t);

  let winner = null;
  if (correctSubs.length && roomCode) {
    const [winnerTeamId] = correctSubs[0];
    const team = teamsMap[winnerTeamId] || {};
    winner = { teamId: winnerTeamId, name: team.name, emoji: team.emoji, newTotal: (team.score || 0) + TRIVIA_POINTS };
    await updateDoc(doc(db, "rooms", roomCode, "teams", winnerTeamId), { score: increment(TRIVIA_POINTS) }).catch(
      () => {}
    );
  }

  if (roomCode) {
    await updateDoc(doc(db, "rooms", roomCode), {
      phase: "trivia-revealed",
      triviaResult: {
        correctIndex: triviaCorrectIndex,
        winnerTeamId: winner ? winner.teamId : null,
        winnerName: winner ? winner.name : null,
        winnerEmoji: winner ? winner.emoji : null,
      },
    }).catch((err) => console.error("performTriviaReveal failed", err));
  }

  renderTriviaOptions(els.triviaResultOptions, triviaOptions, { dimWrong: true, correctIndex: triviaCorrectIndex });
  if (winner) {
    els.triviaResultBanner.className = "round-result-banner win";
    els.triviaResultBanner.textContent = `${winner.emoji || ""} ${winner.name} got it first! +${TRIVIA_POINTS} points`;
  } else {
    els.triviaResultBanner.className = "round-result-banner lose";
    els.triviaResultBanner.textContent = "Nobody got it right this time.";
  }
  renderScoreboard(winner, els.triviaScoreboardList);
  showPanel("trivia-result");
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

// Only clips not already used this game go back into a fresh shuffle —
// usedClipIds is empty for a brand-new game, so this is a full shuffle
// there, but also works for the "reshuffle & play again" case where the
// whole library becomes eligible again only after usedClipIds is cleared.
function initQueue() {
  const remaining = clips.map((c) => c.id).filter((id) => !usedClipIds.includes(id));
  queue = shuffle(remaining);
}

async function loadLibrary() {
  try {
    const cloudClips = await fetchClipsFromCloud();
    clips = cloudClips.length > 0 ? cloudClips : loadClipsFromLocalStorage();
    saveClips(clips); // keep the local mirror fresh
  } catch (err) {
    console.error("Cloud clip fetch failed, falling back to local cache", err);
    clips = loadClipsFromLocalStorage();
  }
  clipsById = Object.fromEntries(clips.map((c) => [c.id, c]));
}

// ---------- Panel switching ----------
// Exactly one of these is visible inside the cover at a time; the cover
// itself is hidden only while a clip is actively playing.

function showPanel(name) {
  els.setupPanel.hidden = name !== "setup";
  els.idlePanel.hidden = name !== "idle";
  els.noClipsPanel.hidden = name !== "no-clips";
  els.audioPanel.hidden = name !== "audio";
  els.endedPanel.hidden = name !== "ended";
  els.answerPanel.hidden = name !== "answer";
  els.triviaPanel.hidden = name !== "trivia";
  els.triviaResultPanel.hidden = name !== "trivia-result";
  els.allDonePanel.hidden = name !== "all-done";
  els.errorPanel.hidden = name !== "error";
  els.cover.hidden = false;
}

function showNewGameSetup() {
  els.resumeBlock.hidden = true;
  els.newGameBlock.hidden = false;
  els.gameNameInput.value = "";
  showPanel("setup");
  els.gameNameInput.focus();
}

function showResumeChoice(resumable) {
  els.resumeBlock.hidden = false;
  els.newGameBlock.hidden = true;
  els.resumeGameName.textContent = resumable.room.gameName || "Untitled game";
  const clipsShown = resumable.gameState.usedClipIds?.length || 0;
  els.resumeGameDetail.textContent = `Round ${resumable.gameState.roundIndex || 0} · ${clipsShown} clip${clipsShown === 1 ? "" : "s"} shown so far`;
  showPanel("setup");
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
  stopAudioPhaseTimers(); // in case the error happened during the audio-only phase
  audioChoiceHandled = true; // don't let a queued auto-continue fire after we've already shown an error
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

// Audio-only phase: the clip plays (audio audible to the whole room) but
// the cover stays up the entire time — video is never shown here. The
// same play-through covers YouTube's brief start-of-video title/info
// overlay, so by the time video is revealed (always at least
// AUDIO_ONLY_WINDOW_MS in) that overlay has long since disappeared and
// there's no need for a separate reveal buffer. The active team's phone
// offers "Answer now" (double
// points, skips straight to guessing) or "Go to video" (normal points);
// this auto-continues to video if neither is chosen in time.
function startAudioPhase(clip) {
  currentClip = clip;
  roundAudioOnly = false;
  audioChoiceHandled = false;
  els.hud.hidden = true;
  showPanel("audio");
  els.audioTurnLabel.textContent = activeTeamId && teamsMap[activeTeamId] ? teamsMap[activeTeamId].name : "the team";
  els.audioTimer.textContent = Math.round(AUDIO_ONLY_WINDOW_MS / 1000);

  ytPlayer.loadVideoById({ videoId: clip.youtubeId, startSeconds: clip.startSec });
  ytPlayer.playVideo();

  const deadline = Date.now() + AUDIO_ONLY_WINDOW_MS;
  if (roomCode) {
    updateDoc(doc(db, "rooms", roomCode), { phase: "audio", audioDeadline: deadline }).catch((err) =>
      console.error("startAudioPhase failed", err)
    );
  }

  if (audioCountdownInterval) clearInterval(audioCountdownInterval);
  audioCountdownInterval = setInterval(() => {
    const remaining = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    els.audioTimer.textContent = remaining;
    if (remaining <= 0) {
      clearInterval(audioCountdownInterval);
      audioCountdownInterval = null;
    }
  }, 250);

  if (audioTimeout) clearTimeout(audioTimeout);
  audioTimeout = setTimeout(() => {
    if (!audioChoiceHandled) {
      audioChoiceHandled = true;
      revealVideo(clip);
    }
  }, AUDIO_ONLY_WINDOW_MS);
}

function stopAudioPhaseTimers() {
  if (audioCountdownInterval) {
    clearInterval(audioCountdownInterval);
    audioCountdownInterval = null;
  }
  if (audioTimeout) {
    clearTimeout(audioTimeout);
    audioTimeout = null;
  }
}

// The active team chose (or timed out into) seeing the video — it's
// already been playing (audio-only, hidden behind the cover) since
// startAudioPhase, so this just reveals what's already running in place
// rather than reloading/restarting it from the top.
function revealVideo(clip) {
  stopAudioPhaseTimers();
  roundAudioOnly = false;
  currentClip = clip;

  if (roomCode) {
    updateDoc(doc(db, "rooms", roomCode), { phase: "playing" }).catch((err) =>
      console.error("revealVideo phase update failed", err)
    );
  }

  els.cover.hidden = true;
  els.hud.hidden = false;

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

// The active team chose to answer on audio alone, before ever seeing the
// video — skip straight to the guessing window, doubled scoring applies.
function skipToGuessing(clip) {
  stopAudioPhaseTimers();
  roundAudioOnly = true;
  currentClip = clip;
  ytPlayer.pauseVideo();
  els.hud.hidden = true;
  showPanel("ended");
  els.guessTimer.textContent = "60";
  startGuessWindow();
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

// ---------- Fullscreen ----------
// The Fullscreen API only works from inside a user-gesture handler, so
// there's no way to make the page fullscreen the instant it loads — the
// dedicated button covers the "enter fullscreen right away" case, and
// starting the first round (also a click) tries it too so hosts who skip
// the button still end up fullscreen for the actual game.

function updateFullscreenBtnLabel() {
  els.fullscreenBtn.textContent = document.fullscreenElement ? "⛶ Exit fullscreen" : "⛶ Fullscreen";
}

function requestFullscreen() {
  if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen().catch(() => {}); // ignore if blocked/unsupported
  }
}

els.fullscreenBtn.addEventListener("click", () => {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    requestFullscreen();
  }
});
document.addEventListener("fullscreenchange", updateFullscreenBtnLabel);

// ---------- Game setup / resume ----------

els.resumeBtn.addEventListener("click", async () => {
  const savedRoom = localStorage.getItem(ACTIVE_ROOM_KEY);
  els.resumeBtn.disabled = true;
  const resumable = savedRoom && (await tryLoadResumableGame(savedRoom));
  if (resumable) {
    await resumeGame(resumable);
  } else {
    showNewGameSetup();
  }
  els.resumeBtn.disabled = false;
});

els.startFreshBtn.addEventListener("click", () => showNewGameSetup());

els.newGameBtn.addEventListener("click", async () => {
  els.newGameBtn.disabled = true;
  els.newGameBtn.textContent = "Starting…";
  try {
    await startNewGame(els.gameNameInput.value.trim());
  } finally {
    els.newGameBtn.disabled = false;
    els.newGameBtn.textContent = "Start new game";
  }
});

els.finishGameBtn.addEventListener("click", finishGame);
els.finishGameBtnAllDone.addEventListener("click", finishGame);

// ---------- Round flow ----------

els.startBtn.addEventListener("click", async () => {
  if (!playerReady) return; // guarded by disabled attribute too; belt-and-suspenders
  if (queue.length === 0) {
    showPanel("all-done");
    return;
  }
  requestFullscreen();
  const clipId = queue.pop();
  const clip = clipsById[clipId];
  usedClipIds.push(clipId);
  await startRoundInFirestore(clip); // fast (<1s typically); players need this before guessing — also bumps currentRoundIndex
  await saveGameState(); // after the round-index bump above, so a resume lands on the right round number
  startAudioPhase(clip);
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
  const activeRow = rows[0]; // at most one row now: only the active team's turn counts

  if (activeRow) {
    const activeTeam = teamsMap[activeRow.teamId] || {};
    els.roundResultBanner.className = `round-result-banner ${activeRow.points > 0 ? "win" : "lose"}`;
    const audioBonusNote = roundAudioOnly ? " 🎧 audio-only bonus!" : "";
    els.roundResultBanner.textContent =
      activeRow.points > 0
        ? `${activeTeam.emoji || ""} ${activeRow.name} scored +${activeRow.points} points!${audioBonusNote}`
        : `${activeTeam.emoji || ""} ${activeRow.name} scored 0 points this round.`;
    els.roundBreakdown.innerHTML = `
      <span class="${activeRow.movieOk ? "result-correct" : "result-wrong"}">Movie: ${escapeHtml(activeRow.movieGuess || "—")} ${activeRow.movieOk ? "✓" : "✗"}</span><br>
      <span class="${activeRow.directorOk ? "result-correct" : "result-wrong"}">Director: ${escapeHtml(activeRow.directorGuess || "—")} ${activeRow.directorOk ? "✓" : "✗"}</span><br>
      <span class="${activeRow.yearOk ? "result-correct" : "result-wrong"}">Year: ${escapeHtml(String(activeRow.yearGuess || "—"))} ${activeRow.yearOk ? "✓" : "✗"}</span>
    `;
  } else {
    els.roundResultBanner.className = "round-result-banner lose";
    els.roundResultBanner.textContent = "No team answered this round.";
    els.roundBreakdown.innerHTML = "";
  }

  renderScoreboard(activeRow);
  showPanel("answer");
}

function renderScoreboard(activeRow, targetEl = els.scoreboardList) {
  const standings = Object.entries(teamsMap).map(([id, team]) => ({
    id,
    name: team.name,
    emoji: team.emoji,
    score: activeRow && activeRow.teamId === id ? activeRow.newTotal : team.score || 0,
  }));
  standings.sort((a, b) => b.score - a.score);

  targetEl.innerHTML = standings.length
    ? standings
        .map(
          (t) =>
            `<div class="scoreboard-row${activeRow && t.id === activeRow.teamId ? " active-row" : ""}"><span class="sb-name">${t.emoji} ${escapeHtml(t.name)}</span><span class="sb-score">${t.score}</span></div>`
        )
        .join("")
    : '<div class="hint">No teams have joined yet.</div>';
}

els.revealBtn.addEventListener("click", performReveal);

async function advanceToNextRound() {
  await returnToLobby();
  if (queue.length === 0) {
    showPanel("all-done");
  } else {
    showIdle();
  }
}

els.nextBtn.addEventListener("click", async () => {
  const trivia = pickTriviaForClip(currentClip);
  if (trivia && Math.random() < TRIVIA_CHANCE) {
    await startTriviaRound(trivia);
  } else {
    await advanceToNextRound();
  }
});

els.triviaContinueBtn.addEventListener("click", advanceToNextRound);

els.reshuffleBtn.addEventListener("click", async () => {
  await returnToLobby();
  usedClipIds = []; // the whole library is fair game again once it's been fully exhausted
  initQueue();
  await saveGameState();
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
    await init();
  } catch (err) {
    alert(`Import failed: ${err.message}`);
  } finally {
    e.target.value = "";
  }
});

// ---------- Init ----------

async function init() {
  await loadLibrary();
  if (clips.length === 0) {
    showPanel("no-clips");
    return;
  }

  const savedRoom = localStorage.getItem(ACTIVE_ROOM_KEY);
  const resumable = savedRoom && (await tryLoadResumableGame(savedRoom));
  if (resumable) {
    showResumeChoice(resumable);
  } else {
    if (savedRoom) localStorage.removeItem(ACTIVE_ROOM_KEY); // stale pointer, room's gone
    showNewGameSetup();
  }
}

await init();
