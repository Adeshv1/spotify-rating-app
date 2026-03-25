import { updateElo } from './elo'

const SCHEMA_VERSION = 1

export const BUCKETS = /** @type {const} */ (['S', 'A', 'B', 'C', 'D', 'U', 'X'])
export const TIER_BUCKETS = /** @type {const} */ (['S', 'A', 'B', 'C', 'D'])
export const DUEL_BUCKET_ORDER = /** @type {const} */ (['S', 'A', 'B', 'C', 'D', 'U'])

function storageKey(userId) {
  return `sp_rank_v${SCHEMA_VERSION}_user_${userId}`
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

function metaTrackKeyOfTrack(track, albumOverride = null) {
  const name = normalizeString(track?.name)
  const artists = Array.isArray(track?.artists) ? track.artists.map(normalizeString).filter(Boolean).join(',') : ''
  const album = albumOverride === null ? normalizeString(track?.album) : normalizeString(albumOverride)
  const duration = Number.isFinite(track?.durationMs) ? String(track.durationMs) : ''
  const seed = [name, artists, album, duration].join('|')
  return `meta:${seed || 'unknown'}`
}

export function songIdentityOfTrack(track) {
  const name = normalizeString(track?.name).toLowerCase()
  const artists = Array.isArray(track?.artists) ? track.artists.map(normalizeString).filter(Boolean).join(',').toLowerCase() : ''
  if (name && artists) return `song:${name}|${artists}`
  const durationSeconds = Number.isFinite(track?.durationMs) ? String(Math.round(track.durationMs / 1000)) : ''
  const seed = [name, artists, durationSeconds].filter(Boolean).join('|')
  return seed ? `song:${seed}` : trackKeyOfTrack(track)
}

export function trackKeyOfTrack(track) {
  const id = typeof track?.id === 'string' ? track.id : null
  if (id) return `spid:${id}`

  return metaTrackKeyOfTrack(track)
}

export function createEmptyUserRanking({ userId }) {
  const now = new Date().toISOString()
  return {
    schemaVersion: SCHEMA_VERSION,
    userId,
    createdAt: now,
    updatedAt: now,
    tracks: {},
    history: [],
    migratedPlaylists: {},
  }
}

export function readUserRanking(userId) {
  if (!userId) return null
  const raw = localStorage.getItem(storageKey(userId))
  if (!raw) return null

  const parsed = safeJsonParse(raw)
  if (!parsed || parsed.schemaVersion !== SCHEMA_VERSION) return null
  if (parsed.userId !== userId) return null
  if (!parsed.tracks || typeof parsed.tracks !== 'object') return null
  if (!Array.isArray(parsed.history)) return null
  return parsed
}

export function writeUserRanking(userId, ranking) {
  if (!userId) return
  if (!ranking || typeof ranking !== 'object') return
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(ranking))
  } catch {
    // ignore
  }
}

function defaultTrackState() {
  return { bucket: 'U', rating: 1000, games: 0, wins: 0, losses: 0, lastComparedAt: null }
}

function isDefaultTrackState(state) {
  return (
    state?.bucket === 'U' &&
    Math.round(Number(state?.rating) || 0) === 1000 &&
    Number(state?.games) === 0 &&
    Number(state?.wins) === 0 &&
    Number(state?.losses) === 0 &&
    state?.lastComparedAt === null
  )
}

