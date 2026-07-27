// Film-Geek clip tagging tool — vanilla JS, no build step.
// Clips are stored in this browser's localStorage until Firebase sync is wired up.

const STORAGE_KEY = "filmgeek_clips";
const TMDB_KEY_STORAGE = "filmgeek_tmdb_key";

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
  tmdbKey: document.getElementById("tmdb-key"),
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
let editIndex = null; // null = adding new clip, otherwise index into clips array being edited

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
  } catch (err) {
    currentVideoId = videoId;
    currentEmbeddable = false;
    els.checkResult.innerHTML = "";
    const text = document.createElement("span");
    text.textContent = "Could not confirm this clip embeds (blocked, region-locked, or invalid ID). ";
    const proceedBtn = document.createElement("button");
    proceedBtn.textContent = "Use anyway";
    proceedBtn.addEventListener("click", () => openPlayerFor(videoId));
    els.checkResult.appendChild(text);
    els.checkResult.appendChild(proceedBtn);
    els.checkResult.classList.add("bad");
  }
});

// ---------- YouTube IFrame player ----------

// Called by the YouTube IFrame API script once it has loaded.
window.onYouTubeIframeAPIReady = function () {
  ytPlayerReady = true;
};

function openPlayerFor(videoId) {
  els.playerSection.hidden = false;
  els.metadataSection.hidden = false;

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

  if (ytPlayerReady) {
    start();
  } else {
    const waitForApi = setInterval(() => {
      if (ytPlayerReady) {
        clearInterval(waitForApi);
        start();
      }
    }, 200);
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

els.autofillBtn.addEventListener("click", async () => {
  const key = els.tmdbKey.value.trim();
  const title = els.movieTitle.value.trim();
  els.tmdbPicker.hidden = true;
  els.tmdbPicker.innerHTML = "";

  if (!key) {
    alert("Paste a TMDb API key above first (free at themoviedb.org/settings/api).");
    return;
  }
  if (!title) {
    alert("Type a movie title first, then autofill.");
    return;
  }

  try {
    const searchRes = await fetch(
      `https://api.themoviedb.org/3/search/movie?api_key=${encodeURIComponent(key)}&query=${encodeURIComponent(title)}`
    );
    if (!searchRes.ok) throw new Error(`TMDb search returned ${searchRes.status}`);
    const searchData = await searchRes.json();
    const results = searchData.results || [];

    if (results.length === 0) {
      alert("No TMDb matches for that title — fill in the details manually.");
      return;
    }
    if (results.length === 1) {
      await fillFromTmdbMovie(results[0].id, key);
      return;
    }

    els.tmdbPicker.hidden = false;
    results.slice(0, 8).forEach((movie) => {
      const btn = document.createElement("button");
      const year = (movie.release_date || "").slice(0, 4) || "?";
      btn.textContent = `${movie.title} (${year})`;
      btn.addEventListener("click", async () => {
        await fillFromTmdbMovie(movie.id, key);
        els.tmdbPicker.hidden = true;
      });
      els.tmdbPicker.appendChild(btn);
    });
  } catch (err) {
    alert(`TMDb lookup failed: ${err.message}`);
  }
});

async function fillFromTmdbMovie(movieId, key) {
  const res = await fetch(
    `https://api.themoviedb.org/3/movie/${movieId}?api_key=${encodeURIComponent(key)}&append_to_response=credits`
  );
  if (!res.ok) {
    alert(`TMDb details lookup failed (${res.status}).`);
    return;
  }
  const data = await res.json();
  els.movieTitle.value = data.title || els.movieTitle.value;
  els.movieYear.value = (data.release_date || "").slice(0, 4) || "";
  const director = (data.credits?.crew || []).find((c) => c.job === "Director");
  els.movieDirector.value = director ? director.name : "";
  els.movieCast.value = (data.credits?.cast || []).slice(0, 6).map((c) => c.name).join(", ");
  els.movieGenre.value = (data.genres || []).map((g) => g.name).join(", ");
}

// ---------- Clip storage ----------

function loadClips() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveClips(clips) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(clips));
}

function resetForm() {
  currentVideoId = null;
  currentEmbeddable = null;
  editIndex = null;
  els.youtubeUrl.value = "";
  els.checkResult.textContent = "";
  els.checkResult.className = "check-result";
  els.playerSection.hidden = true;
  els.metadataSection.hidden = true;
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
  els.cancelEditBtn.hidden = true;
  if (previewWatchInterval) clearInterval(previewWatchInterval);
}

els.saveClipBtn.addEventListener("click", () => {
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
    embeddable: currentEmbeddable,
    addedAt: new Date().toISOString(),
  };

  const clips = loadClips();
  if (editIndex !== null) {
    clips[editIndex] = clip;
  } else {
    clips.push(clip);
  }
  saveClips(clips);
  renderTable();
  resetForm();
});

els.cancelEditBtn.addEventListener("click", resetForm);

// ---------- Table rendering ----------

function renderTable() {
  const clips = loadClips();
  els.clipCount.textContent = `(${clips.length})`;
  els.clipTableBody.innerHTML = "";

  clips.forEach((clip, index) => {
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

    const actionsTd = document.createElement("td");
    actionsTd.className = "actions";
    const editBtn = document.createElement("button");
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => loadClipIntoForm(index));
    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", () => deleteClip(index));
    actionsTd.appendChild(editBtn);
    actionsTd.appendChild(deleteBtn);
    tr.appendChild(actionsTd);

    els.clipTableBody.appendChild(tr);
  });
}

function loadClipIntoForm(index) {
  const clips = loadClips();
  const clip = clips[index];
  if (!clip) return;

  editIndex = index;
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

  els.cancelEditBtn.hidden = false;
  openPlayerFor(clip.youtubeId);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function deleteClip(index) {
  const clips = loadClips();
  clips.splice(index, 1);
  saveClips(clips);
  renderTable();
}

// ---------- Export / Import ----------

els.exportBtn.addEventListener("click", () => {
  const clips = loadClips();
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
    renderTable();
    alert(`Imported ${imported.length} clip(s).`);
  } catch (err) {
    alert(`Import failed: ${err.message}`);
  } finally {
    e.target.value = "";
  }
});

// ---------- Init ----------

renderTable();
