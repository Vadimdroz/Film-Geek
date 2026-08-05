// Film-Geek clip tagging tool — vanilla JS, no build step.
// Clips live in Firestore (clipLibrary/{clipId}) — that's the durable
// source of truth, not this browser's localStorage, which has already
// been lost more than once (a stray localStorage.clear() elsewhere on
// the site, or just unreliable browser storage). localStorage is still
// written as a passive mirror/offline cache, but Firestore is what
// survives a wiped browser.

import { db, authReady } from "../shared/firebase.js";
import {
  collection,
  doc,
  getDocs,
  setDoc,
  deleteDoc,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";

const STORAGE_KEY = "filmgeek_clips";
const TMDB_KEY_STORAGE = "filmgeek_tmdb_key";

function computeClipId(clip) {
  return `${clip.youtubeId}_${clip.startSec}_${clip.endSec}`;
}

const els = {
  youtubeUrl: document.getElementById("youtube-url"),
  checkBtn: document.getElementById("check-btn"),
  checkResult: document.getElementById("check-result"),

  playerSection: document.getElementById("player-section"),
  currentTime: document.getElementById("current-time"),
  setStartBtn: document.getElementById("set-start-btn"),
  setEndBtn: document.getElementById("set-end-btn"),
  previewBtn: document.getElementById("preview-btn"),
  startSec: document.getElementById("start-sec"),
  endSec: document.getElementById("end-sec"),
  durationDisplay: document.getElementById("duration-display"),

  metadataSection: document.getElementById("metadata-section"),
  metadataTitleDisplay: document.getElementById("metadata-title-display"),
  tmdbKey: document.getElementById("tmdb-key"),
  tmdbStatus: document.getElementById("tmdb-status"),
  movieTitle: document.getElementById("movie-title"),
  autofillBtn: document.getElementById("autofill-btn"),
  tmdbPicker: document.getElementById("tmdb-picker"),
  movieYear: document.getElementById("movie-year"),
  movieDirector: document.getElementById("movie-director"),
  movieCast: document.getElementById("movie-cast"),
  movieGenre: document.getElementById("movie-genre"),
  movieDifficulty: document.getElementById("movie-difficulty"),
  movieNotes: document.getElementById("movie-notes"),
  saveClipBtn: document.getElementById("save-clip-btn"),
  cancelEditBtn: document.getElementById("cancel-edit-btn"),

  triviaSection: document.getElementById("trivia-section"),
  triviaList: document.getElementById("trivia-list"),
  triviaQuestionInput: document.getElementById("trivia-question-input"),
  triviaOptInputs: [0, 1, 2, 3].map((i) => document.getElementById(`trivia-opt-${i}`)),
  triviaCorrectSelect: document.getElementById("trivia-correct-select"),
  addTriviaBtn: document.getElementById("add-trivia-btn"),

  clipCount: document.getElementById("clip-count"),
  exportBtn: document.getElementById("export-btn"),
  importInput: document.getElementById("import-input"),
  clipTableBody: document.getElementById("clip-table-body"),
};

let ytPlayer = null;
let ytPlayerReady = false;
let timeTrackInterval = null;
let previewWatchInterval = null;

let currentVideoId = null;
let currentEmbeddable = null; // true | false | null (unknown)
let editingClipId = null; // null = adding new clip, otherwise the Firestore doc id being edited
let clips = []; // live-synced from Firestore, each entry carries its own .id
let pendingTrivia = []; // trivia questions staged for the clip currently being added/edited

// ---------- Bonus trivia ----------

function renderTriviaList() {
  els.triviaList.innerHTML = pendingTrivia
    .map(
      (t, i) => `
      <div class="trivia-item">
        <span class="trivia-item-text">${escapeHtml(t.question)} <span class="trivia-item-answer">(${"ABCD"[t.correctIndex]}: ${escapeHtml(t.options[t.correctIndex])})</span></span>
        <button type="button" data-index="${i}" class="remove-trivia-btn">Remove</button>
      </div>`
    )
    .join("");
  els.triviaList.querySelectorAll(".remove-trivia-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      pendingTrivia.splice(Number(btn.dataset.index), 1);
      renderTriviaList();
    });
  });
}

