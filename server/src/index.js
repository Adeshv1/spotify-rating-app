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

function shouldAttemptSpotifyRefresh({ record, nowMs }) {
  if (!record) return { stale: true, throttled: false, shouldRefresh: true }
  const fetchedAtMs = Date.parse(record.fetchedAt)
  const lastRefreshedAtMs = Date.parse(record.lastRefreshedAt)
  const stale = Number.isFinite(fetchedAtMs) ? nowMs - fetchedAtMs >= REFRESH_WINDOW_MS : true
  const throttled = Number.isFinite(lastRefreshedAtMs) ? nowMs - lastRefreshedAtMs < REFRESH_WINDOW_MS : false
  return { stale, throttled, shouldRefresh: stale && !throttled }
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

function logSpotifyFailure({ label, url, status, retryAfterSeconds, wwwAuthenticate, requestId, context, data }) {
  const summary = {
    label,
    status,
    url,
    retryAfterSeconds: retryAfterSeconds ?? null,
    wwwAuthenticate: wwwAuthenticate ?? null,
    requestId: requestId ?? null,
    context: context ?? null,
    error: data?.error ?? data ?? null,
  }
  console.error('[spotify] request failed', JSON.stringify(summary, null, 2))
}

async function spotifyMe({ accessToken }) {
  const response = await fetch('https://api.spotify.com/v1/me', {
    headers: { authorization: `Bearer ${accessToken}` },
  })

  let data
  try {
    data = await response.json()
  } catch {
    data = null
  }

  const retryAfterSeconds = getRetryAfterSeconds(response.headers)
  const wwwAuthenticate = response.headers.get('www-authenticate')
  const requestId = response.headers.get('x-request-id')

  if (!response.ok) {
    logSpotifyFailure({
      label: 'GET /v1/me (callback)',
      url: 'https://api.spotify.com/v1/me',
      status: response.status,
      retryAfterSeconds,
      wwwAuthenticate,
      data,
      requestId,
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

  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: params,
  })

  const data = await response.json()
  if (!response.ok) {
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

  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: params,
  })

  const data = await response.json()
  if (!response.ok) {
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
    const pickPreviewUserId = () => {
      const envId = typeof process.env.SPOTIFY_OWNER_USER_ID === 'string' ? process.env.SPOTIFY_OWNER_USER_ID.trim() : ''
      if (envId) return envId
      try {
        const files = fs.readdirSync(rankingsDir)
        const jsonFiles = files.filter((f) => f.endsWith('.json'))
        if (!jsonFiles.length) return null
        jsonFiles.sort()
        return jsonFiles[0].slice(0, -'.json'.length)
      } catch {
        return null
      }
    }

    const userId = pickPreviewUserId()
    if (!userId) {
      sendJson(res, 404, { error: 'preview_unavailable' })
      return
    }

    const ranking = readJsonFile(rankingFilePathForUser(userId))
    if (!ranking) {
      sendJson(res, 404, { error: 'preview_unavailable' })
      return
    }

    /** @type {Map<string, {id:string, name:string|null, artists:string[], artistsDetailed:Array<{id:string|null,name:string}>, album:string|null}>} */
    const trackMeta = new Map()
    /** @type {Array<{file:string, fetchedAt:string|null, lastRefreshedAt:string|null}>} */
    const sources = []

    try {
      const userCacheDir = path.join(spotifyCacheDir, safeFileComponent(userId))
      const files = fs.readdirSync(userCacheDir)
      for (const file of files) {
        if (!file.endsWith('.json')) continue
        if (!file.startsWith('playlist_') || !file.endsWith('_tracks_all.json')) continue
        const record = readJsonFile(path.join(userCacheDir, file))
        if (!record || typeof record !== 'object') continue

        sources.push({
          file,
          fetchedAt: typeof record.fetchedAt === 'string' ? record.fetchedAt : null,
          lastRefreshedAt: typeof record.lastRefreshedAt === 'string' ? record.lastRefreshedAt : null,
        })

        const items = Array.isArray(record?.data?.items) ? record.data.items : []
        for (const row of items) {
          const entry =
            row?.item && typeof row.item === 'object'
              ? row.item
              : row?.track && typeof row.track === 'object'
                ? row.track
                : null
          if (!entry || typeof entry.id !== 'string' || !entry.id) continue

          const artistsRaw = Array.isArray(entry.artists) ? entry.artists : []
          const artistsDetailed = artistsRaw
            .map((a) => ({
              id: typeof a?.id === 'string' ? a.id : null,
              name: typeof a?.name === 'string' ? a.name : null,
            }))
            .filter((a) => a.name)
          const artists = artistsDetailed.map((a) => a.name)
          const album = typeof entry.album?.name === 'string' ? entry.album.name : null

          trackMeta.set(entry.id, {
            id: entry.id,
            name: typeof entry.name === 'string' ? entry.name : null,
            artists,
            artistsDetailed,
            album,
          })
        }
      }
    } catch {
      // ignore
    }

    function pushTopNByRank(list, item, maxN) {
      list.push(item)
      list.sort((a, b) => a.rank - b.rank)
      if (list.length > maxN) list.length = maxN
    }

    function computeTopArtistsFromTracks(tracks, { maxSongsPerArtist = 5, maxArtists = Number.POSITIVE_INFINITY } = {}) {
      const byArtist = new Map()
      const idByArtist = new Map()

      for (const t of tracks) {
        const rank = Number(t?.rank)
        if (!Number.isFinite(rank)) continue
        const trackId = typeof t?.id === 'string' ? t.id : null
        const artists = Array.isArray(t?.artists) ? t.artists.filter(Boolean) : []
        if (!artists.length) continue

        for (const artistName of artists) {
          if (!idByArtist.has(artistName) && Array.isArray(t?.artistsDetailed)) {
            const match = t.artistsDetailed.find((a) => a?.name === artistName && typeof a?.id === 'string' && a.id)
            if (match?.id) idByArtist.set(artistName, match.id)
          }

          const existing = byArtist.get(artistName) || []
          pushTopNByRank(
            existing,
            {
              trackKey: typeof t?.trackKey === 'string' ? t.trackKey : trackId ? `spid:${trackId}` : null,
              id: trackId,
              name: typeof t?.name === 'string' ? t.name : null,
              rank,
            },
            maxSongsPerArtist,
          )
          byArtist.set(artistName, existing)
        }
      }

      const scored = []
      for (const [name, topSongs] of byArtist.entries()) {
        const n = topSongs.length
        if (!n) continue
        const avgRank = topSongs.reduce((sum, s) => sum + s.rank, 0) / n
        const adjustedAvgRank = avgRank * (maxSongsPerArtist / n)
        const artistId = idByArtist.get(name) || null
        scored.push({ name, artistId, n, avgRank, adjustedAvgRank, topSongs, topTracks: topSongs })
      }

      scored.sort((a, b) => a.adjustedAvgRank - b.adjustedAvgRank)
      return scored.slice(0, maxArtists)
    }

    const tracks = []
    const states = ranking?.tracks && typeof ranking.tracks === 'object' ? ranking.tracks : {}
    for (const [trackKey, state] of Object.entries(states)) {
      if (typeof trackKey !== 'string' || !trackKey.startsWith('spid:')) continue
      const id = trackKey.slice('spid:'.length)
      const meta = trackMeta.get(id)
      if (!meta) continue
      const rating = Number(state?.rating)
      const bucket = typeof state?.bucket === 'string' ? state.bucket : 'U'
      const games = Number(state?.games) || 0
      const isRanked = (bucket !== 'U' && bucket !== 'X') ||
        (Number.isFinite(rating) && Math.round(rating) !== 1000) ||
        games > 0
      if (bucket === 'X' || !isRanked) continue
      tracks.push({
        trackKey: `spid:${id}`,
        id,
        name: meta.name,
        artists: meta.artists,
        artistsDetailed: meta.artistsDetailed,
        album: meta.album,
        bucket,
        rating: Number.isFinite(rating) ? rating : 1000,
        games,
      })
    }

    tracks.sort((a, b) => b.rating - a.rating)
    tracks.forEach((t, idx) => {
      t.rank = idx + 1
    })
    const albumAgg = new Map()

    for (const t of tracks) {
      const album = t.album
      if (album) {
        const prev = albumAgg.get(album) || {
          name: album,
          tracks: 0,
          sumRank: 0,
          bestTrackId: null,
          bestRank: Number.POSITIVE_INFINITY,
        }
        prev.tracks += 1
        prev.sumRank += t.rank
        if (t.id && t.rank < prev.bestRank) {
          prev.bestRank = t.rank
          prev.bestTrackId = t.id
        }
        albumAgg.set(album, prev)
      }
    }

    const topSongs = tracks
    const topArtists = computeTopArtistsFromTracks(tracks, {
      maxSongsPerArtist: 5,
      maxArtists: Number.POSITIVE_INFINITY,
    }).map((a) => {
      const imageUrl =
        typeof a?.artistId === 'string' && a.artistId
          ? (readSpotifyCacheRecord(userId, `artist_${a.artistId}_image`)?.data?.imageUrl ?? null)
          : null
      return { ...a, imageUrl }
    })

    const topAlbums = Array.from(albumAgg.values())
      .map((a) => ({ ...a, avgRank: a.tracks ? a.sumRank / a.tracks : 0 }))
      .sort((a, b) => a.avgRank - b.avgRank)

    sendJson(res, 200, {
      ok: true,
      userId,
      generatedAt: new Date().toISOString(),
      rankingUpdatedAt: typeof ranking?.updatedAt === 'string' ? ranking.updatedAt : null,
      sources,
      topSongs,
      topArtists,
      topAlbums,
    })
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

        if (typeof accessToken === 'string') {
          setCookie(res, 'sp_access', accessToken, { path: '/', maxAge: Math.max(0, (Number(expiresIn) || 3600) - 30) })
        }
        if (typeof refreshToken === 'string') {
          setCookie(res, 'sp_refresh', refreshToken, { path: '/', maxAge: 30 * 24 * 60 * 60 })
        }
        if (typeof scope === 'string') {
          setCookie(res, 'sp_scope', scope, { path: '/', maxAge: 30 * 24 * 60 * 60 })
        }

        // Helpful for debugging + client cache keying without extra calls on every page load.
        if (typeof accessToken === 'string') {
          const me = await spotifyMe({ accessToken })
          if (me.ok && me.data && typeof me.data === 'object') {
            if (typeof me.data.id === 'string') setCookie(res, 'sp_user_id', me.data.id, { path: '/', maxAge: 30 * 24 * 60 * 60 })
            if (typeof me.data.display_name === 'string') setCookie(res, 'sp_user_name', me.data.display_name, { path: '/', maxAge: 30 * 24 * 60 * 60, httpOnly: false })
          }
        }

        res.statusCode = 302
        res.setHeader('location', '/')
        res.end()
      } catch (error) {
        sendJson(res, Number(error?.statusCode) || 500, { error: 'spotify_callback_failed', message: error?.message })
      }
    })()

    return
  }

  if (req.method === 'POST' && url.pathname === '/auth/logout') {
    clearCookie(res, 'sp_access', { path: '/' })
    clearCookie(res, 'sp_refresh', { path: '/' })
    clearCookie(res, 'sp_scope', { path: '/' })
    clearCookie(res, 'sp_user_id', { path: '/' })
    clearCookie(res, 'sp_user_name', { path: '/' })
    sendJson(res, 200, { ok: true })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/session') {
    const hasAccess = typeof cookies.sp_access === 'string' && cookies.sp_access.length > 0
    const hasRefresh = typeof cookies.sp_refresh === 'string' && cookies.sp_refresh.length > 0
    const loggedIn = hasAccess || hasRefresh
    const scopes = typeof cookies.sp_scope === 'string' ? cookies.sp_scope.split(' ').filter(Boolean) : []
    const user = typeof cookies.sp_user_id === 'string' ? { id: cookies.sp_user_id, display_name: cookies.sp_user_name || null } : null
    const owner = isOwnerUser(user?.id)
    sendJson(res, 200, { loggedIn, scopes, user, isOwnerUser: owner })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/ranking') {
    const userId = typeof cookies.sp_user_id === 'string' ? cookies.sp_user_id : null
    const hasAccess = typeof cookies.sp_access === 'string' && cookies.sp_access.length > 0
    const hasRefresh = typeof cookies.sp_refresh === 'string' && cookies.sp_refresh.length > 0
    const loggedIn = hasAccess || hasRefresh

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
    const hasAccess = typeof cookies.sp_access === 'string' && cookies.sp_access.length > 0
    const hasRefresh = typeof cookies.sp_refresh === 'string' && cookies.sp_refresh.length > 0
    const loggedIn = hasAccess || hasRefresh

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
        const response = await fetch('https://api.spotify.com/v1/me', {
          headers: { authorization: `Bearer ${token}` },
        })
        const data = await response.json()
        const retryAfterSeconds = getRetryAfterSeconds(response.headers)
        const wwwAuthenticate = response.headers.get('www-authenticate')
        const requestId = response.headers.get('x-request-id')
        if (!response.ok) {
          logSpotifyFailure({
            label: 'GET /v1/me',
            url: 'https://api.spotify.com/v1/me',
            status: response.status,
            retryAfterSeconds,
            wwwAuthenticate,
            requestId,
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
    const clientId = process.env.SPOTIFY_CLIENT_ID
    const accessToken = cookies.sp_access
    const refreshToken = cookies.sp_refresh
    const userId = typeof cookies.sp_user_id === 'string' ? cookies.sp_user_id : null
    const owner = userId ? isOwnerUser(userId) : false

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

    ;(async () => {
      const canUseServerCache = Boolean(all && userId)
      const cacheKey = 'me_playlists_all'
      const nowMs = Date.now()
      let cachedRecord = canUseServerCache ? readSpotifyCacheRecord(userId, cacheKey) : null
      const lockKey = canUseServerCache ? `${userId}:${cacheKey}` : null
      let lockTaken = false

      if (canUseServerCache && cachedRecord) {
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

        // Mark a refresh attempt so we don't keep hammering Spotify if it fails.
        const attemptedAt = new Date(nowMs).toISOString()
        cachedRecord = { ...cachedRecord, lastRefreshedAt: attemptedAt }
        writeSpotifyCacheRecordAtomic(userId, cacheKey, cachedRecord)
      }

      let currentAccessToken = accessToken

      const callPlaylists = async (token, { offset: pageOffset }) => {
        const apiUrl = new URL('https://api.spotify.com/v1/me/playlists')
        apiUrl.searchParams.set('limit', String(limit))
        apiUrl.searchParams.set('offset', String(pageOffset))
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
                'description',
                'images',
                'owner(id,display_name)',
                'tracks(total)',
                'public',
                'collaborative',
                'external_urls(spotify)',
                'snapshot_id',
              ].join(',') +
            ')',
          ].join(','),
        )

        const response = await fetch(apiUrl.toString(), {
          headers: { authorization: `Bearer ${token}` },
        })

        let data
        try {
          data = await response.json()
        } catch {
          data = null
        }

        const retryAfterSeconds = getRetryAfterSeconds(response.headers)
        const wwwAuthenticate = response.headers.get('www-authenticate')
        const requestId = response.headers.get('x-request-id')
        if (!response.ok) {
          logSpotifyFailure({
            label: 'GET /v1/me/playlists',
            url: apiUrl.toString(),
            status: response.status,
            retryAfterSeconds,
            wwwAuthenticate,
            requestId,
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

        const items = Array.isArray(first.data?.items) ? first.data.items.slice() : []
        const total = Number(first.data?.total) || items.length
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
          items.push(...pageItems)
          if (pageItems.length === 0) break
          nextOffset += pageItems.length
          pagesFetched += 1
        }

        const payload = { ...first.data, items, offset: 0, limit, total }
        if (canUseServerCache) {
          const storedAt = new Date().toISOString()
          writeSpotifyCacheRecordAtomic(userId, cacheKey, {
            schemaVersion: 1,
            userId,
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
    const clientId = process.env.SPOTIFY_CLIENT_ID
    const accessToken = cookies.sp_access
    const refreshToken = cookies.sp_refresh
    const userId = typeof cookies.sp_user_id === 'string' ? cookies.sp_user_id : null
    const owner = userId ? isOwnerUser(userId) : false

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
      const cacheKey = `track_${trackId}_artists`
      const cachedRecord = readSpotifyCacheRecord(userId, cacheKey)
      if (cachedRecord) {
        res.setHeader('x-sp-cache', 'hit')
        res.setHeader('x-sp-cache-fetched-at', cachedRecord.fetchedAt)
        sendJson(res, 200, { artists: cachedRecord.data?.artists ?? [] })
        return
      }

      if (!owner) {
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
      }

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
        const response = await fetch(apiUrl, { headers: { authorization: `Bearer ${token}` } })

        let data
        try {
          data = await response.json()
        } catch {
          data = null
        }

        const retryAfterSeconds = getRetryAfterSeconds(response.headers)
        const wwwAuthenticate = response.headers.get('www-authenticate')
        const requestId = response.headers.get('x-request-id')
        if (!response.ok) {
          logSpotifyFailure({
            label: 'GET /v1/tracks/:id',
            url: apiUrl,
            status: response.status,
            retryAfterSeconds,
            wwwAuthenticate,
            requestId,
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

        const storedAt = new Date().toISOString()
        writeSpotifyCacheRecordAtomic(userId, cacheKey, {
          schemaVersion: 1,
          userId,
          cacheKey,
          fetchedAt: storedAt,
          lastRefreshedAt: storedAt,
          data: { artists },
        })

        res.setHeader('x-sp-cache', 'miss_stored')
        res.setHeader('x-sp-cache-fetched-at', storedAt)
        sendJson(res, 200, { artists })
      } finally {
        if (lockTaken) spotifyRefreshInFlight.delete(lockKey)
      }
    })()

    return
  }

  if (req.method === 'GET' && url.pathname.startsWith('/artist-image/')) {
    const clientId = process.env.SPOTIFY_CLIENT_ID
    const accessToken = cookies.sp_access
    const refreshToken = cookies.sp_refresh
    const userId = typeof cookies.sp_user_id === 'string' ? cookies.sp_user_id : null
    const owner = userId ? isOwnerUser(userId) : false

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
      const cacheKey = `artist_${artistId}_image`
      const cachedRecord = readSpotifyCacheRecord(userId, cacheKey)
      const cachedFetchedAtMs = cachedRecord ? Date.parse(cachedRecord.fetchedAt) : NaN
      const cachedImageUrl = cachedRecord?.data?.imageUrl ?? null
      const nowMs = Date.now()

      const isStale =
        !cachedRecord ||
        !Number.isFinite(cachedFetchedAtMs) ||
        nowMs - cachedFetchedAtMs >= ARTIST_IMAGE_REFRESH_MS ||
        (!cachedImageUrl && Number.isFinite(cachedFetchedAtMs) && nowMs - cachedFetchedAtMs >= ARTIST_IMAGE_NULL_RETRY_MS)

      if (cachedRecord && !isStale) {
        res.setHeader('x-sp-cache', 'hit')
        res.setHeader('x-sp-cache-fetched-at', cachedRecord.fetchedAt)
        sendJson(res, 200, { imageUrl: cachedImageUrl })
        return
      }

      if (!owner) {
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
      }

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
        const response = await fetch(apiUrl, { headers: { authorization: `Bearer ${token}` } })

        let data
        try {
          data = await response.json()
        } catch {
          data = null
        }

        const retryAfterSeconds = getRetryAfterSeconds(response.headers)
        const wwwAuthenticate = response.headers.get('www-authenticate')
        const requestId = response.headers.get('x-request-id')
        if (!response.ok) {
          logSpotifyFailure({
            label: 'GET /v1/artists/:id',
            url: apiUrl,
            status: response.status,
            retryAfterSeconds,
            wwwAuthenticate,
            requestId,
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
        writeSpotifyCacheRecordAtomic(userId, cacheKey, {
          schemaVersion: 1,
          userId,
          cacheKey,
          fetchedAt: storedAt,
          lastRefreshedAt: storedAt,
          data: { imageUrl },
        })

        res.setHeader('x-sp-cache', cachedRecord ? 'refreshed' : 'miss_stored')
        res.setHeader('x-sp-cache-fetched-at', storedAt)
        sendJson(res, 200, { imageUrl })
      } finally {
        if (lockTaken) spotifyRefreshInFlight.delete(lockKey)
      }
    })()

    return
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/playlists/') && url.pathname.endsWith('/tracks')) {
    const clientId = process.env.SPOTIFY_CLIENT_ID
    const accessToken = cookies.sp_access
    const refreshToken = cookies.sp_refresh
    const userId = typeof cookies.sp_user_id === 'string' ? cookies.sp_user_id : null
    const owner = userId ? isOwnerUser(userId) : false

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

    ;(async () => {
      const canUseServerCache = Boolean(all && userId)
      const cacheKey = `playlist_${playlistId}_tracks_all`
      const nowMs = Date.now()
      let cachedRecord = canUseServerCache ? readSpotifyCacheRecord(userId, cacheKey) : null
      const lockKey = canUseServerCache ? `${userId}:${cacheKey}` : null
      let lockTaken = false

      if (canUseServerCache && cachedRecord) {
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
        writeSpotifyCacheRecordAtomic(userId, cacheKey, cachedRecord)
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
                    'album(name)',
                  ].join(',') +
                ')',
              ].join(',') +
            ')',
          ].join(','),
        )

        const response = await fetch(apiUrl.toString(), {
          headers: { authorization: `Bearer ${token}` },
        })

        let data
        try {
          data = await response.json()
        } catch {
          data = null
        }

        const retryAfterSeconds = getRetryAfterSeconds(response.headers)
        const wwwAuthenticate = response.headers.get('www-authenticate')
        const requestId = response.headers.get('x-request-id')
        if (!response.ok) {
          logSpotifyFailure({
            label: 'GET /v1/playlists/:id/items',
            url: apiUrl.toString(),
            status: response.status,
            retryAfterSeconds,
            wwwAuthenticate,
            requestId,
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
          writeSpotifyCacheRecordAtomic(userId, cacheKey, {
            schemaVersion: 1,
            userId,
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
