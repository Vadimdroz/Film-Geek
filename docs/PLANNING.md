# Film-Geek — Project Plan

## Critical foundations

1. **Legal framing: private, embedded, non-distributed.** Clips are referenced by YouTube ID + timestamp, not downloaded or re-hosted — YouTube stays the host of record. The app stays private (played with friends, not published or monetized). Don't let scope creep toward "public app" without revisiting this.

2. **Architecture: Host display + Player controllers, synced via Firebase.**
   - **Host** = a web view built for a big screen, opened in a PC browser (fullscreen/kiosk) plugged into the TV as its monitor. Fallback for no-PC setups: open the same host URL on a phone and mirror it to the TV via AirPlay/Chromecast/Miracast.
   - **Players** = each friend's phone, joined via a room code, used as a buzzer/answer pad.
   - **Sync** = Firebase Realtime DB/Firestore ties host + players together. Works over LAN or internet, so remote play later is a toggle, not a rearchitecture.

3. **Content model: pointers, not files.** Each clip is metadata: `{ youtubeId, startSec, endSec, title, year, director, cast, tags }`. A tagging tool builds this library — this is the real content bottleneck of the project, more than any code.

4. **Hiding the answer is a real engineering problem.** A raw YouTube embed leaks the title, channel name, suggested videos, and URL. Needs deliberate handling: custom play/pause overlay, disabled controls/related videos/annotations (`controls=0`, `rel=0`, `iv_load_policy=3`), tight start/end trimming, a cover screen for the first-frame flash. Deliberately *not* using the `youtube-nocookie.com` embed domain — it's a nice privacy touch but its cross-origin handshake with the parent page can get silently blocked by ad-blockers/privacy settings, leaving the player's `onReady` event never firing at all.

5. **One GitHub repo, hosted, versioned from day one.** GitHub Pages for hosting, Firebase for data/sync, tagged releases as checkpoints.

## Deep dive

### A. Sourcing clips
- Curate from YouTube: trailer channels, "iconic movie scenes" compilations, studio channels. Trailers are safest for embedding but reveal too much/little; fan scene compilations are better for gameplay but embedding permissions vary per video.
- Verify embeddability per candidate before adding it — build this check into the tagging tool.
- Keep a "watchlist" of candidates separate from "approved/tagged" clips so sourcing and tagging can happen at different paces.

### B. Tagging / indexing pipeline
- Schema: `youtubeId, startSec, endSec, movieTitle, year, director, cast[], genre, difficulty, notes`.
- Manual tagging UI: paste a YouTube URL, scrub to pick start/end, fill metadata by hand. This is the fallback of record.
- AI-assist: once the movie title is typed, auto-fill year/director/cast via **TMDb** (free API) rather than asking a model to recall it from memory — then eyeball/confirm before saving.
- Stored in Firestore; the host app reads it directly, no export step.

### C. Making it CTV-adaptable
- TV-first design: large type, high contrast, safe margins, tested at couch viewing distance.
- Runs as a PWA in fullscreen/kiosk mode in the PC's browser (hides URL bar/chrome) as the primary path.
- Phone-mirroring fallback needs its own test pass — mirrored screens sometimes add letterboxing or lag.
- Auto-reconnect if the PC browser refreshes or room state changes mid-game.

### D. Phones as controllers (not screen sharing)
- Primary mechanic: phone as an input device (buzz in, answer) talking to Firebase, which the host listens to. Jackbox-style pattern, right fit for local shared-TV play.
- True screen mirroring (AirPlay/Chromecast/Miracast) is reserved for the no-PC fallback, where a phone *is* the display — don't conflate the two.

### E. Room / session model
- Host generates a short room code; players join by entering it on their phone, no login required.
- Host controls pace: start round, reveal answer, advance. Players only ever see their own state, never the answer key.
- Handle disconnects/rejoins gracefully.

### F. Scoring & answer judging
- Shipped as free-text (movie title, year, two actor slots), not multiple-choice — see milestone 9 for current per-field point values and matching rules.
- Typo tolerance: movie title has a live "did you mean" suggestion against the tagged library (Levenshtein). Actor names are judged with a more generous fuzzy match (length-scaled Levenshtein, substring, last-name-only) plus a host override at reveal — see the "Flexible actor-name matching" note near the end of this doc.

### G. Tech stack
- Vanilla JS/PWA + Firebase (Firestore + realtime sync) + GitHub Pages — consistent with prior projects, no new backend infra.

