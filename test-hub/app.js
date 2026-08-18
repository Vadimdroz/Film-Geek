// Film-Geek test hub — dev-only tool for fast manual playtesting.
// Seeds a room under a FIXED code (never a randomly generated one, unlike
// a real host game) so the "open host / open player" links below never
// need a room code copy-pasted between windows. Everything here is scoped
// to that one room code — it never touches real game data.

import { db, authReady } from "../shared/firebase.js";
import {
  doc,
  getDoc,
  getDocs,
  setDoc,
  deleteDoc,
  onSnapshot,
  collection,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";

const ROOM_CODE = "TEST";
const ACTIVE_ROOM_KEY = "filmgeek_active_room"; // same key host/app.js reads to auto-resume a game

// Fixed doc ids so re-seeding overwrites (score reset to 0) instead of
// piling up duplicate teams. The player app matches by team NAME on join,
// not by this id, so it doesn't need to match anything player-side.
const TEST_TEAMS = [
  { id: "test-team-a", name: "Team A", emoji: "🍿" },
  { id: "test-team-b", name: "Team B", emoji: "🎬" },
];

const els = {
  seedBtn: document.getElementById("seed-btn"),
  seedStatus: document.getElementById("seed-status"),
  resetBtn: document.getElementById("reset-btn"),
  resetStatus: document.getElementById("reset-status"),
  statusEmpty: document.getElementById("status-empty"),
  statusBlock: document.getElementById("status-block"),
  statusPhase: document.getElementById("status-phase"),
  statusRound: document.getElementById("status-round"),
  statusTeams: document.getElementById("status-teams"),
  teamALink: document.getElementById("team-a-link"),
  teamBLink: document.getElementById("team-b-link"),
};

function buildPlayerLink(team, testerName) {
  const params = new URLSearchParams({
    room: ROOM_CODE,
    team: team.name,
    name: testerName,
    emoji: team.emoji,
    autojoin: "1",
  });
  return `../player/?${params.toString()}`;
}

els.teamALink.href = buildPlayerLink(TEST_TEAMS[0], "Tester 1");
els.teamBLink.href = buildPlayerLink(TEST_TEAMS[1], "Tester 2");

function setStatusText(el, message, tone) {
  el.textContent = message;
  el.className = `status-text${tone ? ` ${tone}` : ""}`;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- Seed ----------

els.seedBtn.addEventListener("click", async () => {
  els.seedBtn.disabled = true;
  els.seedBtn.textContent = "Seeding…";
  setStatusText(els.seedStatus, "", null);
  try {
    const user = await authReady;
    const hostUid = user.uid;

    const clipsSnap = await getDocs(collection(db, "clipLibrary"));
    const clips = [];
    clipsSnap.forEach((d) => clips.push({ id: d.id, ...d.data() }));
    const usableClips = clips.filter((c) => !c.excluded);
    const queueIds = shuffle(usableClips.map((c) => c.id));
    const titles = [...new Set(usableClips.map((c) => c.movieTitle).filter(Boolean))].sort();

    await setDoc(doc(db, "rooms", ROOM_CODE), {
      hostUid,
      gameName: "Test Room",
      phase: "lobby",
      roundIndex: 0,
      revealedAnswer: null,
      guessDeadline: null,
      createdAt: serverTimestamp(),
    });

    await setDoc(doc(db, "rooms", ROOM_CODE, "private", "gameState"), {
      queueIds,
      usedClipIds: [],
      roundIndex: 0,
      updatedAt: serverTimestamp(),
    });

    await setDoc(doc(db, "rooms", ROOM_CODE, "public", "movieIndex"), { titles });

    await Promise.all(
      TEST_TEAMS.map((team) =>
        setDoc(doc(db, "rooms", ROOM_CODE, "teams", team.id), {
          name: team.name,
          emoji: team.emoji,
          score: 0,
          memberNames: [],
          createdAt: serverTimestamp(),
        })
      )
    );

    // Same key host/app.js reads on load — since this hub, /host, and
    // /player all share one origin, opening host/ in a regular tab of
    // this same browser profile will pick this up and auto-resume TEST
    // (it also shares this hub's anonymous-auth identity, which is what
    // tryLoadResumableGame checks against hostUid).
    localStorage.setItem(ACTIVE_ROOM_KEY, ROOM_CODE);

    if (usableClips.length === 0) {
      setStatusText(
        els.seedStatus,
        "Seeded, but your clip library is empty — tag at least one clip (step 2 below) before starting a round.",
        "warn"
      );
    } else {
      setStatusText(els.seedStatus, `Seeded with ${usableClips.length} clip(s) from your library and 2 test teams.`, "ok");
    }
  } catch (err) {
    setStatusText(els.seedStatus, `Couldn't seed: ${err.message}`, "error");
  } finally {
    els.seedBtn.disabled = false;
    els.seedBtn.textContent = "🌱 Seed test room";
  }
});

// ---------- Reset ----------

els.resetBtn.addEventListener("click", async () => {
  if (!confirm("Clear all data for the TEST room? This can't be undone.")) return;
  els.resetBtn.disabled = true;
  els.resetBtn.textContent = "Clearing…";
  setStatusText(els.resetStatus, "", null);
  try {
    await authReady;

    const teamsSnap = await getDocs(collection(db, "rooms", ROOM_CODE, "teams"));
    await Promise.all(teamsSnap.docs.map((d) => deleteDoc(d.ref)));

    const gameStateSnap = await getDoc(doc(db, "rooms", ROOM_CODE, "private", "gameState"));
    const roundCount = gameStateSnap.exists() ? gameStateSnap.data().roundIndex || 0 : 0;
    for (let i = 1; i <= roundCount; i++) {
      const guessesSnap = await getDocs(collection(db, "rooms", ROOM_CODE, "rounds", String(i), "guesses"));
      await Promise.all(guessesSnap.docs.map((d) => deleteDoc(d.ref)));
      const triviaSnap = await getDocs(collection(db, "rooms", ROOM_CODE, "rounds", String(i), "trivia"));
      await Promise.all(triviaSnap.docs.map((d) => deleteDoc(d.ref)));
    }

    await deleteDoc(doc(db, "rooms", ROOM_CODE, "private", "answer")).catch(() => {});
    await deleteDoc(doc(db, "rooms", ROOM_CODE, "private", "triviaAnswer")).catch(() => {});
    await deleteDoc(doc(db, "rooms", ROOM_CODE, "private", "gameState")).catch(() => {});
    await deleteDoc(doc(db, "rooms", ROOM_CODE, "public", "movieIndex")).catch(() => {});
    await deleteDoc(doc(db, "rooms", ROOM_CODE));

    localStorage.removeItem(ACTIVE_ROOM_KEY);
    setStatusText(els.resetStatus, "TEST room cleared.", "ok");
  } catch (err) {
    setStatusText(els.resetStatus, `Couldn't clear: ${err.message}`, "error");
  } finally {
    els.resetBtn.disabled = false;
    els.resetBtn.textContent = "🧹 Finish test game & clear TEST data";
  }
});

// ---------- Copy link ----------

document.querySelectorAll(".copy-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const link = document.getElementById(btn.dataset.target);
    try {
      await navigator.clipboard.writeText(new URL(link.getAttribute("href"), window.location.href).href);
      const original = btn.textContent;
      btn.textContent = "✓ Copied";
      setTimeout(() => (btn.textContent = original), 1500);
    } catch {
      alert("Couldn't copy — copy the link manually from the address bar after opening it.");
    }
  });
});

