# Roadmap

+ Initialize the project scaffold with Vite + React (scaffold created 2026-03-02)
+ Add minimal backend scaffold under `/server` (created 2026-03-03)
- Establish app structure (routing/layout/state approach)
+ Define rating data model and storage (localStorage per user, track-based/global across playlists) (implemented 2026-03-03)
- Build core UI: search/list, details, rating input, history
+ Add tier seeding UI (S/A/B/C/D + Do not rate) (implemented 2026-03-03)
+ Add head-to-head Elo ranking UI with skip + undo + session targets (implemented 2026-03-03)
+ Add leaderboard per tier + all tracks (implemented 2026-03-03)
+ Decide Spotify auth approach: auth code + PKCE via `/server` (implemented 2026-03-03)
+ Add Spotify login flow (auth endpoints + client prompt) (implemented 2026-03-03)
+ Fetch + cache current user's playlists (`/me/playlists`) with manual refresh, cache source, and cache age indicator (implemented 2026-03-03)
+ Click a playlist to fetch + cache playlist items (`/playlists/{id}/items`) with per-playlist refresh, cache age indicator, and forbidden caching to avoid wasted requests (implemented 2026-03-03)
- Add Spotify integration (fetch tracks/albums/playlists as needed)
- Improve matchup selection (cross-tier checks, uncertainty, avoid repeats)
- Add pin/search in head-to-head mode
- Add keyboard shortcuts for faster seeding/duels
- Add export/import (CSV/JSON) for rankings
- Add tests/linting and basic CI