### H. Repo & workflow
- Structure: `/host`, `/player`, `/admin-tagging`, `/data`, `/docs`.
- `main` deploys via **GitHub Pages** (`vadimdroz.github.io/Film-Geek/`, source: branch `main`, path `/`) — not Cloudflare Pages, despite earlier drafts of this doc saying otherwise. No build step; a push to `main` triggers a GitHub Pages build automatically, usually live within a couple of minutes. Verify with `gh api /repos/Vadimdroz/Film-Geek/pages/builds/latest` (checks the `commit` field against `git rev-parse HEAD`) if it's ever unclear whether a deploy landed.
- Secrets (Firebase config, TMDb API key) via environment variables, never committed.
- **Cache-busting:** `host/`, `player/`, and `admin-tagging/` each load `app.js` and `style.css` with a `?v=YYYYMMDD` query string (see each `index.html`). GitHub Pages serves these with `cache-control: max-age=600` and no other invalidation, and mobile browsers (especially an "Add to Home Screen" PWA) can hold onto a cached copy well past that — bump the `?v=` date in all three `index.html` files whenever `app.js` or `style.css` changes, or a deployed fix may not actually reach a phone that already has the page loaded/bookmarked. (First hit 2026-08-03: a player's phone showed pre-rewrite waiting-screen text minutes after a deploy that no longer contained that text at all — confirmed via `curl` that the live file was correct; the phone's own cache was stale.)

