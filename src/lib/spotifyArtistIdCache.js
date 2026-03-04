const SCHEMA_VERSION = 1

function storageKey(userId) {
  return `sp_cache_v${SCHEMA_VERSION}_artist_ids_by_name_${userId}`
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

export function readArtistIdByNameCache(userId) {
  if (!userId) return null
  const raw = localStorage.getItem(storageKey(userId))
  if (!raw) return null

  const parsed = safeJsonParse(raw)
  if (!parsed || parsed?.schemaVersion !== SCHEMA_VERSION) return null
  if (parsed?.userId !== userId) return null
  if (!parsed?.items || typeof parsed.items !== 'object') return null
  return parsed
}

export function mergeArtistIdByNameCache(userId, updates) {
  if (!userId) return
  if (!updates || typeof updates !== 'object') return

  const existing = readArtistIdByNameCache(userId)
  const nextItems = { ...(existing?.items || {}) }

  let changed = false
  for (const [nameKey, artistId] of Object.entries(updates)) {
    if (typeof nameKey !== 'string' || !nameKey) continue
    if (typeof artistId !== 'string' || !artistId) continue
    if (nextItems[nameKey] === artistId) continue
    nextItems[nameKey] = artistId
    changed = true
  }

  if (!changed) return

  const record = {
    schemaVersion: SCHEMA_VERSION,
    userId,
    updatedAt: new Date().toISOString(),
    items: nextItems,
  }

  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(record))
  } catch {
    // ignore
  }
}

