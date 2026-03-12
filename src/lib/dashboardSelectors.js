// Dashboard selector helpers.
//
// Top Artists scoring:
// - For each artist, take their top 5 songs by global rank (lower is better).
// - Let n be the number of songs available (1..5) and avg be the mean rank.
// - adjustedAvgRank = avg * (5 / n)
//   This penalizes artists with fewer ranked songs so 1 great song doesn't outrank
//   an artist with many consistently high-ranked songs.

function pushTopNByRank(list, item, maxN) {
  list.push(item)
  list.sort((a, b) => a.rank - b.rank)
  if (list.length > maxN) list.length = maxN
}

/**
 * @param {Array<{ trackKey: string, id?: string|null, name?: string|null, rank: number, artists: string[], artistsDetailed?: Array<{name:string, id:string|null}> }>} tracks
 * @param {{ maxSongsPerArtist?: number, maxArtists?: number }} [options]
 */
export function computeTopArtistsFromTracks(tracks, options = {}) {
  const maxSongsPerArtist = Number(options.maxSongsPerArtist) || 5
  const maxArtists = Number(options.maxArtists) || 15

  /** @type {Map<string, Array<{trackKey:string, id:string|null, name:string|null, rank:number}>>} */
  const byArtist = new Map()
  /** @type {Map<string, number>} */
  const totalTracksByArtist = new Map()
  /** @type {Map<string, string>} */
  const idByArtist = new Map()

  for (const t of tracks) {
    const rank = Number(t?.rank)
    if (!Number.isFinite(rank)) continue
    const trackId = typeof t?.id === 'string' ? t.id : null
    const artists = Array.isArray(t?.artists) ? t.artists.filter(Boolean) : []
    if (!artists.length) continue

    for (const artistName of artists) {
      if (!idByArtist.has(artistName) && Array.isArray(t?.artistsDetailed)) {
        const match = t.artistsDetailed.find((a) => a?.name === artistName && typeof a?.id === 'string' && a.id)
        if (match?.id) idByArtist.set(artistName, match.id)
      }

      const existing = byArtist.get(artistName) || []
      pushTopNByRank(
        existing,
        { trackKey: t.trackKey, id: trackId, name: typeof t?.name === 'string' ? t.name : null, rank },
        maxSongsPerArtist,
      )
      byArtist.set(artistName, existing)
      totalTracksByArtist.set(artistName, (totalTracksByArtist.get(artistName) || 0) + 1)
    }
  }

  const scored = []
  for (const [name, topSongs] of byArtist.entries()) {
    const n = topSongs.length
    if (!n) continue
    const avgRank = topSongs.reduce((sum, s) => sum + s.rank, 0) / n
    const adjustedAvgRank = avgRank * (maxSongsPerArtist / n)
    const artistId = idByArtist.get(name) || null
    scored.push({
      name,
      artistId,
      n,
      totalTracks: totalTracksByArtist.get(name) || n,
      avgRank,
      adjustedAvgRank,
      topSongs,
      topTracks: topSongs,
    })
  }

  scored.sort((a, b) => a.adjustedAvgRank - b.adjustedAvgRank)
  return scored.slice(0, maxArtists)
}
