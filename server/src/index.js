import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
    sendJson(res, 200, { loggedIn, scopes, user })
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
            sendJson(res, page.status, { error: 'spotify_playlists_failed', details: page.data, retryAfterSeconds: page.retryAfterSeconds, partial: { items, total, nextOffset } })
            return
          }

          const pageItems = Array.isArray(page.data?.items) ? page.data.items : []
          items.push(...pageItems)
          if (pageItems.length === 0) break
          nextOffset += pageItems.length
          pagesFetched += 1
        }

        sendJson(res, 200, { ...first.data, items, offset: 0, limit, total })
      } catch (error) {
        sendJson(res, 500, { error: 'spotify_playlists_failed', message: error?.message })
      }
    })()

    return
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/playlists/') && url.pathname.endsWith('/tracks')) {
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
                    'artists(name)',
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
            sendJson(res, page.status, { error: 'spotify_playlist_tracks_failed', details: page.data, retryAfterSeconds: page.retryAfterSeconds, partial: { items, total, nextOffset } })
            return
          }

          const pageItems = Array.isArray(page.data?.items) ? page.data.items : []
          items.push(...pageItems)
          if (pageItems.length === 0) break
          nextOffset += pageItems.length
          pagesFetched += 1
        }

        sendJson(res, 200, { ...first.data, items, offset: 0, limit, total })
      } catch (error) {
        sendJson(res, 500, { error: 'spotify_playlist_tracks_failed', message: error?.message })
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
