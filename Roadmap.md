# Roadmap

+ Initialize the project scaffold with Vite + React (scaffold created 2026-03-02)
+ Add minimal backend scaffold under `/server` (created 2026-03-03)
- Establish app structure (routing/layout/state approach)
- Define rating data model and storage (local first, then backend if needed)
- Build core UI: search/list, details, rating input, history
+ Decide Spotify auth approach: auth code + PKCE via `/server` (implemented 2026-03-03)
+ Add Spotify login flow (auth endpoints + client prompt) (implemented 2026-03-03)
- Add Spotify integration (fetch tracks/albums/playlists as needed)
- Add tests/linting and basic CI
