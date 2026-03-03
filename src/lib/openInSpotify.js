export function openTrackInSpotify(trackId) {
  if (!trackId) return
  window.location.href = `spotify:track:${trackId}`
}

