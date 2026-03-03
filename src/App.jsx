import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import './Dashboard.css'
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
import { openArtistInSpotify, openTrackInSpotify } from './lib/openInSpotify'
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
import { computeTopArtistsFromTracks } from './lib/dashboardSelectors'

function App() {
  const [loading, setLoading] = useState(true)
  const [loggedIn, setLoggedIn] = useState(false)
  const [profile, setProfile] = useState(null)
  const [error, setError] = useState(null)
  const [isOwnerUser, setIsOwnerUser] = useState(false)
  const [routePath, setRoutePath] = useState(() => window.location.pathname || '/')
  const [publicPreview, setPublicPreview] = useState({ status: 'idle', data: null, error: null })

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
  const pendingSaveRef = useRef(false)

  const isDashboardRoute = routePath === '/app/dashboard'
  const headerTitle = loggedIn ? (isDashboardRoute ? 'Dashboard' : 'Playlists') : ''

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    const onPop = () => setRoutePath(window.location.pathname || '/')
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  function navigate(to, { replace = false } = {}) {
    if (!to || to === routePath) return
    if (replace) window.history.replaceState(null, '', to)
    else window.history.pushState(null, '', to)
    setRoutePath(to)
  }

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
    if (loading) return
    if (!loggedIn && routePath !== '/') navigate('/', { replace: true })
    if (loggedIn && !routePath.startsWith('/app')) navigate('/app', { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, loggedIn, routePath])

  useEffect(() => {
    if (loggedIn) return
    let cancelled = false

    setPublicPreview((s) => (s.status === 'ok' ? s : { status: 'loading', data: null, error: null }))

    ;(async () => {
      try {
        const res = await fetch('/api/public/preview')
        const data = await res.json().catch(() => null)
        if (cancelled) return
        if (!res.ok || !data?.ok) {
          setPublicPreview({ status: 'error', data: null, error: data?.error || 'Preview unavailable' })
          return
        }
        setPublicPreview({ status: 'ok', data, error: null })
      } catch (e) {
        if (cancelled) return
        setPublicPreview({ status: 'error', data: null, error: e?.message || 'Preview unavailable' })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [loggedIn])

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
    window.location.href = '/'
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

    pendingSaveRef.current = true
    saveTimerRef.current = setTimeout(() => {
      ;(async () => {
        try {
          await fetch('/api/ranking', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(userRanking),
          })
          setRankingSync(() => ({ status: 'ok', lastSyncedAt: new Date().toISOString(), message: null }))
          pendingSaveRef.current = false
        } catch (e) {
          setRankingSync((s) => ({ status: 'error', lastSyncedAt: s.lastSyncedAt, message: e?.message || 'Sync failed' }))
        }
      })()
    }, 800)

    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [loggedIn, profile?.id, userRanking, rankingSync.status])

  useEffect(() => {
    if (!loggedIn || !profile?.id) return

    const onBeforeUnload = () => {
      if (!pendingSaveRef.current) return
      try {
        fetch('/api/ranking', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(userRanking),
          keepalive: true,
        })
      } catch {
        // ignore
      }
    }

    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [loggedIn, profile?.id, userRanking])

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

	          <div className="headerTitle" aria-label="Page title">
	            {headerTitle}
	          </div>

		          <div className="topActions">
		            {loggedIn ? (
		              <>
		                {isDashboardRoute ? (
		                  <button className="btn" onClick={() => navigate('/app', { replace: true })}>
		                    Playlists
		                  </button>
		                ) : (
		                  <button className="btn" onClick={() => navigate('/app/dashboard', { replace: true })}>
		                    Dashboard
		                  </button>
		                )}
		                {rankingSync.status === 'error' ? (
		                  <span className="saveStatus err" title={rankingSync.message || 'Save failed'}>
		                    Save failed (will retry)
		                  </span>
		                ) : null}
		                <button className="btn danger" onClick={logout}>
		                  Log out
		                </button>
		              </>
		            ) : null}
		          </div>
        </div>
	      </header>

	      <main className={isDashboardRoute ? 'main mainDashboard' : 'main'}>
	        <div className="container">
	          <div className={isDashboardRoute ? 'card cardDashboard' : 'card'}>
	            {error ? <p className="error">{error}</p> : null}

          {!loggedIn ? (
            <LandingPage publicPreview={publicPreview} />
          ) : (
            <>
              {routePath === '/app/dashboard' ? (
                <DashboardPage
                  userId={profile?.id}
                  isOwnerUser={isOwnerUser}
                  ranking={userRanking}
                  playlistsCache={playlistsCache}
                  onOverwriteRanking={(next) => setUserRanking(next)}
                />
              ) : selectedPlaylistId ? (
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
      </main>
    </div>
  )
}

function TopArtistCard({ artist, artistId, rootEl, imageState, onVisible }) {
  const cardRef = useRef(null)
  const artistName = typeof artist?.name === 'string' ? artist.name : 'Unknown artist'
  const tracks = Array.isArray(artist?.topTracks)
    ? artist.topTracks
    : Array.isArray(artist?.topSongs)
      ? artist.topSongs
      : []
  const imageUrl = typeof imageState?.imageUrl === 'string' ? imageState.imageUrl : null

  useEffect(() => {
    if (!cardRef.current) return
    if (imageState?.status === 'loaded' || imageState?.status === 'loading' || imageState?.status === 'error') return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          onVisible?.(artist)
          observer.disconnect()
        }
      },
      { root: rootEl || null, rootMargin: '200px 0px', threshold: 0.01 },
    )

    observer.observe(cardRef.current)
    return () => observer.disconnect()
  }, [rootEl, onVisible, artist, imageState?.status])

  return (
    <div ref={cardRef} className="artistCard" role="listitem">
      <div className="artistCardImage">
        {imageUrl ? (
          <img src={imageUrl} alt={`${artistName}`} loading="lazy" />
        ) : (
          <div className="artistCardPlaceholder" aria-hidden="true">
            {artistName.slice(0, 1).toUpperCase()}
          </div>
        )}
      </div>
      <div className="artistCardBody">
        <div className="artistCardHeaderRow">
          <div className="artistCardName">{artistName}</div>
          {artistId ? (
            <button
              className="btn small artistCardPlayBtn"
              onClick={() => openArtistInSpotify(artistId)}
              title="Open artist in Spotify"
            >
              Play
            </button>
          ) : null}
        </div>
        {Number.isFinite(Number(artist?.artistScore)) ? (
          <div className="artistCardScore">
            <span className="artistCardScoreLabel">AVG ELO (Top 5):</span>{' '}
            <span className="eloValue">{Math.round(Number(artist.artistScore) || 0)}</span>
          </div>
        ) : null}
        <ul className="artistCardTracks" aria-label={`${artistName} top songs`}>
          {tracks.slice(0, 5).map((s) => (
            <li key={s.trackKey} className="artistCardTrack">
              <span className="artistCardTrackName">{s.name || s.trackKey}</span>
              <span className="artistCardTrackRight">
                <span className="artistCardTrackScore eloValue">{Math.round(Number(s.rating) || 0)}</span>
                {(() => {
                  const trackId =
                    (typeof s?.id === 'string' ? s.id : null) ||
                    (typeof s?.trackKey === 'string' && s.trackKey.startsWith('spid:') ? s.trackKey.slice('spid:'.length) : null)
                  if (!trackId) return null
                  return (
                    <button
                      className="btn small artistCardTrackPlayBtn"
                      onClick={() => openTrackInSpotify(trackId)}
                      title="Open track in Spotify"
                    >
                      Play
                    </button>
                  )
                })()}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function DashboardPage({ userId, isOwnerUser, ranking, playlistsCache, onOverwriteRanking }) {
  const importInputRef = useRef(null)
  const [importError, setImportError] = useState(null)
  const [artistCardsRootEl, setArtistCardsRootEl] = useState(null)
  const [artistImagesById, setArtistImagesById] = useState(() => ({}))
  const [resolvedArtistByName, setResolvedArtistByName] = useState(() => ({}))
  const artistImageInFlight = useRef(new Map())
  const trackResolveInFlight = useRef(new Map())

  const ensureArtistImage = useCallback(async (artistId) => {
    if (!artistId) return

    setArtistImagesById((prev) => {
      const existing = prev?.[artistId]
      if (existing && (existing.status === 'loading' || existing.status === 'loaded' || existing.status === 'error')) return prev
      return { ...prev, [artistId]: { status: 'loading', imageUrl: null } }
    })

    if (artistImageInFlight.current.has(artistId)) return artistImageInFlight.current.get(artistId)

    const p = (async () => {
      try {
        const res = await fetch(`/artist-image/${encodeURIComponent(artistId)}`)
        let data = null
        try {
          data = await res.json()
        } catch {
          data = null
        }

        if (!res.ok) {
          setArtistImagesById((prev) => ({ ...prev, [artistId]: { status: 'error', imageUrl: null } }))
          return
        }

        const imageUrl = typeof data?.imageUrl === 'string' ? data.imageUrl : null
        setArtistImagesById((prev) => ({ ...prev, [artistId]: { status: 'loaded', imageUrl } }))
      } catch {
        setArtistImagesById((prev) => ({ ...prev, [artistId]: { status: 'error', imageUrl: null } }))
      } finally {
        artistImageInFlight.current.delete(artistId)
      }
    })()

    artistImageInFlight.current.set(artistId, p)
    return p
  }, [])

  const ensureArtistIdForName = useCallback(
    async ({ artistName, tracks }) => {
      if (!artistName || artistName === 'Unknown artist') return null

      const existing = resolvedArtistByName?.[artistName]
      if (existing?.status === 'loaded') return existing.artistId || null
      if (existing?.status === 'loading' || existing?.status === 'error') return null

      const candidateTrackKey = tracks?.map((t) => t?.trackKey).find((k) => typeof k === 'string' && k.startsWith('spid:')) || null
      const trackId = candidateTrackKey ? candidateTrackKey.slice('spid:'.length) : null
      if (!trackId) {
        setResolvedArtistByName((prev) => ({ ...prev, [artistName]: { status: 'error', artistId: null } }))
        return null
      }

      setResolvedArtistByName((prev) => ({ ...prev, [artistName]: { status: 'loading', artistId: null } }))

      if (trackResolveInFlight.current.has(trackId)) return trackResolveInFlight.current.get(trackId)

      const p = (async () => {
        try {
          const res = await fetch(`/api/tracks/${encodeURIComponent(trackId)}`)
          let data = null
          try {
            data = await res.json()
          } catch {
            data = null
          }

          if (!res.ok) {
            setResolvedArtistByName((prev) => ({ ...prev, [artistName]: { status: 'error', artistId: null } }))
            return null
          }

          const artists = Array.isArray(data?.artists) ? data.artists : []
          const wanted = artistName.trim().toLowerCase()
          const match = artists.find((a) => typeof a?.name === 'string' && a.name.trim().toLowerCase() === wanted) || null
          const artistId = typeof match?.id === 'string' ? match.id : null
          setResolvedArtistByName((prev) => ({ ...prev, [artistName]: { status: 'loaded', artistId } }))
          return artistId
        } catch {
          setResolvedArtistByName((prev) => ({ ...prev, [artistName]: { status: 'error', artistId: null } }))
          return null
        } finally {
          trackResolveInFlight.current.delete(trackId)
        }
      })()

      trackResolveInFlight.current.set(trackId, p)
      return p
    },
    [resolvedArtistByName],
  )

  const ensureArtistImageForArtist = useCallback(
    async (artist) => {
      const artistName = typeof artist?.name === 'string' ? artist.name : null
      const tracks = Array.isArray(artist?.topTracks) ? artist.topTracks : Array.isArray(artist?.topSongs) ? artist.topSongs : []
      const directId = typeof artist?.artistId === 'string' ? artist.artistId : null
      const resolvedId = artistName ? resolvedArtistByName?.[artistName]?.artistId : null
      const artistId = directId || resolvedId || null

      if (artistId) {
        await ensureArtistImage(artistId)
        return
      }

      const nextId = await ensureArtistIdForName({ artistName, tracks })
      if (nextId) await ensureArtistImage(nextId)
    },
    [ensureArtistImage, ensureArtistIdForName, resolvedArtistByName],
  )

  function exportJson() {
    if (!ranking) return
    const payload = { version: 1, exportedAt: new Date().toISOString(), state: ranking }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `spotify-rating-export-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  function sanitizeImportedState(state) {
    const next = state && typeof state === 'object' ? { ...state } : null
    if (!next) return null
    if (typeof next.schemaVersion !== 'number') next.schemaVersion = 1
    if (typeof next.userId !== 'string') next.userId = userId
    if (typeof next.createdAt !== 'string') next.createdAt = new Date().toISOString()
    if (typeof next.updatedAt !== 'string') next.updatedAt = new Date().toISOString()
    if (!next.tracks || typeof next.tracks !== 'object') next.tracks = {}
    if (!Array.isArray(next.history)) next.history = []
    if (!next.migratedPlaylists || typeof next.migratedPlaylists !== 'object') next.migratedPlaylists = {}
    return next
  }

  function importFromText(text) {
    setImportError(null)
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      setImportError('Invalid JSON.')
      return
    }

    if (!parsed || typeof parsed !== 'object') {
      setImportError('Invalid export format.')
      return
    }

    if (parsed.version !== 1) {
      setImportError('Unsupported export version.')
      return
    }

    const importedState = sanitizeImportedState(parsed.state)
    if (!importedState) {
      setImportError('Missing state.')
      return
    }

    if (importedState.schemaVersion !== 1) {
      setImportError('Unsupported state schemaVersion.')
      return
    }

    importedState.userId = userId

    const ok = window.confirm('Import will overwrite your current ranking on this device (and sync to the server). Continue?')
    if (!ok) return

    onOverwriteRanking?.(importedState)
  }

  async function onPickImportFile(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      const text = await file.text()
      importFromText(text)
    } catch (err) {
      setImportError(err?.message || 'Failed to read file.')
    }
  }

  const trackIndex = useMemo(() => {
    const map = new Map()
    if (!userId) return map

    const playlistIds = Array.isArray(playlistsCache?.items)
      ? playlistsCache.items.map((p) => p?.id).filter(Boolean)
      : []

	    for (const playlistId of playlistIds) {
	      const cachedTracks = readPlaylistTracksCache(userId, playlistId)
	      const items = Array.isArray(cachedTracks?.items) ? cachedTracks.items : []
	      for (const t of items) {
	        const id = typeof t?.id === 'string' ? t.id : null
	        if (!id) continue
	        const key = trackKeyOfTrack(t)
	        if (!map.has(key)) {
	          const artistNames = Array.isArray(t?.artists) ? t.artists.filter(Boolean) : []
	          const artistIds = Array.isArray(t?.artistIds) ? t.artistIds : []
	          const artistsDetailed = artistNames.map((name, idx) => ({
	            name,
	            id: typeof artistIds?.[idx] === 'string' ? artistIds[idx] : null,
	          }))
	          map.set(key, {
	            id,
	            name: typeof t?.name === 'string' ? t.name : null,
	            artists: artistNames,
	            artistIds,
	            artistsDetailed,
	            album: typeof t?.album === 'string' ? t.album : null,
	          })
	        }
	      }
	    }

    return map
  }, [userId, playlistsCache])

  const computed = useMemo(() => {
    if (!ranking) return null

    const entries = Object.entries(ranking?.tracks ?? {})
    const rows = []

    for (const [trackKey] of entries) {
      const state = getTrackState(ranking, trackKey)
      if (trackKey.startsWith('meta:')) continue
      if (state.bucket === 'X') continue

      const meta = trackIndex.get(trackKey) || null
	      rows.push({
	        trackKey,
	        id: meta?.id || (trackKey.startsWith('spid:') ? trackKey.slice('spid:'.length) : null),
	        name: meta?.name || null,
	        artists: meta?.artists || [],
	        artistsDetailed: meta?.artistsDetailed || [],
	        album: meta?.album || null,
	        rating: state.rating,
	        games: state.games,
	        bucket: state.bucket,
	      })
	    }

    const hasAnyRatings = rows.some((r) => r.bucket !== 'U' || r.games > 0 || r.rating !== 1000)
    rows.sort((a, b) => b.rating - a.rating)

	    const albumAgg = new Map()

	    for (const r of rows) {
	      if (r.album) {
	        const prev = albumAgg.get(r.album) || { name: r.album, tracks: 0, sumRating: 0, bestTrackId: null, bestRating: -Infinity }
	        prev.tracks += 1
	        prev.sumRating += r.rating
	        if (r.id && r.rating > prev.bestRating) {
	          prev.bestRating = r.rating
	          prev.bestTrackId = r.id
	        }
	        albumAgg.set(r.album, prev)
	      }
	    }

    const topSongs = rows
    const topArtists = computeTopArtistsFromTracks(rows, { maxSongsPerArtist: 5, maxArtists: Number.POSITIVE_INFINITY })

	    const topAlbums = Array.from(albumAgg.values())
	      .sort((a, b) => b.sumRating - a.sumRating)
	      .map((a) => ({ ...a, avgRating: a.tracks ? a.sumRating / a.tracks : 0 }))

	    return { hasAnyRatings, topSongs, topArtists, topAlbums }
	  }, [ranking, trackIndex])

  if (!userId) return <p className="meta">Loading…</p>
	  if (!ranking) return <p className="meta">Loading ranking…</p>
	  if (!computed?.hasAnyRatings) {
	    return (
	      <div className="section dashboardPage">
	        <p className="meta">No ratings yet. Seed some songs into tiers or do a few head-to-head matchups first.</p>
	      </div>
	    )
	  }

	  return (
	    <div className="section dashboardPage">
	      {!isOwnerUser ? (
	        <div className="cardSub">
	          <h3>Export / Import</h3>
	          <div className="controls">
            <button className="btn" onClick={exportJson} disabled={!ranking}>
              Export JSON
            </button>
            <button className="btn" onClick={() => importInputRef.current?.click()}>
              Import JSON
            </button>
            <input
              ref={importInputRef}
              type="file"
              accept="application/json"
              onChange={onPickImportFile}
              style={{ display: 'none' }}
            />
          </div>
          {importError ? <p className="error">{importError}</p> : null}
        </div>
      ) : null}

      <div className="dashboardColumns" role="region" aria-label="Dashboard columns">
	        <div className="dashPanel">
	          <div className="dashPanelHeader">
	            <h3>Top songs ({computed.topSongs.length})</h3>
	          </div>
	          <div className="dashPanelBody dashPanelBodyTight" role="region" aria-label="Top songs list" tabIndex={0}>
	            <table className="dashTable">
	              <thead>
	                <tr>
	                  <th className="right dashColIndex">#</th>
	                  <th>Song</th>
	                  <th>Artist</th>
	                  <th className="right dashColElo">Elo</th>
	                  <th className="right dashColPlay" aria-label="Play column" />
	                </tr>
	              </thead>
	              <tbody>
	                {computed.topSongs.map((t, idx) => {
	                  const trackId =
	                    (typeof t?.id === 'string' ? t.id : null) ||
	                    (typeof t?.trackKey === 'string' && t.trackKey.startsWith('spid:') ? t.trackKey.slice('spid:'.length) : null)
	                  return (
	                    <tr key={t.trackKey} className="dashTableRow">
	                      <td className="right">
	                        <span className="cellSub">{idx + 1}</span>
	                      </td>
	                      <td>
	                        <div className="cellTitle">{t.name || t.id || t.trackKey}</div>
	                      </td>
	                      <td>
	                        <div className="cellSub">{t.artists?.length ? t.artists.join(', ') : 'Unknown artist'}</div>
	                      </td>
	                      <td className="right">
	                        <span className="cellSub eloValue">{Math.round(Number(t.rating) || 0)}</span>
	                      </td>
	                      <td className="right">
	                        {trackId ? (
	                          <button className="btn small rowPlayBtn" onClick={() => openTrackInSpotify(trackId)} title="Open in Spotify">
	                            Play
	                          </button>
	                        ) : null}
	                      </td>
	                    </tr>
	                  )
	                })}
	              </tbody>
	            </table>
	          </div>
	        </div>

	        <div className="dashPanel dashPanelArtists">
	          <div className="dashPanelHeader">
	            <h3>Top artists ({computed.topArtists.length})</h3>
	          </div>
	          <div
	            ref={setArtistCardsRootEl}
	            className="dashPanelBody"
	            role="region"
	            aria-label="Top artists list"
	            tabIndex={0}
	          >
	            <div className="artistGrid" role="list" aria-label="Top artists cards">
	              {computed.topArtists.map((a) => {
	                const artistName = typeof a?.name === 'string' ? a.name : 'Unknown artist'
	                const effectiveArtistId =
	                  (typeof a?.artistId === 'string' ? a.artistId : null) || (typeof resolvedArtistByName?.[artistName]?.artistId === 'string' ? resolvedArtistByName[artistName].artistId : null) || null
	                const imageState = effectiveArtistId ? artistImagesById?.[effectiveArtistId] : null
	                return (
	                <TopArtistCard
	                  key={a.name}
	                  artist={a}
	                  artistId={effectiveArtistId}
	                  rootEl={artistCardsRootEl}
	                  imageState={imageState}
	                  onVisible={ensureArtistImageForArtist}
	                />
	                )
	              })}
	            </div>
	          </div>
	        </div>

	        <div className="dashPanel">
	          <div className="dashPanelHeader">
	            <h3>Top albums ({computed.topAlbums.length})</h3>
	          </div>
	          <div className="dashPanelBody dashPanelBodyTight" role="region" aria-label="Top albums list" tabIndex={0}>
	            <table className="dashTable">
	              <thead>
	                <tr>
	                  <th className="right dashColIndex">#</th>
	                  <th>Album</th>
	                  <th className="right dashColTracks">Tracks</th>
	                  <th className="right dashColElo">Elo</th>
	                  <th className="right dashColPlay" aria-label="Play column" />
	                </tr>
	              </thead>
	              <tbody>
	                {computed.topAlbums.map((a, idx) => (
	                  <tr key={a.name} className="dashTableRow">
	                    <td className="right">
	                      <span className="cellSub">{idx + 1}</span>
	                    </td>
	                    <td>
	                      <div className="cellTitle">{a.name}</div>
	                    </td>
	                    <td className="right">
	                      <span className="cellSub">{a.tracks}</span>
	                    </td>
	                    <td className="right">
	                      <span className="cellSub eloValue">{Math.round(Number(a.avgRating) || 0)}</span>
	                    </td>
	                    <td className="right">
	                      {a?.bestTrackId ? (
	                        <button
	                          className="btn small rowPlayBtn"
	                          onClick={() => openTrackInSpotify(a.bestTrackId)}
	                          title="Open a track from this album in Spotify"
	                        >
	                          Play
	                        </button>
	                      ) : null}
	                    </td>
	                  </tr>
	                ))}
	              </tbody>
	            </table>
	          </div>
	        </div>
      </div>
    </div>
  )
}

function LandingPage({ publicPreview }) {
  const data = publicPreview?.data
  const topSongs = Array.isArray(data?.topSongs) ? data.topSongs : []
  const topArtists = Array.isArray(data?.topArtists) ? data.topArtists : []
  const topAlbums = Array.isArray(data?.topAlbums) ? data.topAlbums : []

  return (
    <div className="section">
      <h2>Rate your music with tiers + head-to-head</h2>

      <p className="meta">
        This app helps you seed songs into tiers (S/A/B/C/D), then refine ordering with Elo-style head-to-head matchups.
        Your ranking syncs across devices when you sign in.
      </p>

      <div className="controls">
        <a className="btn primary" href="/auth/login">
          Sign in with Spotify
        </a>
      </div>

      <div className="cardSub">
        <h3>Preview: Adesh’s dashboard (read-only)</h3>

        {publicPreview?.status === 'loading' ? <p className="meta">Loading preview…</p> : null}
        {publicPreview?.status === 'error' ? <p className="meta">{publicPreview.error || 'Preview unavailable.'}</p> : null}

        {publicPreview?.status === 'ok' ? (
          <>
            <p className="meta">
              Updated {data?.rankingUpdatedAt ? formatDateTime(data.rankingUpdatedAt) : 'recently'}.
            </p>

            <div className="tableWrap" role="region" aria-label="Top songs preview" tabIndex={0}>
              <table className="table">
                <thead>
                  <tr>
                    <th className="right colIndex">#</th>
                    <th className="colSong">Song</th>
                    <th className="colArtist">Artist</th>
                    <th className="colAlbum">Album</th>
                    <th className="right colElo">Elo</th>
                  </tr>
                </thead>
                <tbody>
                  {topSongs.slice(0, 15).map((t, idx) => (
                    <tr key={t.id || idx}>
                      <td className="right">
                        <span className="cellSub">{idx + 1}</span>
                      </td>
                      <td>
                        <div className="cellTitle">{t.name || t.id}</div>
                      </td>
                      <td>
                        <div className="cellSub">{Array.isArray(t.artists) ? t.artists.join(', ') : 'Unknown artist'}</div>
                      </td>
                      <td>
                        <div className="cellSub">{t.album || 'Unknown album'}</div>
                      </td>
                      <td className="right">
                        <span className="cellSub">{Math.round(Number(t.rating) || 0)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="section">
              <h3>Top artists</h3>
              <div className="tableWrap" role="region" aria-label="Top artists preview" tabIndex={0}>
                <table className="table">
                  <thead>
                    <tr>
                      <th className="right colIndex">#</th>
                      <th className="colArtist">Artist</th>
                      <th className="right colMatches">Tracks</th>
                      <th className="right colElo">Avg Elo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topArtists.slice(0, 10).map((a, idx) => (
                      <tr key={a.name || idx}>
                        <td className="right">
                          <span className="cellSub">{idx + 1}</span>
                        </td>
                        <td>
                          <div className="cellTitle">{a.name}</div>
                        </td>
                        <td className="right">
                          <span className="cellSub">{a.tracks}</span>
                        </td>
                        <td className="right">
                          <span className="cellSub">{Math.round(Number(a.avgRating) || 0)}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="section">
              <h3>Top albums</h3>
              <div className="tableWrap" role="region" aria-label="Top albums preview" tabIndex={0}>
                <table className="table">
                  <thead>
                    <tr>
                      <th className="right colIndex">#</th>
                      <th className="colAlbum">Album</th>
                      <th className="right colMatches">Tracks</th>
                      <th className="right colElo">Avg Elo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topAlbums.slice(0, 10).map((a, idx) => (
                      <tr key={a.name || idx}>
                        <td className="right">
                          <span className="cellSub">{idx + 1}</span>
                        </td>
                        <td>
                          <div className="cellTitle">{a.name}</div>
                        </td>
                        <td className="right">
                          <span className="cellSub">{a.tracks}</span>
                        </td>
                        <td className="right">
                          <span className="cellSub">{Math.round(Number(a.avgRating) || 0)}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        ) : null}
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
