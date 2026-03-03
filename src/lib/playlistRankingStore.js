import { updateElo } from './elo'

const SCHEMA_VERSION = 1

export const BUCKETS = /** @type {const} */ (['S', 'A', 'B', 'C', 'D', 'U', 'X'])
export const TIER_BUCKETS = /** @type {const} */ (['S', 'A', 'B', 'C', 'D'])
export const DUEL_BUCKET_ORDER = /** @type {const} */ (['S', 'A', 'B', 'C', 'D', 'U'])

function storageKey(userId, playlistId) {
  return `sp_rank_v${SCHEMA_VERSION}_${userId}_${playlistId}`
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

export function trackKeyOfTrack(track) {
  const id = typeof track?.id === 'string' ? track.id : null
  if (id) return `spid:${id}`

  const name = normalizeString(track?.name)
  const artists = Array.isArray(track?.artists) ? track.artists.map(normalizeString).filter(Boolean).join(',') : ''
  const album = normalizeString(track?.album)
  const duration = Number.isFinite(track?.durationMs) ? String(track.durationMs) : ''
  const seed = [name, artists, album, duration].join('|')
  return `meta:${seed || 'unknown'}`
}

export function createEmptyPlaylistRanking({ userId, playlistId }) {
  const now = new Date().toISOString()
  return {
    schemaVersion: SCHEMA_VERSION,
    userId,
    playlistId,
    createdAt: now,
    updatedAt: now,
    tracks: {},
    history: [],
  }
}

export function readPlaylistRanking(userId, playlistId) {
  if (!userId || !playlistId) return null
  const raw = localStorage.getItem(storageKey(userId, playlistId))
  if (!raw) return null

  const parsed = safeJsonParse(raw)
  if (!parsed || parsed.schemaVersion !== SCHEMA_VERSION) return null
  if (parsed.userId !== userId || parsed.playlistId !== playlistId) return null
  if (!parsed.tracks || typeof parsed.tracks !== 'object') return null
  if (!Array.isArray(parsed.history)) return null
  return parsed
}

export function writePlaylistRanking(userId, playlistId, ranking) {
  if (!userId || !playlistId) return
  if (!ranking || typeof ranking !== 'object') return
  try {
    localStorage.setItem(storageKey(userId, playlistId), JSON.stringify(ranking))
  } catch {
    // ignore
  }
}

function defaultTrackState() {
  return { bucket: 'U', rating: 1000, games: 0, wins: 0, losses: 0, lastComparedAt: null }
}

export function getTrackState(ranking, trackKey) {
  const existing = ranking?.tracks?.[trackKey]
  if (!existing || typeof existing !== 'object') return defaultTrackState()
  const bucket = typeof existing.bucket === 'string' && BUCKETS.includes(existing.bucket) ? existing.bucket : 'U'
  const rating = Number.isFinite(existing.rating) ? existing.rating : 1000
  const games = Number.isFinite(existing.games) ? existing.games : 0
  const wins = Number.isFinite(existing.wins) ? existing.wins : 0
  const losses = Number.isFinite(existing.losses) ? existing.losses : 0
  const lastComparedAt = typeof existing.lastComparedAt === 'string' ? existing.lastComparedAt : null
  return { bucket, rating, games, wins, losses, lastComparedAt }
}

function withUpdatedAt(ranking) {
  return { ...ranking, updatedAt: new Date().toISOString() }
}

export function setTrackBucket(ranking, trackKey, bucket) {
  const nextBucket = typeof bucket === 'string' && BUCKETS.includes(bucket) ? bucket : 'U'
  const prev = getTrackState(ranking, trackKey)
  const next = withUpdatedAt({
    ...ranking,
    tracks: {
      ...ranking.tracks,
      [trackKey]: { ...prev, bucket: nextBucket },
    },
  })
  return next
}

export function excludeTrack(ranking, trackKey) {
  return setTrackBucket(ranking, trackKey, 'X')
}

export function recordDuel(ranking, { leftKey, rightKey, winnerKey, kFactor = 24 }) {
  if (!leftKey || !rightKey || leftKey === rightKey) return ranking
  const at = new Date().toISOString()

  const leftPrev = getTrackState(ranking, leftKey)
  const rightPrev = getTrackState(ranking, rightKey)

  const scoreLeft = winnerKey === leftKey ? 1 : 0
  const { nextA: leftRating, nextB: rightRating } = updateElo({
    ratingA: leftPrev.rating,
    ratingB: rightPrev.rating,
    scoreA: scoreLeft,
    kFactor,
  })

  const leftNext = {
    ...leftPrev,
    rating: leftRating,
    games: leftPrev.games + 1,
    wins: leftPrev.wins + (winnerKey === leftKey ? 1 : 0),
    losses: leftPrev.losses + (winnerKey === rightKey ? 1 : 0),
    lastComparedAt: at,
  }
  const rightNext = {
    ...rightPrev,
    rating: rightRating,
    games: rightPrev.games + 1,
    wins: rightPrev.wins + (winnerKey === rightKey ? 1 : 0),
    losses: rightPrev.losses + (winnerKey === leftKey ? 1 : 0),
    lastComparedAt: at,
  }

  const historyItem = {
    at,
    type: 'duel',
    leftKey,
    rightKey,
    winnerKey,
    prev: { left: leftPrev, right: rightPrev },
    next: { left: leftNext, right: rightNext },
  }

  return withUpdatedAt({
    ...ranking,
    tracks: {
      ...ranking.tracks,
      [leftKey]: leftNext,
      [rightKey]: rightNext,
    },
    history: ranking.history.concat(historyItem),
  })
}

export function undoLast(ranking) {
  const last = ranking?.history?.length ? ranking.history[ranking.history.length - 1] : null
  if (!last || last.type !== 'duel') return ranking

  const nextHistory = ranking.history.slice(0, -1)

  return withUpdatedAt({
    ...ranking,
    tracks: {
      ...ranking.tracks,
      [last.leftKey]: last.prev.left,
      [last.rightKey]: last.prev.right,
    },
    history: nextHistory,
  })
}
