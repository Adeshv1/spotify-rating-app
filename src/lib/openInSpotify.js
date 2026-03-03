export function openTrackInSpotify(trackId) {
  if (!trackId) return
  window.location.href = `spotify:track:${trackId}`
}

export function openArtistInSpotify(artistId) {
  if (!artistId) return
  window.location.href = `spotify:artist:${artistId}`
}

export function openAlbumInSpotify(albumId) {
  if (!albumId) return
  window.location.href = `spotify:album:${albumId}`
}

export function openPlaylistInSpotify(playlistId) {
  if (!playlistId) return
  window.location.href = `spotify:playlist:${playlistId}`
}
