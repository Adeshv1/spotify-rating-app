import { useEffect, useState } from 'react'
import './App.css'
import {
  clearPlaylistsCache,
  formatAge,
  formatDateTime,
  getSpotifyCooldownUntil,
  readPlaylistsCache,
  setSpotifyCooldown,
  writePlaylistsCache,
} from './lib/spotifyPlaylistsCache'
import {
  clearPlaylistTracksCache,
  readPlaylistTracksCache,
  readPlaylistTracksCacheMeta,
  readPlaylistTracksErrorCache,
  writePlaylistTracksCache,
  writePlaylistTracksErrorCache,
} from './lib/spotifyPlaylistTracksCache'

function App() {
  const [loading, setLoading] = useState(true)
  const [loggedIn, setLoggedIn] = useState(false)
  const [profile, setProfile] = useState(null)
  const [error, setError] = useState(null)
  const [scopes, setScopes] = useState([])

  const [nowMs, setNowMs] = useState(() => Date.now())

  const [playlistsLoading, setPlaylistsLoading] = useState(false)
  const [playlistsError, setPlaylistsError] = useState(null)
  const [playlistsCache, setPlaylistsCache] = useState(null)
  const [playlistsSource, setPlaylistsSource] = useState(null) // 'cache' | 'api'
  const [cooldownUntilMs, setCooldownUntilMs] = useState(null)

  const [selectedPlaylistId, setSelectedPlaylistId] = useState(null)
  const [tracksLoading, setTracksLoading] = useState(false)
  const [tracksError, setTracksError] = useState(null)
  const [tracksCache, setTracksCache] = useState(null)
  const [tracksSource, setTracksSource] = useState(null) // 'cache' | 'api'

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

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
        setScopes(Array.isArray(session?.scopes) ? session.scopes : [])

        if (session?.user && typeof session.user === 'object') {
          setProfile(session.user)
          return
        }

        const meRes = await fetch('/api/me')
        if (meRes.ok) {
          const me = await meRes.json()
          setProfile(me)
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
      setSelectedPlaylistId(null)
      setTracksCache(null)
      setTracksError(null)
      setTracksSource(null)
    }
  }, [loggedIn])

  async function refreshPlaylistsCache({ force = false } = {}) {
    if (!loggedIn || !profile?.id) return

    const userId = profile.id
    if (force) {
      clearPlaylistsCache(userId)
      setPlaylistsCache(null)
      setPlaylistsSource(null)
    }

    const now = Date.now()
    const cooldownUntil = getSpotifyCooldownUntil(userId)
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
      const res = await fetch('/api/me/playlists?all=1')

      let data = null
      try {
        data = await res.json()
      } catch {
        data = null
      }

      if (res.status === 429) {
        const retryAfterSeconds = Number(data?.retryAfterSeconds)
        const until = Number.isFinite(retryAfterSeconds) ? Date.now() + retryAfterSeconds * 1000 : Date.now() + 60_000
        setSpotifyCooldown(userId, until)
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
        setPlaylistsError(
          res.status === 403
            ? `${msg} (Spotify 403). If you recently changed scopes, click “Log out” and log back in.`
            : msg,
        )
        return
      }

      const fetchedAt = new Date().toISOString()
      const apiItemsCount = Array.isArray(data?.items) ? data.items.length : 0
      const apiTotal = Number(data?.total) || apiItemsCount
      const isComplete = !data?.partial && apiItemsCount >= apiTotal

      writePlaylistsCache(userId, data, { fetchedAt, isComplete })
      const cached = readPlaylistsCache(userId)
      setPlaylistsCache(cached)
      setPlaylistsSource('api')
      setCooldownUntilMs(getSpotifyCooldownUntil(userId))
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
    setCooldownUntilMs(getSpotifyCooldownUntil(userId))

    if (cached) {
      setPlaylistsCache(cached)
      setPlaylistsSource('cache')
      return
    }

    // No cache yet: do a fetch to seed the cache.
    refreshPlaylistsCache({ force: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loggedIn, profile?.id])

  async function refreshPlaylistTracks({ playlistId, force = false } = {}) {
    if (!loggedIn || !profile?.id || !playlistId) return

    const userId = profile.id
    if (force) {
      clearPlaylistTracksCache(userId, playlistId)
      setTracksCache(null)
      setTracksSource(null)
      setTracksError(null)
    }

    const now = Date.now()
    const cooldownUntil = getSpotifyCooldownUntil(userId)
    if (cooldownUntil && now < cooldownUntil) {
      setCooldownUntilMs(cooldownUntil)
      setTracksError(
        `Spotify rate limit cooldown active until ${new Date(cooldownUntil).toLocaleString()}. Avoid refreshing until then.`,
      )
      return
    }

    setTracksLoading(true)
    setTracksError(null)

    try {
      const res = await fetch(`/api/playlists/${encodeURIComponent(playlistId)}/tracks?all=1`)

      let data = null
      try {
        data = await res.json()
      } catch {
        data = null
      }

      if (res.status === 429) {
        const retryAfterSeconds = Number(data?.retryAfterSeconds)
        const until = Number.isFinite(retryAfterSeconds) ? Date.now() + retryAfterSeconds * 1000 : Date.now() + 60_000
        setSpotifyCooldown(userId, until)
        setCooldownUntilMs(until)
        setTracksError(
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
              : 'Failed to fetch playlist tracks')
        const finalMsg =
          res.status === 403
            ? `${msg} (Spotify 403). This can happen if Spotify restricts access to playlist items unless you own/collaborate on the playlist, or if scopes are missing. Try “Log out” + log back in.`
            : msg

        if (res.status === 403 || res.status === 404) {
          writePlaylistTracksErrorCache(userId, playlistId, { status: res.status, message: finalMsg })
        }

        setTracksError(finalMsg)
        return
      }

      const fetchedAt = new Date().toISOString()
      const apiItemsCount = Array.isArray(data?.items) ? data.items.length : 0
      const apiTotal = Number(data?.total) || apiItemsCount
      const isComplete = !data?.partial && apiItemsCount >= apiTotal

      writePlaylistTracksCache(userId, playlistId, data, { fetchedAt, isComplete })
      const cachedTracks = readPlaylistTracksCache(userId, playlistId)
      setTracksCache(cachedTracks)
      setTracksSource('api')
      setCooldownUntilMs(getSpotifyCooldownUntil(userId))
    } catch (e) {
      setTracksError(e?.message || 'Failed to fetch playlist tracks')
    } finally {
      setTracksLoading(false)
    }
  }

  useEffect(() => {
    if (!loggedIn || !profile?.id || !selectedPlaylistId) return

    const userId = profile.id
    const playlist = playlistsCache?.items?.find((p) => p?.id === selectedPlaylistId) || null
    const ownedByUser = playlist?.owner?.id && playlist.owner.id === userId

    const cachedError = readPlaylistTracksErrorCache(userId, selectedPlaylistId)
    if (cachedError) {
      setTracksError(cachedError.message || `Playlist tracks previously failed (HTTP ${cachedError.status}).`)
      setTracksSource('cache')
      return
    }

    const cachedTracks = readPlaylistTracksCache(userId, selectedPlaylistId)
    if (cachedTracks) {
      setTracksCache(cachedTracks)
      setTracksSource('cache')
      return
    }

    if (!ownedByUser) {
      setTracksError(
        'Spotify may forbid reading items for playlists you do not own (even if they appear in your list). Click “Refresh playlist cache” to try anyway.',
      )
      return
    }

    refreshPlaylistTracks({ playlistId: selectedPlaylistId, force: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loggedIn, profile?.id, selectedPlaylistId, playlistsCache])

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
            {scopes?.length ? <p className="meta">Scopes: {scopes.join(' ')}</p> : null}
            <button onClick={logout}>Log out</button>

            {selectedPlaylistId ? (
              <PlaylistView
                playlistsCache={playlistsCache}
                playlistId={selectedPlaylistId}
                cooldownUntilMs={cooldownUntilMs}
                nowMs={nowMs}
                tracksLoading={tracksLoading}
                tracksError={tracksError}
                tracksCache={tracksCache}
                tracksSource={tracksSource}
                onBack={() => {
                  setSelectedPlaylistId(null)
                  setTracksError(null)
                  setTracksCache(null)
                  setTracksSource(null)
                }}
                onRefresh={() => refreshPlaylistTracks({ playlistId: selectedPlaylistId, force: true })}
              />
            ) : (
              <PlaylistsView
                profile={profile}
                playlistsLoading={playlistsLoading}
                playlistsError={playlistsError}
                playlistsCache={playlistsCache}
                playlistsSource={playlistsSource}
                cooldownUntilMs={cooldownUntilMs}
                nowMs={nowMs}
                onRefresh={() => refreshPlaylistsCache({ force: true })}
                onSelect={(playlistId) => {
                  setSelectedPlaylistId(playlistId)
                  setTracksError(null)
                  setTracksCache(null)
                  setTracksSource(null)
                }}
              />
            )}
          </>
        )}
      </div>
    </>
  )
}

