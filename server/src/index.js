import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isOwnerUser } from './permissions/isOwnerUser.js'

function loadEnvFile(filePath) {
  let contents
  try {
    contents = fs.readFileSync(filePath, 'utf8')
  } catch {
    return
  }

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const withoutExport = line.startsWith('export ') ? line.slice('export '.length) : line
    const index = withoutExport.indexOf('=')
    if (index === -1) continue

    const key = withoutExport.slice(0, index).trim()
    let value = withoutExport.slice(index + 1).trim()

    if (!key) continue
    if (Object.hasOwn(process.env, key)) continue

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    process.env[key] = value
  }
}

loadEnvFile(path.join(process.cwd(), '.env'))
loadEnvFile(path.join(process.cwd(), '..', '.env'))
loadEnvFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env'))

if (!process.env.SPOTIFY_CLIENT_ID && process.env.spotify_client_id) {
  process.env.SPOTIFY_CLIENT_ID = process.env.spotify_client_id
}
if (!process.env.SPOTIFY_REDIRECT_URI && process.env.spotify_redirect_uri) {
  process.env.SPOTIFY_REDIRECT_URI = process.env.spotify_redirect_uri
}

const port = Number(process.env.PORT) || 8787

const dataDir = path.join(process.cwd(), 'data')
const rankingsDir = path.join(dataDir, 'rankings')
const spotifyCacheDir = path.join(dataDir, 'spotify_cache')
const REFRESH_WINDOW_MS = 15 * 60 * 1000
const PLAYLISTS_REFRESH_WINDOW_MS = 5 * 60 * 1000
const PUBLIC_PREVIEW_PLAYLIST_ID = '5DBL17LWOZ1Yk87gan9wQq'
const MOCK_DEMO_CACHE_USER_ID = 'mock_demo'
const MOCK_DEMO_DISPLAY_NAME = 'Spotify Rating Demo'
const MOCK_DEMO_AUTH_MODE = 'demo'
const MOCK_DEMO_SCOPE = [
  'user-read-email',
  'user-read-private',
  'playlist-read-private',
  'playlist-read-collaborative',
].join(' ')
const MOCK_DEMO_PLAYLIST_IDS = [
  '4j8kEJ1ifY5t1vsdSOabrW',
  '0Xbg4lYWUfBcr6VFdTD9cO',
  '3cC5l1hBHylTYRXTL2pL3O',
  '4Asx6gqYElg3Y9yXOLyOGH',
  '0skZPa2R7gdmrUHTAo7hYb',
]
const MOCK_DEMO_PLAYLIST_ID_SET = new Set(MOCK_DEMO_PLAYLIST_IDS)
const mockDemoManifestPath = path.join(dataDir, 'mock_demo_cache_manifest.json')
const spotifyRefreshInFlight = new Map()
const ARTIST_IMAGE_MISS_WINDOW_MS = 60 * 1000
const ARTIST_IMAGE_MISS_MAX_PER_WINDOW = 25
const ARTIST_IMAGE_REFRESH_MS = 30 * 24 * 60 * 60 * 1000
const ARTIST_IMAGE_NULL_RETRY_MS = 24 * 60 * 60 * 1000
const artistImageMissesByUser = new Map()
const trackResolveMissesByUser = new Map()
try {
  fs.mkdirSync(rankingsDir, { recursive: true })
  fs.mkdirSync(spotifyCacheDir, { recursive: true })
} catch {
  // ignore
}

function safeFileComponent(value) {
  if (typeof value !== 'string') return 'unknown'
  const cleaned = value.replaceAll(/[^a-zA-Z0-9_-]/g, '_')
  return cleaned || 'unknown'
}

function rankingFilePathForUser(userId) {
  return path.join(rankingsDir, `${safeFileComponent(userId)}.json`)
}

function spotifyCacheFilePathForUserKey(userId, cacheKey) {
  const userDir = path.join(spotifyCacheDir, safeFileComponent(userId))
  try {
    fs.mkdirSync(userDir, { recursive: true })
  } catch {
    // ignore
  }
  return path.join(userDir, `${safeFileComponent(cacheKey)}.json`)
}

function readSpotifyCacheRecord(userId, cacheKey) {
  if (!userId || !cacheKey) return null
  const filePath = spotifyCacheFilePathForUserKey(userId, cacheKey)
  const record = readJsonFile(filePath)
  if (!record || typeof record !== 'object') return null
  if (typeof record.fetchedAt !== 'string') return null
  if (typeof record.lastRefreshedAt !== 'string') return null
  if (record.data == null) return null
  return record
}

function writeSpotifyCacheRecordAtomic(userId, cacheKey, record) {
  if (!userId || !cacheKey) return
  const filePath = spotifyCacheFilePathForUserKey(userId, cacheKey)
  writeJsonFileAtomic(filePath, record)
}

function writeSpotifyCacheDataRecord(userId, cacheKey, data, storedAt = new Date().toISOString()) {
  writeSpotifyCacheRecordAtomic(userId, cacheKey, {
    schemaVersion: 1,
    userId,
    cacheKey,
    fetchedAt: storedAt,
    lastRefreshedAt: storedAt,
    data,
  })
}

function getPersistentSpotifyCacheUserId(userId) {
  if (!isOwnerUser(userId)) return null
  return userId
}

function isDemoUserId(userId) {
  return userId === MOCK_DEMO_CACHE_USER_ID
}

function isDemoSession(cookies) {
  return cookies?.sp_auth_mode === MOCK_DEMO_AUTH_MODE && isDemoUserId(cookies?.sp_user_id)
}

function buildMockDemoProfile() {
  return {
    id: MOCK_DEMO_CACHE_USER_ID,
    display_name: MOCK_DEMO_DISPLAY_NAME,
  }
}

function setDemoSessionCookies(res) {
  setCookie(res, 'sp_auth_mode', MOCK_DEMO_AUTH_MODE, { path: '/', maxAge: 30 * 24 * 60 * 60 })
  setCookie(res, 'sp_scope', MOCK_DEMO_SCOPE, { path: '/', maxAge: 30 * 24 * 60 * 60 })
  setCookie(res, 'sp_user_id', MOCK_DEMO_CACHE_USER_ID, { path: '/', maxAge: 30 * 24 * 60 * 60 })
  setCookie(res, 'sp_user_name', MOCK_DEMO_DISPLAY_NAME, {
    path: '/',
    maxAge: 30 * 24 * 60 * 60,
    httpOnly: false,
  })
}

function readMockDemoManifest() {
  const parsed = readJsonFile(mockDemoManifestPath)
  if (!parsed || typeof parsed !== 'object') {
    return {
      schemaVersion: 1,
      updatedAt: null,
      resources: {},
    }
  }

  return {
    schemaVersion: 1,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    resources: parsed.resources && typeof parsed.resources === 'object' ? parsed.resources : {},
  }
}

function updateMockDemoManifestResource({ kind, id, status, cacheKey = null, note = null, extra = null }) {
  if (!kind || !id) return

  const now = new Date().toISOString()
  const manifest = readMockDemoManifest()
  const resourceKey = `${kind}:${id}`
  const existing = manifest.resources?.[resourceKey]

  manifest.resources[resourceKey] = {
    kind,
    id,
    status,
    cacheKey: typeof cacheKey === 'string' ? cacheKey : existing?.cacheKey ?? null,
    note: typeof note === 'string' ? note : existing?.note ?? null,
    firstObservedAt: typeof existing?.firstObservedAt === 'string' ? existing.firstObservedAt : now,
    lastObservedAt: now,
    observations: Number(existing?.observations) > 0 ? Number(existing.observations) + 1 : 1,
    ...(extra && typeof extra === 'object' ? extra : {}),
  }
  manifest.updatedAt = now
  writeJsonFileAtomic(mockDemoManifestPath, manifest)
}

function syncMockDemoManifestSeedState() {
  const playlistIndexKey = 'me_playlists_all'
  const playlistIndexRecord = readSpotifyCacheRecord(MOCK_DEMO_CACHE_USER_ID, playlistIndexKey)
  updateMockDemoManifestResource({
    kind: 'playlists_index',
    id: 'me',
    status: playlistIndexRecord ? 'cached' : 'needed',
    cacheKey: playlistIndexKey,
    note: playlistIndexRecord
      ? 'Demo playlist index is cached.'
      : 'Demo playlist index still needs to be cached.',
    extra: playlistIndexRecord
      ? { total: Number(playlistIndexRecord?.data?.total) || 0, cachedAt: playlistIndexRecord.fetchedAt }
      : null,
  })

  for (const playlistId of MOCK_DEMO_PLAYLIST_IDS) {
    const cacheKey = `playlist_${playlistId}_tracks_all`
    const record = readSpotifyCacheRecord(MOCK_DEMO_CACHE_USER_ID, cacheKey)
    const itemCount = Array.isArray(record?.data?.items) ? record.data.items.length : 0
    updateMockDemoManifestResource({
      kind: 'playlist_tracks',
      id: playlistId,
      status: record ? 'cached' : 'needed',
      cacheKey,
      note: record
        ? 'Demo playlist tracks are cached.'
        : 'Demo playlist tracks still need to be cached before the full flow works.',
      extra: record
        ? {
            total: Number(record?.data?.total) || itemCount,
            itemCount,
            cachedAt: record.fetchedAt,
          }
        : null,
    })
  }
}

function sendDemoCachePayload(res, { cacheKey, kind, id, missingError, missingMessage, transform }) {
  const record = readSpotifyCacheRecord(MOCK_DEMO_CACHE_USER_ID, cacheKey)
  if (!record) {
    updateMockDemoManifestResource({
      kind,
      id,
      status: 'needed',
      cacheKey,
      note: missingMessage,
    })
    sendJson(res, 503, {
      error: missingError,
      message: missingMessage,
      demoCacheKey: cacheKey,
    })
    return true
  }

  updateMockDemoManifestResource({
    kind,
    id,
    status: 'cached',
    cacheKey,
    note: 'Served from mock demo cache.',
    extra: {
      cachedAt: record.fetchedAt,
      lastRefreshedAt: record.lastRefreshedAt,
      total: Number(record?.data?.total) || null,
      itemCount: Array.isArray(record?.data?.items) ? record.data.items.length : null,
    },
  })
  res.setHeader('x-sp-cache', 'demo_hit')
  res.setHeader('x-sp-cache-fetched-at', record.fetchedAt)
  res.setHeader('x-sp-cache-last-refreshed-at', record.lastRefreshedAt)
  sendJson(res, 200, typeof transform === 'function' ? transform(record) : record.data)
  return true
}

function shouldAttemptSpotifyRefresh({ record, nowMs, refreshWindowMs = REFRESH_WINDOW_MS }) {
  if (!record) return { stale: true, throttled: false, shouldRefresh: true }
  const fetchedAtMs = Date.parse(record.fetchedAt)
  const lastRefreshedAtMs = Date.parse(record.lastRefreshedAt)
  const stale = Number.isFinite(fetchedAtMs) ? nowMs - fetchedAtMs >= refreshWindowMs : true
  const throttled = Number.isFinite(lastRefreshedAtMs)
    ? nowMs - lastRefreshedAtMs < refreshWindowMs
    : false
  return { stale, throttled, shouldRefresh: stale && !throttled }
}

function pushTopNByRank(list, item, maxN) {
  list.push(item)
  list.sort((a, b) => a.rank - b.rank)
  if (list.length > maxN) list.length = maxN
}

function normalizePlaylistTracks(items) {
  const tracks = []
  if (!Array.isArray(items)) return tracks
  let position = 0

  for (const row of items) {
    const entry =
      row?.item && typeof row.item === 'object'
        ? row.item
        : row?.track && typeof row.track === 'object'
          ? row.track
          : null
    if (!entry || typeof entry.id !== 'string' || !entry.id) continue

    position += 1
    const artistsRaw = Array.isArray(entry.artists) ? entry.artists : []
    const artistsDetailed = artistsRaw
      .map((a) => ({
        id: typeof a?.id === 'string' ? a.id : null,
        name: typeof a?.name === 'string' ? a.name : null,
      }))
      .filter((a) => a.name)
    const artists = artistsDetailed.map((a) => a.name)
    const album = typeof entry.album?.name === 'string' ? entry.album.name : null

    tracks.push({
      trackKey: `spid:${entry.id}`,
      id: entry.id,
      name: typeof entry.name === 'string' ? entry.name : null,
      artists,
      artistsDetailed,
      album,
      rank: position,
    })
  }

  return tracks
}

