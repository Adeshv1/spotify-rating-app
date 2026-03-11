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

function normalizeString(value) {
  if (typeof value !== 'string') return ''
  return value.trim().replaceAll(/\s+/g, ' ')
}

function normalizeAlbumMembership(value) {
  const albumId = typeof value?.albumId === 'string' && value.albumId ? value.albumId : null
  const album = typeof value?.album === 'string' && value.album.trim() ? value.album : null
  const albumTrackCount = Number.isFinite(value?.albumTrackCount) ? value.albumTrackCount : null
  if (!albumId && !album) return null
  return { albumId, album, albumTrackCount }
}

function albumMembershipKey(value) {
  const membership = normalizeAlbumMembership(value)
  if (!membership) return ''
  if (membership.albumId) return `id:${membership.albumId}`
  return `name:${normalizeString(membership.album).toLowerCase()}`
}

function mergeAlbumMemberships(existingTrack, incomingTrack) {
  const map = new Map()

  const addMembership = (value) => {
    const membership = normalizeAlbumMembership(value)
    if (!membership) return
    const key = albumMembershipKey(membership)
    const prev = map.get(key) || null
    map.set(key, {
      albumId: membership.albumId || prev?.albumId || null,
      album: membership.album || prev?.album || null,
      albumTrackCount: Number.isFinite(membership.albumTrackCount)
        ? membership.albumTrackCount
        : Number.isFinite(prev?.albumTrackCount)
          ? prev.albumTrackCount
          : null,
    })
  }

  const addTrackMemberships = (track) => {
    if (!track || typeof track !== 'object') return
    if (Array.isArray(track.albumMemberships)) {
      track.albumMemberships.forEach(addMembership)
    }
    addMembership(track)
  }

  addTrackMemberships(existingTrack)
  addTrackMemberships(incomingTrack)
  return Array.from(map.values())
}

function pickPrimaryAlbumMembership(existingTrack, incomingTrack, memberships) {
  const preferredKeys = [
    albumMembershipKey(existingTrack),
    albumMembershipKey(incomingTrack),
  ].filter(Boolean)

  for (const preferredKey of preferredKeys) {
    const match = memberships.find((membership) => albumMembershipKey(membership) === preferredKey)
    if (match) return match
  }

  return memberships.find((membership) => membership.albumId) || memberships[0] || null
}

function normalizeGlobalSongItem(track) {
  if (!track || typeof track !== 'object') return null
  const memberships = mergeAlbumMemberships(null, track)
  const primaryMembership = pickPrimaryAlbumMembership(track, null, memberships)

  return {
    id: typeof track?.id === 'string' ? track.id : null,
    name: typeof track?.name === 'string' ? track.name : null,
    artists: Array.isArray(track?.artists) ? track.artists.filter(Boolean) : [],
    albumMemberships: memberships,
    albumId: primaryMembership?.albumId ?? null,
    album: primaryMembership?.album ?? null,
    albumTrackCount: Number.isFinite(primaryMembership?.albumTrackCount)
      ? primaryMembership.albumTrackCount
      : null,
    durationMs: Number.isFinite(track?.durationMs) ? track.durationMs : null,
    explicit: typeof track?.explicit === 'boolean' ? track.explicit : null,
    externalUrl: typeof track?.externalUrl === 'string' ? track.externalUrl : null,
  }
}

export function readGlobalSongs(userId) {
  if (!userId) return null
  const raw = localStorage.getItem(keyForUserGlobalSongs(userId))
  if (!raw) return null
  const parsed = safeJsonParse(raw)
  if (!parsed || parsed?.schemaVersion !== SCHEMA_VERSION) return null
  if (!parsed?.items || typeof parsed.items !== 'object') return null

  const items = {}
  for (const [key, value] of Object.entries(parsed.items)) {
    const normalized = normalizeGlobalSongItem(value)
    if (!normalized) continue
    items[key] = normalized
  }

  return {
    ...parsed,
    total: Object.keys(items).length,
    items,
  }
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
    const existingTrack = normalizeGlobalSongItem(items[id])
    if (!existingTrack) added += 1

    const albumMemberships = mergeAlbumMemberships(existingTrack, track)
    const primaryMembership = pickPrimaryAlbumMembership(existingTrack, track, albumMemberships)

    items[id] = {
      id,
      name: typeof track?.name === 'string'
        ? track.name
        : typeof existingTrack?.name === 'string'
          ? existingTrack.name
          : null,
      artists: Array.isArray(track?.artists) && track.artists.length
        ? track.artists.filter(Boolean)
        : Array.isArray(existingTrack?.artists)
          ? existingTrack.artists
          : [],
      albumMemberships,
      albumId: primaryMembership?.albumId ?? null,
      album: primaryMembership?.album ?? null,
      albumTrackCount: Number.isFinite(primaryMembership?.albumTrackCount)
        ? primaryMembership.albumTrackCount
        : null,
      durationMs: Number.isFinite(track?.durationMs)
        ? track.durationMs
        : Number.isFinite(existingTrack?.durationMs)
          ? existingTrack.durationMs
          : null,
      explicit: typeof track?.explicit === 'boolean'
        ? track.explicit
        : typeof existingTrack?.explicit === 'boolean'
          ? existingTrack.explicit
          : null,
      externalUrl: typeof track?.externalUrl === 'string'
        ? track.externalUrl
        : typeof existingTrack?.externalUrl === 'string'
          ? existingTrack.externalUrl
          : null,
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