function clearTriviaInputs() {
  els.triviaQuestionInput.value = "";
  els.triviaOptInputs.forEach((input) => (input.value = ""));
  els.triviaCorrectSelect.value = "0";
}

els.addTriviaBtn.addEventListener("click", () => {
  const question = els.triviaQuestionInput.value.trim();
  const options = els.triviaOptInputs.map((input) => input.value.trim());
  if (!question || options.some((o) => !o)) {
    alert("Fill in the question and all 4 options first.");
    return;
  }
  pendingTrivia.push({ question, options, correctIndex: Number(els.triviaCorrectSelect.value) });
  clearTriviaInputs();
  renderTriviaList();
});

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

// ---------- YouTube ID parsing ----------

function parseYouTubeId(input) {
  const raw = input.trim();
  if (!raw) return null;
  const idOnly = /^[\w-]{11}$/;
  if (idOnly.test(raw)) return raw;

  try {
    const url = new URL(raw);
    if (url.hostname.includes("youtu.be")) {
      return url.pathname.slice(1).split("/")[0] || null;
    }
    if (url.hostname.includes("youtube.com")) {
      if (url.searchParams.has("v")) return url.searchParams.get("v");
      const embedMatch = url.pathname.match(/\/embed\/([\w-]{11})/);
      if (embedMatch) return embedMatch[1];
      const shortsMatch = url.pathname.match(/\/shorts\/([\w-]{11})/);
      if (shortsMatch) return shortsMatch[1];
    }
  } catch {
    // not a URL, fall through
  }
  return null;
}

// ---------- Embeddability check (YouTube oEmbed) ----------