function PlaylistsView({
  profile,
  playlistsLoading,
  playlistsError,
  playlistsCache,
  playlistsSource,
  cooldownUntilMs,
  nowMs,
  onRefresh,
  onSelect,
}) {
  const userId = profile?.id
  return (
    <div className="section">
      <h2>Your playlists</h2>

      <div className="controls">
        <button
          onClick={onRefresh}
          disabled={playlistsLoading || (cooldownUntilMs && nowMs < cooldownUntilMs)}
          title="Re-fetches playlists from Spotify and overwrites the local cache."
        >
          Refresh playlists cache
        </button>
      </div>

      {playlistsError ? <p className="error">{playlistsError}</p> : null}

      {playlistsCache ? (
        <p className="meta">
          Loaded from <strong>{playlistsSource === 'cache' ? 'cache' : 'Spotify API'}</strong>. Cached at{' '}
          {formatDateTime(playlistsCache.fetchedAt)} ({formatAge(nowMs - Date.parse(playlistsCache.fetchedAt))} ago).{' '}
          {playlistsCache.isComplete
            ? `All ${playlistsCache.total} playlist(s) cached.`
            : `Showing ${playlistsCache.items.length} of ${playlistsCache.total} (partial).`}
        </p>
      ) : playlistsLoading ? (
        <p className="meta">Fetching playlists…</p>
      ) : (
        <p className="meta">No playlist cache yet.</p>
      )}

      {playlistsCache?.items?.length ? (
        <ul className="list">
          {playlistsCache.items.map((p) => {
            const tracksMeta = userId && p.id ? readPlaylistTracksCacheMeta(userId, p.id) : null
            const hasTracksCache = Boolean(tracksMeta?.fetchedAt)
            const snapshotMismatch =
              hasTracksCache &&
              typeof p.snapshotId === 'string' &&
              typeof tracksMeta?.snapshotId === 'string' &&
              p.snapshotId !== tracksMeta.snapshotId
            const ownedByUser = userId && p.owner?.id && p.owner.id === userId

            return (
              <li key={p.id || p.name}>
                <button className="linkButton" onClick={() => onSelect(p.id)} disabled={!p.id}>
                  {p.name || '(untitled playlist)'}
                </button>
                {p.externalUrl ? (
                  <a className="subLink" href={p.externalUrl} target="_blank" rel="noreferrer" title="Open in Spotify">
                    open
                  </a>
                ) : null}
                {typeof p.tracksTotal === 'number' ? <span className="sub"> · {p.tracksTotal} tracks</span> : null}
                {p.owner?.display_name ? <span className="sub"> · by {p.owner.display_name}</span> : null}
                {typeof p.public === 'boolean' ? <span className="sub"> · {p.public ? 'public' : 'private'}</span> : null}
                {ownedByUser ? <span className="sub"> · owned by you</span> : null}
                {hasTracksCache ? (
                  <span className="sub">
                    {' '}
                    · tracks cached {formatAge(nowMs - Date.parse(tracksMeta.fetchedAt))} ago
                    {snapshotMismatch ? ' (playlist changed)' : ''}
                    {tracksMeta.latestAddedAt ? ` · newest added ${formatDateTime(tracksMeta.latestAddedAt)}` : ''}
                  </span>
                ) : (
                  <span className="sub"> · tracks not cached</span>
                )}
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}

function PlaylistView({
  playlistsCache,
  playlistId,
  cooldownUntilMs,
  nowMs,
  tracksLoading,
  tracksError,
  tracksCache,
  tracksSource,
  onBack,
  onRefresh,
}) {
  const playlist = playlistsCache?.items?.find((p) => p?.id === playlistId) || null
  const playlistSnapshotId = typeof playlist?.snapshotId === 'string' ? playlist.snapshotId : null
  const cachedSnapshotId = typeof tracksCache?.snapshotId === 'string' ? tracksCache.snapshotId : null
  const snapshotMismatch = playlistSnapshotId && cachedSnapshotId && playlistSnapshotId !== cachedSnapshotId

  return (
    <div className="section">
      <div className="controls">
        <button onClick={onBack}>← Back</button>
        <button
          onClick={onRefresh}
          disabled={tracksLoading || (cooldownUntilMs && nowMs < cooldownUntilMs)}
          title="Re-fetches playlist tracks from Spotify and overwrites the local cache for this playlist."
        >
          Refresh playlist cache
        </button>
      </div>

      <h2>{playlist?.name || 'Playlist'}</h2>

      {tracksError ? <p className="error">{tracksError}</p> : null}

      {tracksCache ? (
        <p className="meta">
          Loaded from <strong>{tracksSource === 'cache' ? 'cache' : 'Spotify API'}</strong>. Cached at{' '}
          {formatDateTime(tracksCache.fetchedAt)} ({formatAge(nowMs - Date.parse(tracksCache.fetchedAt))} ago).{' '}
          {tracksCache.isComplete
            ? `All ${tracksCache.total} track(s) cached.`
            : `Showing ${tracksCache.items.length} of ${tracksCache.total} (partial).`}{' '}
          {tracksCache.latestAddedAt ? `Newest added: ${formatDateTime(tracksCache.latestAddedAt)}.` : ''}
          {snapshotMismatch ? ' Playlist has changed since this cache (snapshot mismatch).' : ''}
        </p>
      ) : tracksLoading ? (
        <p className="meta">Fetching tracks…</p>
      ) : (
        <p className="meta">No track cache for this playlist yet.</p>
      )}

      {tracksCache?.items?.length ? (
        <ol className="tracks">
          {tracksCache.items.map((t, idx) => (
            <li key={`${t.id || t.name}-${idx}`}>
              {t.externalUrl ? (
                <a href={t.externalUrl} target="_blank" rel="noreferrer">
                  {t.name || '(untitled track)'}
                </a>
              ) : (
                <span>{t.name || '(untitled track)'}</span>
              )}
              {t.artists?.length ? <span className="sub"> — {t.artists.join(', ')}</span> : null}
              {t.album ? <span className="sub"> · {t.album}</span> : null}
              {t.addedAt ? <span className="sub"> · added {formatDateTime(t.addedAt)}</span> : null}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  )
}

export default App
