# Spotify Rating App

Vite + React frontend with a minimal Node backend used for Spotify OAuth.

## Docs

- [User Guide](./USER_GUIDE.md)

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

## Production notes

- Build the frontend with `npm run build`.
- Start the backend with `npm --prefix server start`.
- The backend now serves the built frontend from `../dist` by default, so production can run as a single same-origin service.
- Set `SPOTIFY_REDIRECT_URI` to your production callback URL, for example `https://your-domain.com/auth/callback`.
- Set `SPOTIFY_OWNER_USER_ID` if you want owner-only cache/ranking privileges.
- Set `DATA_DIR` to a persistent disk mount path in production so rankings and Spotify cache survive deploys.
