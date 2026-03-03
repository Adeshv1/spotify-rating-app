# Spotify Rating App

Vite + React frontend with a minimal Node backend used for Spotify OAuth.

## Dev setup

1. Create a Spotify app in the Spotify Developer Dashboard.
2. Add this Redirect URI to your Spotify app settings:
   - `http://127.0.0.1:5173/auth/callback`
3. Create `server/.env` from `server/.env.example` and set:
   - `SPOTIFY_CLIENT_ID=...`
   - `SPOTIFY_REDIRECT_URI=http://127.0.0.1:5173/auth/callback`

## Run

Terminal 1 (backend):

- `npm run dev:server`

Terminal 2 (frontend):

- `npm run dev`

Open:

- `http://127.0.0.1:5173`

You should see a “Log in with Spotify” link that starts the OAuth flow.

Note: Spotify no longer allows `localhost` redirect URIs, so use `127.0.0.1` in the URL and in your app settings.