async function checkEmbeddable(videoId) {
  const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(
    `https://www.youtube.com/watch?v=${videoId}`
  )}&format=json`;
  const res = await fetch(oembedUrl);
  if (!res.ok) throw new Error(`oEmbed returned ${res.status}`);
  return res.json();
}

els.checkBtn.addEventListener("click", async () => {
  const videoId = parseYouTubeId(els.youtubeUrl.value);
  els.checkResult.className = "check-result";
  if (!videoId) {
    els.checkResult.textContent = "Couldn't find a video ID in that — paste a full YouTube URL or the 11-character video ID.";
    els.checkResult.classList.add("bad");
    return;
  }

  els.checkResult.textContent = "Checking…";

  try {
    const info = await checkEmbeddable(videoId);
    currentVideoId = videoId;
    currentEmbeddable = true;
    els.checkResult.innerHTML = "";
    const img = document.createElement("img");
    img.src = info.thumbnail_url;
    const text = document.createElement("span");
    text.textContent = `Embeddable — "${info.title}" (${info.author_name})`;
    els.checkResult.appendChild(img);
    els.checkResult.appendChild(text);
    els.checkResult.classList.add("ok");
    openPlayerFor(videoId);
    runTmdbAutofill();
  } catch (err) {
    currentVideoId = videoId;
    currentEmbeddable = false;
    els.checkResult.innerHTML = "";
    const text = document.createElement("span");
    text.textContent = "Could not confirm this clip embeds (blocked, region-locked, or invalid ID). ";
    const proceedBtn = document.createElement("button");
    proceedBtn.textContent = "Use anyway";
    proceedBtn.addEventListener("click", () => {
      openPlayerFor(videoId);
      runTmdbAutofill();
    });
    els.checkResult.appendChild(text);
    els.checkResult.appendChild(proceedBtn);
    els.checkResult.classList.add("bad");
  }
});

// ---------- YouTube IFrame player ----------

// window.onYouTubeIframeAPIReady is the API's own callback hook, but it's
// only reliable if it's registered before the API finishes loading — and
// since our code runs as a deferred module script, on a repeat visit with
// the API script already cached, the API can finish and skip calling it
// before we've even registered it (same bug, same fix, as the host app).
// Polling for YT.Player directly instead can't miss that window.
function openPlayerFor(videoId) {
  els.playerSection.hidden = false;
  els.metadataSection.hidden = false;
  els.triviaSection.hidden = false;
  els.metadataTitleDisplay.textContent = els.movieTitle.value.trim() || "(untitled)";

  const start = () => {
    if (ytPlayer) {
      ytPlayer.cueVideoById(videoId);
    } else {
      ytPlayer = new YT.Player("yt-player", {
        videoId,
        playerVars: { modestbranding: 1, rel: 0, controls: 1 },
        events: {
          onReady: () => startTimeTracking(),
        },
      });
    }
  };

  if (window.YT && window.YT.Player) {
    ytPlayerReady = true;
    start();
  } else {
    const waitForApi = setInterval(() => {
      if (window.YT && window.YT.Player) {
        ytPlayerReady = true;
        clearInterval(waitForApi);
        start();
      }
    }, 100);
  }
}

function startTimeTracking() {
  if (timeTrackInterval) clearInterval(timeTrackInterval);
  timeTrackInterval = setInterval(() => {
    if (ytPlayer && typeof ytPlayer.getCurrentTime === "function") {
      els.currentTime.textContent = ytPlayer.getCurrentTime().toFixed(1);
    }
  }, 200);
}

els.setStartBtn.addEventListener("click", () => {
  if (!ytPlayer) return;
  els.startSec.value = ytPlayer.getCurrentTime().toFixed(1);
  updateDurationDisplay();
});

els.setEndBtn.addEventListener("click", () => {
  if (!ytPlayer) return;
  els.endSec.value = ytPlayer.getCurrentTime().toFixed(1);
  updateDurationDisplay();
});

els.previewBtn.addEventListener("click", () => {
  if (!ytPlayer) return;
  const start = parseFloat(els.startSec.value) || 0;
  const end = parseFloat(els.endSec.value) || start + 10;
  ytPlayer.seekTo(start, true);
  ytPlayer.playVideo();
  if (previewWatchInterval) clearInterval(previewWatchInterval);
  previewWatchInterval = setInterval(() => {
    if (ytPlayer.getCurrentTime() >= end) {
      ytPlayer.pauseVideo();
      clearInterval(previewWatchInterval);
    }
  }, 100);
});

function updateDurationDisplay() {
  const start = parseFloat(els.startSec.value);
  const end = parseFloat(els.endSec.value);
  if (isNaN(start) || isNaN(end)) {
    els.durationDisplay.textContent = "";
    return;
  }
  const dur = end - start;
  els.durationDisplay.textContent = `${dur.toFixed(1)}s clip`;
  els.durationDisplay.classList.toggle("warn", dur < 8 || dur > 16 || dur <= 0);
}

els.startSec.addEventListener("input", updateDurationDisplay);
els.endSec.addEventListener("input", updateDurationDisplay);

// ---------- TMDb autofill ----------

els.tmdbKey.value = localStorage.getItem(TMDB_KEY_STORAGE) || "";
els.tmdbKey.addEventListener("change", () => {
  localStorage.setItem(TMDB_KEY_STORAGE, els.tmdbKey.value.trim());
});

els.autofillBtn.addEventListener("click", () => runTmdbAutofill());

function setTmdbStatus(message, tone) {
  els.tmdbStatus.textContent = message;
  els.tmdbStatus.className = "check-result" + (tone ? ` ${tone}` : "");
}

async function tmdbSearch(title, key) {
  const res = await fetch(
    `https://api.themoviedb.org/3/search/movie?api_key=${encodeURIComponent(key)}&query=${encodeURIComponent(title)}`
  );
  if (!res.ok) throw new Error(`TMDb search returned ${res.status}`);
  const data = await res.json();
  return data.results || [];
}

