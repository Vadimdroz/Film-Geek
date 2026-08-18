# Test hub

Dev-only tool for playtesting new functionality without the copy-paste grind of a normal game (generate a room, tell every phone the code, join manually). Not linked anywhere a real player would stumble into it, but it is a public path on GitHub Pages like the other apps.

## Running it

Same as the rest of the app — static files, no build step:

```
python3 -m http.server 8770
```

Open `http://localhost:8770/test-hub/`, or the deployed `vadimdroz.github.io/Film-Geek/test-hub/`.

## What it does

1. **Seed test room** — creates a room under the fixed code `TEST` (never a randomly generated one) using whatever clips are already in your real `clipLibrary`, plus two fake teams (🍿 Team A, 🎬 Team B) reset to 0 points. Safe to re-run any time to reset for a new test pass.
2. **Open test windows** — one link to the host (open in a normal browser tab; it shares this hub's browser profile, so it auto-resumes room `TEST` with no manual setup) and one link per fake team, meant for **separate incognito windows**. Regular tabs of the same browser share one Firebase anonymous-auth identity, so two "teams" opened as regular tabs would collide on that identity — incognito windows each get their own.
3. **Live status** — a read-only view of the TEST room's current phase/round/scores, so you can sanity-check state without the host window open.
4. **Reset** — deletes room `TEST`'s data only (teams, rounds, scores). Hardcoded to that one room code; can't touch a real game.

## Content

Doesn't write anything to `clipLibrary` — it's the same shared library real games read from, and seeding fake clips there risked one showing up during an actual game night. Tag at least one real clip via `/admin-tagging` before a full round can be tested end to end.
