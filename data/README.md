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
