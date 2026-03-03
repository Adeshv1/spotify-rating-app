import { useEffect, useState } from 'react'
import './App.css'
import {
  clearPlaylistsCache,
  formatAge,
  formatDateTime,
  getPlaylistsCooldownUntil,
  readPlaylistsCache,
  setPlaylistsCooldown,
  writePlaylistsCache,
} from './lib/spotifyPlaylistsCache'
import { readMeCache, writeMeCache } from './lib/spotifyMeCache'

function App() {
  const [loading, setLoading] = useState(true)
  const [loggedIn, setLoggedIn] = useState(false)
  const [profile, setProfile] = useState(null)
  const [error, setError] = useState(null)

  const [playlistsLoading, setPlaylistsLoading] = useState(false)
  const [playlistsError, setPlaylistsError] = useState(null)
  const [playlistsCache, setPlaylistsCache] = useState(null)
  const [playlistsSource, setPlaylistsSource] = useState(null) // 'cache' | 'api'
  const [cooldownUntilMs, setCooldownUntilMs] = useState(null)

  useEffect(() => {
    ;(async () => {
      try {
        const sessionRes = await fetch('/api/session')
        const session = await sessionRes.json()

        if (!session?.loggedIn) {
          setLoggedIn(false)
          return
        }

        setLoggedIn(true)

        const cachedMe = readMeCache()
        if (cachedMe?.profile) {
          setProfile(cachedMe.profile)
          return
        }

        const meRes = await fetch('/api/me')
        if (meRes.ok) {
          const me = await meRes.json()
          setProfile(me)
          writeMeCache(me)
        }
      } catch (e) {
        setError(e?.message || 'Something went wrong')
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  useEffect(() => {
    if (!loggedIn) {
      setPlaylistsCache(null)
      setPlaylistsError(null)
      setPlaylistsSource(null)
      setCooldownUntilMs(null)
    }
  }, [loggedIn])

  async function refreshPlaylists({ all = false } = {}) {
    if (!loggedIn || !profile?.id) return

    const userId = profile.id
    const now = Date.now()
    const cooldownUntil = getPlaylistsCooldownUntil(userId)
    if (cooldownUntil && now < cooldownUntil) {
      setCooldownUntilMs(cooldownUntil)
      setPlaylistsError(
        `Spotify rate limit cooldown active until ${new Date(cooldownUntil).toLocaleString()}. Avoid refreshing until then.`,
      )
      return
    }

    setPlaylistsLoading(true)
    setPlaylistsError(null)

    try {
      const url = all ? '/api/me/playlists?all=1' : '/api/me/playlists?limit=50&offset=0'
      const res = await fetch(url)

      let data = null
      try {
        data = await res.json()
      } catch {
        data = null
      }

      if (res.status === 429) {
        const retryAfterSeconds = Number(data?.retryAfterSeconds)
        const until = Number.isFinite(retryAfterSeconds) ? Date.now() + retryAfterSeconds * 1000 : Date.now() + 60_000
        setPlaylistsCooldown(userId, until)
        setCooldownUntilMs(until)
        setPlaylistsError(
          `Spotify rate limited this request (HTTP 429). Next safe refresh: ${new Date(until).toLocaleString()}.`,
        )
        return
      }

      if (!res.ok) {
        const detailsMessage =
          typeof data?.details?.error?.message === 'string'
            ? data.details.error.message
            : typeof data?.details?.error_description === 'string'
              ? data.details.error_description
              : null
        const msg =
          detailsMessage ||
          (typeof data?.message === 'string'
            ? data.message
            : typeof data?.error === 'string'
              ? data.error
              : 'Failed to fetch playlists')
        setPlaylistsError(msg)
        return
      }

      const fetchedAt = new Date().toISOString()
      const apiItemsCount = Array.isArray(data?.items) ? data.items.length : 0
      const apiTotal = Number(data?.total) || apiItemsCount
      const isComplete = all || apiItemsCount >= apiTotal

      writePlaylistsCache(userId, data, { fetchedAt, isComplete })
      const cached = readPlaylistsCache(userId)
      setPlaylistsCache(cached)
      setPlaylistsSource('api')
      setCooldownUntilMs(getPlaylistsCooldownUntil(userId))
    } catch (e) {
      setPlaylistsError(e?.message || 'Failed to fetch playlists')
    } finally {
      setPlaylistsLoading(false)
    }
  }

  useEffect(() => {
    if (!loggedIn || !profile?.id) return

    const userId = profile.id
    const cached = readPlaylistsCache(userId)
    setCooldownUntilMs(getPlaylistsCooldownUntil(userId))

    if (cached) {
      setPlaylistsCache(cached)
      setPlaylistsSource('cache')
      return
    }

    // No cache yet: do a single fetch to seed the cache.
    refreshPlaylists({ all: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loggedIn, profile?.id])

  async function logout() {
    await fetch('/auth/logout', { method: 'POST' })
    window.location.reload()
  }

  if (loading) {
    return (
      <div className="card">
        <p>Loading…</p>
      </div>
    )
  }

  return (
    <>
      <div className="card">
        <h1>Spotify Rating App</h1>
        {error ? <p>{error}</p> : null}

        {!loggedIn ? (
          <>
            <p>Log in to Spotify to continue.</p>
            <a className="read-the-docs" href="/auth/login">
              Log in with Spotify
            </a>
          </>
        ) : (
          <>
            <p>
              Logged in{profile?.display_name ? ` as ${profile.display_name}` : ''}.
            </p>
            <button onClick={logout}>Log out</button>

            <div className="section">
              <h2>Your playlists</h2>

              <div className="controls">
                <button
                  onClick={() => refreshPlaylists({ all: false })}
                  disabled={playlistsLoading || (cooldownUntilMs && Date.now() < cooldownUntilMs)}
                  title="Makes 1 Spotify API request (first page)."
                >
                  Refresh cache (1 request)
                </button>
                <button
                  onClick={() => refreshPlaylists({ all: true })}
                  disabled={playlistsLoading || (cooldownUntilMs && Date.now() < cooldownUntilMs)}
                  title="May make multiple Spotify API requests. Use sparingly."
                >
                  Refresh cache (fetch all)
                </button>
                <button
                  onClick={() => {
                    if (!profile?.id) return
                    clearPlaylistsCache(profile.id)
                    setPlaylistsCache(null)
                    setPlaylistsSource(null)
                    setPlaylistsError(null)
                  }}
                  disabled={playlistsLoading || !playlistsCache}
                  title="Removes the local cache from this browser."
                >
                  Clear cache
                </button>
              </div>

              {playlistsError ? <p className="error">{playlistsError}</p> : null}

              {playlistsCache ? (
                <p className="meta">
                  Loaded from <strong>{playlistsSource === 'cache' ? 'cache' : 'Spotify API'}</strong>. Cached at{' '}
                  {formatDateTime(playlistsCache.fetchedAt)} ({formatAge(Date.now() - Date.parse(playlistsCache.fetchedAt))}{' '}
                  ago).{' '}
                  {playlistsCache.isComplete
                    ? `All ${playlistsCache.total} playlist(s) cached.`
                    : `Showing ${playlistsCache.items.length} of ${playlistsCache.total}.`}
                </p>
              ) : playlistsLoading ? (
                <p className="meta">Fetching playlists…</p>
              ) : (
                <p className="meta">No playlist cache yet.</p>
              )}

              {playlistsCache?.items?.length ? (
                <ul className="list">
                  {playlistsCache.items.map((p) => (
                    <li key={p.id || p.name}>
                      {p.externalUrl ? (
                        <a href={p.externalUrl} target="_blank" rel="noreferrer">
                          {p.name || '(untitled playlist)'}
                        </a>
                      ) : (
                        <span>{p.name || '(untitled playlist)'}</span>
                      )}
                      {typeof p.tracksTotal === 'number' ? <span className="sub"> · {p.tracksTotal} tracks</span> : null}
                      {p.owner?.display_name ? <span className="sub"> · by {p.owner.display_name}</span> : null}
                      {typeof p.public === 'boolean' ? (
                        <span className="sub"> · {p.public ? 'public' : 'private'}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </>
        )}
      </div>
    </>
  )
}

export default App
