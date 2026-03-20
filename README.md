# Rankify

Rankify is a React + Vite frontend with a small Node backend for Spotify OAuth, playlist caching, and optional owner-only backup features. The app turns playlists into one global song ranking, then uses that ranking to power top songs, top artists, and album-progress views.

## What it does

- Sign in with Spotify or use `Try Demo`
- Import Spotify playlists into one shared ranking pool
- Rank songs with a fast binary placement flow
- Exclude songs with `Do not rate`
- Review results in `Top songs`, `Top artists`, and `Album progress`
- Export and import local ranking data as JSON

## Stack

- React 19
- Vite 7
- Node.js HTTP server
- Spotify Web API

## Docs

- [User Guide](./USER_GUIDE.md)

## Local development

1. Install dependencies:
   - `npm install`
2. Create a Spotify app in the Spotify Developer Dashboard.
3. Add this redirect URI in Spotify:
   - `http://127.0.0.1:5173/auth/callback`
4. Create `server/.env` from `server/.env.example`.
5. Set at least:
   - `SPOTIFY_CLIENT_ID=...`
   - `SPOTIFY_REDIRECT_URI=http://127.0.0.1:5173/auth/callback`

Start the backend:

- `npm run dev:server`

Start the frontend:

- `npm run dev`

Open:

- `http://127.0.0.1:5173`

Spotify no longer accepts `localhost` redirect URIs for this flow, so use `127.0.0.1` in both the Spotify app settings and the local URL.

## Environment variables

`server/.env.example` includes the supported configuration:

- `PORT`: backend port, default `8787`
- `DATA_DIR`: persistent data directory for rankings and Spotify cache
- `CLIENT_DIST_DIR`: optional override for the built frontend path
- `SPOTIFY_CLIENT_ID`: Spotify app client id
- `SPOTIFY_REDIRECT_URI`: OAuth callback URL
- `SPOTIFY_OWNER_USER_ID`: optional Spotify user id for owner-only cache seeding and server backup behavior

## Production

1. Build the frontend:
   - `npm run build`
2. Set your production callback URL, for example:
   - `SPOTIFY_REDIRECT_URI=https://your-domain.com/auth/callback`
3. Start the backend:
   - `npm --prefix server start`

The backend serves the built frontend from `dist/` by default, so production can run as one same-origin app.

For a persistent deployment:

- Set `HOST=0.0.0.0` so the Node server binds correctly on managed hosts
- Set `DATA_DIR` to durable storage so rankings and Spotify cache survive restarts
- Set `SPOTIFY_OWNER_USER_ID` if you want owner-only backup and demo-cache priming
- If you reuse this project publicly, update the landing-page copy and allowlist/contact details in `src/App.jsx`

### Render setup

If you deploy on Render, create a `Web Service` and use:

- Build Command: `npm install && npm run build`
- Start Command: `npm --prefix server start`
- Health Check Path: `/health`

Recommended environment variables:

- `NODE_ENV=production`
- `HOST=0.0.0.0`
- `DATA_DIR=/var/data`
- `SPOTIFY_CLIENT_ID=...`
- `SPOTIFY_REDIRECT_URI=https://your-render-domain.onrender.com/auth/callback`
- `SPOTIFY_OWNER_USER_ID=...` if needed

Attach a persistent disk and mount it at `/var/data`, otherwise rankings and server-side cache data will be lost on redeploy or restart.

## Notes for a public deployment

- Spotify apps in development mode require allowlisted users for real login
- `Try Demo` works without Spotify login by using a shared cached demo library
- Owner login can seed shared demo cache data for playlists, albums, and artists

## Acknowledgements

This app was built with the help of OpenAI Codex.