function isRankedTrackState(state) {
  if (!state || typeof state !== 'object') return false
  if (state.bucket && state.bucket !== 'U' && state.bucket !== 'X') return true
  const rating = Number(state.rating)
  if (Number.isFinite(rating) && Math.round(rating) !== 1000) return true
  if (Number(state.games) > 0) return true
  return typeof state.lastComparedAt === 'string' && Boolean(state.lastComparedAt)
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

function trackMetaAliasesOfTrack(track) {
  const aliases = new Set()
  aliases.add(metaTrackKeyOfTrack(track))
  aliases.add(metaTrackKeyOfTrack(track, ''))

  const memberships = Array.isArray(track?.albumMemberships) ? track.albumMemberships : []
  for (const membership of memberships) {
    if (typeof membership?.album !== 'string') continue
    aliases.add(metaTrackKeyOfTrack(track, membership.album))
  }

  return Array.from(aliases).filter(Boolean)
}

function newerTimestamp(a, b) {
  if (a && b) return Date.parse(a) >= Date.parse(b) ? a : b
  return a ?? b ?? null
}

function mergeTrackStates(current, incoming) {
  const a = current || defaultTrackState()
  const b = incoming || defaultTrackState()
  const aRanked = isRankedTrackState(a)
  const bRanked = isRankedTrackState(b)

  if (isDefaultTrackState(a)) return { ...b }
  if (isDefaultTrackState(b)) return { ...a }

  if (b.games > a.games) {
    return {
      ...b,
      bucket: aRanked || bRanked ? (b.bucket === 'X' ? 'U' : b.bucket || 'U') : a.bucket === 'X' || b.bucket === 'X' ? 'X' : b.bucket !== 'U' ? b.bucket : a.bucket,
      lastComparedAt: newerTimestamp(a.lastComparedAt, b.lastComparedAt),
    }
  }

  if (a.games > b.games) {
    return {
      ...a,
      bucket: aRanked || bRanked ? (a.bucket === 'X' ? 'U' : a.bucket || 'U') : a.bucket === 'X' || b.bucket === 'X' ? 'X' : a.bucket !== 'U' ? a.bucket : b.bucket,
      lastComparedAt: newerTimestamp(a.lastComparedAt, b.lastComparedAt),
    }
  }

  return {
    ...a,
    bucket:
      aRanked || bRanked
        ? aRanked && a.bucket !== 'X'
          ? a.bucket
          : bRanked && b.bucket !== 'X'
            ? b.bucket
            : 'U'
        : a.bucket === 'X' || b.bucket === 'X'
          ? 'X'
          : a.bucket !== 'U'
            ? a.bucket
            : b.bucket !== 'U'
              ? b.bucket
              : 'U',
    rating: Math.max(a.rating, b.rating),
    wins: Math.max(a.wins, b.wins),
    losses: Math.max(a.losses, b.losses),
    lastComparedAt: newerTimestamp(a.lastComparedAt, b.lastComparedAt),
  }
}

function remapHistoryItem(item, keyMap) {
  if (!item || typeof item !== 'object') return item

  if (item.type === 'duel') {
    const leftKey = keyMap.get(item.leftKey) || item.leftKey
    const rightKey = keyMap.get(item.rightKey) || item.rightKey
    const winnerKey = keyMap.get(item.winnerKey) || item.winnerKey
    if (!leftKey || !rightKey || leftKey === rightKey) return null
    return { ...item, leftKey, rightKey, winnerKey }
  }

  if (item.type === 'manual_elo') {
    const trackKey = keyMap.get(item.trackKey) || item.trackKey
    if (!trackKey) return null
    return { ...item, trackKey }
  }

  return item
}

export function reconcileRankingTrackKeys(ranking, tracks) {
  if (!ranking || typeof ranking !== 'object') return ranking
  if (!Array.isArray(tracks) || tracks.length === 0) return ranking
  if (!ranking?.tracks || typeof ranking.tracks !== 'object') return ranking

  const nextTracks = { ...ranking.tracks }
  const keyMap = new Map()
  const groups = new Map()
  let changed = false

  for (const track of tracks) {
    const canonicalKey = trackKeyOfTrack(track)
    if (!canonicalKey) continue
    const identity = songIdentityOfTrack(track)
    const group = groups.get(identity) || new Set()
    group.add(canonicalKey)
    for (const aliasKey of trackMetaAliasesOfTrack(track)) {
      if (aliasKey) group.add(aliasKey)
    }
    groups.set(identity, group)
  }

  for (const keys of groups.values()) {
    const observedKeys = Array.from(keys).filter(Boolean)
    if (!observedKeys.length) continue

    const presentKeys = observedKeys.filter(trackKey => Object.hasOwn(nextTracks, trackKey))
    if (presentKeys.length === 0) continue

    const canonicalKey = observedKeys
      .slice()
      .sort((left, right) => {
        const leftState = Object.hasOwn(nextTracks, left) ? getTrackState({ tracks: nextTracks, history: [] }, left) : null
        const rightState = Object.hasOwn(nextTracks, right) ? getTrackState({ tracks: nextTracks, history: [] }, right) : null
        const leftRanked = isRankedTrackState(leftState)
        const rightRanked = isRankedTrackState(rightState)
        if (leftRanked !== rightRanked) return leftRanked ? -1 : 1
        const leftExcluded = leftState?.bucket === 'X'
        const rightExcluded = rightState?.bucket === 'X'
        if (leftExcluded !== rightExcluded) return leftExcluded ? -1 : 1
        const leftHasState = Object.hasOwn(nextTracks, left) && !isDefaultTrackState(leftState)
        const rightHasState = Object.hasOwn(nextTracks, right) && !isDefaultTrackState(rightState)
        if (leftHasState !== rightHasState) return leftHasState ? -1 : 1
        const leftSpid = left.startsWith('spid:')
        const rightSpid = right.startsWith('spid:')
        if (leftSpid !== rightSpid) return leftSpid ? -1 : 1
        return left.localeCompare(right, 'en', { numeric: true })
      })[0]

    let mergedState = null
    for (const trackKey of presentKeys) {
      const state = getTrackState({ tracks: nextTracks, history: [] }, trackKey)
      mergedState = mergedState ? mergeTrackStates(mergedState, state) : state
    }

    if (!mergedState) continue

    for (const trackKey of presentKeys) {
      if (trackKey === canonicalKey) continue
      delete nextTracks[trackKey]
      keyMap.set(trackKey, canonicalKey)
      changed = true
    }

    const currentCanonicalState = Object.hasOwn(nextTracks, canonicalKey)
      ? getTrackState({ tracks: nextTracks, history: [] }, canonicalKey)
      : null
    const nextCanonicalState = currentCanonicalState
      ? mergeTrackStates(currentCanonicalState, mergedState)
      : mergedState

    if (!currentCanonicalState || JSON.stringify(currentCanonicalState) !== JSON.stringify(nextCanonicalState)) {
      nextTracks[canonicalKey] = nextCanonicalState
      changed = true
    }
  }

  if (!changed) return ranking

  const history = Array.isArray(ranking.history)
    ? ranking.history.map(item => remapHistoryItem(item, keyMap)).filter(Boolean)
    : []

  return withUpdatedAt({
    ...ranking,
    tracks: nextTracks,
    history,
  })
}

export function setTrackBucket(ranking, trackKey, bucket) {
  const nextBucket = typeof bucket === 'string' && BUCKETS.includes(bucket) ? bucket : 'U'
  const prev = getTrackState(ranking, trackKey)
  return withUpdatedAt({
    ...ranking,
    tracks: {
      ...ranking.tracks,
      [trackKey]: { ...prev, bucket: nextBucket },
    },
  })
}

export function excludeTrack(ranking, trackKey) {
  return setTrackBucket(ranking, trackKey, 'X')
}

export function resetTrackState(ranking, trackKey) {
  if (!trackKey) return ranking
  if (!ranking?.tracks || typeof ranking.tracks !== 'object') return ranking
  if (!Object.hasOwn(ranking.tracks, trackKey)) return ranking

  const nextTracks = { ...ranking.tracks }
  delete nextTracks[trackKey]

  return withUpdatedAt({
    ...ranking,
    tracks: nextTracks,
  })
}

export function recordDuel(ranking, { leftKey, rightKey, winnerKey, kFactor = 24, context = null } = {}) {
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
    context,
    prev: { left: leftPrev, right: rightPrev },
    next: { left: leftNext, right: rightNext },
  }

  const maxHistory = 2500
  const nextHistory = ranking.history.length >= maxHistory ? ranking.history.slice(-maxHistory + 1).concat(historyItem) : ranking.history.concat(historyItem)

  return withUpdatedAt({
    ...ranking,
    tracks: {
      ...ranking.tracks,
      [leftKey]: leftNext,
      [rightKey]: rightNext,
    },
    history: nextHistory,
  })
}

