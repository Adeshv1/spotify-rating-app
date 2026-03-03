import { DUEL_BUCKET_ORDER, getTrackState } from './userRankingStore'

function randomInt(maxExclusive) {
  return Math.floor(Math.random() * maxExclusive)
}

function pickFrom(array) {
  if (!array.length) return null
  return array[randomInt(array.length)]
}

function bucketAuto(trackKeys, ranking) {
  for (const b of DUEL_BUCKET_ORDER) {
    const count = trackKeys.filter((k) => getTrackState(ranking, k).bucket === b).length
    if (count >= 2) return b
  }
  return null
}

export function pickMatchup({ trackKeys, ranking, bucket = 'AUTO' } = {}) {
  if (!Array.isArray(trackKeys) || trackKeys.length < 2) return null
  if (!ranking) return null

  const eligible = trackKeys.filter((k) => getTrackState(ranking, k).bucket !== 'X')
  if (eligible.length < 2) return null

  const bucketUsed = bucket === 'AUTO' ? bucketAuto(eligible, ranking) : bucket
  if (!bucketUsed) return null

  const inBucket = eligible.filter((k) => getTrackState(ranking, k).bucket === bucketUsed)
  if (inBucket.length < 2) return null

  const scored = inBucket.map((k) => {
    const s = getTrackState(ranking, k)
    return { key: k, rating: s.rating, games: s.games }
  })

  const minGames = Math.min(...scored.map((s) => s.games))
  const pool = scored.filter((s) => s.games <= minGames + 1)
  pool.sort(() => Math.random() - 0.5)

  const left = pickFrom(pool.slice(0, Math.min(10, pool.length))) ?? pool[0]
  if (!left) return null

  let best = null
  for (const other of scored) {
    if (other.key === left.key) continue
    const ratingDiff = Math.abs(other.rating - left.rating)
    const gamesPenalty = (other.games - minGames) * 15
    const score = ratingDiff + gamesPenalty
    if (!best || score < best.score) best = { ...other, score }
  }
  if (!best) return null

  return { leftKey: left.key, rightKey: best.key, bucketUsed }
}
