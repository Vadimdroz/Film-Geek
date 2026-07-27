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
  "notes": "string"
}
```