export function setTrackElo(ranking, trackKey, rating) {
  if (!trackKey) return ranking
  const nextRating = Number(rating)
  if (!Number.isFinite(nextRating)) return ranking

  const at = new Date().toISOString()
  const prev = getTrackState(ranking, trackKey)
  const next = { ...prev, rating: nextRating, lastComparedAt: at }

  const historyItem = {
    at,
    type: 'manual_elo',
    trackKey,
    prev,
    next,
  }

  const maxHistory = 2500
  const nextHistory = ranking.history.length >= maxHistory ? ranking.history.slice(-maxHistory + 1).concat(historyItem) : ranking.history.concat(historyItem)

  return withUpdatedAt({
    ...ranking,
    tracks: {
      ...ranking.tracks,
      [trackKey]: next,
    },
    history: nextHistory,
  })
}

export function undoLast(ranking) {
  const last = ranking?.history?.length ? ranking.history[ranking.history.length - 1] : null
  if (!last) return ranking

  const nextHistory = ranking.history.slice(0, -1)

  if (last.type === 'duel') {
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

  if (last.type === 'manual_elo') {
    return withUpdatedAt({
      ...ranking,
      tracks: {
        ...ranking.tracks,
        [last.trackKey]: last.prev,
      },
      history: nextHistory,
    })
  }

  return ranking
}

export function mergeLegacyPlaylistRanking(userRanking, legacyPlaylistRanking, playlistId) {
  if (!userRanking || typeof userRanking !== 'object') return userRanking
  if (!legacyPlaylistRanking || typeof legacyPlaylistRanking !== 'object') return userRanking
  if (!playlistId) return userRanking

  const already = userRanking?.migratedPlaylists?.[playlistId]
  if (already) return userRanking

  const nextTracks = { ...userRanking.tracks }
  const legacyTracks = legacyPlaylistRanking?.tracks && typeof legacyPlaylistRanking.tracks === 'object' ? legacyPlaylistRanking.tracks : {}

  for (const [trackKey, legacyStateRaw] of Object.entries(legacyTracks)) {
    const legacyState = legacyStateRaw && typeof legacyStateRaw === 'object' ? legacyStateRaw : null
    if (!legacyState) continue

    const current = getTrackState(userRanking, trackKey)
    const legacy = getTrackState({ tracks: { [trackKey]: legacyState }, history: [] }, trackKey)

    const isDefaultCurrent = current.games === 0 && current.bucket === 'U' && Math.round(current.rating) === 1000

    if (!userRanking.tracks[trackKey]) {
      nextTracks[trackKey] = legacy
      continue
    }

    if (isDefaultCurrent) {
      nextTracks[trackKey] = legacy
      continue
    }

    if (legacy.games > current.games) {
      const mergedBucket = current.bucket !== 'U' ? current.bucket : legacy.bucket
      const keepX = current.bucket === 'X'
      nextTracks[trackKey] = {
        ...legacy,
        bucket: keepX ? 'X' : mergedBucket,
      }
    } else if (current.bucket === 'U' && legacy.bucket !== 'U') {
      nextTracks[trackKey] = { ...current, bucket: legacy.bucket === 'X' ? 'U' : legacy.bucket }
    }
  }

  return withUpdatedAt({
    ...userRanking,
    tracks: nextTracks,
    migratedPlaylists: { ...(userRanking.migratedPlaylists ?? {}), [playlistId]: new Date().toISOString() },
  })
}

export function mergeUserRankings(a, b) {
  if (!a) return b
  if (!b) return a
  if (typeof a !== 'object' || typeof b !== 'object') return a
  if (a.userId && b.userId && a.userId !== b.userId) return a

  const userId = a.userId ?? b.userId ?? null
  const nextTracks = { ...(a.tracks ?? {}) }

  const bTracks = b.tracks && typeof b.tracks === 'object' ? b.tracks : {}
  for (const trackKey of Object.keys(bTracks)) {
    const aHas = Boolean(a.tracks && Object.hasOwn(a.tracks, trackKey))
    const bHas = Boolean(b.tracks && Object.hasOwn(b.tracks, trackKey))
    if (!bHas) continue

    if (!aHas) {
      nextTracks[trackKey] = getTrackState(b, trackKey)
      continue
    }

    const aState = getTrackState(a, trackKey)
    const bState = getTrackState(b, trackKey)

    if (bState.games > aState.games) {
      nextTracks[trackKey] = bState
      continue
    }
    if (aState.games > bState.games) {
      nextTracks[trackKey] = aState
      continue
    }

    const bucket =
      aState.bucket === 'X' || bState.bucket === 'X'
        ? 'X'
        : aState.bucket !== 'U'
          ? aState.bucket
          : bState.bucket !== 'U'
            ? bState.bucket
            : 'U'

    nextTracks[trackKey] = {
      ...aState,
      bucket,
      rating: Math.max(aState.rating, bState.rating),
      wins: Math.max(aState.wins, bState.wins),
      losses: Math.max(aState.losses, bState.losses),
      lastComparedAt:
        aState.lastComparedAt && bState.lastComparedAt
          ? Date.parse(aState.lastComparedAt) >= Date.parse(bState.lastComparedAt)
            ? aState.lastComparedAt
            : bState.lastComparedAt
          : aState.lastComparedAt ?? bState.lastComparedAt ?? null,
    }
  }

  const mergedMigrated = { ...(a.migratedPlaylists ?? {}), ...(b.migratedPlaylists ?? {}) }
  const history = Array.isArray(a.history) && a.history.length >= (Array.isArray(b.history) ? b.history.length : 0) ? a.history : b.history

  return withUpdatedAt({
    ...a,
    schemaVersion: SCHEMA_VERSION,
    userId,
    tracks: nextTracks,
    history: Array.isArray(history) ? history : [],
    migratedPlaylists: mergedMigrated,
    createdAt: a.createdAt ?? b.createdAt ?? new Date().toISOString(),
  })
}
