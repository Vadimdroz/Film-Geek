# Data

Clip and game data lives in Firebase (Firestore), not in this repo. This folder holds the schema reference and any local fixtures used for development.

## Clip schema

```json
{
  "youtubeId": "string",
  "startSec": 0,
  "endSec": 15,
  "movieTitle": "string",
  "year": 0,
  "director": "string",
  "cast": ["string"],
  "genre": "string",
  "difficulty": "easy | medium | hard",
  "notes": "string",
  "excluded": false
}
```

`excluded` — when `true`, the host app leaves this clip out of every game's shuffle. Toggled from the clip library table in `/admin-tagging`, e.g. to retire clips a group has already seen.

## Trivia bank schema (`triviaBank/{id}`)

General movie-knowledge questions, independent of any clip — managed in `/admin-tagging/trivia.html`, not this repo (`trivia-bank.json` here is a seed/backup you import through that page's "Import JSON" button, not something the app reads directly).

```json
{
  "question": "string",
  "category": "string",
  "options": ["string", "string", "string", "string"],
  "correctIndex": 0
}
```

The host draws from this pool (alongside a clip's own authored `trivia[]`, if it has any) for bonus-trivia rounds — see milestone 13 in `docs/PLANNING.md`. A question never repeats within one running game (tracked in `rooms/{code}/private/gameState.usedTriviaIds`), but the full bank is fair game again next game night — same behavior as the clip library. Use "Delete all questions" + "Import JSON" with a freshly written batch on that page to refresh the whole bank for a group that's seen it before.