function computeTopArtistsFromPlaylist(tracks, { maxSongsPerArtist = 5, maxArtists = Number.POSITIVE_INFINITY } = {}) {
  const total = tracks.length
  const byArtist = new Map()

  for (const track of tracks) {
    const rank = Number(track?.rank)
    if (!Number.isFinite(rank)) continue
    const points = total - rank + 1
    const artistsDetailed = Array.isArray(track?.artistsDetailed) ? track.artistsDetailed : []
    const artistNames = Array.isArray(track?.artists) ? track.artists.filter(Boolean) : []
    if (!artistNames.length) continue

    for (const artistName of artistNames) {
      const existing = byArtist.get(artistName) || {
        name: artistName,
        artistId: null,
        points: 0,
        totalTracks: 0,
        topTracks: [],
      }
      if (!existing.artistId && artistsDetailed.length) {
        const match = artistsDetailed.find((a) => a?.name === artistName && typeof a?.id === 'string' && a.id)
        if (match?.id) existing.artistId = match.id
      }
      existing.points += points
      existing.totalTracks += 1
      pushTopNByRank(
        existing.topTracks,
        {
          trackKey: typeof track?.trackKey === 'string' ? track.trackKey : null,
          id: typeof track?.id === 'string' ? track.id : null,
          name: typeof track?.name === 'string' ? track.name : null,
          rank,
        },
        maxSongsPerArtist,
      )
      byArtist.set(artistName, existing)
    }
  }

  const scored = Array.from(byArtist.values()).map((artist) => {
    const topTracks = artist.topTracks
    const n = topTracks.length || 0
    const avgRank = n ? topTracks.reduce((sum, t) => sum + t.rank, 0) / n : null
    const adjustedAvgRank = n ? avgRank * (maxSongsPerArtist / n) : null
    return {
      name: artist.name,
      artistId: artist.artistId,
      points: artist.points,
      score: artist.points,
      totalTracks: artist.totalTracks,
      topTracks,
      topSongs: topTracks,
      avgRank,
      adjustedAvgRank,
    }
  })

  scored.sort((a, b) => b.points - a.points || String(a.name).localeCompare(String(b.name)))
  return scored.slice(0, maxArtists).map((artist, idx) => ({ ...artist, rank: idx + 1 }))
}

function computeTopAlbumsFromPlaylist(tracks) {
  const total = tracks.length
  const byAlbum = new Map()

  for (const track of tracks) {
    const rank = Number(track?.rank)
    if (!Number.isFinite(rank)) continue
    const albumName = typeof track?.album === 'string' ? track.album : null
    if (!albumName) continue
    const points = total - rank + 1
    const record = byAlbum.get(albumName) || {
      name: albumName,
      tracks: 0,
      score: 0,
      sumRank: 0,
      bestTrackId: null,
      bestRank: Number.POSITIVE_INFINITY,
    }
    record.tracks += 1
    record.score += points
    record.sumRank += rank
    if (typeof track?.id === 'string' && rank < record.bestRank) {
      record.bestRank = rank
      record.bestTrackId = track.id
    }
    byAlbum.set(albumName, record)
  }

  return Array.from(byAlbum.values())
    .map((album) => ({
      ...album,
      avgRank: album.tracks ? album.sumRank / album.tracks : null,
    }))
    .sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name)))
    .map((album, idx) => ({ ...album, rank: idx + 1 }))
}

function shouldRefreshArtistImageRecord(record, nowMs) {
  const fetchedAtMs = record ? Date.parse(record.fetchedAt) : NaN
  const cachedImageUrl = record?.data?.imageUrl ?? null
  return (
    !record ||
    !Number.isFinite(fetchedAtMs) ||
    nowMs - fetchedAtMs >= ARTIST_IMAGE_REFRESH_MS ||
    (!cachedImageUrl && Number.isFinite(fetchedAtMs) && nowMs - fetchedAtMs >= ARTIST_IMAGE_NULL_RETRY_MS)
  )
}

function extractArtistIdsFromPlaylistPayload(payload) {
  const items = Array.isArray(payload?.items)
    ? payload.items
    : Array.isArray(payload?.tracks?.items)
      ? payload.tracks.items
      : []

  const artistIds = new Set()
  const tracks = normalizePlaylistTracks(items)
  for (const track of tracks) {
    const artistsDetailed = Array.isArray(track?.artistsDetailed) ? track.artistsDetailed : []
    for (const artist of artistsDetailed) {
      if (typeof artist?.id === 'string' && artist.id) artistIds.add(artist.id)
    }
  }

  return Array.from(artistIds)
}

async function fetchSpotifyArtistById({ artistId, accessToken, debugContext }) {
  const apiUrl = `https://api.spotify.com/v1/artists/${encodeURIComponent(artistId)}`

  const response = await spotifyFetch(apiUrl, {
    label: '/v1/artists/:id',
    debugContext,
    headers: { authorization: `Bearer ${accessToken}` },
  })

  let data
  try {
    data = await response.json()
  } catch {
    data = null
  }

  const retryAfterSeconds = getRetryAfterSeconds(response.headers)
  if (!response.ok) {
    logSpotifyFailure({
      label: 'GET /v1/artists/:id',
      url: apiUrl,
      status: response.status,
      retryAfterSeconds,
      requestId: response.headers.get('x-request-id'),
      context: debugContext,
      data,
    })
  }

  return { ok: response.ok, status: response.status, data, retryAfterSeconds }
}

async function primeArtistImageCacheForPlaylist({ cacheUserId, playlistPayload, accessToken, debugContext }) {
  if (!cacheUserId || !accessToken) return

  const artistIds = extractArtistIdsFromPlaylistPayload(playlistPayload)
  if (!artistIds.length) return

  const nowMs = Date.now()
  const idsToRefresh = artistIds.filter((artistId) =>
    shouldRefreshArtistImageRecord(readSpotifyCacheRecord(cacheUserId, `artist_${artistId}_image`), nowMs),
  )
  if (!idsToRefresh.length) return

  const chunkSize = 5
  for (let i = 0; i < idsToRefresh.length; i += chunkSize) {
    const chunk = idsToRefresh.slice(i, i + chunkSize)
    const results = await Promise.all(
      chunk.map((artistId) =>
        fetchSpotifyArtistById({
          artistId,
          accessToken,
          debugContext,
        }),
      ),
    )

    for (const result of results) {
      if (!result.ok) continue
      const artistId = typeof result.data?.id === 'string' ? result.data.id : null
      if (!artistId) continue
      const images = Array.isArray(result.data?.images) ? result.data.images : []
      const imageUrl = typeof images?.[0]?.url === 'string' ? images[0].url : null
      const cacheKey = `artist_${artistId}_image`
      const storedAt = new Date().toISOString()
      writeSpotifyCacheRecordAtomic(cacheUserId, cacheKey, {
        schemaVersion: 1,
        userId: cacheUserId,
        cacheKey,
        fetchedAt: storedAt,
        lastRefreshedAt: storedAt,
        data: { imageUrl },
      })
    }
  }
}

function hasPlaylistItems(record) {
  const items = Array.isArray(record?.data?.items)
    ? record.data.items
    : Array.isArray(record?.data?.tracks?.items)
      ? record.data.tracks.items
      : []
  if (items.length > 0) return true
  const total = Number(record?.data?.total) || Number(record?.data?.tracks?.total) || 0
  return total === 0
}

function hasUsablePlaylistPagePayload(payload) {
  const items = Array.isArray(payload?.items) ? payload.items : null
  const total = Number(payload?.total) || 0
  return Boolean(items) && (total === 0 || items.length > 0)
}

function playlistPageContainsAllIds(payload, playlistIds) {
  const items = Array.isArray(payload?.items) ? payload.items : []
  if (!items.length || !Array.isArray(playlistIds) || !playlistIds.length) return false
  const availableIds = new Set(items.map((item) => (typeof item?.id === 'string' ? item.id : null)).filter(Boolean))
  return playlistIds.every((playlistId) => availableIds.has(playlistId))
}

function filterPlaylistPageByIds(payload, allowedIds) {
  if (!allowedIds || typeof allowedIds.has !== 'function') return null
  const items = Array.isArray(payload?.items) ? payload.items.filter((item) => allowedIds.has(item?.id)) : []
  return {
    href: typeof payload?.href === 'string' ? payload.href : null,
    limit: Math.max(items.length || 0, Number(payload?.limit) || 0, 1),
    next: null,
    offset: 0,
    previous: null,
    total: items.length,
    items,
  }
}

async function fetchPlaylistTracksAll({ playlistId, accessToken, debugContext }) {
  const limit = 50

  const callPage = async ({ offset }) => {
    const apiUrl = new URL(`https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/items`)
    apiUrl.searchParams.set('limit', String(limit))
    apiUrl.searchParams.set('offset', String(offset))
    apiUrl.searchParams.set('market', 'from_token')
    apiUrl.searchParams.set('additional_types', 'track')
    apiUrl.searchParams.set(
      'fields',
      [
        'href',
        'limit',
        'next',
        'offset',
        'previous',
        'total',
        'items(' +
          [
            'added_at',
            'item(' +
              [
                'type',
                'id',
                'name',
                'duration_ms',
                'explicit',
                'external_urls(spotify)',
                'artists(id,name)',
                'album(id,name,total_tracks)',
              ].join(',') +
            ')',
          ].join(',') +
        ')',
      ].join(','),
    )

    const response = await spotifyFetch(apiUrl.toString(), {
      label: '/v1/playlists/:id/items',
      debugContext,
      headers: { authorization: `Bearer ${accessToken}` },
    })

    let data
    try {
      data = await response.json()
    } catch {
      data = null
    }

    const retryAfterSeconds = getRetryAfterSeconds(response.headers)
    if (!response.ok) {
      logSpotifyFailure({
        label: 'GET /v1/playlists/:id/items',
        url: apiUrl.toString(),
        status: response.status,
        retryAfterSeconds,
        requestId: response.headers.get('x-request-id'),
        context: debugContext,
        data,
      })
    }

    return { ok: response.ok, status: response.status, data, retryAfterSeconds }
  }

  const first = await callPage({ offset: 0 })
  if (!first.ok) return first

  const firstTracks = first.data?.tracks && typeof first.data.tracks === 'object' ? first.data.tracks : first.data
  const items = Array.isArray(firstTracks?.items) ? firstTracks.items.slice() : []
  const total = Number(firstTracks?.total) || items.length
  let nextOffset = items.length
  const maxPages = 50
  let pagesFetched = 1

  while (nextOffset < total) {
    if (pagesFetched >= maxPages) break
    const page = await callPage({ offset: nextOffset })
    if (!page.ok) return { ...page, partial: { items, total, nextOffset } }
    const pageTracks = page.data?.tracks && typeof page.data.tracks === 'object' ? page.data.tracks : page.data
    const pageItems = Array.isArray(pageTracks?.items) ? pageTracks.items : []
    items.push(...pageItems)
    if (pageItems.length === 0) break
    nextOffset += pageItems.length
    pagesFetched += 1
  }

  return { ok: true, status: 200, data: { items, offset: 0, limit, total } }
}

