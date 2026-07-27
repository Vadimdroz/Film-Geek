# Film-Geek

A "Guess the Movie" party game for the living room. Players watch a short (10–15s) clip on the TV and race to name the movie, its year, director, and other details from their phones.

## How it works

- **Host display** (`/host`) — runs full-screen in a browser on a PC connected to the TV (or mirrored from a phone via AirPlay/Chromecast/Miracast if no PC is available). Shows the clip, the room code, and the scoreboard. Never shows the answer before it's revealed.
- **Player controller** (`/player`) — opened on each friend's phone. Join a room by code, buzz in, submit answers.
- **Admin tagging tool** (`/admin-tagging`) — where clips get added: paste a YouTube URL, set start/end timestamps, fill in movie metadata (title, year, director, cast).
- **Data** (`/data`) — clip/movie schema and any local reference data. Live game state and the clip library are stored in Firebase.

## Status

Early planning/scaffolding stage. See [`docs/PLANNING.md`](docs/PLANNING.md) for the full project plan, architecture decisions, and build order.

## Ground rules

- Clips are referenced by YouTube ID + timestamp, never downloaded or re-hosted.
- Private use only — played with friends, not distributed or monetized.

## Stack

Vanilla JS/PWA, Firebase (Firestore + realtime sync), Cloudflare Pages hosting, TMDb API for movie metadata lookups.