// ---------- Live status ----------

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function renderStatus(room, teams) {
  if (!room) {
    els.statusEmpty.hidden = false;
    els.statusBlock.hidden = true;
    return;
  }
  els.statusEmpty.hidden = true;
  els.statusBlock.hidden = false;
  els.statusPhase.textContent = room.phase || "—";
  els.statusRound.textContent = room.roundIndex ?? "—";
  els.statusTeams.innerHTML = teams.length
    ? teams
        .map((t) => `<div class="status-team-row"><span>${t.emoji || ""} ${escapeHtml(t.name)}</span><span>${t.score || 0} pts</span></div>`)
        .join("")
    : '<p class="hint">No teams joined yet.</p>';
}

let latestRoom = null;
let latestTeams = [];

// Wait for anonymous sign-in before attaching listeners — rules require
// isSignedIn() to read rooms/teams, and attaching earlier would surface a
// spurious permission-denied error in the console during the brief window
// before auth resolves.
await authReady;

onSnapshot(doc(db, "rooms", ROOM_CODE), (snap) => {
  latestRoom = snap.exists() ? snap.data() : null;
  renderStatus(latestRoom, latestTeams);
});

onSnapshot(collection(db, "rooms", ROOM_CODE, "teams"), (snap) => {
  latestTeams = [];
  snap.forEach((d) => latestTeams.push({ id: d.id, ...d.data() }));
  renderStatus(latestRoom, latestTeams);
});