// Runs the TMDb waterfall: search by title, auto-apply the best match, and
// offer the rest as overrides. Uses inline status text rather than alert()
// so it can run automatically right after "Add clip", not just on a click.
async function runTmdbAutofill() {
  const key = els.tmdbKey.value.trim();
  const title = els.movieTitle.value.trim();
  els.tmdbPicker.hidden = true;
  els.tmdbPicker.innerHTML = "";

  if (!key) {
    setTmdbStatus("No TMDb key saved yet — paste one above to autofill year/director/cast.", "muted");
    return;
  }
  if (!title) {
    setTmdbStatus("Add a movie title above to autofill from TMDb.", "muted");
    return;
  }

  setTmdbStatus("Looking up on TMDb…", "muted");

  try {
    const results = await tmdbSearch(title, key);
    if (results.length === 0) {
      setTmdbStatus("No TMDb matches for that title — fill in the details manually.", "bad");
      return;
    }

    const best = results[0];
    const applyMatch = async (movie) => {
      await fillFromTmdbMovie(movie.id, key);
      els.movieTitle.value = movie.title;
      els.metadataTitleDisplay.textContent = movie.title;
      const year = (movie.release_date || "").slice(0, 4) || "?";
      setTmdbStatus(`Matched "${movie.title}" (${year}) on TMDb.`, "ok");
    };

    await applyMatch(best);

    if (results.length > 1) {
      els.tmdbPicker.hidden = false;
      results.slice(0, 8).forEach((movie) => {
        const btn = document.createElement("button");
        const year = (movie.release_date || "").slice(0, 4) || "?";
        btn.textContent = movie.id === best.id ? `✓ ${movie.title} (${year})` : `${movie.title} (${year})`;
        btn.addEventListener("click", () => applyMatch(movie));
        els.tmdbPicker.appendChild(btn);
      });
    }
  } catch (err) {
    setTmdbStatus(`TMDb lookup failed: ${err.message}`, "bad");
  }
}

async function fillFromTmdbMovie(movieId, key) {
  const res = await fetch(
    `https://api.themoviedb.org/3/movie/${movieId}?api_key=${encodeURIComponent(key)}&append_to_response=credits`
  );
  if (!res.ok) throw new Error(`TMDb details lookup failed (${res.status})`);
  const data = await res.json();
  els.movieYear.value = (data.release_date || "").slice(0, 4) || "";
  const director = (data.credits?.crew || []).find((c) => c.job === "Director");
  els.movieDirector.value = director ? director.name : "";
  els.movieCast.value = (data.credits?.cast || []).slice(0, 6).map((c) => c.name).join(", ");
  els.movieGenre.value = (data.genres || []).map((g) => g.name).join(", ");
}

// ---------- Clip storage (Firestore, live-synced) ----------

let unsubscribeClips = null;

// One-time safety net: the very first time this loads after switching to
// Firestore, the cloud library is empty but this browser's localStorage
// might still hold clips from before. Seed the cloud from that local
// cache so switching storage backends doesn't itself look like data loss.
// Only runs when the cloud is empty — never overwrites real cloud data.
async function migrateLocalStorageClipsIfNeeded() {
  try {
    const existingSnap = await getDocs(collection(db, "clipLibrary"));
    if (!existingSnap.empty) return;
    const local = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    if (local.length === 0) return;
    for (const clip of local) {
      await setDoc(doc(db, "clipLibrary", computeClipId(clip)), clip);
    }
  } catch (err) {
    console.error("One-time localStorage-to-cloud migration failed", err);
  }
}

async function initClipSync() {
  await authReady;
  await migrateLocalStorageClipsIfNeeded();
  if (unsubscribeClips) unsubscribeClips();
  unsubscribeClips = onSnapshot(
    collection(db, "clipLibrary"),
    (snap) => {
      clips = [];
      snap.forEach((d) => clips.push({ id: d.id, ...d.data() }));
      clips.sort((a, b) => (a.addedAt || "").localeCompare(b.addedAt || ""));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(clips)); // passive mirror only
      renderTable();
    },
    (err) => {
      console.error("Clip library sync failed", err);
      setTmdbStatus(`Cloud sync error: ${err.message} — check your connection.`, "bad");
    }
  );
}

