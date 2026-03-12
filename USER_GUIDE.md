# Spotify Rating App User Guide

This document explains how the website works from a user perspective.

## What the site does

The app lets you build a global ranking of your Spotify songs.

It is designed around three main ideas:

- You add playlists from your Spotify account into the app.
- You rank songs using a binary comparison flow instead of scoring everything manually.
- The dashboard turns your ranked songs into useful views like top songs, top artists, and album progress.

The ranking is global. A song only needs to be ranked once, even if it appears in multiple playlists or albums.

## Main pages

The website has three main signed-in pages:

1. `Playlists`
2. `Rank Songs`
3. `Dashboard`

There is also a public landing page for people who are not signed in.

## Public landing page

When someone opens the site without logging in, they see:

- A short explanation of the app
- A `Sign in with Spotify` button
- A read-only dashboard preview

The public preview is just for viewing. It does not let the visitor add playlists or rank songs.

## Signing in

Users sign in with Spotify.

After login, the app can:

- Read the user's playlists
- Read playlist tracks when the user chooses to add a playlist
- Open songs, artists, albums, and playlists in Spotify

## Playlists page

The Playlists page is where users choose what music to bring into the ranking system.

Each playlist card shows:

- The playlist cover image
- The playlist title
- The playlist owner
- Whether it has already been added to rankings
- Whether the track cache is fresh or outdated

There is also a playlist search bar at the top so users can filter by playlist name or owner.

### Actions on the Playlists page

Each playlist has two main actions:

- Click the cover or title to open the playlist detail page
- Click `Add to Rankings` or `Refresh Playlist` to import the playlist's songs into the app

### What happens when a playlist is added

When the user adds a playlist:

- The app fetches the playlist tracks from Spotify
- The track list is cached locally
- Songs from the playlist are added into the user's global song pool
- If the playlist was already added before, refreshing it updates the cached track list

This means the app separates:

- having a playlist in Spotify
- having that playlist ingested into the app's ranking system

## Playlist detail page

When a user opens a playlist from the Playlists page, they see:

- The playlist name
- Cache information for that playlist
- A table of tracks in the playlist

The playlist track table is mainly a browsing view. It shows:

- Song name
- Artist
- Album
- Global rank, if the song is already ranked
- A `Play` button when Spotify can open that song

This page helps users inspect what is inside a playlist and how those songs currently relate to the global ranking.

## Rank Songs page

This is the main working page of the app.

It has three columns:

1. `Unranked`
2. `Rank`
3. `Ranked`

### Unranked column

This column contains songs that are in the global song pool but are not yet ranked.

Users can:

- Search unranked songs
- Click `Rank` to start placing a song
- Click `Play` to open the song in Spotify
- Click the `x` button to move a song into `Do not rate`

At the bottom of the column there is a `Do not rate` section.

Songs in `Do not rate` are excluded from ranking until the user restores them.

Users can:

- Open the `Do not rate` list
- Click `Add to Ranking` to move a song back into the normal ranking flow

### Rank column

This is the binary sort interface.

When a user starts ranking a song, the app compares that active song against a song that already has a position in the global order.

The user chooses which song is better.

Each choice narrows the correct position for the active song until the app knows exactly where to insert it.

Available actions in this column:

- `Better` on the left song
- `Better` on the right song
- `Play` for either song when available
- `Skip` to leave the current song and pick another one later
- `Do not rate` to exclude the active song from ranking

This method is faster than comparing every song against every other song.

### Ranked column

This column shows the current global order of all ranked songs.

Users can:

- Search ranked songs
- Hover a row to swap the visible rank number with a `Play` button
- Click the up arrow to move a song up by one spot
- Click the down arrow to move a song down by one spot
- Click `Reset` to move a song back to unranked and place it again from scratch

This page is the core ranking workflow for the site.

## Dashboard page

The Dashboard page turns ranked data into summary views.

It has three major sections:

1. `Top songs`
2. `Top artists`
3. `Album progress`

There is also an `Export / Import` section at the top.

### Top songs

This section shows the user's best ranked songs in order.

Each row shows:

- Rank number
- Song name
- Artist names
- A `Play` button

### Top artists

This section groups ranked songs by artist and estimates artist strength from the user's song rankings.

Each artist card shows:

- Artist image when available
- Artist name
- Average rank based on that artist's top songs
- A short list of the artist's best songs in the user's ranking
- A `Play` button to open the artist in Spotify

This is not based on Spotify popularity. It is based on the user's own song order.

### Album progress

This section shows albums that have at least one rated song.

Each album row shows:

- Album rank inside the dashboard
- Album name
- Artist label
- Average rank of the album's rated songs
- How many songs are rated out of the total album track count

Users can expand an album row with `Show`.

When expanded, the album view shows:

- `Rated` songs
- `Unrated` songs
- `DO NOT RATE` songs inside the unrated side
- `Open album` to open the album in Spotify
- `Rate next song` to immediately start ranking the next available song

Within an expanded album:

- Rated songs have their rank number and a `Play` button
- Unrated songs have a `Rate` button
- Songs in `DO NOT RATE` also have a `Rate` button, which restores them and starts ranking them again

### How album progress works

Album progress is meant to help users finish albums from their existing ranked music pool.

The app can fetch the full track list for an album when needed so album progress is more accurate than just looking at playlist copies of songs.

If the same song appears on more than one album, the app tries to keep one song identity for ranking while still letting that song count toward each relevant album.

## Export and Import

At the top of the Dashboard page, users can:

- Export JSON
- Import JSON

This is for moving or backing up ranking data.

Export creates a JSON file containing the current ranking state.

Import replaces the current in-browser ranking state with the imported file.

## How the ranking data behaves

The app is built around a few important rules:

### One global ranking

The ranking is not per playlist.

If a song appears in multiple playlists, it still belongs to one global order.

### Do not rate

If a song is marked `Do not rate`, it is excluded from the normal ranking flow until restored.

### Duplicate song handling

Spotify sometimes exposes the same visible song through different playlist or album variants.

The app tries to collapse those variants into one song identity so users do not have to rank the same song multiple times.

### Rankings and albums

Album progress is derived from the global ranking state plus cached album data.

An album only appears in Album progress after at least one song on that album has been rated.

## Saving and persistence

For every user:

- Rankings are stored in local browser storage
- Cached playlists and cached tracks are stored locally

For the owner account:

- Rankings are also backed up on the server

From the user's point of view, the app behaves the same for everyone. The only owner-specific difference is the extra server backup.

## Recommended user flow

If someone is new to the app, the easiest way to use it is:

1. Sign in with Spotify
2. Open `Playlists`
3. Search for a playlist
4. Click `Add to Rankings`
5. Go to `Rank Songs`
6. Start ranking songs from the `Unranked` column
7. Use `Do not rate` for songs they do not want in the ranking
8. Open `Dashboard` to review top songs, top artists, and album progress
9. Use album expansion and `Rate next song` to finish albums faster
10. Export JSON occasionally as a backup

## Short explanation for other people

If you need a quick one-paragraph description to send someone, use this:

> This site connects to Spotify, lets you add your playlists into a personal song pool, and builds a global ranking of your music using a fast binary comparison system. After ranking songs, the dashboard shows your top songs, strongest artists, and album progress, and you can exclude songs with Do not rate or export/import your data as JSON.
