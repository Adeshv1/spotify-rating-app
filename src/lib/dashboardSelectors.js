// Dashboard selector helpers.
//
// Top Artists scoring:
// - For each artist, take their top 5 rated songs (by Elo/rating).
// - Let n be the number of songs available (1..5) and avg be the mean rating.
// - artistScore = avg * (n / 5)
//   This penalizes artists with fewer rated songs so 1 great song doesn't outrank
//   an artist with many consistently high-rated songs.

function pushTopNByRating(list, item, maxN) {
  list.push(item)
  list.sort((a, b) => b.rating - a.rating)
  if (list.length > maxN) list.length = maxN
}

/**
 * @param {Array<{ trackKey: string, id?: string|null, name?: string|null, rating: number, artists: string[], artistsDetailed?: Array<{name:string, id:string|null}> }>} tracks
 * @param {{ maxSongsPerArtist?: number, maxArtists?: number }} [options]
 */
export function computeTopArtistsFromTracks(tracks, options = {}) {
  const maxSongsPerArtist = Number(options.maxSongsPerArtist) || 5
  const maxArtists = Number(options.maxArtists) || 15

  /** @type {Map<string, Array<{trackKey:string, id:string|null, name:string|null, rating:number}>>} */
  const byArtist = new Map()
  /** @type {Map<string, string>} */
  const idByArtist = new Map()

  for (const t of tracks) {
    const rating = Number(t?.rating)
    if (!Number.isFinite(rating)) continue
    const trackId = typeof t?.id === 'string' ? t.id : null
    const artists = Array.isArray(t?.artists) ? t.artists.filter(Boolean) : []
    if (!artists.length) continue

    for (const artistName of artists) {
      if (!idByArtist.has(artistName) && Array.isArray(t?.artistsDetailed)) {
        const match = t.artistsDetailed.find((a) => a?.name === artistName && typeof a?.id === 'string' && a.id)
        if (match?.id) idByArtist.set(artistName, match.id)
      }

      const existing = byArtist.get(artistName) || []
      pushTopNByRating(
        existing,
        { trackKey: t.trackKey, id: trackId, name: typeof t?.name === 'string' ? t.name : null, rating },
        maxSongsPerArtist,
      )
      byArtist.set(artistName, existing)
    }
  }

  const scored = []
  for (const [name, topSongs] of byArtist.entries()) {
    const n = topSongs.length
    if (!n) continue
    const avgRating = topSongs.reduce((sum, s) => sum + s.rating, 0) / n
    const artistScore = avgRating * (n / maxSongsPerArtist)
    const artistId = idByArtist.get(name) || null
    scored.push({ name, artistId, n, avgRating, artistScore, topSongs, topTracks: topSongs })
  }

  scored.sort((a, b) => b.artistScore - a.artistScore)
  return scored.slice(0, maxArtists)
}