function resetForm() {
  if (ytPlayer && typeof ytPlayer.pauseVideo === "function") {
    ytPlayer.pauseVideo();
  }
  currentVideoId = null;
  currentEmbeddable = null;
  editingClipId = null;
  els.youtubeUrl.value = "";
  els.checkResult.textContent = "";
  els.checkResult.className = "check-result";
  els.playerSection.hidden = true;
  els.metadataSection.hidden = true;
  els.triviaSection.hidden = true;
  pendingTrivia = [];
  clearTriviaInputs();
  renderTriviaList();
  els.startSec.value = "0";
  els.endSec.value = "10";
  els.durationDisplay.textContent = "";
  els.movieTitle.value = "";
  els.movieYear.value = "";
  els.movieDirector.value = "";
  els.movieCast.value = "";
  els.movieGenre.value = "";
  els.movieDifficulty.value = "medium";
  els.movieNotes.value = "";
  els.tmdbPicker.hidden = true;
  els.tmdbPicker.innerHTML = "";
  els.tmdbStatus.textContent = "";
  els.tmdbStatus.className = "check-result";
  els.metadataTitleDisplay.textContent = "";
  els.cancelEditBtn.hidden = true;
  if (previewWatchInterval) clearInterval(previewWatchInterval);
}

els.saveClipBtn.addEventListener("click", async () => {
  if (!currentVideoId) {
    alert("Check a YouTube clip first.");
    return;
  }
  if (!els.movieTitle.value.trim()) {
    alert("Movie title is required.");
    return;
  }

  const clip = {
    youtubeId: currentVideoId,
    startSec: parseFloat(els.startSec.value) || 0,
    endSec: parseFloat(els.endSec.value) || 10,
    movieTitle: els.movieTitle.value.trim(),
    year: els.movieYear.value ? parseInt(els.movieYear.value, 10) : null,
    director: els.movieDirector.value.trim(),
    cast: els.movieCast.value.split(",").map((s) => s.trim()).filter(Boolean),
    genre: els.movieGenre.value.trim(),
    difficulty: els.movieDifficulty.value,
    notes: els.movieNotes.value.trim(),
    trivia: pendingTrivia,
    embeddable: currentEmbeddable,
    excluded: editingClipId ? clips.find((c) => c.id === editingClipId)?.excluded || false : false,
    addedAt: editingClipId ? clips.find((c) => c.id === editingClipId)?.addedAt || new Date().toISOString() : new Date().toISOString(),
  };

  const newId = computeClipId(clip);
  els.saveClipBtn.disabled = true;
  try {
    await setDoc(doc(db, "clipLibrary", newId), clip);
    if (editingClipId && editingClipId !== newId) {
      await deleteDoc(doc(db, "clipLibrary", editingClipId));
    }
    resetForm();
  } catch (err) {
    alert(`Couldn't save to the cloud: ${err.message}`);
  } finally {
    els.saveClipBtn.disabled = false;
  }
});

els.cancelEditBtn.addEventListener("click", resetForm);

// ---------- Table rendering ----------

