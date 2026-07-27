// Film-Geek player app — vanilla JS, no build step.
// Joins a room by code and submits guesses; never has access to the
// answer until the host reveals it (Firestore rules enforce this, not
// just the UI). See /firestore.rules for the actual access control.

import { db, authReady } from "../shared/firebase.js";
import {
  doc,
  getDoc,
  setDoc,
  onSnapshot,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";

const ROOM_STORAGE_KEY = "filmgeek_player_room";
const NAME_STORAGE_KEY = "filmgeek_player_name";

const els = {
  topBar: document.getElementById("top-bar"),
  topRoom: document.getElementById("top-room"),
  topScore: document.getElementById("top-score"),

  screens: {
    join: document.getElementById("join-screen"),
    waiting: document.getElementById("waiting-screen"),
    guessing: document.getElementById("guessing-screen"),
    locked: document.getElementById("locked-screen"),
    revealed: document.getElementById("revealed-screen"),
  },

  roomCodeInput: document.getElementById("room-code-input"),
  nameInput: document.getElementById("name-input"),
  joinBtn: document.getElementById("join-btn"),
  joinError: document.getElementById("join-error"),

  guessOptions: document.getElementById("guess-options"),
  guessFreetext: document.getElementById("guess-freetext"),
  guessFreetextInput: document.getElementById("guess-freetext-input"),
  guessFreetextBtn: document.getElementById("guess-freetext-btn"),

  lockedChoice: document.getElementById("locked-choice"),

  revealedTitle: document.getElementById("revealed-title"),
  revealedMeta: document.getElementById("revealed-meta"),
  revealedYourGuess: document.getElementById("revealed-your-guess"),
};

let roomCode = null;
let myUid = null;
let lastSeenRoundIndex = -1;
let hasGuessedThisRound = false;
let myLastChoice = null;
let currentOptions = [];

function showScreen(name) {
  for (const [key, el] of Object.entries(els.screens)) {
    el.hidden = key !== name;
  }
}

function showJoinError(message) {
  els.joinError.textContent = message;
}

// ---------- Join ----------

els.joinBtn.addEventListener("click", async () => {
  const code = els.roomCodeInput.value.trim().toUpperCase();
  const name = els.nameInput.value.trim();
  showJoinError("");

  if (code.length !== 4) {
    showJoinError("Room codes are 4 characters.");
    return;
  }
  if (!name) {
    showJoinError("Enter your name so the host can see your score.");
    return;
  }

  els.joinBtn.disabled = true;
  els.joinBtn.textContent = "Joining…";
  try {
    const user = await authReady;
    myUid = user.uid;

    const roomRef = doc(db, "rooms", code);
    const snap = await getDoc(roomRef);
    if (!snap.exists()) {
      showJoinError("Room not found — double check the code with the host.");
      return;
    }

    await setDoc(
      doc(db, "rooms", code, "players", myUid),
      { name, joinedAt: serverTimestamp(), score: 0 },
      { merge: true }
    );

    roomCode = code;
    localStorage.setItem(ROOM_STORAGE_KEY, code);
    localStorage.setItem(NAME_STORAGE_KEY, name);
    attachListeners();
  } catch (err) {
    showJoinError(`Couldn't join: ${err.message}`);
  } finally {
    els.joinBtn.disabled = false;
    els.joinBtn.textContent = "Join";
  }
});

// ---------- Live room state ----------

function attachListeners() {
  els.topBar.hidden = false;
  els.topRoom.textContent = `Room ${roomCode}`;
  showScreen("waiting");

  onSnapshot(doc(db, "rooms", roomCode), (snap) => {
    const data = snap.data();
    if (data) handleRoomUpdate(data);
  });

  onSnapshot(doc(db, "rooms", roomCode, "players", myUid), (snap) => {
    const data = snap.data();
    if (data) els.topScore.textContent = `Score: ${data.score || 0}`;
  });
}

function handleRoomUpdate(data) {
  if (data.roundIndex !== lastSeenRoundIndex) {
    lastSeenRoundIndex = data.roundIndex;
    hasGuessedThisRound = false;
    myLastChoice = null;
  }
  currentOptions = data.currentOptions || [];

  if (data.phase === "playing") {
    if (hasGuessedThisRound) {
      showScreen("locked");
    } else {
      renderGuessing();
    }
  } else if (data.phase === "revealed") {
    renderRevealed(data.revealedAnswer);
  } else {
    // "lobby" or unknown — waiting for the host to start a round
    showScreen("waiting");
  }
}

// ---------- Guessing ----------

function renderGuessing() {
  showScreen("guessing");
  els.guessOptions.innerHTML = "";

  if (currentOptions.length >= 2) {
    els.guessFreetext.hidden = true;
    currentOptions.forEach((title) => {
      const btn = document.createElement("button");
      btn.className = "option-btn";
      btn.textContent = title;
      btn.addEventListener("click", () => submitGuess(title));
      els.guessOptions.appendChild(btn);
    });
  } else {
    // Tiny library (not enough other movies for multiple-choice distractors)
    // — fall back to a free-text guess for this round.
    els.guessFreetext.hidden = false;
  }
}

els.guessFreetextBtn.addEventListener("click", () => {
  const v = els.guessFreetextInput.value.trim();
  if (v) submitGuess(v);
});

async function submitGuess(choice) {
  hasGuessedThisRound = true;
  myLastChoice = choice;
  els.lockedChoice.textContent = choice;
  showScreen("locked");
  try {
    await setDoc(doc(db, "rooms", roomCode, "rounds", String(lastSeenRoundIndex), "guesses", myUid), {
      choice,
      submittedAt: serverTimestamp(),
    });
  } catch (err) {
    hasGuessedThisRound = false;
    showJoinError("");
    renderGuessing();
    alert(`Couldn't submit your guess: ${err.message}`);
  }
}

// ---------- Reveal ----------

function renderRevealed(answer) {
  showScreen("revealed");
  if (!answer) return;

  els.revealedTitle.textContent = `${answer.movieTitle}${answer.year ? ` (${answer.year})` : ""}`;
  els.revealedMeta.textContent = answer.director ? `Directed by ${answer.director}` : "";

  if (myLastChoice) {
    const correct = myLastChoice === answer.movieTitle;
    els.revealedYourGuess.textContent = correct
      ? `You guessed "${myLastChoice}" — correct! 🎉`
      : `You guessed "${myLastChoice}" — not quite.`;
    els.revealedYourGuess.className = `your-guess ${correct ? "result-correct" : "result-wrong"}`;
  } else {
    els.revealedYourGuess.textContent = "You didn't answer this round.";
    els.revealedYourGuess.className = "your-guess";
  }
}

// ---------- Reconnect on load ----------

(async function initFromStorage() {
  const savedRoom = localStorage.getItem(ROOM_STORAGE_KEY);
  const savedName = localStorage.getItem(NAME_STORAGE_KEY);
  if (!savedRoom || !savedName) {
    showScreen("join");
    return;
  }

  els.roomCodeInput.value = savedRoom;
  els.nameInput.value = savedName;

  try {
    const user = await authReady;
    myUid = user.uid;
    const snap = await getDoc(doc(db, "rooms", savedRoom));
    if (!snap.exists()) {
      showScreen("join");
      return;
    }
    await setDoc(doc(db, "rooms", savedRoom, "players", myUid), { name: savedName }, { merge: true });
    roomCode = savedRoom;
    attachListeners();
  } catch {
    showScreen("join");
  }
})();