async function fetchCurrentUserPlaylistsAll({ accessToken, debugContext }) {
  const limit = 50

  const callPage = async ({ offset }) => {
    const apiUrl = new URL('https://api.spotify.com/v1/me/playlists')
    apiUrl.searchParams.set('limit', String(limit))
    apiUrl.searchParams.set('offset', String(offset))

    const response = await spotifyFetch(apiUrl.toString(), {
      label: '/v1/me/playlists',
      debugContext,
      headers: { authorization: `Bearer ${accessToken}` },
    })

    let data
    try {
      data = await response.json()
    } catch {
      data = null
    }

    const retryAfterSeconds = getRetryAfterSeconds(response.headers)
    if (!response.ok) {
      logSpotifyFailure({
        label: 'GET /v1/me/playlists',
        url: apiUrl.toString(),
        status: response.status,
        retryAfterSeconds,
        requestId: response.headers.get('x-request-id'),
        context: debugContext,
        data,
      })
    }

    return { ok: response.ok, status: response.status, data, retryAfterSeconds }
  }

  const first = await callPage({ offset: 0 })
  if (!first.ok) return first

  const items = Array.isArray(first.data?.items) ? first.data.items.slice() : []
  const total = Number(first.data?.total) || items.length
  let nextOffset = items.length
  const maxPages = 50
  let pagesFetched = 1

  while (nextOffset < total) {
    if (pagesFetched >= maxPages) break
    const page = await callPage({ offset: nextOffset })
    if (!page.ok) return { ...page, partial: { items, total, nextOffset } }
    const pageItems = Array.isArray(page.data?.items) ? page.data.items : []
    items.push(...pageItems)
    if (pageItems.length === 0) break
    nextOffset += pageItems.length
    pagesFetched += 1
  }

  return {
    ok: true,
    status: 200,
    data: {
      href: typeof first.data?.href === 'string' ? first.data.href : null,
      items,
      limit,
      next: null,
      offset: 0,
      previous: null,
      total,
    },
  }
}

async function seedMockDemoPlaylistCache({ sourceUserId, accessToken, debugContext }) {
  if (!sourceUserId || !accessToken || !isOwnerUser(sourceUserId)) return

  let playlistPayload = readSpotifyCacheRecord(sourceUserId, 'me_playlists_all')?.data ?? null
  if (!hasUsablePlaylistPagePayload(playlistPayload) || !playlistPageContainsAllIds(playlistPayload, MOCK_DEMO_PLAYLIST_IDS)) {
    const fetchedPlaylists = await fetchCurrentUserPlaylistsAll({ accessToken, debugContext })
    if (!fetchedPlaylists.ok || !hasUsablePlaylistPagePayload(fetchedPlaylists.data)) return
    playlistPayload = fetchedPlaylists.data
    writeSpotifyCacheDataRecord(sourceUserId, 'me_playlists_all', playlistPayload)
  }

  const demoPlaylistsPayload = filterPlaylistPageByIds(playlistPayload, MOCK_DEMO_PLAYLIST_ID_SET)
  if (!Array.isArray(demoPlaylistsPayload?.items) || demoPlaylistsPayload.items.length === 0) return
  const storedAt = new Date().toISOString()
  writeSpotifyCacheDataRecord(MOCK_DEMO_CACHE_USER_ID, 'me_playlists_all', demoPlaylistsPayload, storedAt)
  updateMockDemoManifestResource({
    kind: 'playlists_index',
    id: 'me',
    status: 'cached',
    cacheKey: 'me_playlists_all',
    note: 'Demo playlist index refreshed from owner login.',
    extra: {
      total: Number(demoPlaylistsPayload?.total) || (Array.isArray(demoPlaylistsPayload?.items) ? demoPlaylistsPayload.items.length : 0),
      cachedAt: storedAt,
    },
  })

  const playlistMetaById = new Map(
    (demoPlaylistsPayload.items || [])
      .filter(Boolean)
      .map((playlist) => [playlist.id, playlist]),
  )

  for (const playlistId of MOCK_DEMO_PLAYLIST_IDS) {
    const cacheKey = `playlist_${playlistId}_tracks_all`
    const fetchedTracks = await fetchPlaylistTracksAll({
      playlistId,
      accessToken,
      debugContext,
    })
    const playlistName =
      typeof playlistMetaById.get(playlistId)?.name === 'string'
        ? playlistMetaById.get(playlistId).name
        : null

    if (!fetchedTracks.ok || !hasPlaylistItems({ data: fetchedTracks.data })) {
      updateMockDemoManifestResource({
        kind: 'playlist_tracks',
        id: playlistId,
        status: 'needed',
        cacheKey,
        note: 'Owner login attempted to refresh demo playlist tracks, but the full payload was not cached.',
        extra: {
          playlistName,
          retryAfterSeconds: Number(fetchedTracks?.retryAfterSeconds) || null,
          lastStatus: Number(fetchedTracks?.status) || null,
        },
      })
      continue
    }

    const playlistTracksPayload = fetchedTracks.data
    const playlistStoredAt = new Date().toISOString()
    writeSpotifyCacheDataRecord(sourceUserId, cacheKey, playlistTracksPayload, playlistStoredAt)
    writeSpotifyCacheDataRecord(MOCK_DEMO_CACHE_USER_ID, cacheKey, playlistTracksPayload, playlistStoredAt)
    updateMockDemoManifestResource({
      kind: 'playlist_tracks',
      id: playlistId,
      status: 'cached',
      cacheKey,
      note: 'Demo playlist tracks refreshed from owner login.',
      extra: {
        playlistName,
        total: Number(playlistTracksPayload?.total) || 0,
        itemCount: Array.isArray(playlistTracksPayload?.items) ? playlistTracksPayload.items.length : 0,
        cachedAt: playlistStoredAt,
      },
    })
  }
}

async function fetchAlbumTracksAll({ albumId, accessToken, debugContext }) {
  const limit = 50

  const callPage = async ({ offset }) => {
    const apiUrl = new URL(`https://api.spotify.com/v1/albums/${encodeURIComponent(albumId)}/tracks`)
    apiUrl.searchParams.set('limit', String(limit))
    apiUrl.searchParams.set('offset', String(offset))
    apiUrl.searchParams.set('market', 'from_token')
    apiUrl.searchParams.set(
      'fields',
      [
        'href',
        'limit',
        'next',
        'offset',
        'previous',
        'total',
        'items(' +
          [
            'id',
            'name',
            'duration_ms',
            'explicit',
            'track_number',
            'disc_number',
            'external_urls(spotify)',
            'artists(id,name)',
          ].join(',') +
        ')',
      ].join(','),
    )

    const response = await spotifyFetch(apiUrl.toString(), {
      label: '/v1/albums/:id/tracks',
      debugContext,
      headers: { authorization: `Bearer ${accessToken}` },
    })

    let data
    try {
      data = await response.json()
    } catch {
      data = null
    }

    const retryAfterSeconds = getRetryAfterSeconds(response.headers)
    if (!response.ok) {
      logSpotifyFailure({
        label: 'GET /v1/albums/:id/tracks',
        url: apiUrl.toString(),
        status: response.status,
        retryAfterSeconds,
        requestId: response.headers.get('x-request-id'),
        context: debugContext,
        data,
      })
    }

    return { ok: response.ok, status: response.status, data, retryAfterSeconds }
  }

  const first = await callPage({ offset: 0 })
  if (!first.ok) return first

  const items = Array.isArray(first.data?.items) ? first.data.items.slice() : []
  const total = Number(first.data?.total) || items.length
  let nextOffset = items.length
  const maxPages = 20
  let pagesFetched = 1

  while (nextOffset < total) {
    if (pagesFetched >= maxPages) break
    const page = await callPage({ offset: nextOffset })
    if (!page.ok) return { ...page, partial: { items, total, nextOffset } }
    const pageItems = Array.isArray(page.data?.items) ? page.data.items : []
    items.push(...pageItems)
    if (pageItems.length === 0) break
    nextOffset += pageItems.length
    pagesFetched += 1
  }

  return { ok: true, status: 200, data: { items, offset: 0, limit, total, albumId } }
}

function readJsonFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function writeJsonFileAtomic(filePath, value) {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tmpPath, filePath)
}

function readBody(req, { maxBytes = 1_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    let bytes = 0
    /** @type {Buffer[]} */
    const chunks = []

    req.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > maxBytes) {
        const error = new Error('payload_too_large')
        error.statusCode = 413
        reject(error)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', reject)
  })
}

async function readJsonBody(req, options = {}) {
  const raw = await readBody(req, options)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    const error = new Error('invalid_json')
    error.statusCode = 400
    throw error
  }
}

function parseCookies(cookieHeader) {
  if (!cookieHeader) return {}
  const pairs = cookieHeader.split(';')
  const cookies = {}
  for (const pair of pairs) {
    const index = pair.indexOf('=')
    if (index === -1) continue
    const key = pair.slice(0, index).trim()
    const value = pair.slice(index + 1).trim()
    cookies[key] = decodeURIComponent(value)
  }
  return cookies
}

function setCookie(res, name, value, options = {}) {
  const {
    httpOnly = true,
    sameSite = 'Lax',
    path = '/',
    maxAge,
    secure = false,
  } = options

  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `SameSite=${sameSite}`]
  if (httpOnly) parts.push('HttpOnly')
  if (secure) parts.push('Secure')
  if (typeof maxAge === 'number') parts.push(`Max-Age=${Math.floor(maxAge)}`)

  const existing = res.getHeader('set-cookie')
  const next = Array.isArray(existing) ? existing.concat(parts.join('; ')) : [parts.join('; ')]
  res.setHeader('set-cookie', next)
}

function clearCookie(res, name, options = {}) {
  setCookie(res, name, '', { ...options, maxAge: 0 })
}

function clearSpotifyAuthCookies(res) {
  clearCookie(res, 'sp_auth_mode', { path: '/' })
  clearCookie(res, 'sp_access', { path: '/' })
  clearCookie(res, 'sp_refresh', { path: '/' })
  clearCookie(res, 'sp_scope', { path: '/' })
  clearCookie(res, 'sp_user_id', { path: '/' })
  clearCookie(res, 'sp_user_name', { path: '/' })
}

function sendJson(res, statusCode, body) {
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

function getRetryAfterSeconds(headers) {
  const raw = headers?.get?.('retry-after')
  if (!raw) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

function sendPartialJson(res, body) {
  sendJson(res, 206, body)
}

function logSpotifyFailure({ label, url, status, retryAfterSeconds, requestId, context, data }) {
  const summary = {
    label,
    status,
    url,
    retryAfterSeconds: retryAfterSeconds ?? null,
    requestId: requestId ?? null,
    context: context ?? null,
    error: data?.error ?? data ?? null,
  }
  console.error('[spotify] request failed', JSON.stringify(summary, null, 2))
}

function logSpotifyRequest({ label, method = 'GET', status, ok, durationMs, retryAfterSeconds, context, error }) {
  const parts = [
    '[spotify]',
    ok ? 'ok' : 'fail',
    method,
    label,
    String(status),
    `${Math.max(0, Math.round(durationMs || 0))}ms`,
  ]
  if (typeof context?.userId === 'string' && context.userId) parts.push(`user=${context.userId}`)
  if (Number.isFinite(retryAfterSeconds)) parts.push(`retryAfter=${retryAfterSeconds}s`)
  if (!ok) {
    const message =
      typeof error?.message === 'string'
        ? error.message
        : typeof error?.error_description === 'string'
          ? error.error_description
          : typeof error?.error === 'string'
            ? error.error
            : null
    if (message) parts.push(`message=${JSON.stringify(message)}`)
  }
  console.log(parts.join(' '))
}

function redirectWithAuthError(res, code, status) {
  const location = new URL('http://localhost/')
  location.searchParams.set('auth_error', code)
  if (Number.isFinite(status)) location.searchParams.set('auth_status', String(status))
  res.statusCode = 302
  res.setHeader('location', `${location.pathname}${location.search}`)
  res.end()
}

async function spotifyFetch(url, { label, debugContext, method = 'GET', ...options } = {}) {
  const startedAt = Date.now()
  try {
    const response = await fetch(url, {
      method,
      ...options,
    })
    if (response.ok) {
      logSpotifyRequest({
        label,
        method,
        status: response.status,
        ok: response.ok,
        durationMs: Date.now() - startedAt,
        retryAfterSeconds: getRetryAfterSeconds(response.headers),
        context: debugContext,
      })
    }
    return response
  } catch (error) {
    logSpotifyRequest({
      label,
      method,
      status: 0,
      ok: false,
      durationMs: Date.now() - startedAt,
      context: debugContext,
      error,
    })
    throw error
  }
}

async function spotifyMe({ accessToken }) {
  const response = await spotifyFetch('https://api.spotify.com/v1/me', {
    label: '/v1/me',
    debugContext: null,
    headers: { authorization: `Bearer ${accessToken}` },
  })

  let data
  try {
    data = await response.json()
  } catch {
    data = null
  }

  const retryAfterSeconds = getRetryAfterSeconds(response.headers)
  const requestId = response.headers.get('x-request-id')
  if (!response.ok) {
    logSpotifyFailure({
      label: 'GET /v1/me (callback)',
      url: 'https://api.spotify.com/v1/me',
      status: response.status,
      retryAfterSeconds,
      requestId,
      context: null,
      data,
    })
  }

  return { ok: response.ok, status: response.status, data, retryAfterSeconds, requestId }
}

function base64Url(buffer) {
  return buffer
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}

function generateVerifier() {
  return base64Url(crypto.randomBytes(64))
}

function challengeFromVerifier(verifier) {
  const hashed = crypto.createHash('sha256').update(verifier).digest()
  return base64Url(hashed)
}

async function spotifyTokenExchange({ code, codeVerifier, redirectUri, clientId }) {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  })

  const response = await spotifyFetch('https://accounts.spotify.com/api/token', {
    label: '/api/token auth_code',
    method: 'POST',
    debugContext: null,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: params,
  })

  const data = await response.json()
  if (!response.ok) {
    logSpotifyFailure({
      label: 'POST /api/token (auth_code)',
      url: 'https://accounts.spotify.com/api/token',
      status: response.status,
      retryAfterSeconds: getRetryAfterSeconds(response.headers),
      requestId: response.headers.get('x-request-id'),
      context: null,
      data,
    })
    const message = typeof data?.error_description === 'string' ? data.error_description : 'token_exchange_failed'
    const error = new Error(message)
    error.statusCode = response.status
    error.data = data
    throw error
  }

  return data
}

