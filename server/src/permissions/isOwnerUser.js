function getOwnerSpotifyUserId() {
  const raw =
    process.env.SPOTIFY_OWNER_USER_ID ??
    process.env.OWNER_SPOTIFY_USER_ID ??
    process.env.SPOTIFY_OWNER_ID ??
    ''

  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed ? trimmed : null
}

export function isOwnerUser(spotifyUserId) {
  const ownerId = getOwnerSpotifyUserId()
  if (!ownerId) return false
  if (typeof spotifyUserId !== 'string' || !spotifyUserId) return false
  return spotifyUserId === ownerId
}

