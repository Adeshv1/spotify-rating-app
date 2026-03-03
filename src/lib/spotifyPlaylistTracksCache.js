const SCHEMA_VERSION = 1

function keyForPlaylistTracks(userId, playlistId) {
  return `sp_cache_v${SCHEMA_VERSION}_playlist_tracks_${userId}_${playlistId}`
}

function keyForPlaylistTracksMeta(userId, playlistId) {
  return `sp_cache_v${SCHEMA_VERSION}_playlist_tracks_meta_${userId}_${playlistId}`
}

function keyForPlaylistTracksError(userId, playlistId) {
  return `sp_cache_v${SCHEMA_VERSION}_playlist_tracks_error_${userId}_${playlistId}`
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function pickTrackItem(item) {
  if (!item || typeof item !== 'object') return null
  const entry =
    item.item && typeof item.item === 'object'
      ? item.item
      : item.track && typeof item.track === 'object'
        ? item.track
        : null
  if (!entry) return null

  if (typeof entry.type === 'string' && entry.type !== 'track') return null

  const artists = Array.isArray(entry.artists) ? entry.artists : []
  return {
    addedAt: typeof item.added_at === 'string' ? item.added_at : null,
    id: entry.id ?? null,
    name: entry.name ?? null,
    artists: artists.map((a) => a?.name).filter(Boolean),
    album: typeof entry.album?.name === 'string' ? entry.album.name : null,
    durationMs: typeof entry.duration_ms === 'number' ? entry.duration_ms : null,
    explicit: typeof entry.explicit === 'boolean' ? entry.explicit : null,
    externalUrl: entry.external_urls?.spotify ?? null,
  }
}

function computeLatestAddedAt(items) {
  let latest = null
  for (const item of items) {
    if (!item?.addedAt) continue
    if (!latest || Date.parse(item.addedAt) > Date.parse(latest)) latest = item.addedAt
  }
  return latest
}

export function readPlaylistTracksCache(userId, playlistId) {
  if (!userId || !playlistId) return null
  const raw = localStorage.getItem(keyForPlaylistTracks(userId, playlistId))
  if (!raw) return null

  const parsed = safeJsonParse(raw)
  if (!parsed || parsed?.schemaVersion !== SCHEMA_VERSION) return null
  if (typeof parsed?.fetchedAt !== 'string') return null
  if (!Array.isArray(parsed?.items)) return null
  return parsed
}

export function readPlaylistTracksCacheMeta(userId, playlistId) {
  if (!userId || !playlistId) return null
  const raw = localStorage.getItem(keyForPlaylistTracksMeta(userId, playlistId))
  if (!raw) return null
  const parsed = safeJsonParse(raw)
  if (!parsed || parsed?.schemaVersion !== SCHEMA_VERSION) return null
  return parsed
}

export function readPlaylistTracksErrorCache(userId, playlistId) {
  if (!userId || !playlistId) return null
  const raw = localStorage.getItem(keyForPlaylistTracksError(userId, playlistId))
  if (!raw) return null
  const parsed = safeJsonParse(raw)
  if (!parsed || parsed?.schemaVersion !== SCHEMA_VERSION) return null
  if (typeof parsed?.fetchedAt !== 'string') return null
  if (typeof parsed?.status !== 'number') return null
  return parsed
}

export function writePlaylistTracksErrorCache(userId, playlistId, { status, message, fetchedAt = new Date().toISOString() } = {}) {
  if (!userId || !playlistId) return
  if (typeof status !== 'number') return
  const record = { schemaVersion: SCHEMA_VERSION, playlistId, fetchedAt, status, message: message ?? null }
  try {
    localStorage.setItem(keyForPlaylistTracksError(userId, playlistId), JSON.stringify(record))
  } catch {
    // ignore
  }
}

export function writePlaylistTracksCache(
  userId,
  playlistId,
  apiResponse,
  { fetchedAt = new Date().toISOString(), isComplete = false } = {},
) {
  if (!userId || !playlistId) return

  const items = Array.isArray(apiResponse?.items) ? apiResponse.items.map(pickTrackItem).filter(Boolean) : []
  const total = Number(apiResponse?.total) || items.length
  const snapshotId = typeof apiResponse?.snapshot_id === 'string' ? apiResponse.snapshot_id : null
  const latestAddedAt = computeLatestAddedAt(items)

  const record = {
    schemaVersion: SCHEMA_VERSION,
    playlistId,
    fetchedAt,
    total,
    isComplete: Boolean(isComplete),
    snapshotId,
    latestAddedAt,
    items,
  }

  try {
    localStorage.setItem(keyForPlaylistTracks(userId, playlistId), JSON.stringify(record))
    localStorage.removeItem(keyForPlaylistTracksError(userId, playlistId))
    localStorage.setItem(
      keyForPlaylistTracksMeta(userId, playlistId),
      JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        playlistId,
        fetchedAt,
        total,
        isComplete: Boolean(isComplete),
        snapshotId,
        latestAddedAt,
      }),
    )
  } catch {
    // Quota fallback: cache only minimal fields.
    const minimal = {
      ...record,
      items: items.map((t) => ({ addedAt: t.addedAt, id: t.id, name: t.name, artists: t.artists })),
    }
    try {
      localStorage.setItem(keyForPlaylistTracks(userId, playlistId), JSON.stringify(minimal))
      localStorage.removeItem(keyForPlaylistTracksError(userId, playlistId))
      localStorage.setItem(
        keyForPlaylistTracksMeta(userId, playlistId),
        JSON.stringify({
          schemaVersion: SCHEMA_VERSION,
          playlistId,
          fetchedAt,
          total,
          isComplete: Boolean(isComplete),
          snapshotId,
          latestAddedAt,
        }),
      )
    } catch {
      // ignore
    }
  }
}

export function clearPlaylistTracksCache(userId, playlistId) {
  if (!userId || !playlistId) return
  localStorage.removeItem(keyForPlaylistTracks(userId, playlistId))
  localStorage.removeItem(keyForPlaylistTracksMeta(userId, playlistId))
  localStorage.removeItem(keyForPlaylistTracksError(userId, playlistId))
}
