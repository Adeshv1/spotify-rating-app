const SCHEMA_VERSION = 1
const KEY = `sp_cache_v${SCHEMA_VERSION}_me_profile`

function safeJsonParse(value) {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

export function readMeCache() {
  const raw = localStorage.getItem(KEY)
  if (!raw) return null
  const parsed = safeJsonParse(raw)
  if (!parsed || parsed?.schemaVersion !== SCHEMA_VERSION) return null
  if (typeof parsed?.fetchedAt !== 'string') return null
  if (!parsed?.profile || typeof parsed.profile !== 'object') return null
  return parsed
}

export function writeMeCache(profile, { fetchedAt = new Date().toISOString() } = {}) {
  if (!profile || typeof profile !== 'object') return
  const record = { schemaVersion: SCHEMA_VERSION, fetchedAt, profile }
  try {
    localStorage.setItem(KEY, JSON.stringify(record))
  } catch {
    // ignore
  }
}

export function clearMeCache() {
  localStorage.removeItem(KEY)
}