function renderTable() {
  els.clipCount.textContent = `(${clips.length})`;
  els.clipTableBody.innerHTML = "";

  clips.forEach((clip) => {
    const tr = document.createElement("tr");

    const thumbTd = document.createElement("td");
    const img = document.createElement("img");
    img.src = `https://img.youtube.com/vi/${clip.youtubeId}/mqdefault.jpg`;
    img.alt = "";
    thumbTd.appendChild(img);
    tr.appendChild(thumbTd);

    const titleTd = document.createElement("td");
    titleTd.textContent = clip.movieTitle;
    tr.appendChild(titleTd);

    const yearTd = document.createElement("td");
    yearTd.textContent = clip.year ?? "";
    tr.appendChild(yearTd);

    const directorTd = document.createElement("td");
    directorTd.textContent = clip.director || "";
    tr.appendChild(directorTd);

    const rangeTd = document.createElement("td");
    rangeTd.textContent = `${clip.startSec}s–${clip.endSec}s`;
    tr.appendChild(rangeTd);

    const diffTd = document.createElement("td");
    diffTd.textContent = clip.difficulty || "";
    tr.appendChild(diffTd);

    const embedTd = document.createElement("td");
    embedTd.textContent = clip.embeddable ? "yes" : clip.embeddable === false ? "no" : "?";
    embedTd.className = clip.embeddable ? "badge-yes" : "badge-no";
    tr.appendChild(embedTd);

    const includeTd = document.createElement("td");
    const includeCheckbox = document.createElement("input");
    includeCheckbox.type = "checkbox";
    includeCheckbox.checked = !clip.excluded;
    includeCheckbox.title = "Uncheck to leave this clip out of future games";
    includeCheckbox.addEventListener("change", () => setClipExcluded(clip, !includeCheckbox.checked));
    includeTd.appendChild(includeCheckbox);
    tr.appendChild(includeTd);
    if (clip.excluded) tr.classList.add("excluded-row");

    const actionsTd = document.createElement("td");
    actionsTd.className = "actions";
    const editBtn = document.createElement("button");
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => loadClipIntoForm(clip));
    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", () => deleteClip(clip));
    actionsTd.appendChild(editBtn);
    actionsTd.appendChild(deleteBtn);
    tr.appendChild(actionsTd);

    els.clipTableBody.appendChild(tr);
  });
}

function loadClipIntoForm(clip) {
  editingClipId = clip.id;
  currentVideoId = clip.youtubeId;
  currentEmbeddable = clip.embeddable;

  els.youtubeUrl.value = clip.youtubeId;
  els.checkResult.textContent = `Editing existing clip — "${clip.movieTitle}"`;
  els.checkResult.className = "check-result ok";

  els.startSec.value = clip.startSec;
  els.endSec.value = clip.endSec;
  updateDurationDisplay();

  els.movieTitle.value = clip.movieTitle || "";
  els.movieYear.value = clip.year ?? "";
  els.movieDirector.value = clip.director || "";
  els.movieCast.value = (clip.cast || []).join(", ");
  els.movieGenre.value = clip.genre || "";
  els.movieDifficulty.value = clip.difficulty || "medium";
  els.movieNotes.value = clip.notes || "";

  pendingTrivia = (clip.trivia || []).map((t) => ({ ...t }));
  clearTriviaInputs();
  renderTriviaList();

  els.cancelEditBtn.hidden = false;
  openPlayerFor(clip.youtubeId); // also syncs metadata-title-display from movieTitle
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// Toggled straight from the table so excluding a clip a group has already
// seen doesn't require opening the full edit form.
async function setClipExcluded(clip, excluded) {
  try {
    await setDoc(doc(db, "clipLibrary", clip.id), { excluded }, { merge: true });
  } catch (err) {
    alert(`Couldn't update: ${err.message}`);
    renderTable(); // revert the checkbox to match the last known-good state
  }
}

async function deleteClip(clip) {
  if (!confirm(`Delete "${clip.movieTitle}"? This can't be undone.`)) return;
  try {
    await deleteDoc(doc(db, "clipLibrary", clip.id));
  } catch (err) {
    alert(`Couldn't delete: ${err.message}`);
  }
}

// ---------- Export / Import ----------

els.exportBtn.addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(clips, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "filmgeek-clips.json";
  a.click();
  URL.revokeObjectURL(url);
});

els.importInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const imported = JSON.parse(text);
    if (!Array.isArray(imported)) throw new Error("Expected a JSON array of clips.");

    for (const incoming of imported) {
      await setDoc(doc(db, "clipLibrary", computeClipId(incoming)), incoming);
    }
    alert(`Imported ${imported.length} clip(s) to the cloud library.`);
  } catch (err) {
    alert(`Import failed: ${err.message}`);
  } finally {
    e.target.value = "";
  }
});

// ---------- Init ----------

initClipSync();
