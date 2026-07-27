// Film-Geek host display — vanilla JS, no build step.
// Reads the same clip library the admin-tagging tool writes to (same-origin
// localStorage). Firebase sync for multiplayer/room state is a later milestone.

const STORAGE_KEY = "filmgeek_clips";

const els = {
  playerWrap: document.getElementById("player-wrap"),
  hud: document.getElementById("hud"),
  timer: document.getElementById("timer"),
  stopEarlyBtn: document.getElementById("stop-early-btn"),

  cover: document.getElementById("cover"),
  idlePanel: document.getElementById("idle-panel"),
  queueStatus: document.getElementById("queue-status"),
  startBtn: document.getElementById("start-btn"),

  noClipsPanel: document.getElementById("no-clips-panel"),
  importInput: document.getElementById("import-input"),

  endedPanel: document.getElementById("ended-panel"),
  revealBtn: document.getElementById("reveal-btn"),

  answerPanel: document.getElementById("answer-panel"),
  answerTitle: document.getElementById("answer-title"),
  answerMeta: document.getElementById("answer-meta"),
  nextBtn: document.getElementById("next-btn"),

  allDonePanel: document.getElementById("all-done-panel"),
  reshuffleBtn: document.getElementById("reshuffle-btn"),
};

let clips = [];
let queue = []; // indices into `clips` not yet shown this round
let currentClip = null;

let ytPlayer = null;
let ytReady = false;
let endWatcher = null;

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
  els.cover.hidden = false;
}

function showIdle() {
  els.queueStatus.textContent = `${queue.length} of ${clips.length} clips left in this round`;
  showPanel("idle");
}

// ---------- YouTube player ----------

window.onYouTubeIframeAPIReady = function () {
  ytReady = true;
  ytPlayer = new YT.Player("yt-player", {
    host: "https://www.youtube-nocookie.com",
    playerVars: {
      controls: 0,
      modestbranding: 1,
      rel: 0,
      iv_load_policy: 3,
      disablekb: 1,
      fs: 0,
      playsinline: 1,
    },
  });
};

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

els.startBtn.addEventListener("click", () => {
  if (queue.length === 0) {
    showPanel("all-done");
    return;
  }
  const idx = queue.pop();
  playClip(clips[idx]);
});

els.revealBtn.addEventListener("click", () => {
  const c = currentClip;
  els.answerTitle.textContent = `${c.movieTitle}${c.year ? ` (${c.year})` : ""}`;
  const parts = [];
  if (c.director) parts.push(`<strong>Director:</strong> ${escapeHtml(c.director)}`);
  if (c.cast && c.cast.length) parts.push(`<strong>Cast:</strong> ${escapeHtml(c.cast.join(", "))}`);
  if (c.genre) parts.push(`<strong>Genre:</strong> ${escapeHtml(c.genre)}`);
  els.answerMeta.innerHTML = parts.join("<br>");
  showPanel("answer");
});

els.nextBtn.addEventListener("click", () => {
  if (queue.length === 0) {
    showPanel("all-done");
  } else {
    showIdle();
  }
});

els.reshuffleBtn.addEventListener("click", () => {
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
