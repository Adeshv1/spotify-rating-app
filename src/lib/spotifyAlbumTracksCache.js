const SCHEMA_VERSION = 1

function keyForAlbumTracks(userId, albumId) {
  return `sp_cache_v${SCHEMA_VERSION}_album_tracks_${userId}_${albumId}`
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

export function readAlbumTracksCache(userId, albumId) {
  if (!userId || !albumId) return null
  const raw = localStorage.getItem(keyForAlbumTracks(userId, albumId))
  if (!raw) return null
  const parsed = safeJsonParse(raw)
  if (!parsed || parsed?.schemaVersion !== SCHEMA_VERSION) return null
  if (typeof parsed?.fetchedAt !== 'string') return null
  if (!Array.isArray(parsed?.items)) return null
  return parsed
}

export function writeAlbumTracksCache(
  userId,
  albumId,
  albumName,
  apiResponse,
  { fetchedAt = new Date().toISOString() } = {},
) {
  if (!userId || !albumId) return

  const items = Array.isArray(apiResponse?.items)
    ? apiResponse.items
        .map((item) => ({
          id: typeof item?.id === 'string' ? item.id : null,
          name: typeof item?.name === 'string' ? item.name : null,
          artists: Array.isArray(item?.artists)
            ? item.artists.map((artist) => (typeof artist?.name === 'string' ? artist.name : null)).filter(Boolean)
            : [],
          artistIds: Array.isArray(item?.artists)
            ? item.artists.map((artist) => (typeof artist?.id === 'string' ? artist.id : null))
            : [],
          albumId,
          album: typeof albumName === 'string' ? albumName : null,
          albumTrackCount: Number.isFinite(apiResponse?.total) ? apiResponse.total : null,
          durationMs: Number.isFinite(item?.duration_ms) ? item.duration_ms : null,
          explicit: typeof item?.explicit === 'boolean' ? item.explicit : null,
          externalUrl: item?.external_urls?.spotify ?? null,
          trackNumber: Number.isFinite(item?.track_number) ? item.track_number : null,
          discNumber: Number.isFinite(item?.disc_number) ? item.disc_number : null,
        }))
        .filter((item) => item.id || item.name)
    : []

  const record = {
    schemaVersion: SCHEMA_VERSION,
    albumId,
    albumName: typeof albumName === 'string' ? albumName : null,
    fetchedAt,
    total: Number.isFinite(apiResponse?.total) ? apiResponse.total : items.length,
    items,
  }

  try {
    localStorage.setItem(keyForAlbumTracks(userId, albumId), JSON.stringify(record))
  } catch {
    // ignore
  }

  return record
}
