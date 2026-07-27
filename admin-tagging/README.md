# Admin tagging tool

Where the clip library gets built. Paste a YouTube URL, scrub to pick a start/end timestamp, fill in movie metadata, save.

## Running it

No build step. Serve the folder with any static server and open it:

```
cd admin-tagging
python3 -m http.server 8770
```

Then open http://localhost:8770. Opening `index.html` directly via `file://` will not work — the YouTube player and the oEmbed/TMDb network calls need a real origin.

## What it does

- **Check clip**: paste a YouTube URL or video ID. Confirms the video actually embeds (via YouTube's oEmbed endpoint) and shows its thumbnail/title. If the check fails, you can still "Use anyway" and it's flagged `embeddable: false` in the saved data.
- **Set start & end**: an embedded YouTube player lets you scrub and capture the current playhead as the clip's start/end. "Preview clip" plays just that window. A duration warning flags clips outside ~8–16s.
- **Tag the movie**: title, year, director, cast, genre, difficulty, notes. "Autofill from TMDb" fills year/director/cast from The Movie Database once you paste a free TMDb v3 API key (get one at themoviedb.org/settings/api) — the key is stored only in this browser's localStorage, never committed anywhere. Autofilled fields are always editable before saving.
- **Library**: saved clips currently live in this browser's `localStorage` (key `filmgeek_clips`), not Firestore yet — see the note below. Export/Import JSON buttons back up or move the library between machines, matching the schema in `data/README.md`.

## Current limitation

This is local-storage-only for now (per-browser, not shared). Wiring it to Firestore so the host app can read the same library is the next milestone — see `docs/PLANNING.md`.
