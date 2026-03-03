const SCHEMA_VERSION = 1

function keyForUserPlaylists(userId) {
  return `sp_cache_v${SCHEMA_VERSION}_me_playlists_${userId}`
}

function cooldownKeyForUser(userId) {
  return `sp_cache_v${SCHEMA_VERSION}_cooldown_${userId}`
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function pickPlaylist(item) {
  if (!item || typeof item !== 'object') return null
  return {
    id: item.id ?? null,
    name: item.name ?? null,
    description: item.description ?? null,
    images: Array.isArray(item.images) ? item.images : [],
    snapshotId: item.snapshot_id ?? null,
    owner: item.owner
      ? { id: item.owner.id ?? null, display_name: item.owner.display_name ?? null }
      : null,
    tracksTotal: item.tracks?.total ?? null,
    public: item.public ?? null,
    collaborative: item.collaborative ?? null,
    externalUrl: item.external_urls?.spotify ?? null,
  }
}

export function readPlaylistsCache(userId) {
  if (!userId) return null
  const raw = localStorage.getItem(keyForUserPlaylists(userId))
  if (!raw) return null

  const parsed = safeJsonParse(raw)
  if (!parsed || parsed?.schemaVersion !== SCHEMA_VERSION) return null
  if (typeof parsed?.fetchedAt !== 'string') return null
  if (!Array.isArray(parsed?.items)) return null

  return parsed
}

export function writePlaylistsCache(userId, apiResponse, { fetchedAt = new Date().toISOString(), isComplete = false } = {}) {
  if (!userId) return

  const items = Array.isArray(apiResponse?.items) ? apiResponse.items.map(pickPlaylist).filter(Boolean) : []
  const total = Number(apiResponse?.total) || items.length

  const record = {
    schemaVersion: SCHEMA_VERSION,
    fetchedAt,
    source: 'spotify_api',
    total,
    isComplete: Boolean(isComplete),
    items,
  }

  try {
    localStorage.setItem(keyForUserPlaylists(userId), JSON.stringify(record))
  } catch {
    // If storage quota is exceeded, fall back to caching a minimal subset (names/ids only).
    const minimal = {
      ...record,
      items: items.map((p) => ({ id: p.id, name: p.name, externalUrl: p.externalUrl })),
    }
    try {
      localStorage.setItem(keyForUserPlaylists(userId), JSON.stringify(minimal))
    } catch {
      // Give up silently; UI can still show the live data.
    }
  }
}

export function clearPlaylistsCache(userId) {
  if (!userId) return
  localStorage.removeItem(keyForUserPlaylists(userId))
}

function getSpotifyCooldownKey(userId) {
  return cooldownKeyForUser(userId)
}

export function getSpotifyCooldownUntil(userId) {
  if (!userId) return null
  const raw = localStorage.getItem(getSpotifyCooldownKey(userId))
  if (!raw) return null
  const parsed = safeJsonParse(raw)
  const ms = typeof parsed?.cooldownUntilMs === 'number' ? parsed.cooldownUntilMs : null
  return Number.isFinite(ms) ? ms : null
}

export function setSpotifyCooldown(userId, cooldownUntilMs) {
  if (!userId) return
  try {
    localStorage.setItem(getSpotifyCooldownKey(userId), JSON.stringify({ cooldownUntilMs }))
  } catch {
    // ignore
  }
}

// Backwards-compatible aliases (older code paths)
export function getPlaylistsCooldownUntil(userId) {
  return getSpotifyCooldownUntil(userId)
}

export function setPlaylistsCooldown(userId, cooldownUntilMs) {
  setSpotifyCooldown(userId, cooldownUntilMs)
}

export function formatDateTime(isoString) {
  try {
    return new Date(isoString).toLocaleString()
  } catch {
    return isoString
  }
}

export function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown'
  if (ms < 15_000) return 'just now'
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  if (ms < 60 * 60_000) return `${Math.floor(ms / 60_000)}m`
  if (ms < 24 * 60 * 60_000) return `${Math.floor(ms / (60 * 60_000))}h`
  return `${Math.floor(ms / (24 * 60 * 60_000))}d`
}
