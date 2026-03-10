const SCHEMA_VERSION = 1

function keyForUserGlobalSongs(userId) {
  return `sp_global_songs_v${SCHEMA_VERSION}_${userId}`
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

export function readGlobalSongs(userId) {
  if (!userId) return null
  const raw = localStorage.getItem(keyForUserGlobalSongs(userId))
  if (!raw) return null
  const parsed = safeJsonParse(raw)
  if (!parsed || parsed?.schemaVersion !== SCHEMA_VERSION) return null
  if (!parsed?.items || typeof parsed.items !== 'object') return null
  return parsed
}

export function writeGlobalSongs(userId, record) {
  if (!userId || !record) return
  try {
    localStorage.setItem(keyForUserGlobalSongs(userId), JSON.stringify(record))
  } catch {
    // ignore
  }
}

export function upsertGlobalSongs(userId, tracks) {
  if (!userId || !Array.isArray(tracks) || tracks.length === 0) {
    return { added: 0, total: 0 }
  }

  const existing = readGlobalSongs(userId)
  const items = { ...(existing?.items ?? {}) }
  let added = 0

  for (const track of tracks) {
    const id = typeof track?.id === 'string' ? track.id : null
    if (!id) continue
    if (!items[id]) added += 1
    items[id] = {
      id,
      name: typeof track?.name === 'string' ? track.name : null,
      artists: Array.isArray(track?.artists) ? track.artists.filter(Boolean) : [],
      albumId: typeof track?.albumId === 'string' ? track.albumId : (typeof items[id]?.albumId === 'string' ? items[id].albumId : null),
      album: typeof track?.album === 'string' ? track.album : null,
      albumTrackCount: Number.isFinite(track?.albumTrackCount)
        ? track.albumTrackCount
        : Number.isFinite(items[id]?.albumTrackCount)
          ? items[id].albumTrackCount
          : null,
      durationMs: Number.isFinite(track?.durationMs) ? track.durationMs : null,
      explicit: typeof track?.explicit === 'boolean' ? track.explicit : null,
      externalUrl: typeof track?.externalUrl === 'string' ? track.externalUrl : null,
    }
  }

  const next = {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    total: Object.keys(items).length,
    items,
  }

  writeGlobalSongs(userId, next)
  return { added, total: next.total }
}
