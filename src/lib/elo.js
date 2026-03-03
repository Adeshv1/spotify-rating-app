export function expectedScore(ratingA, ratingB) {
  const a = Number.isFinite(ratingA) ? ratingA : 1000
  const b = Number.isFinite(ratingB) ? ratingB : 1000
  return 1 / (1 + 10 ** ((b - a) / 400))
}

export function updateElo({ ratingA, ratingB, scoreA, kFactor = 24 } = {}) {
  const a = Number.isFinite(ratingA) ? ratingA : 1000
  const b = Number.isFinite(ratingB) ? ratingB : 1000
  const sA = scoreA === 1 ? 1 : scoreA === 0 ? 0 : 0.5
  const k = Number.isFinite(kFactor) ? kFactor : 24

  const eA = expectedScore(a, b)
  const eB = 1 - eA
  const nextA = a + k * (sA - eA)
  const nextB = b + k * ((1 - sA) - eB)

  return { nextA, nextB }
}

