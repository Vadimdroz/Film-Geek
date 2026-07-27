# Admin tagging tool

Where the clip library gets built. Paste a YouTube URL, scrub to pick a start/end timestamp, fill in movie metadata, save to Firestore.

Responsibilities:
- Verify a candidate clip is embeddable before saving it.
- Manual metadata entry (title, year, director, cast, genre, difficulty).
- AI-assist: auto-fill year/director/cast from TMDb once a title is entered — always shown for human confirmation before saving, never auto-committed.

Not built yet — see `docs/PLANNING.md` for the build order.
