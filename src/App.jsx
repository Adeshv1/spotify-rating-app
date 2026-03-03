import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { openTrackInSpotify } from './lib/openInSpotify'
import {
  excludeTrack,
  createEmptyUserRanking,
  getTrackState,
  mergeLegacyPlaylistRanking,
  readUserRanking,
  recordDuel,
  setTrackBucket,
  setTrackElo,
  TIER_BUCKETS,
  trackKeyOfTrack,
  undoLast,
  mergeUserRankings,
  writeUserRanking,
} from './lib/userRankingStore'
import { pickMatchup } from './lib/matchup'
import { readPlaylistRanking as readLegacyPlaylistRanking } from './lib/playlistRankingStore'

function App() {
  const [loading, setLoading] = useState(true)
  const [loggedIn, setLoggedIn] = useState(false)
  const [profile, setProfile] = useState(null)
  const [error, setError] = useState(null)
  const [isOwnerUser, setIsOwnerUser] = useState(false)

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

  const [rankingSync, setRankingSync] = useState({ status: 'idle', lastSyncedAt: null, message: null })
  const [userRanking, setUserRanking] = useState(null)
  const saveTimerRef = useRef(null)

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
          setIsOwnerUser(false)
          return
        }

        setLoggedIn(true)
        setIsOwnerUser(Boolean(session?.isOwnerUser))

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
      setUserRanking(null)
      setRankingSync({ status: 'idle', lastSyncedAt: null, message: null })
      setIsOwnerUser(false)
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
      if (!isOwnerUser) refreshPlaylistsCache({ force: false })
      return
    }

    // No cache yet: do a fetch to seed the cache.
    refreshPlaylistsCache({ force: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loggedIn, profile?.id, isOwnerUser])

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
      if (!isOwnerUser) refreshPlaylistTracks({ playlistId: selectedPlaylistId, force: false })
      return
    }

    if (!ownedByUser) {
      setTracksError(
        isOwnerUser
          ? 'Spotify may forbid reading items for playlists you do not own (even if they appear in your list). Click “Refresh playlist cache” to try anyway.'
          : 'Spotify may forbid reading items for playlists you do not own (even if they appear in your list).',
      )
      return
    }

    refreshPlaylistTracks({ playlistId: selectedPlaylistId, force: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loggedIn, profile?.id, selectedPlaylistId, playlistsCache, isOwnerUser])

  async function logout() {
    await fetch('/auth/logout', { method: 'POST' })
    window.location.reload()
  }

  const syncRankings = useCallback(
    async ({ force = false } = {}) => {
      if (!loggedIn || !profile?.id) return
      const userId = profile.id

      setRankingSync((s) => ({ status: 'syncing', lastSyncedAt: s.lastSyncedAt, message: null }))

      let local = readUserRanking(userId) ?? createEmptyUserRanking({ userId })

      const legacyPrefix = `sp_rank_v1_${userId}_`
      try {
        for (let i = 0; i < localStorage.length; i += 1) {
          const k = localStorage.key(i)
          if (!k || !k.startsWith(legacyPrefix)) continue
          const playlistId = k.slice(legacyPrefix.length)
          if (!playlistId) continue
          const legacy = readLegacyPlaylistRanking(userId, playlistId)
          if (legacy) local = mergeLegacyPlaylistRanking(local, legacy, playlistId)
        }
      } catch {
        // ignore
      }

      setUserRanking(local)

      try {
        const res = await fetch('/api/ranking')
        const data = await res.json().catch(() => null)
        if (!res.ok) throw new Error(data?.error || data?.message || 'ranking_fetch_failed')

        const serverRanking = data?.exists ? data?.ranking : null
        const merged = serverRanking ? mergeUserRankings(local, serverRanking) : local

        const hasAny = Boolean(Object.keys(merged?.tracks ?? {}).length)
        if (hasAny || force) {
          const putRes = await fetch('/api/ranking', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(merged),
          })
          const putData = await putRes.json().catch(() => null)
          if (!putRes.ok) throw new Error(putData?.error || putData?.message || 'ranking_save_failed')
        }

        writeUserRanking(userId, merged)
        setUserRanking(merged)
        setRankingSync({ status: 'ok', lastSyncedAt: new Date().toISOString(), message: null })
      } catch (e) {
        setRankingSync((s) => ({ status: 'error', lastSyncedAt: s.lastSyncedAt, message: e?.message || 'Sync failed' }))
      }
    },
    [loggedIn, profile?.id],
  )

  useEffect(() => {
    if (!loggedIn || !profile?.id) return
    ;(async () => {
      await syncRankings({ force: false })
    })()
  }, [loggedIn, profile?.id, syncRankings])

  useEffect(() => {
    if (!loggedIn || !profile?.id || !userRanking) return
    writeUserRanking(profile.id, userRanking)
  }, [loggedIn, profile?.id, userRanking])

  useEffect(() => {
    if (!loggedIn || !profile?.id || !userRanking) return
    if (rankingSync.status === 'syncing') return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)

    saveTimerRef.current = setTimeout(() => {
      ;(async () => {
        try {
          await fetch('/api/ranking', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(userRanking),
          })
          setRankingSync(() => ({ status: 'ok', lastSyncedAt: new Date().toISOString(), message: null }))
        } catch (e) {
          setRankingSync((s) => ({ status: 'error', lastSyncedAt: s.lastSyncedAt, message: e?.message || 'Sync failed' }))
        }
      })()
    }, 900)

    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [loggedIn, profile?.id, userRanking, rankingSync.status])

  if (loading) {
    return (
      <div className="appShell">
        <div className="container">
          <div className="card">
            <p>Loading…</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="appShell">
      <header className="topBar">
        <div className="topBarInner">
          <div className="brand">
            <div className="brandTitle">Spotify Rating App</div>
            <div className="brandSub">
              {loggedIn ? (
                <>
                  {profile?.display_name ? `Signed in as ${profile.display_name}.` : 'Signed in.'}
                </>
              ) : (
                'Rank your songs with tiers + head-to-head.'
              )}
            </div>
          </div>

          <div className="topActions">
            {loggedIn ? (
              <>
                <span
                  className={`pill ${
                    rankingSync.status === 'ok'
                      ? 'ok'
                      : rankingSync.status === 'error'
                        ? 'err'
                        : ''
                  }`}
                >
                  {rankingSync.status === 'syncing'
                    ? 'Syncing…'
                    : rankingSync.status === 'ok'
                      ? rankingSync.lastSyncedAt
                        ? `Synced ${formatDateTime(rankingSync.lastSyncedAt)}`
                        : 'Synced'
                      : rankingSync.status === 'error'
                        ? `Sync error: ${rankingSync.message || 'unknown'}`
                        : 'Not synced yet'}
                </span>

                <button className="btn" onClick={() => syncRankings({ force: true })} disabled={rankingSync.status === 'syncing'}>
                  Sync
                </button>
                <button className="btn danger" onClick={logout}>
                  Log out
                </button>
              </>
            ) : null}
          </div>
        </div>
      </header>

      <div className="container">
        <div className="card">
          {error ? <p className="error">{error}</p> : null}

        {!loggedIn ? (
          <>
            <p>Log in to Spotify to continue.</p>
            <a className="read-the-docs" href="/auth/login">
              Log in with Spotify
            </a>
          </>
        ) : (
          <>
            {selectedPlaylistId ? (
              <PlaylistView
                playlistsCache={playlistsCache}
                playlistId={selectedPlaylistId}
                ranking={userRanking}
                onChangeRanking={setUserRanking}
                isOwnerUser={isOwnerUser}
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
                isOwnerUser={isOwnerUser}
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
      </div>
    </div>
  )
}

function PlaylistsView({
  profile,
  playlistsLoading,
  playlistsError,
  playlistsCache,
  playlistsSource,
  isOwnerUser,
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
        {isOwnerUser ? (
          <button
            className="btn"
            onClick={onRefresh}
            disabled={playlistsLoading || (cooldownUntilMs && nowMs < cooldownUntilMs)}
            title="Re-fetches playlists from Spotify and overwrites the local cache."
          >
            Refresh playlists cache
          </button>
        ) : null}
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
  ranking,
  onChangeRanking,
  isOwnerUser,
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

  const [view, setView] = useState('tracks') // tracks | bucket | duel | leaderboard

  const uniqueTracks = useMemo(() => {
    const items = Array.isArray(tracksCache?.items) ? tracksCache.items : []
    const map = new Map()
    for (const t of items) {
      const key = trackKeyOfTrack(t)
      const existing = map.get(key)
      if (existing) {
        existing.count += 1
      } else {
        map.set(key, { key, track: t, count: 1 })
      }
    }
    return Array.from(map.values())
  }, [tracksCache])

  return (
    <div className="section">
      <div className="controls">
        <button className="btn" onClick={onBack}>
          ← Back
        </button>
        {isOwnerUser ? (
          <button
            className="btn"
            onClick={onRefresh}
            disabled={tracksLoading || (cooldownUntilMs && nowMs < cooldownUntilMs)}
            title="Re-fetches playlist tracks from Spotify and overwrites the local cache for this playlist."
          >
            Refresh playlist cache
          </button>
        ) : null}
      </div>

      <h2>{playlist?.name || 'Playlist'}</h2>

      <div className="tabs" role="tablist" aria-label="Playlist views">
        <button className={`tab ${view === 'tracks' ? 'active' : ''}`} onClick={() => setView('tracks')}>
          Tracks
        </button>
        <button className={`tab ${view === 'bucket' ? 'active' : ''}`} onClick={() => setView('bucket')}>
          Seed tiers (global)
        </button>
        <button className={`tab ${view === 'duel' ? 'active' : ''}`} onClick={() => setView('duel')}>
          Head-to-head
        </button>
        <button className={`tab ${view === 'leaderboard' ? 'active' : ''}`} onClick={() => setView('leaderboard')}>
          Leaderboard (global)
        </button>
      </div>

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

      {view === 'tracks' ? (
        <TracksTable uniqueTracks={uniqueTracks} ranking={ranking} onChangeRanking={onChangeRanking} />
      ) : null}

      {view === 'bucket' ? (
        <BucketSeeder uniqueTracks={uniqueTracks} ranking={ranking} onChange={onChangeRanking} />
      ) : null}

      {view === 'duel' ? (
        <HeadToHead uniqueTracks={uniqueTracks} ranking={ranking} onChange={onChangeRanking} />
      ) : null}

      {view === 'leaderboard' ? (
        <Leaderboard uniqueTracks={uniqueTracks} ranking={ranking} onChange={onChangeRanking} />
      ) : null}
    </div>
  )
}

function EloEditor({ rating, disabled = false, onSave }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(() => String(Math.round(Number.isFinite(rating) ? rating : 1000)))

  function commit() {
    const next = Number(value)
    if (!Number.isFinite(next)) return
    onSave?.(next)
    setEditing(false)
  }

  if (!editing) {
    return (
      <span className="eloEditor">
        <span className="eloValue">{Math.round(Number.isFinite(rating) ? rating : 1000)}</span>
        <button
          className="btn small eloEditBtn"
          onClick={() => {
            setValue(String(Math.round(Number.isFinite(rating) ? rating : 1000)))
            setEditing(true)
          }}
          disabled={disabled}
          title="Edit Elo"
        >
          Edit
        </button>
      </span>
    )
  }

  return (
    <span className="eloEditor">
      <input
        className="eloInput"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={disabled}
        inputMode="numeric"
        aria-label="Elo"
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') setEditing(false)
        }}
      />
      <button className="btn small primary" onClick={commit} disabled={disabled}>
        Save
      </button>
      <button className="btn small" onClick={() => setEditing(false)} disabled={disabled}>
        Cancel
      </button>
    </span>
  )
}

function TracksTable({ uniqueTracks, ranking, onChangeRanking }) {
  const rows = useMemo(() => {
    return uniqueTracks.map(({ key, track }) => {
      const state = ranking ? getTrackState(ranking, key) : null
      return {
        key,
        track,
        state,
        artists: Array.isArray(track?.artists) ? track.artists.join(', ') : '',
      }
    })
  }, [uniqueTracks, ranking])

  if (!uniqueTracks?.length) return <p className="meta">No tracks found.</p>

  return (
    <div className="cardSub">
      <div className="tableWrap" role="region" aria-label="Tracks table" tabIndex={0}>
        <table className="table">
          <thead>
            <tr>
              <th className="colSong">Song</th>
              <th className="colArtist">Artist</th>
              <th className="colAlbum">Album</th>
              <th className="right colElo">Elo</th>
              <th className="right colActions">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td>
                  <div className="cellTitle">{r.track?.name || '(untitled track)'}</div>
                </td>
                <td>
                  <div className="cellSub">{r.artists || 'Unknown artist'}</div>
                </td>
                <td>
                  <div className="cellSub">{r.track?.album || 'Unknown album'}</div>
                </td>
                <td className="right">
                  <EloEditor
                    rating={r.state?.rating}
                    disabled={!ranking}
                    onSave={(next) => onChangeRanking?.((rk) => (rk ? setTrackElo(rk, r.key, next) : rk))}
                  />
                </td>
                <td className="right">
                  <span className="btnRow">
                    {r.track?.id ? (
                      <button className="btn small" onClick={() => openTrackInSpotify(r.track.id)} title="Play in Spotify">
                        Play
                      </button>
                    ) : null}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function BucketSeeder({ uniqueTracks, ranking, onChange }) {
  const [query, setQuery] = useState('')
  const [filterBuckets, setFilterBuckets] = useState([])

  function toggleFilter(bucket) {
    setFilterBuckets((prev) => (prev.includes(bucket) ? prev.filter((b) => b !== bucket) : prev.concat(bucket)))
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filterSet = new Set(filterBuckets)
    return uniqueTracks.filter(({ key, track }) => {
      const state = ranking ? getTrackState(ranking, key) : null
      if (filterBuckets.length && state && !filterSet.has(state.bucket)) return false
      if (!q) return true
      const hay = `${track?.name ?? ''} ${(track?.artists ?? []).join(' ')}`.toLowerCase()
      return hay.includes(q)
    })
  }, [uniqueTracks, ranking, query, filterBuckets])

  return (
    <div className="cardSub">
      <p className="meta">
        Fast seeding step (global per song): put favorites into <strong>S</strong>, good songs into <strong>A</strong>, and
        leave the rest <strong>unseeded</strong>. Head-to-head mostly happens within the tier you pick, so you don’t have to
        grind through everything.
      </p>

      <div className="controls">
        <input
          className="textInput"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search tracks…"
          aria-label="Search tracks"
        />
        <div className="filterRow" aria-label="Tier filters">
          <button className={`filterBtn ${filterBuckets.length === 0 ? 'active' : ''}`} onClick={() => setFilterBuckets([])}>
            All
          </button>
          {TIER_BUCKETS.map((b) => (
            <button
              key={b}
              className={`filterBtn ${filterBuckets.includes(b) ? 'active' : ''}`}
              onClick={() => toggleFilter(b)}
            >
              {b}
            </button>
          ))}
          <button className={`filterBtn ${filterBuckets.includes('U') ? 'active' : ''}`} onClick={() => toggleFilter('U')}>
            Unseeded
          </button>
          <button className={`filterBtn ${filterBuckets.includes('X') ? 'active' : ''}`} onClick={() => toggleFilter('X')}>
            Do not rate
          </button>
        </div>
      </div>

      <div className="tableWrap" role="region" aria-label="Seeding table" tabIndex={0}>
        <table className="table">
          <thead>
            <tr>
              <th className="right colIndex">#</th>
              <th className="colSong">Song</th>
              <th className="colArtist">Artist</th>
              <th className="colAlbum">Album</th>
              <th className="right colElo">Elo</th>
              <th className="right colTier">Tier</th>
              <th className="right colActions">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(({ key, track }, idx) => {
              const state = ranking ? getTrackState(ranking, key) : null
              const bucket = state?.bucket ?? 'U'
              const artists = Array.isArray(track?.artists) ? track.artists.join(', ') : ''
              return (
                <tr key={key}>
                  <td className="right">
                    <span className="cellSub">{idx + 1}</span>
                  </td>
                  <td>
                    <div className="cellTitle">{track?.name || '(untitled track)'}</div>
                  </td>
                  <td>
                    <div className="cellSub">{artists || 'Unknown artist'}</div>
                  </td>
                  <td>
                    <div className="cellSub">{track?.album || 'Unknown album'}</div>
                  </td>
                  <td className="right">
                    <EloEditor
                      rating={state?.rating}
                      disabled={!ranking}
                      onSave={(next) => onChange?.((rk) => (rk ? setTrackElo(rk, key, next) : rk))}
                    />
                  </td>
                  <td className="right">
                    <span className="btnRow tierButtons">
                      {TIER_BUCKETS.map((b) => (
                        <button
                          key={b}
                          className={`btn small ${bucket === b ? 'active' : ''}`}
                          onClick={() => onChange?.((rk) => (rk ? setTrackBucket(rk, key, b) : rk))}
                          disabled={!ranking}
                          title={`Set tier ${b}`}
                        >
                          {b}
                        </button>
                      ))}
                      <button
                        className={`btn small ${bucket === 'U' ? 'active' : ''}`}
                        onClick={() => onChange?.((rk) => (rk ? setTrackBucket(rk, key, 'U') : rk))}
                        disabled={!ranking}
                        title="Clear tier (unseeded)"
                      >
                        —
                      </button>
                      <button
                        className={`btn small danger ${bucket === 'X' ? 'active' : ''}`}
                        onClick={() => onChange?.((rk) => (rk ? setTrackBucket(rk, key, 'X') : rk))}
                        disabled={!ranking}
                        title="Do not rate (exclude)"
                      >
                        X
                      </button>
                    </span>
                  </td>
                  <td className="right">
                    <span className="btnRow">
                      {track?.id ? (
                        <button className="btn small" onClick={() => openTrackInSpotify(track.id)} title="Play in Spotify">
                          Play
                        </button>
                      ) : null}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Leaderboard({ uniqueTracks, ranking, onChange }) {
  const [bucket, setBucket] = useState('S')
  const [query, setQuery] = useState('')

  const rows = useMemo(() => {
    if (!ranking) return []
    const q = query.trim().toLowerCase()
    return uniqueTracks
      .map(({ key, track }) => ({
        key,
        track,
        state: getTrackState(ranking, key),
        artists: Array.isArray(track?.artists) ? track.artists.join(', ') : '',
      }))
      .filter((r) => r.state.bucket !== 'X')
      .filter((r) => (bucket === 'ALL' ? r.state.bucket !== 'X' : r.state.bucket === bucket))
      .filter((r) => {
        if (!q) return true
        const hay = `${r.track?.name ?? ''} ${r.artists}`.toLowerCase()
        return hay.includes(q)
      })
      .sort((a, b) => b.state.rating - a.state.rating)
  }, [uniqueTracks, ranking, bucket, query])

  return (
    <div className="cardSub">
      <div className="controls">
        <input
          className="textInput"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search leaderboard…"
          aria-label="Search leaderboard"
        />
        <label className="inlineLabel">
          Tier
          <select value={bucket} onChange={(e) => setBucket(e.target.value)}>
            {TIER_BUCKETS.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
            <option value="U">Unseeded</option>
            <option value="ALL">All (except excluded)</option>
          </select>
        </label>
      </div>

      {!ranking ? <p className="meta">Loading ranking…</p> : null}

      {ranking && rows.length ? (
        <div className="tableWrap" role="region" aria-label="Leaderboard table" tabIndex={0}>
          <table className="table">
            <thead>
              <tr>
                <th className="right colIndex">Rank</th>
                <th className="colSong">Song</th>
                <th className="colArtist">Artist</th>
                <th className="colAlbum">Album</th>
                <th className="right colElo">Elo</th>
                <th className="right colMatches">Matches</th>
                <th className="right colActions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 250).map((r, idx) => (
                <tr key={r.key}>
                  <td className="right">
                    <span className="cellSub">{idx + 1}</span>
                  </td>
                  <td>
                    <div className="cellTitle">{r.track?.name || '(untitled track)'}</div>
                    <div className="cellSub">tier {r.state.bucket === 'U' ? 'unseeded' : r.state.bucket}</div>
                  </td>
                  <td>
                    <div className="cellSub">{r.artists || 'Unknown artist'}</div>
                  </td>
                  <td>
                    <div className="cellSub">{r.track?.album || 'Unknown album'}</div>
                  </td>
                  <td className="right">
                    <EloEditor
                      rating={r.state.rating}
                      disabled={!ranking}
                      onSave={(next) => onChange?.((rk) => (rk ? setTrackElo(rk, r.key, next) : rk))}
                    />
                  </td>
                  <td className="right">
                    <span className="cellSub">{r.state.games}</span>
                  </td>
                  <td className="right">
                    <span className="btnRow">
                      {r.track?.id ? (
                        <button className="btn small" onClick={() => openTrackInSpotify(r.track.id)} title="Play in Spotify">
                          Play
                        </button>
                      ) : null}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : ranking ? (
        <p className="meta">No tracks to show for this tier yet.</p>
      ) : null}
    </div>
  )
}

function HeadToHead({ uniqueTracks, ranking, onChange }) {
  const [bucket, setBucket] = useState('AUTO')
  const [seed, setSeed] = useState(0)
  const [sessionTarget, setSessionTarget] = useState(25)
  const [sessionDone, setSessionDone] = useState(0)

  const trackByKey = useMemo(() => {
    const map = new Map()
    for (const u of uniqueTracks) map.set(u.key, u.track)
    return map
  }, [uniqueTracks])

  const trackKeys = useMemo(() => uniqueTracks.map((t) => t.key), [uniqueTracks])

  const matchup = useMemo(() => {
    if (!ranking) return null
    return pickMatchup({ trackKeys, ranking, bucket, seed })
  }, [ranking, trackKeys, bucket, seed])

  const leftTrack = matchup ? trackByKey.get(matchup.leftKey) : null
  const rightTrack = matchup ? trackByKey.get(matchup.rightKey) : null

  const leftState = matchup && ranking ? getTrackState(ranking, matchup.leftKey) : null
  const rightState = matchup && ranking ? getTrackState(ranking, matchup.rightKey) : null

  const canUndo = Boolean(ranking?.history?.length)

  function vote(winnerKey) {
    if (!matchup) return
    onChange((r) => (r ? recordDuel(r, { leftKey: matchup.leftKey, rightKey: matchup.rightKey, winnerKey }) : r))
    setSessionDone((n) => n + 1)
  }

  function skip() {
    setSeed((s) => s + 1)
  }

  function undo() {
    onChange((r) => {
      const next = r ? undoLast(r) : r
      if (next !== r) setSessionDone((n) => Math.max(0, n - 1))
      return next
    })
  }

  function doNotRate(trackKey) {
    onChange((r) => (r ? excludeTrack(r, trackKey) : r))
    setSeed((s) => s + 1)
  }

  return (
    <div className="cardSub">
      <p className="meta">
        Tip: seed 10–30 favorites into <strong>S</strong>, set Tier to <strong>S</strong>, and you’ll quickly get a Top list
        without comparing every song. Everything is saved globally per song across playlists.
      </p>

      <div className="controls">
        <label className="inlineLabel">
          Tier
          <select value={bucket} onChange={(e) => setBucket(e.target.value)}>
            <option value="AUTO">Auto</option>
            {TIER_BUCKETS.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
            <option value="U">Unseeded</option>
          </select>
        </label>

        <button
          className="btn"
          onClick={() => setSessionDone(0)}
          title="Resets the in-session counter only (does not affect ratings)."
        >
          Reset session
        </button>

        <label className="inlineLabel">
          Target
          <select value={sessionTarget} onChange={(e) => setSessionTarget(Number(e.target.value) || 25)}>
            <option value={10}>10</option>
            <option value={25}>25</option>
            <option value={50}>50</option>
          </select>
        </label>

        <button className="btn" onClick={undo} disabled={!canUndo} title="Undo last comparison">
          Undo
        </button>
      </div>

      {ranking ? (
        <p className="meta">
          Session: {sessionDone}/{sessionTarget}. Total comparisons: {ranking.history.length}.
        </p>
      ) : null}

      {!ranking ? (
        <p className="meta">Loading ranking…</p>
      ) : !matchup || !leftTrack || !rightTrack ? (
        <p className="meta">
          Not enough eligible tracks for a matchup yet. Add at least 2 non-excluded songs to the selected tier (or use
          Auto).
        </p>
      ) : (
        <>
          <div className="duelGrid">
            <div className="duelCard">
              <div className="duelTitle">{leftTrack?.name || '(untitled track)'}</div>
              {(leftTrack?.artists ?? []).length ? <div className="duelMeta">{leftTrack.artists.join(', ')}</div> : null}
              {leftState ? (
                <div className="duelStats">
                  <span className="cellSub">tier {leftState.bucket === 'U' ? 'unseeded' : leftState.bucket}</span>
                  <span className="cellSub"> · matches {leftState.games}</span>
                </div>
              ) : null}
              {leftState ? (
                <div className="controls">
                  <span className="cellSub">Elo</span>
                  <EloEditor
                    rating={leftState.rating}
                    disabled={!ranking}
                    onSave={(next) => onChange?.((rk) => (rk ? setTrackElo(rk, matchup.leftKey, next) : rk))}
                  />
                </div>
              ) : null}
              <div className="controls">
                {leftTrack?.id ? (
                  <button className="btn" onClick={() => openTrackInSpotify(leftTrack.id)} title="Play in Spotify">
                    Play
                  </button>
                ) : null}
                <button className="btn primary" onClick={() => vote(matchup.leftKey)}>
                  Left wins
                </button>
                <button className="btn danger" onClick={() => doNotRate(matchup.leftKey)} title="Exclude this track forever">
                  Do not rate
                </button>
              </div>
            </div>

            <div className="duelVs">vs</div>

            <div className="duelCard">
              <div className="duelTitle">{rightTrack?.name || '(untitled track)'}</div>
              {(rightTrack?.artists ?? []).length ? <div className="duelMeta">{rightTrack.artists.join(', ')}</div> : null}
              {rightState ? (
                <div className="duelStats">
                  <span className="cellSub">tier {rightState.bucket === 'U' ? 'unseeded' : rightState.bucket}</span>
                  <span className="cellSub"> · matches {rightState.games}</span>
                </div>
              ) : null}
              {rightState ? (
                <div className="controls">
                  <span className="cellSub">Elo</span>
                  <EloEditor
                    rating={rightState.rating}
                    disabled={!ranking}
                    onSave={(next) => onChange?.((rk) => (rk ? setTrackElo(rk, matchup.rightKey, next) : rk))}
                  />
                </div>
              ) : null}
              <div className="controls">
                {rightTrack?.id ? (
                  <button className="btn" onClick={() => openTrackInSpotify(rightTrack.id)} title="Play in Spotify">
                    Play
                  </button>
                ) : null}
                <button className="btn primary" onClick={() => vote(matchup.rightKey)}>
                  Right wins
                </button>
                <button className="btn danger" onClick={() => doNotRate(matchup.rightKey)} title="Exclude this track forever">
                  Do not rate
                </button>
              </div>
            </div>
          </div>

          <div className="controls">
            <button className="btn" onClick={skip} title="Skip this matchup and ask again later">
              Skip
            </button>
          </div>
        </>
      )}
    </div>
  )
}

export default App