async function spotifyRefresh({ refreshToken, clientId }) {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken,
  })

  const response = await spotifyFetch('https://accounts.spotify.com/api/token', {
    label: '/api/token refresh',
    method: 'POST',
    debugContext: null,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: params,
  })

  const data = await response.json()
  if (!response.ok) {
    logSpotifyFailure({
      label: 'POST /api/token (refresh)',
      url: 'https://accounts.spotify.com/api/token',
      status: response.status,
      retryAfterSeconds: getRetryAfterSeconds(response.headers),
      requestId: response.headers.get('x-request-id'),
      context: null,
      data,
    })
    const message = typeof data?.error_description === 'string' ? data.error_description : 'refresh_failed'
    const error = new Error(message)
    error.statusCode = response.status
    error.data = data
    throw error
  }

  return data
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const cookies = parseCookies(req.headers.cookie)
  const debugContext = {
    userId: typeof cookies.sp_user_id === 'string' ? cookies.sp_user_id : null,
    scopes: typeof cookies.sp_scope === 'string' ? cookies.sp_scope : null,
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    res.statusCode = 200
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ ok: true }))
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/public/preview') {
    ;(async () => {
      const clientId = process.env.SPOTIFY_CLIENT_ID
      const accessToken = cookies.sp_access
      const refreshToken = cookies.sp_refresh
      const cacheUserId = 'public_preview'
      const cacheKey = `playlist_${PUBLIC_PREVIEW_PLAYLIST_ID}_tracks_all`
      let cachedRecord = readSpotifyCacheRecord(cacheUserId, cacheKey)
      const cachedHasItems = cachedRecord ? hasPlaylistItems(cachedRecord) : false
      if (cachedRecord && !cachedHasItems) cachedRecord = null

      const buildPreviewPayload = (record) => {
        const items = Array.isArray(record?.data?.items)
          ? record.data.items
          : Array.isArray(record?.data?.tracks?.items)
            ? record.data.tracks.items
            : []
        const tracks = normalizePlaylistTracks(items)
        const topSongs = tracks
        const topArtists = computeTopArtistsFromPlaylist(tracks, {
          maxSongsPerArtist: 5,
          maxArtists: Number.POSITIVE_INFINITY,
        }).map((artist) => {
          const imageUrl =
            typeof artist?.artistId === 'string' && artist.artistId
              ? (readSpotifyCacheRecord(cacheUserId, `artist_${artist.artistId}_image`)?.data?.imageUrl ?? null)
              : null
          return { ...artist, imageUrl }
        })
        const topAlbums = computeTopAlbumsFromPlaylist(tracks)

        return {
          ok: true,
          source: 'spotify_playlist',
          playlistId: PUBLIC_PREVIEW_PLAYLIST_ID,
          updatedAt: typeof record?.fetchedAt === 'string' ? record.fetchedAt : new Date().toISOString(),
          topSongs,
          topArtists,
          topAlbums,
        }
      }

      if (cachedRecord) {
        res.setHeader('x-sp-cache', 'hit_permanent')
        res.setHeader('x-sp-cache-fetched-at', cachedRecord.fetchedAt)
        res.setHeader('x-sp-cache-last-refreshed-at', cachedRecord.lastRefreshedAt)
        sendJson(res, 200, buildPreviewPayload(cachedRecord))
        return
      }

      let currentAccessToken = accessToken

      if (!currentAccessToken && refreshToken && clientId) {
        try {
          const refreshed = await spotifyRefresh({ refreshToken, clientId })
          if (typeof refreshed.access_token === 'string') {
            currentAccessToken = refreshed.access_token
            setCookie(res, 'sp_access', refreshed.access_token, { path: '/', maxAge: Math.max(0, (Number(refreshed.expires_in) || 3600) - 30) })
          }
        } catch {
          // ignore refresh failure; fall back to cache or empty state.
        }
      }

      if (!currentAccessToken) {
        if (cachedRecord) {
          res.setHeader('x-sp-cache', 'hit_stale_no_token')
          res.setHeader('x-sp-cache-fetched-at', cachedRecord.fetchedAt)
          res.setHeader('x-sp-cache-last-refreshed-at', cachedRecord.lastRefreshedAt)
          sendJson(res, 200, buildPreviewPayload(cachedRecord))
          return
        }
        sendJson(res, 503, { error: 'preview_unavailable' })
        return
      }

      const lockKey = `${cacheUserId}:${cacheKey}`
      let lockTaken = false

      if (spotifyRefreshInFlight.has(lockKey)) {
        sendJson(res, 429, { error: 'inflight', retryAfterSeconds: 1 })
        return
      }

      spotifyRefreshInFlight.set(lockKey, true)
      lockTaken = true

      try {
        let result = await fetchPlaylistTracksAll({
          playlistId: PUBLIC_PREVIEW_PLAYLIST_ID,
          accessToken: currentAccessToken,
          debugContext,
        })

        if (!result.ok && result.status === 401 && refreshToken && clientId) {
          const refreshed = await spotifyRefresh({ refreshToken, clientId })
          if (typeof refreshed.access_token === 'string') {
            setCookie(res, 'sp_access', refreshed.access_token, { path: '/', maxAge: Math.max(0, (Number(refreshed.expires_in) || 3600) - 30) })
            currentAccessToken = refreshed.access_token
            result = await fetchPlaylistTracksAll({
              playlistId: PUBLIC_PREVIEW_PLAYLIST_ID,
              accessToken: currentAccessToken,
              debugContext,
            })
          }
        }

        if (!result.ok) {
          sendJson(res, result.status || 500, { error: 'preview_unavailable', details: result.data, retryAfterSeconds: result.retryAfterSeconds })
          return
        }

        const storedAt = new Date().toISOString()
        const payload = result.data
        await primeArtistImageCacheForPlaylist({
          cacheUserId,
          playlistPayload: payload,
          accessToken: currentAccessToken,
          debugContext,
        })
        writeSpotifyCacheRecordAtomic(cacheUserId, cacheKey, {
          schemaVersion: 1,
          userId: cacheUserId,
          cacheKey,
          fetchedAt: storedAt,
          lastRefreshedAt: storedAt,
          data: payload,
        })

        res.setHeader('x-sp-cache', cachedRecord ? 'refreshed' : 'miss_refreshed')
        res.setHeader('x-sp-cache-fetched-at', storedAt)
        res.setHeader('x-sp-cache-last-refreshed-at', storedAt)
        sendJson(
          res,
          200,
          buildPreviewPayload({
            fetchedAt: storedAt,
            lastRefreshedAt: storedAt,
            data: payload,
          }),
        )
      } catch (error) {
        sendJson(res, 500, { error: 'preview_unavailable', message: error?.message })
      } finally {
        if (lockTaken) spotifyRefreshInFlight.delete(lockKey)
      }
    })()
    return
  }

  if (req.method === 'GET' && url.pathname === '/auth/login') {
    const clientId = process.env.SPOTIFY_CLIENT_ID
    const redirectUri = process.env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:5173/auth/callback'

    if (!clientId) {
      sendJson(res, 500, { error: 'missing_env', missing: ['SPOTIFY_CLIENT_ID'] })
      return
    }

    const state = base64Url(crypto.randomBytes(16))
    const verifier = generateVerifier()
    const challenge = challengeFromVerifier(verifier)

    setCookie(res, 'sp_state', state, { path: '/', maxAge: 10 * 60 })
    setCookie(res, 'sp_verifier', verifier, { path: '/', maxAge: 10 * 60 })

    const scopes = [
      'user-read-email',
      'user-read-private',
      'playlist-read-private',
      'playlist-read-collaborative',
    ].join(' ')

    const authUrl = new URL('https://accounts.spotify.com/authorize')
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('client_id', clientId)
    authUrl.searchParams.set('redirect_uri', redirectUri)
    authUrl.searchParams.set('state', state)
    authUrl.searchParams.set('code_challenge_method', 'S256')
    authUrl.searchParams.set('code_challenge', challenge)
    authUrl.searchParams.set('scope', scopes)
    authUrl.searchParams.set('show_dialog', 'true')

    res.statusCode = 302
    res.setHeader('location', authUrl.toString())
    res.end()
    return
  }

  if (req.method === 'GET' && url.pathname === '/auth/demo') {
    syncMockDemoManifestSeedState()
    setDemoSessionCookies(res)
    res.statusCode = 302
    res.setHeader('location', '/')
    res.end()
    return
  }

  if (req.method === 'GET' && url.pathname === '/auth/callback') {
    const clientId = process.env.SPOTIFY_CLIENT_ID
    const redirectUri = process.env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:5173/auth/callback'

    if (!clientId) {
      sendJson(res, 500, { error: 'missing_env', missing: ['SPOTIFY_CLIENT_ID'] })
      return
    }

    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    const storedState = cookies.sp_state
    const verifier = cookies.sp_verifier

    if (!code || !state) {
      sendJson(res, 400, { error: 'missing_query', required: ['code', 'state'] })
      return
    }
    if (!storedState || !verifier) {
      sendJson(res, 400, { error: 'missing_cookie', required: ['sp_state', 'sp_verifier'] })
      return
    }
    if (state !== storedState) {
      sendJson(res, 400, { error: 'state_mismatch' })
      return
    }

    clearCookie(res, 'sp_state', { path: '/' })
    clearCookie(res, 'sp_verifier', { path: '/' })

    ;(async () => {
      try {
        const token = await spotifyTokenExchange({ code, codeVerifier: verifier, redirectUri, clientId })

        const accessToken = token.access_token
        const refreshToken = token.refresh_token
        const expiresIn = token.expires_in
        const scope = token.scope

        let me = null
        if (typeof accessToken === 'string') {
          me = await spotifyMe({ accessToken })
        }

        if (me && !me.ok) {
          clearSpotifyAuthCookies(res)
          if (me.status === 403) {
            redirectWithAuthError(res, 'spotify_profile_forbidden', me.status)
            return
          }
          const message =
            typeof me.data?.error?.message === 'string'
              ? me.data.error.message
              : typeof me.data?.error_description === 'string'
                ? me.data.error_description
                : 'spotify_profile_failed'
          const error = new Error(message)
          error.statusCode = me.status || 500
          error.data = me.data
          throw error
        }

        if (typeof accessToken === 'string') {
          setCookie(res, 'sp_access', accessToken, { path: '/', maxAge: Math.max(0, (Number(expiresIn) || 3600) - 30) })
        }
        if (typeof refreshToken === 'string') {
          setCookie(res, 'sp_refresh', refreshToken, { path: '/', maxAge: 30 * 24 * 60 * 60 })
        }
        if (typeof scope === 'string') {
          setCookie(res, 'sp_scope', scope, { path: '/', maxAge: 30 * 24 * 60 * 60 })
        }
        setCookie(res, 'sp_auth_mode', 'spotify', { path: '/', maxAge: 30 * 24 * 60 * 60 })
        if (me?.data && typeof me.data === 'object') {
          if (typeof me.data.id === 'string') setCookie(res, 'sp_user_id', me.data.id, { path: '/', maxAge: 30 * 24 * 60 * 60 })
          if (typeof me.data.display_name === 'string') setCookie(res, 'sp_user_name', me.data.display_name, { path: '/', maxAge: 30 * 24 * 60 * 60, httpOnly: false })
        }

        if (typeof accessToken === 'string') {
          try {
            if (typeof me?.data?.id === 'string' && me.data.id) {
              await seedMockDemoPlaylistCache({
                sourceUserId: me.data.id,
                accessToken,
                debugContext,
              })
            }

            const cacheUserId = 'public_preview'
            const cacheKey = `playlist_${PUBLIC_PREVIEW_PLAYLIST_ID}_tracks_all`
            let previewPayload = readSpotifyCacheRecord(cacheUserId, cacheKey)?.data ?? null
            if (!previewPayload || !hasPlaylistItems({ data: previewPayload })) {
              const fetched = await fetchPlaylistTracksAll({
                playlistId: PUBLIC_PREVIEW_PLAYLIST_ID,
                accessToken,
                debugContext,
              })
              if (fetched.ok) {
                const storedAt = new Date().toISOString()
                previewPayload = fetched.data
                writeSpotifyCacheRecordAtomic(cacheUserId, cacheKey, {
                  schemaVersion: 1,
                  userId: cacheUserId,
                  cacheKey,
                  fetchedAt: storedAt,
                  lastRefreshedAt: storedAt,
                  data: previewPayload,
                })
              }
            }

            if (previewPayload) {
              await primeArtistImageCacheForPlaylist({
                cacheUserId,
                playlistPayload: previewPayload,
                accessToken,
                debugContext,
              })
            }
          } catch {
            // ignore preview prime failures
          }
        }

        res.statusCode = 302
        res.setHeader('location', '/')
        res.end()
      } catch (error) {
        clearSpotifyAuthCookies(res)
        sendJson(res, Number(error?.statusCode) || 500, { error: 'spotify_callback_failed', message: error?.message })
      }
    })()

    return
  }

  if (req.method === 'POST' && url.pathname === '/auth/logout') {
    clearSpotifyAuthCookies(res)
    sendJson(res, 200, { ok: true })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/session') {
    const demoSession = isDemoSession(cookies)
    const hasAccess = typeof cookies.sp_access === 'string' && cookies.sp_access.length > 0
    const hasRefresh = typeof cookies.sp_refresh === 'string' && cookies.sp_refresh.length > 0
    const loggedIn = demoSession || hasAccess || hasRefresh
    const scopes = typeof cookies.sp_scope === 'string' ? cookies.sp_scope.split(' ').filter(Boolean) : []
    const user = demoSession
      ? buildMockDemoProfile()
      : typeof cookies.sp_user_id === 'string'
        ? { id: cookies.sp_user_id, display_name: cookies.sp_user_name || null }
        : null
    const owner = isOwnerUser(user?.id)
    sendJson(res, 200, { loggedIn, scopes, user, isOwnerUser: owner })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/ranking') {
    const userId = typeof cookies.sp_user_id === 'string' ? cookies.sp_user_id : null
    const demoSession = isDemoSession(cookies)
    const hasAccess = typeof cookies.sp_access === 'string' && cookies.sp_access.length > 0
    const hasRefresh = typeof cookies.sp_refresh === 'string' && cookies.sp_refresh.length > 0
    const loggedIn = demoSession || hasAccess || hasRefresh

    if (!loggedIn || !userId) {
      sendJson(res, 401, { error: 'not_logged_in' })
      return
    }

    const filePath = rankingFilePathForUser(userId)
    const ranking = readJsonFile(filePath)
    if (!ranking) {
      sendJson(res, 200, { ok: true, exists: false, ranking: null })
      return
    }

    sendJson(res, 200, { ok: true, exists: true, ranking })
    return
  }

  if (req.method === 'PUT' && url.pathname === '/api/ranking') {
    const userId = typeof cookies.sp_user_id === 'string' ? cookies.sp_user_id : null
    const demoSession = isDemoSession(cookies)
    const hasAccess = typeof cookies.sp_access === 'string' && cookies.sp_access.length > 0
    const hasRefresh = typeof cookies.sp_refresh === 'string' && cookies.sp_refresh.length > 0
    const loggedIn = demoSession || hasAccess || hasRefresh

    if (!loggedIn || !userId) {
      sendJson(res, 401, { error: 'not_logged_in' })
      return
    }

    ;(async () => {
      try {
        const body = await readJsonBody(req, { maxBytes: 2_000_000 })
        if (!body || typeof body !== 'object') {
          sendJson(res, 400, { error: 'invalid_body', message: 'Expected JSON object.' })
          return
        }

        if (Object.hasOwn(body, 'userId') && body.userId !== userId) {
          sendJson(res, 400, { error: 'user_mismatch' })
          return
        }

        const savedAt = new Date().toISOString()
        const toStore = { ...body, userId, serverSavedAt: savedAt }

        const filePath = rankingFilePathForUser(userId)
        writeJsonFileAtomic(filePath, toStore)
        sendJson(res, 200, { ok: true, savedAt })
      } catch (error) {
        sendJson(res, Number(error?.statusCode) || 500, { error: 'ranking_save_failed', message: error?.message })
      }
    })()

    return
  }

  if (req.method === 'GET' && url.pathname === '/api/me') {
    if (isDemoSession(cookies)) {
      sendJson(res, 200, buildMockDemoProfile())
      return
    }

    const clientId = process.env.SPOTIFY_CLIENT_ID
    const accessToken = cookies.sp_access
    const refreshToken = cookies.sp_refresh

    if (!clientId) {
      sendJson(res, 500, { error: 'missing_env', missing: ['SPOTIFY_CLIENT_ID'] })
      return
    }
    if (!accessToken) {
      sendJson(res, 401, { error: 'not_logged_in' })
      return
    }

    ;(async () => {
      const callMe = async (token) => {
        const response = await spotifyFetch('https://api.spotify.com/v1/me', {
          label: '/v1/me',
          debugContext,
          headers: { authorization: `Bearer ${token}` },
        })
        const data = await response.json()
        const retryAfterSeconds = getRetryAfterSeconds(response.headers)
        if (!response.ok) {
          logSpotifyFailure({
            label: 'GET /v1/me',
            url: 'https://api.spotify.com/v1/me',
            status: response.status,
            retryAfterSeconds,
            requestId: response.headers.get('x-request-id'),
            context: debugContext,
            data,
          })
        }
        return { ok: response.ok, status: response.status, data, retryAfterSeconds }
      }

      try {
        let result = await callMe(accessToken)

        if (!result.ok && result.status === 401 && refreshToken) {
          const refreshed = await spotifyRefresh({ refreshToken, clientId })
          if (typeof refreshed.access_token === 'string') {
            setCookie(res, 'sp_access', refreshed.access_token, { path: '/', maxAge: Math.max(0, (Number(refreshed.expires_in) || 3600) - 30) })
            result = await callMe(refreshed.access_token)
          }
        }

        if (!result.ok) {
          sendJson(res, result.status, { error: 'spotify_me_failed', details: result.data, retryAfterSeconds: result.retryAfterSeconds })
          return
        }

        sendJson(res, 200, result.data)
      } catch (error) {
        sendJson(res, 500, { error: 'spotify_me_failed', message: error?.message })
      }
    })()

    return
  }

  if (req.method === 'GET' && url.pathname === '/api/me/playlists') {
    if (isDemoSession(cookies)) {
      sendDemoCachePayload(res, {
        cacheKey: 'me_playlists_all',
        kind: 'playlists_index',
        id: 'me',
        missingError: 'demo_playlists_unavailable',
        missingMessage: 'The demo playlist list is not cached yet.',
      })
      return
    }

    const clientId = process.env.SPOTIFY_CLIENT_ID
    const accessToken = cookies.sp_access
    const refreshToken = cookies.sp_refresh
    const userId = typeof cookies.sp_user_id === 'string' ? cookies.sp_user_id : null

    if (!clientId) {
      sendJson(res, 500, { error: 'missing_env', missing: ['SPOTIFY_CLIENT_ID'] })
      return
    }
    if (!accessToken) {
      sendJson(res, 401, { error: 'not_logged_in' })
      return
    }

    const limitParam = url.searchParams.get('limit')
    const offsetParam = url.searchParams.get('offset')
    const rawLimit = limitParam == null ? NaN : Number(limitParam)
    const rawOffset = offsetParam == null ? NaN : Number(offsetParam)
    const limit = Math.min(50, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 50))
    const offset = Math.max(0, Number.isFinite(rawOffset) ? rawOffset : 0)
    const all = url.searchParams.get('all') === '1'
    const forceRefresh = url.searchParams.get('force') === '1'

    ;(async () => {
      const hasUsablePlaylistPage = (payload) => {
        const items = Array.isArray(payload?.items) ? payload.items : null
        const total = Number(payload?.total) || 0
        return Boolean(items) && (total === 0 || items.length > 0)
      }

      const cacheUserId = all ? getPersistentSpotifyCacheUserId(userId) : null
      const canUseServerCache = Boolean(all && cacheUserId)
      const cacheKey = 'me_playlists_all'
      const nowMs = Date.now()
      let cachedRecord = canUseServerCache ? readSpotifyCacheRecord(cacheUserId, cacheKey) : null
      if (cachedRecord && !hasUsablePlaylistPage(cachedRecord.data)) cachedRecord = null
      const lockKey = canUseServerCache ? `${cacheUserId}:${cacheKey}` : null
      let lockTaken = false

      if (canUseServerCache && cachedRecord && !forceRefresh) {
        const decision = shouldAttemptSpotifyRefresh({
          record: cachedRecord,
          nowMs,
          refreshWindowMs: PLAYLISTS_REFRESH_WINDOW_MS,
        })
        if (!decision.shouldRefresh) {
          res.setHeader('x-sp-cache', decision.stale ? 'hit_throttled' : 'hit_fresh')
          res.setHeader('x-sp-cache-fetched-at', cachedRecord.fetchedAt)
          res.setHeader('x-sp-cache-last-refreshed-at', cachedRecord.lastRefreshedAt)
          sendJson(res, 200, cachedRecord.data)
          return
        }

        if (lockKey && spotifyRefreshInFlight.has(lockKey)) {
          res.setHeader('x-sp-cache', 'hit_inflight')
          res.setHeader('x-sp-cache-fetched-at', cachedRecord.fetchedAt)
          res.setHeader('x-sp-cache-last-refreshed-at', cachedRecord.lastRefreshedAt)
          sendJson(res, 200, cachedRecord.data)
          return
        }

        if (lockKey) {
          spotifyRefreshInFlight.set(lockKey, true)
          lockTaken = true
        }

        // Mark a refresh attempt so we don't keep hammering Spotify if it fails.
        const attemptedAt = new Date(nowMs).toISOString()
        cachedRecord = { ...cachedRecord, lastRefreshedAt: attemptedAt }
        writeSpotifyCacheRecordAtomic(cacheUserId, cacheKey, cachedRecord)
      }

      let currentAccessToken = accessToken

      const callPlaylists = async (token, { offset: pageOffset }) => {
        const apiUrl = new URL('https://api.spotify.com/v1/me/playlists')
        apiUrl.searchParams.set('limit', String(limit))
        apiUrl.searchParams.set('offset', String(pageOffset))

        const response = await spotifyFetch(apiUrl.toString(), {
          label: '/v1/me/playlists',
          debugContext,
          headers: { authorization: `Bearer ${token}` },
        })

        let data
        try {
          data = await response.json()
        } catch {
          data = null
        }

        const retryAfterSeconds = getRetryAfterSeconds(response.headers)
        if (!response.ok) {
          logSpotifyFailure({
            label: 'GET /v1/me/playlists',
            url: apiUrl.toString(),
            status: response.status,
            retryAfterSeconds,
            requestId: response.headers.get('x-request-id'),
            context: debugContext,
            data,
          })
        }
        return { ok: response.ok, status: response.status, data, retryAfterSeconds }
      }

      const fetchWithRefresh = async (fn) => {
        let result = await fn(currentAccessToken)

        if (!result.ok && result.status === 401 && refreshToken) {
          const refreshed = await spotifyRefresh({ refreshToken, clientId })
          if (typeof refreshed.access_token === 'string') {
            setCookie(res, 'sp_access', refreshed.access_token, { path: '/', maxAge: Math.max(0, (Number(refreshed.expires_in) || 3600) - 30) })
            currentAccessToken = refreshed.access_token
            result = await fn(currentAccessToken)
          }
        }

        return result
      }

      try {
        if (!all) {
          const result = await fetchWithRefresh((token) => callPlaylists(token, { offset }))
          if (!result.ok) {
            sendJson(res, result.status, { error: 'spotify_playlists_failed', details: result.data, retryAfterSeconds: result.retryAfterSeconds })
            return
          }

          sendJson(res, 200, result.data)
          return
        }

        const first = await fetchWithRefresh((token) => callPlaylists(token, { offset: 0 }))
        if (!first.ok) {
          if (canUseServerCache && cachedRecord) {
            res.setHeader('x-sp-cache', 'hit_fallback')
            res.setHeader('x-sp-cache-fetched-at', cachedRecord.fetchedAt)
            res.setHeader('x-sp-cache-last-refreshed-at', cachedRecord.lastRefreshedAt)
            sendJson(res, 200, cachedRecord.data)
            return
          }
          sendJson(res, first.status, { error: 'spotify_playlists_failed', details: first.data, retryAfterSeconds: first.retryAfterSeconds })
          return
        }

        const firstItems = Array.isArray(first.data?.items) ? first.data.items : null
        const items = firstItems ? firstItems.slice() : []
        const total = Number(first.data?.total) || items.length
        if (total > 0 && items.length === 0) {
          console.error(
            '[spotify] invalid /v1/me/playlists payload: total > 0 but first page had no items',
            JSON.stringify(
              {
                total,
                offset: Number(first.data?.offset) || 0,
                limit: Number(first.data?.limit) || limit,
                href: typeof first.data?.href === 'string' ? first.data.href : null,
                context: debugContext,
              },
              null,
              2,
            ),
          )
          if (canUseServerCache && cachedRecord) {
            res.setHeader('x-sp-cache', 'hit_fallback')
            res.setHeader('x-sp-cache-fetched-at', cachedRecord.fetchedAt)
            res.setHeader('x-sp-cache-last-refreshed-at', cachedRecord.lastRefreshedAt)
            sendJson(res, 200, cachedRecord.data)
            return
          }
          sendJson(res, 502, {
            error: 'spotify_playlists_incomplete',
            message: 'Spotify returned a playlist total but no playlist items on the first page.',
            details: {
              total,
              offset: Number(first.data?.offset) || 0,
              limit: Number(first.data?.limit) || limit,
            },
          })
          return
        }
        let nextOffset = items.length

        const maxPages = 200
        let pagesFetched = 1

        while (nextOffset < total) {
          if (pagesFetched >= maxPages) {
            sendPartialJson(res, { ...first.data, items, offset: 0, limit, total, partial: true, nextOffset, maxPages })
            return
          }

          const page = await fetchWithRefresh((token) => callPlaylists(token, { offset: nextOffset }))
          if (!page.ok) {
            if (canUseServerCache && cachedRecord) {
              res.setHeader('x-sp-cache', 'hit_fallback')
              res.setHeader('x-sp-cache-fetched-at', cachedRecord.fetchedAt)
              res.setHeader('x-sp-cache-last-refreshed-at', cachedRecord.lastRefreshedAt)
              sendJson(res, 200, cachedRecord.data)
              return
            }
            sendJson(res, page.status, { error: 'spotify_playlists_failed', details: page.data, retryAfterSeconds: page.retryAfterSeconds, partial: { items, total, nextOffset } })
            return
          }

          const pageItems = Array.isArray(page.data?.items) ? page.data.items : []
          if (nextOffset < total && pageItems.length === 0) {
            console.error(
              '[spotify] invalid /v1/me/playlists pagination payload: expected more items but received an empty page',
              JSON.stringify(
                {
                  total,
                  offset: nextOffset,
                  limit,
                  href: typeof page.data?.href === 'string' ? page.data.href : null,
                  context: debugContext,
                },
                null,
                2,
              ),
            )
            if (canUseServerCache && cachedRecord) {
              res.setHeader('x-sp-cache', 'hit_fallback')
              res.setHeader('x-sp-cache-fetched-at', cachedRecord.fetchedAt)
              res.setHeader('x-sp-cache-last-refreshed-at', cachedRecord.lastRefreshedAt)
              sendJson(res, 200, cachedRecord.data)
              return
            }
            sendJson(res, 502, {
              error: 'spotify_playlists_incomplete',
              message: 'Spotify returned an empty playlist page before the reported total was reached.',
              details: {
                total,
                offset: nextOffset,
                limit,
              },
            })
            return
          }
          items.push(...pageItems)
          if (pageItems.length === 0) break
          nextOffset += pageItems.length
          pagesFetched += 1
        }

        const payload = { ...first.data, items, offset: 0, limit, total }
        if (canUseServerCache) {
          const storedAt = new Date().toISOString()
          writeSpotifyCacheRecordAtomic(cacheUserId, cacheKey, {
            schemaVersion: 1,
            userId: cacheUserId,
            cacheKey,
            fetchedAt: storedAt,
            lastRefreshedAt: storedAt,
            data: payload,
          })
          res.setHeader('x-sp-cache', cachedRecord ? 'refreshed' : 'miss_refreshed')
          res.setHeader('x-sp-cache-fetched-at', storedAt)
          res.setHeader('x-sp-cache-last-refreshed-at', storedAt)
        }

        sendJson(res, 200, payload)
      } catch (error) {
        if (canUseServerCache && cachedRecord) {
          res.setHeader('x-sp-cache', 'hit_fallback')
          res.setHeader('x-sp-cache-fetched-at', cachedRecord.fetchedAt)
          res.setHeader('x-sp-cache-last-refreshed-at', cachedRecord.lastRefreshedAt)
          sendJson(res, 200, cachedRecord.data)
          return
        }
        sendJson(res, 500, { error: 'spotify_playlists_failed', message: error?.message })
      } finally {
        if (lockKey && lockTaken) spotifyRefreshInFlight.delete(lockKey)
      }
    })()

    return
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/tracks/')) {
    if (isDemoSession(cookies)) {
      const trackId = url.pathname.slice('/api/tracks/'.length)
      const cacheKey = `track_${trackId}_artists`
      const record = readSpotifyCacheRecord(MOCK_DEMO_CACHE_USER_ID, cacheKey)

      if (!record) {
        updateMockDemoManifestResource({
          kind: 'track_artists',
          id: trackId,
          status: 'needed',
          cacheKey,
          note: 'Track artist metadata is needed for the demo flow.',
        })
        sendJson(res, 200, { artists: [], album: null })
        return
      }

      updateMockDemoManifestResource({
        kind: 'track_artists',
        id: trackId,
        status: 'cached',
        cacheKey,
        note: 'Served track artist metadata from mock demo cache.',
        extra: { cachedAt: record.fetchedAt, lastRefreshedAt: record.lastRefreshedAt },
      })
      res.setHeader('x-sp-cache', 'demo_hit')
      res.setHeader('x-sp-cache-fetched-at', record.fetchedAt)
      sendJson(res, 200, {
        artists: record.data?.artists ?? [],
        album: record.data?.album ?? null,
      })
      return
    }

    const clientId = process.env.SPOTIFY_CLIENT_ID
    const accessToken = cookies.sp_access
    const refreshToken = cookies.sp_refresh
    const userId = typeof cookies.sp_user_id === 'string' ? cookies.sp_user_id : null

    if (!clientId) {
      sendJson(res, 500, { error: 'missing_env', missing: ['SPOTIFY_CLIENT_ID'] })
      return
    }
    if (!accessToken || !userId) {
      sendJson(res, 401, { error: 'not_logged_in' })
      return
    }

    const trackId = url.pathname.slice('/api/tracks/'.length)
    if (!trackId || !/^[a-zA-Z0-9]{10,64}$/.test(trackId)) {
      sendJson(res, 400, { error: 'invalid_track_id' })
      return
    }

    ;(async () => {
      const cacheUserId = getPersistentSpotifyCacheUserId(userId)
      const cacheKey = `track_${trackId}_artists`
      const cachedRecord = cacheUserId ? readSpotifyCacheRecord(cacheUserId, cacheKey) : null
      if (cachedRecord) {
        res.setHeader('x-sp-cache', 'hit')
        res.setHeader('x-sp-cache-fetched-at', cachedRecord.fetchedAt)
        sendJson(res, 200, {
          artists: cachedRecord.data?.artists ?? [],
          album: cachedRecord.data?.album ?? null,
        })
        return
      }

      const nowMs = Date.now()
      const existing = trackResolveMissesByUser.get(userId) || []
      const pruned = existing.filter((t) => nowMs - t < ARTIST_IMAGE_MISS_WINDOW_MS)
      if (pruned.length >= ARTIST_IMAGE_MISS_MAX_PER_WINDOW) {
        const oldest = Math.min(...pruned)
        const retryAfterMs = Math.max(0, ARTIST_IMAGE_MISS_WINDOW_MS - (nowMs - oldest))
        sendJson(res, 429, { error: 'rate_limited', retryAfterSeconds: Math.ceil(retryAfterMs / 1000) })
        return
      }
      pruned.push(nowMs)
      trackResolveMissesByUser.set(userId, pruned)

      const lockKey = `${userId}:${cacheKey}`
      let lockTaken = false
      if (spotifyRefreshInFlight.has(lockKey)) {
        sendJson(res, 429, { error: 'inflight', retryAfterSeconds: 1 })
        return
      }
      spotifyRefreshInFlight.set(lockKey, true)
      lockTaken = true

      let currentAccessToken = accessToken

      const callTrack = async (token) => {
        const apiUrl = `https://api.spotify.com/v1/tracks/${encodeURIComponent(trackId)}?market=from_token`
        const response = await spotifyFetch(apiUrl, {
          label: '/v1/tracks/:id',
          debugContext,
          headers: { authorization: `Bearer ${token}` },
        })

        let data
        try {
          data = await response.json()
        } catch {
          data = null
        }

        const retryAfterSeconds = getRetryAfterSeconds(response.headers)
        if (!response.ok) {
          logSpotifyFailure({
            label: 'GET /v1/tracks/:id',
            url: apiUrl,
            status: response.status,
            retryAfterSeconds,
            requestId: response.headers.get('x-request-id'),
            context: debugContext,
            data,
          })
        }

        return { ok: response.ok, status: response.status, data, retryAfterSeconds }
      }

      const fetchWithRefresh = async (fn) => {
        let result = await fn(currentAccessToken)

        if (!result.ok && result.status === 401 && refreshToken) {
          const refreshed = await spotifyRefresh({ refreshToken, clientId })
          if (typeof refreshed.access_token === 'string') {
            setCookie(res, 'sp_access', refreshed.access_token, {
              path: '/',
              maxAge: Math.max(0, (Number(refreshed.expires_in) || 3600) - 30),
            })
            currentAccessToken = refreshed.access_token
            result = await fn(currentAccessToken)
          }
        }

        return result
      }

      try {
        const result = await fetchWithRefresh((token) => callTrack(token))
        if (!result.ok) {
          sendJson(res, result.status, { error: 'spotify_track_failed', details: result.data, retryAfterSeconds: result.retryAfterSeconds })
          return
        }

        const artistsRaw = Array.isArray(result.data?.artists) ? result.data.artists : []
        const artists = artistsRaw
          .map((a) => ({
            id: typeof a?.id === 'string' ? a.id : null,
            name: typeof a?.name === 'string' ? a.name : null,
          }))
          .filter((a) => a.id && a.name)
        const album = result.data?.album && typeof result.data.album === 'object'
          ? {
              id: typeof result.data.album.id === 'string' ? result.data.album.id : null,
              name: typeof result.data.album.name === 'string' ? result.data.album.name : null,
              totalTracks: Number.isFinite(result.data.album.total_tracks) ? result.data.album.total_tracks : null,
            }
          : null

        const storedAt = new Date().toISOString()
        if (cacheUserId) {
          writeSpotifyCacheRecordAtomic(cacheUserId, cacheKey, {
            schemaVersion: 1,
            userId: cacheUserId,
            cacheKey,
            fetchedAt: storedAt,
            lastRefreshedAt: storedAt,
            data: { artists, album },
          })

          res.setHeader('x-sp-cache', 'miss_stored')
          res.setHeader('x-sp-cache-fetched-at', storedAt)
        }
        sendJson(res, 200, { artists, album })
      } finally {
        if (lockTaken) spotifyRefreshInFlight.delete(lockKey)
      }
    })()

    return
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/albums/') && url.pathname.endsWith('/tracks')) {
    if (isDemoSession(cookies)) {
      const parts = url.pathname.split('/').filter(Boolean)
      const albumId = parts.length === 4 ? parts[2] : null
      if (!albumId) {
        sendJson(res, 400, { error: 'missing_album_id' })
        return
      }

      sendDemoCachePayload(res, {
        cacheKey: `album_${albumId}_tracks_all`,
        kind: 'album_tracks',
        id: albumId,
        missingError: 'demo_album_tracks_unavailable',
        missingMessage: 'This album is not cached for the demo yet.',
      })
      return
    }

    const clientId = process.env.SPOTIFY_CLIENT_ID
    const accessToken = cookies.sp_access
    const refreshToken = cookies.sp_refresh
    const userId = typeof cookies.sp_user_id === 'string' ? cookies.sp_user_id : null

    if (!clientId) {
      sendJson(res, 500, { error: 'missing_env', missing: ['SPOTIFY_CLIENT_ID'] })
      return
    }
    if (!accessToken || !userId) {
      sendJson(res, 401, { error: 'not_logged_in' })
      return
    }

    const parts = url.pathname.split('/').filter(Boolean)
    const albumId = parts.length === 4 ? parts[2] : null
    if (!albumId) {
      sendJson(res, 400, { error: 'missing_album_id' })
      return
    }

    ;(async () => {
      const cacheUserId = getPersistentSpotifyCacheUserId(userId)
      const cacheKey = `album_${albumId}_tracks_all`
      const nowMs = Date.now()
      let cachedRecord = cacheUserId ? readSpotifyCacheRecord(cacheUserId, cacheKey) : null
      const lockKey = `${userId}:${cacheKey}`
      let lockTaken = false

      if (cachedRecord) {
        const decision = shouldAttemptSpotifyRefresh({ record: cachedRecord, nowMs })
        if (!decision.shouldRefresh) {
          res.setHeader('x-sp-cache', decision.stale ? 'hit_throttled' : 'hit_fresh')
          res.setHeader('x-sp-cache-fetched-at', cachedRecord.fetchedAt)
          res.setHeader('x-sp-cache-last-refreshed-at', cachedRecord.lastRefreshedAt)
          sendJson(res, 200, cachedRecord.data)
          return
        }

        if (spotifyRefreshInFlight.has(lockKey)) {
          res.setHeader('x-sp-cache', 'hit_inflight')
          res.setHeader('x-sp-cache-fetched-at', cachedRecord.fetchedAt)
          res.setHeader('x-sp-cache-last-refreshed-at', cachedRecord.lastRefreshedAt)
          sendJson(res, 200, cachedRecord.data)
          return
        }

        spotifyRefreshInFlight.set(lockKey, true)
        lockTaken = true

        const attemptedAt = new Date(nowMs).toISOString()
        cachedRecord = { ...cachedRecord, lastRefreshedAt: attemptedAt }
        writeSpotifyCacheRecordAtomic(cacheUserId, cacheKey, cachedRecord)
      }

      let currentAccessToken = accessToken

      const fetchWithRefresh = async () => {
        let result = await fetchAlbumTracksAll({
          albumId,
          accessToken: currentAccessToken,
          debugContext,
        })

        if (!result.ok && result.status === 401 && refreshToken) {
          const refreshed = await spotifyRefresh({ refreshToken, clientId })
          if (typeof refreshed.access_token === 'string') {
            setCookie(res, 'sp_access', refreshed.access_token, {
              path: '/',
              maxAge: Math.max(0, (Number(refreshed.expires_in) || 3600) - 30),
            })
            currentAccessToken = refreshed.access_token
            result = await fetchAlbumTracksAll({
              albumId,
              accessToken: currentAccessToken,
              debugContext,
            })
          }
        }

        return result
      }

      try {
        const result = await fetchWithRefresh()
        if (!result.ok) {
          if (cachedRecord) {
            res.setHeader('x-sp-cache', 'hit_fallback')
            res.setHeader('x-sp-cache-fetched-at', cachedRecord.fetchedAt)
            res.setHeader('x-sp-cache-last-refreshed-at', cachedRecord.lastRefreshedAt)
            sendJson(res, 200, cachedRecord.data)
            return
          }
          sendJson(res, result.status, {
            error: 'spotify_album_tracks_failed',
            details: result.data,
            retryAfterSeconds: result.retryAfterSeconds,
          })
          return
        }

        const storedAt = new Date().toISOString()
        if (cacheUserId) {
          writeSpotifyCacheRecordAtomic(cacheUserId, cacheKey, {
            schemaVersion: 1,
            userId: cacheUserId,
            cacheKey,
            fetchedAt: storedAt,
            lastRefreshedAt: storedAt,
            data: result.data,
          })

          res.setHeader('x-sp-cache', cachedRecord ? 'refreshed' : 'miss_refreshed')
          res.setHeader('x-sp-cache-fetched-at', storedAt)
          res.setHeader('x-sp-cache-last-refreshed-at', storedAt)
        }
        sendJson(res, 200, result.data)
      } catch (error) {
        if (cachedRecord) {
          res.setHeader('x-sp-cache', 'hit_fallback')
          res.setHeader('x-sp-cache-fetched-at', cachedRecord.fetchedAt)
          res.setHeader('x-sp-cache-last-refreshed-at', cachedRecord.lastRefreshedAt)
          sendJson(res, 200, cachedRecord.data)
          return
        }
        sendJson(res, 500, { error: 'spotify_album_tracks_failed', message: error?.message })
      } finally {
        if (lockTaken) spotifyRefreshInFlight.delete(lockKey)
      }
    })()

    return
  }

  if (req.method === 'GET' && url.pathname.startsWith('/artist-image/')) {
    if (isDemoSession(cookies)) {
      const artistId = url.pathname.slice('/artist-image/'.length)
      if (!artistId || !/^[a-zA-Z0-9]{10,64}$/.test(artistId)) {
        sendJson(res, 400, { error: 'invalid_artist_id' })
        return
      }

      const cacheKey = `artist_${artistId}_image`
      const record = readSpotifyCacheRecord(MOCK_DEMO_CACHE_USER_ID, cacheKey)
      if (!record) {
        updateMockDemoManifestResource({
          kind: 'artist_image',
          id: artistId,
          status: 'needed',
          cacheKey,
          note: 'Artist image is needed for the demo flow.',
        })
        sendJson(res, 200, { imageUrl: null })
        return
      }

      updateMockDemoManifestResource({
        kind: 'artist_image',
        id: artistId,
        status: 'cached',
        cacheKey,
        note: 'Served artist image from mock demo cache.',
        extra: { cachedAt: record.fetchedAt, lastRefreshedAt: record.lastRefreshedAt },
      })
      res.setHeader('x-sp-cache', 'demo_hit')
      res.setHeader('x-sp-cache-fetched-at', record.fetchedAt)
      sendJson(res, 200, { imageUrl: record.data?.imageUrl ?? null })
      return
    }

    const clientId = process.env.SPOTIFY_CLIENT_ID
    const accessToken = cookies.sp_access
    const refreshToken = cookies.sp_refresh
    const userId = typeof cookies.sp_user_id === 'string' ? cookies.sp_user_id : null

    if (!clientId) {
      sendJson(res, 500, { error: 'missing_env', missing: ['SPOTIFY_CLIENT_ID'] })
      return
    }
    if (!accessToken || !userId) {
      sendJson(res, 401, { error: 'not_logged_in' })
      return
    }

    const artistId = url.pathname.slice('/artist-image/'.length)
    if (!artistId || !/^[a-zA-Z0-9]{10,64}$/.test(artistId)) {
      sendJson(res, 400, { error: 'invalid_artist_id' })
      return
    }

    ;(async () => {
      const cacheUserId = getPersistentSpotifyCacheUserId(userId)
      const cacheKey = `artist_${artistId}_image`
      const cachedRecord = cacheUserId ? readSpotifyCacheRecord(cacheUserId, cacheKey) : null
      const cachedImageUrl = cachedRecord?.data?.imageUrl ?? null
      const nowMs = Date.now()
      const isStale = shouldRefreshArtistImageRecord(cachedRecord, nowMs)

      if (cachedRecord && !isStale) {
        res.setHeader('x-sp-cache', 'hit')
        res.setHeader('x-sp-cache-fetched-at', cachedRecord.fetchedAt)
        sendJson(res, 200, { imageUrl: cachedImageUrl })
        return
      }

      const existing = artistImageMissesByUser.get(userId) || []
      const pruned = existing.filter((t) => nowMs - t < ARTIST_IMAGE_MISS_WINDOW_MS)
      if (pruned.length >= ARTIST_IMAGE_MISS_MAX_PER_WINDOW) {
        const oldest = Math.min(...pruned)
        const retryAfterMs = Math.max(0, ARTIST_IMAGE_MISS_WINDOW_MS - (nowMs - oldest))
        if (cachedRecord) {
          res.setHeader('x-sp-cache', 'hit_stale_throttled')
          res.setHeader('x-sp-cache-fetched-at', cachedRecord.fetchedAt)
          sendJson(res, 200, { imageUrl: cachedImageUrl })
        } else {
          sendJson(res, 429, { error: 'rate_limited', retryAfterSeconds: Math.ceil(retryAfterMs / 1000) })
        }
        return
      }
      pruned.push(nowMs)
      artistImageMissesByUser.set(userId, pruned)

      const lockKey = `${userId}:${cacheKey}`
      let lockTaken = false
      if (spotifyRefreshInFlight.has(lockKey)) {
        if (cachedRecord) {
          res.setHeader('x-sp-cache', 'hit_stale_inflight')
          res.setHeader('x-sp-cache-fetched-at', cachedRecord.fetchedAt)
          sendJson(res, 200, { imageUrl: cachedImageUrl })
        } else {
          sendJson(res, 429, { error: 'inflight', retryAfterSeconds: 1 })
        }
        return
      }
      spotifyRefreshInFlight.set(lockKey, true)
      lockTaken = true

      let currentAccessToken = accessToken

      const callArtist = async (token) => {
        const apiUrl = `https://api.spotify.com/v1/artists/${encodeURIComponent(artistId)}`
        const response = await spotifyFetch(apiUrl, {
          label: '/v1/artists/:id',
          debugContext,
          headers: { authorization: `Bearer ${token}` },
        })

        let data
        try {
          data = await response.json()
        } catch {
          data = null
        }

        const retryAfterSeconds = getRetryAfterSeconds(response.headers)
        if (!response.ok) {
          logSpotifyFailure({
            label: 'GET /v1/artists/:id',
            url: apiUrl,
            status: response.status,
            retryAfterSeconds,
            requestId: response.headers.get('x-request-id'),
            context: debugContext,
            data,
          })
        }

        return { ok: response.ok, status: response.status, data, retryAfterSeconds }
      }

      const fetchWithRefresh = async (fn) => {
        let result = await fn(currentAccessToken)

        if (!result.ok && result.status === 401 && refreshToken) {
          const refreshed = await spotifyRefresh({ refreshToken, clientId })
          if (typeof refreshed.access_token === 'string') {
            setCookie(res, 'sp_access', refreshed.access_token, {
              path: '/',
              maxAge: Math.max(0, (Number(refreshed.expires_in) || 3600) - 30),
            })
            currentAccessToken = refreshed.access_token
            result = await fn(currentAccessToken)
          }
        }

        return result
      }

      try {
        const result = await fetchWithRefresh((token) => callArtist(token))
        if (!result.ok) {
          if (cachedRecord) {
            res.setHeader('x-sp-cache', 'hit_stale_error')
            res.setHeader('x-sp-cache-fetched-at', cachedRecord.fetchedAt)
            sendJson(res, 200, { imageUrl: cachedImageUrl })
          } else {
            sendJson(res, result.status, {
              error: 'spotify_artist_failed',
              details: result.data,
              retryAfterSeconds: result.retryAfterSeconds,
            })
          }
          return
        }

        const images = Array.isArray(result.data?.images) ? result.data.images : []
        const imageUrl = typeof images?.[0]?.url === 'string' ? images[0].url : null

        const storedAt = new Date().toISOString()
        if (cacheUserId) {
          writeSpotifyCacheRecordAtomic(cacheUserId, cacheKey, {
            schemaVersion: 1,
            userId: cacheUserId,
            cacheKey,
            fetchedAt: storedAt,
            lastRefreshedAt: storedAt,
            data: { imageUrl },
          })

          res.setHeader('x-sp-cache', cachedRecord ? 'refreshed' : 'miss_stored')
          res.setHeader('x-sp-cache-fetched-at', storedAt)
        }
        sendJson(res, 200, { imageUrl })
      } finally {
        if (lockTaken) spotifyRefreshInFlight.delete(lockKey)
      }
    })()

    return
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/playlists/') && url.pathname.endsWith('/tracks')) {
    if (isDemoSession(cookies)) {
      const parts = url.pathname.split('/').filter(Boolean)
      const playlistId = parts.length === 4 ? parts[2] : null
      if (!playlistId) {
        sendJson(res, 400, { error: 'missing_playlist_id' })
        return
      }

      sendDemoCachePayload(res, {
        cacheKey: `playlist_${playlistId}_tracks_all`,
        kind: 'playlist_tracks',
        id: playlistId,
        missingError: 'demo_playlist_tracks_unavailable',
        missingMessage: 'This demo playlist is not cached yet.',
      })
      return
    }

    const clientId = process.env.SPOTIFY_CLIENT_ID
    const accessToken = cookies.sp_access
    const refreshToken = cookies.sp_refresh
    const userId = typeof cookies.sp_user_id === 'string' ? cookies.sp_user_id : null

    if (!clientId) {
      sendJson(res, 500, { error: 'missing_env', missing: ['SPOTIFY_CLIENT_ID'] })
      return
    }
    if (!accessToken) {
      sendJson(res, 401, { error: 'not_logged_in' })
      return
    }

    const parts = url.pathname.split('/').filter(Boolean) // ['api','playlists',':id','tracks']
    const playlistId = parts.length === 4 ? parts[2] : null
    if (!playlistId) {
      sendJson(res, 400, { error: 'missing_playlist_id' })
      return
    }

    const limitParam = url.searchParams.get('limit')
    const offsetParam = url.searchParams.get('offset')
    const rawLimit = limitParam == null ? NaN : Number(limitParam)
    const rawOffset = offsetParam == null ? NaN : Number(offsetParam)
    const limit = Math.min(50, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 50))
    const offset = Math.max(0, Number.isFinite(rawOffset) ? rawOffset : 0)
    const all = url.searchParams.get('all') === '1'
    const forceRefresh = url.searchParams.get('force') === '1'

    ;(async () => {
      const cacheUserId = all ? getPersistentSpotifyCacheUserId(userId) : null
      const canUseServerCache = Boolean(all && cacheUserId)
      const cacheKey = `playlist_${playlistId}_tracks_all`
      const nowMs = Date.now()
      let cachedRecord = canUseServerCache ? readSpotifyCacheRecord(cacheUserId, cacheKey) : null
      const lockKey = canUseServerCache ? `${cacheUserId}:${cacheKey}` : null
      let lockTaken = false

      if (canUseServerCache && cachedRecord && !forceRefresh) {
        const decision = shouldAttemptSpotifyRefresh({ record: cachedRecord, nowMs })
        if (!decision.shouldRefresh) {
          res.setHeader('x-sp-cache', decision.stale ? 'hit_throttled' : 'hit_fresh')
          res.setHeader('x-sp-cache-fetched-at', cachedRecord.fetchedAt)
          res.setHeader('x-sp-cache-last-refreshed-at', cachedRecord.lastRefreshedAt)
          sendJson(res, 200, cachedRecord.data)
          return
        }

        if (lockKey && spotifyRefreshInFlight.has(lockKey)) {
          res.setHeader('x-sp-cache', 'hit_inflight')
          res.setHeader('x-sp-cache-fetched-at', cachedRecord.fetchedAt)
          res.setHeader('x-sp-cache-last-refreshed-at', cachedRecord.lastRefreshedAt)
          sendJson(res, 200, cachedRecord.data)
          return
        }

        if (lockKey) {
          spotifyRefreshInFlight.set(lockKey, true)
          lockTaken = true
        }

        const attemptedAt = new Date(nowMs).toISOString()
        cachedRecord = { ...cachedRecord, lastRefreshedAt: attemptedAt }
        writeSpotifyCacheRecordAtomic(cacheUserId, cacheKey, cachedRecord)
      }

      let currentAccessToken = accessToken

      const callTracks = async (token, { offset: pageOffset }) => {
        const apiUrl = new URL(`https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/items`)
        apiUrl.searchParams.set('limit', String(limit))
        apiUrl.searchParams.set('offset', String(pageOffset))
        apiUrl.searchParams.set('market', 'from_token')
        apiUrl.searchParams.set('additional_types', 'track')
        apiUrl.searchParams.set(
          'fields',
          [
            'href',
            'limit',
            'next',
            'offset',
            'previous',
            'total',
            'snapshot_id',
            'items(' +
              [
                'added_at',
                'item(' +
                  [
                    'type',
                    'id',
                    'name',
                    'duration_ms',
                    'explicit',
                  'external_urls(spotify)',
                    'artists(id,name)',
                    'album(id,name,total_tracks)',
                  ].join(',') +
                ')',
              ].join(',') +
            ')',
          ].join(','),
        )

        const response = await spotifyFetch(apiUrl.toString(), {
          label: '/v1/playlists/:id/items',
          debugContext,
          headers: { authorization: `Bearer ${token}` },
        })

        let data
        try {
          data = await response.json()
        } catch {
          data = null
        }

        const retryAfterSeconds = getRetryAfterSeconds(response.headers)
        if (!response.ok) {
          logSpotifyFailure({
            label: 'GET /v1/playlists/:id/items',
            url: apiUrl.toString(),
            status: response.status,
            retryAfterSeconds,
            requestId: response.headers.get('x-request-id'),
            context: debugContext,
            data,
          })
        }
        return { ok: response.ok, status: response.status, data, retryAfterSeconds }
      }

      const fetchWithRefresh = async (fn) => {
        let result = await fn(currentAccessToken)

        if (!result.ok && result.status === 401 && refreshToken) {
          const refreshed = await spotifyRefresh({ refreshToken, clientId })
          if (typeof refreshed.access_token === 'string') {
            setCookie(res, 'sp_access', refreshed.access_token, { path: '/', maxAge: Math.max(0, (Number(refreshed.expires_in) || 3600) - 30) })
            currentAccessToken = refreshed.access_token
            result = await fn(currentAccessToken)
          }
        }

        return result
      }

      try {
        if (!all) {
          const result = await fetchWithRefresh((token) => callTracks(token, { offset }))
          if (!result.ok) {
            sendJson(res, result.status, { error: 'spotify_playlist_tracks_failed', details: result.data, retryAfterSeconds: result.retryAfterSeconds })
            return
          }
          sendJson(res, 200, result.data)
          return
        }

        const first = await fetchWithRefresh((token) => callTracks(token, { offset: 0 }))
        if (!first.ok) {
          if (canUseServerCache && cachedRecord) {
            res.setHeader('x-sp-cache', 'hit_fallback')
            res.setHeader('x-sp-cache-fetched-at', cachedRecord.fetchedAt)
            res.setHeader('x-sp-cache-last-refreshed-at', cachedRecord.lastRefreshedAt)
            sendJson(res, 200, cachedRecord.data)
            return
          }
          sendJson(res, first.status, { error: 'spotify_playlist_tracks_failed', details: first.data, retryAfterSeconds: first.retryAfterSeconds })
          return
        }

        const items = Array.isArray(first.data?.items) ? first.data.items.slice() : []
        const total = Number(first.data?.total) || items.length
        let nextOffset = items.length

        const maxPages = 50
        let pagesFetched = 1

        while (nextOffset < total) {
          if (pagesFetched >= maxPages) {
            sendPartialJson(res, { ...first.data, items, offset: 0, limit, total, partial: true, nextOffset, maxPages })
            return
          }

          const page = await fetchWithRefresh((token) => callTracks(token, { offset: nextOffset }))
          if (!page.ok) {
            if (canUseServerCache && cachedRecord) {
              res.setHeader('x-sp-cache', 'hit_fallback')
              res.setHeader('x-sp-cache-fetched-at', cachedRecord.fetchedAt)
              res.setHeader('x-sp-cache-last-refreshed-at', cachedRecord.lastRefreshedAt)
              sendJson(res, 200, cachedRecord.data)
              return
            }
            sendJson(res, page.status, { error: 'spotify_playlist_tracks_failed', details: page.data, retryAfterSeconds: page.retryAfterSeconds, partial: { items, total, nextOffset } })
            return
          }

          const pageItems = Array.isArray(page.data?.items) ? page.data.items : []
          items.push(...pageItems)
          if (pageItems.length === 0) break
          nextOffset += pageItems.length
          pagesFetched += 1
        }

        const payload = { ...first.data, items, offset: 0, limit, total }
        if (canUseServerCache) {
          const storedAt = new Date().toISOString()
          writeSpotifyCacheRecordAtomic(cacheUserId, cacheKey, {
            schemaVersion: 1,
            userId: cacheUserId,
            cacheKey,
            fetchedAt: storedAt,
            lastRefreshedAt: storedAt,
            data: payload,
          })
          res.setHeader('x-sp-cache', cachedRecord ? 'refreshed' : 'miss_refreshed')
          res.setHeader('x-sp-cache-fetched-at', storedAt)
          res.setHeader('x-sp-cache-last-refreshed-at', storedAt)
        }
        sendJson(res, 200, payload)
      } catch (error) {
        if (canUseServerCache && cachedRecord) {
          res.setHeader('x-sp-cache', 'hit_fallback')
          res.setHeader('x-sp-cache-fetched-at', cachedRecord.fetchedAt)
          res.setHeader('x-sp-cache-last-refreshed-at', cachedRecord.lastRefreshedAt)
          sendJson(res, 200, cachedRecord.data)
          return
        }
        sendJson(res, 500, { error: 'spotify_playlist_tracks_failed', message: error?.message })
      } finally {
        if (lockKey && lockTaken) spotifyRefreshInFlight.delete(lockKey)
      }
    })()

    return
  }

  res.statusCode = 404
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify({ error: 'not_found' }))
})

server.listen(port, () => {
  console.log(`server listening on http://localhost:${port}`)
})
