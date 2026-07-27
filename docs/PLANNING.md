# Film-Geek — Project Plan

## Critical foundations

1. **Legal framing: private, embedded, non-distributed.** Clips are referenced by YouTube ID + timestamp, not downloaded or re-hosted — YouTube stays the host of record. The app stays private (played with friends, not published or monetized). Don't let scope creep toward "public app" without revisiting this.

2. **Architecture: Host display + Player controllers, synced via Firebase.**
   - **Host** = a web view built for a big screen, opened in a PC browser (fullscreen/kiosk) plugged into the TV as its monitor. Fallback for no-PC setups: open the same host URL on a phone and mirror it to the TV via AirPlay/Chromecast/Miracast.
   - **Players** = each friend's phone, joined via a room code, used as a buzzer/answer pad.
   - **Sync** = Firebase Realtime DB/Firestore ties host + players together. Works over LAN or internet, so remote play later is a toggle, not a rearchitecture.

3. **Content model: pointers, not files.** Each clip is metadata: `{ youtubeId, startSec, endSec, title, year, director, cast, tags }`. A tagging tool builds this library — this is the real content bottleneck of the project, more than any code.

4. **Hiding the answer is a real engineering problem.** A raw YouTube embed leaks the title, channel name, suggested videos, and URL. Needs deliberate handling: custom play/pause overlay, disabled controls/related videos/annotations (`controls=0`, `rel=0`, `iv_load_policy=3`), tight start/end trimming, a cover screen for the first-frame flash. Deliberately *not* using the `youtube-nocookie.com` embed domain — it's a nice privacy touch but its cross-origin handshake with the parent page can get silently blocked by ad-blockers/privacy settings, leaving the player's `onReady` event never firing at all.

5. **One GitHub repo, hosted, versioned from day one.** Cloudflare Pages for hosting, Firebase for data/sync, tagged releases as checkpoints.

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
- Open decision: free-text answers (needs fuzzy matching for typos/"The" prefixes) vs. multiple-choice buttons (simpler judging). Multiple-choice ships correctly first; free-text is a v2.
- Suggested scoring: points per sub-answer (movie / year / director), speed bonus for buzzing fast, host can manually override ambiguous answers.

### G. Tech stack
- Vanilla JS/PWA + Firebase (Firestore + realtime sync) + Cloudflare Pages — consistent with prior projects, no new backend infra.

### H. Repo & workflow
- Structure: `/host`, `/player`, `/admin-tagging`, `/data`, `/docs`.
- `main` deploys to Cloudflare Pages; feature branches for bigger changes; tag a release each time the game is playable end-to-end.
- Secrets (Firebase config, TMDb API key) via environment variables, never committed.

### I. Suggested build order (MVP milestones)
1. ✅ Manual tagging tool + hand-picked clips (localStorage for now, Firestore sync is a later nice-to-have).
2. ✅ Host display that plays a clip cleanly with the answer hidden.
3. ✅ Room code + phones joining as players, multiple-choice guessing works.
4. Scoring is wired (host tallies + updates player scores on reveal) — still needs a real multi-player playtest.
5. PC-TV kiosk polish, then the phone-mirroring fallback.

### K. Firestore data model (milestone 3)
Firebase project: `film-geek` (separate from other personal projects). Everyone — host and players — signs in anonymously (silent, no login UI) so security rules have a `request.auth.uid` to check against.

```
rooms/{roomCode}                        — public: hostUid, phase, roundIndex, currentOptions, revealedAnswer
rooms/{roomCode}/private/answer         — host-only: the real movieTitle/year/director/cast for the current clip
rooms/{roomCode}/players/{uid}          — name, score (each player writes only their own doc)
rooms/{roomCode}/rounds/{roundIndex}/guesses/{uid} — a player's submitted choice for that round
```

The split between the public room doc and the host-only `private/answer` doc is what stops a player from opening devtools and reading the answer out of Firestore before reveal — see `/firestore.rules` for the exact rules (paste into Firebase Console → Firestore Database → Rules → Publish).

Multiple-choice options are generated from other tagged movie titles in the library as distractors; with a small library this degrades to 2 options, and below 2 the player app falls back to a free-text guess for that round.

### J. Risks to watch, not solve now
- Per-video embed restrictions and regional availability changing over time.
- YouTube ads or thumbnails briefly flashing the title before the overlay loads.
- TMDb/YouTube API rate limits if the library grows large.