### I. Suggested build order (MVP milestones)
1. ✅ Manual tagging tool + hand-picked clips (localStorage for now, Firestore sync is a later nice-to-have).
2. ✅ Host display that plays a clip cleanly with the answer hidden.
3. ✅ Room code + phones joining as teams; team-based 3-field guessing (movie/director/year), 60s timer, live leaderboard.
4. ✅ Scoring is wired (host tallies each team's earliest per-round submission, updates team score on reveal). Originally 2/5/10 points for 1/2/3 of the 3 fields correct — superseded by milestone 9's per-field weighted scoring.
5. ✅ Audio-only round phase: each round plays audio-only for 15s first (video hidden, cover stays up), during which a team could tap "Answer now" for double points. Original version had per-team independent choices with a fixed window for everyone — reworked into a race in milestone 10.
6. ✅ First real playtest fixes: host goes fullscreen (button + auto-request on Start round), the Next-clip button stays reachable via a scrollable/sticky answer panel on short TV viewports, clips are tracked by id and never re-served within a game (holds across a host reload), and the host can save/resume a named game (room code + remaining queue + round persisted to Firestore) or explicitly "Finish game" to delete that game's Firestore data.
7. ✅ Bonus trivia: admin-tagging can optionally attach multiple-choice trivia questions to a clip; after some reveals (~50% chance, only for clips that have trivia) the host's Next-clip button leads into a Kahoot-style round instead — question + 4 colored options on the TV, every team races to answer on their phone, first correct team wins 5 points.
8. ✅ Removed turn rotation entirely — there is no more "active team" or turn order. Every team decides for itself, every round, whether to answer on audio alone or wait for the video, and every team that submits a guess scores (not just one team per round). Scoring/audio-only doubling is read per-team from each guess's own `audioOnly` flag instead of one shared per-round flag, and a round reveals as soon as every currently-joined team has answered — whether during the audio phase (skipping the video entirely if nobody needed it) or after watching the clip — rather than waiting out a fixed timer.
9. ✅ Second playtest fixes: (a) fixed a permission-denied error a team could hit on an accidental double-submit — Firestore rules only allowed *creating* a guess/trivia-answer doc, not updating one, so a resubmission (e.g. a fast double-tap on "Lock in answer") was rejected; now allows update too. (b) Blank fields are explicitly OK — submitting with something left empty shows a one-time "No answer for: X — submit anyway?" confirm instead of silently failing or blocking the team. (c) Replaced the director field with Year + two Actor slots; scoring is now a direct per-field sum — movie 3 / year 2 / each actor 1 (max 7, doubled to 14 for a full audio-only answer) — instead of the old "how many of 3 fields correct" lookup table. An actor guess counts if it matches *any* name in the clip's cast, not a specific billing slot; the same name typed into both actor slots only scores once.
10. ✅ Audio-only bonus reworked into a race, not an independent per-team choice: any team can tap "Answer with audio only" during the 15s window, but the FIRST one to do so claims it — the room's audio stops immediately (`ytPlayer.pauseVideo()`), everyone else just waits, and the claiming team gets a private guess form with its own clock. Once that team submits (or times out), video resumes from wherever it paused and plays for whoever's left, who then answer after watching it as usual. If nobody claims it before the 15s runs out, the video just reveals normally for everyone, same as before. Ties among near-simultaneous buzz-ins are broken by a server timestamp on the team's claim write.
11. PC-TV kiosk polish, then the phone-mirroring fallback. Still untested: a real multi-team playtest with a full 30–50 clip library.

### K. Firestore data model (milestone 3, team-based)
Firebase project: `film-geek` (separate from other personal projects). Everyone — host and players — signs in anonymously (silent, no login UI) so security rules have a `request.auth.uid` to check against. Scoring is per-**team**, not per-player: players join/create a team (name + emoji avatar) on the join screen, and the first team member to submit each round locks in that team's answer.

```
rooms/{roomCode}                        — public: hostUid, phase (lobby|audio|audio-claimed|playing|guessing|revealed|trivia|trivia-revealed), roundIndex, guessDeadline, revealedAnswer, audioClaimedTeamId, audioClaimedDeadline
rooms/{roomCode}/public/movieIndex      — public: distinct { titles[] } across the whole tagged library — safe to expose (doesn't say which is THIS round's answer), used for player autocomplete/typo-correction
rooms/{roomCode}/private/answer         — host-only: the real movieTitle/year/director/cast for the current clip
rooms/{roomCode}/teams/{teamId}         — name, emoji, score, memberNames[], audioChoice/audioChoiceRound/audioChoiceAt (open read/write among signed-in users — private friends game, not defended against cheating)
rooms/{roomCode}/rounds/{roundIndex}/guesses/{uid} — { teamId, movieGuess, yearGuess, actor1Guess, actor2Guess, audioOnly, submittedAt } — create AND update allowed (a resubmission shouldn't ever hit permission-denied)
```

No turn order, no "active team" for the main guessing round — every team can submit a guess and score every round (see milestone 8). The audio-only bonus itself is a race, not an independent per-team choice (see milestone 10): only one team per round can claim it (earliest `audioChoiceAt` wins), tracked via `audioClaimedTeamId`/phase `"audio-claimed"`. `audioOnly` on a guess doc is set by the player only when they were the team that won that race, and drives that team's own double-points bonus at reveal.

The split between the public room doc and the host-only `private/answer` doc is what stops a player from opening devtools and reading the answer out of Firestore before reveal — see `/firestore.rules` for the exact rules (paste into Firebase Console → Firestore Database → Rules → Publish).

Movie title gets a filtered-as-you-type dropdown sourced from `public/movieIndex`, typo-corrected against that same list via Levenshtein distance on blur (e.g. "Intersteller" → "Interstellar"). Scoring (milestone 9): movie title exact-match (case-insensitive) = 3 pts, year exact string match = 2 pts, each of the two actor slots that matches any name in the clip's cast = 1 pt each (max 7/round, doubled to 14 for a full audio-only answer). The director is still shown at reveal as trivia/context but is no longer a scored field. 60-second countdown starts when the clip ends (not when it starts); host auto-reveals if the timer runs out without a manual reveal click, or immediately once every currently-joined team has answered.

**Save/resume (milestone 6).** `rooms/{roomCode}/private/gameState` — host-only: `{ queueIds[], usedClipIds[], roundIndex, updatedAt }`, written after every round starts. The host browser remembers the active room code in `localStorage`; on load it offers "Resume '<gameName>'" if that room + gameState still exist and are still owned by this browser's anon-auth uid, otherwise it's a fresh "start new game" screen. `usedClipIds` is what guarantees a clip is never re-served within a game (any team), and survives a host reload since it's the same doc. "Finish game" deletes the room doc and everything under it (teams, rounds/\*/guesses, rounds/\*/trivia, private/\*, public/\*) and clears the localStorage pointer.

**Bonus trivia (milestone 7).** Clip docs in `clipLibrary` optionally carry `trivia: [{ question, options[4], correctIndex }]`, authored in admin-tagging. After a reveal, the host's Next-clip button sometimes (`TRIVIA_CHANCE` in host/app.js) starts a trivia round instead: `rooms/{roomCode}` gains `phase: "trivia"`/`"trivia-revealed"`, `triviaQuestion: { question, options }` (correctIndex withheld), `triviaDeadline`, `triviaResult: { correctIndex, winnerTeamId, winnerName, winnerEmoji }`; the correct index sits in `private/triviaAnswer` until reveal. Every team's phone can answer via `rounds/{roundIndex}/trivia/{uid} — { teamId, selectedIndex, submittedAt }` (same round index the clip's guesses used, no round bump) — first correct submission across all teams wins 5 points.

### J. Risks to watch, not solve now
- Per-video embed restrictions and regional availability changing over time.
- YouTube ads or thumbnails briefly flashing the title before the overlay loads.
- TMDb/YouTube API rate limits if the library grows large.

### Flexible actor-name matching (milestone 9)
Exact-match-after-normalize was too strict for a fast-typed actor name. Went with algorithmic fuzzy matching + a host override rather than a real AI/LLM call, to stay inside the project's zero-new-backend stance (an LLM call would need a server-side proxy for the API key, plus per-call cost/latency and a network dependency mid-game).

`namesAreClose(a, b)` in both host/app.js and player/app.js (kept in sync manually, same duplication pattern as the rest of the scoring logic): normalizes (strip accents/punctuation, lowercase), then matches if exactly equal, if one name contains the other as a substring ("DiCaprio" → "Leonardo DiCaprio"), if the last words match ("Deniro" → "De Niro"), or via Levenshtein distance scaled to the name's length (~1 allowed slip per 4 characters, minimum 1) rather than a flat cutoff. An actor guess counts if it's close to *any* name in the clip's cast.

Host override: every field in a team's reveal-screen result card (movie/year/actor1/actor2) is a tappable button — tapping flips that field's correct/wrong call and applies the point delta directly to Firestore (`host/app.js`'s `toggleFieldCorrectness`), so the host can always overrule the algorithm (nickname, "that guy from Titanic," etc.) without it ever blocking the game.
