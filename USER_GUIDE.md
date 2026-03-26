# Rankify User Guide

This guide explains the current app flow from a user point of view.

## What the app does

Rankify helps you build one global ranking of your music.

The core workflow is:

- bring playlists into the app
- rank songs with a binary placement flow
- review the results in the dashboard

The ranking is global, not per playlist. If the same song appears in multiple playlists or albums, you should only need to rank it once.

## Ways to enter the app

When you open the site while signed out, you land on a simple public page with two options:

- `Sign in with Spotify`
- `Try Demo`

### Sign in with Spotify

Use this when you want to work with your own Spotify playlists.

The app requests enough Spotify access to:

- read your playlists
- read playlist tracks when you open or sync them
- open playlists, tracks, artists, and albums in Spotify

If the deployed Spotify app is still in development mode, your account may need to be allowlisted in the Spotify Developer Dashboard before login will work.

### Try Demo

Use this when you want to explore the product without Spotify login.

Demo mode loads a shared pre-cached library so you can browse playlists, rank songs locally in your browser, and see how the dashboard works.

## Main signed-in pages

The main app has three pages:

1. `Playlists`
2. `Rank Songs`
3. `Dashboard`

There is also a playlist detail view that opens from the Playlists page.

## Header actions

After login or demo entry, the top bar includes:

- navigation for `Playlists`, `Rank Songs`, and `Dashboard`
- `Back up & Restore`
- `How to use`
- `Log out`

`Back up & Restore` saves or restores your local app state. `How to use` opens a short in-app summary of the recommended workflow.

## Playlists page

The Playlists page is where you decide what music enters the ranking pool.

Each playlist card can show:

- playlist cover
- playlist name
- playlist owner
- track count when known
- whether the playlist has already been added to the global ranking pool
- the last sync time when the playlist has been ingested already

There is also a search bar so you can filter playlists by name or owner.

### Playlist actions

Each playlist card supports two main actions:

- click the cover or title to open the playlist detail view
- click `Add to Global Ranking` or `Sync`

`Add to Global Ranking` pulls the playlist's songs into your ranking pool for the first time.

`Sync` refreshes the playlist from Spotify and updates the songs the app uses for that playlist.

### Important detail

A playlist existing in Spotify is not the same as that playlist being included in the app.

You can see a playlist in the list before it has been ingested into your ranking pool.

## Playlist detail view

When you open a playlist, the app shows a track table for that playlist.

The table includes:

- playlist order
- global rank, if the song is already ranked
- song name
- artist
- album
- `Play`

This is mainly a browsing screen. It helps you inspect the playlist and see how its songs currently fit into the larger ranking.

## Rank Songs page

This is the main working page of the app.

It has three columns:

1. `Unranked`
2. `Rank`
3. `Ranked`

### Unranked

This column contains songs that are in your global pool but do not have a placed rank yet.

You can:

- search unranked songs
- click `Rank` to start placing a song
- click `Play` to open the song in Spotify
- move a song into `Do not rate`

At the bottom of the column there is a collapsible `Do not rate` section.

Songs in `Do not rate` are excluded from the ranking flow until you restore them.

### Rank

This column runs the binary placement flow.

When you start ranking a song, the app compares that active song against songs that already have positions in the ordered list. Each choice narrows the correct insertion point until the app can place the song.

Available actions include:

- `Better` on either side
- `Play` for either song when Spotify playback/open is available
- `Skip`
- `Do not rate`

This is much faster than trying to score every song manually.

### Ranked

This column shows the ordered list of ranked songs.

You can:

- search ranked songs
- hover a row to reveal `Play`
- move a song up by one slot
- move a song down by one slot
- click `Reset` to send a song back to unranked

## Dashboard page

The Dashboard summarizes the current global ranking.

Its main sections are:

1. `Top songs`
2. `Top artists`
3. `Album progress`

### Top songs

This is the straightforward ordered list of your highest-ranked songs.

Rows show:

- rank
- song name
- artist names
- `Play`

### Top artists

This section estimates artist strength from your ranked songs.

Each artist card can show:

- artist image
- artist name
- average rank based on that artist's top songs
- ranked track count
- the artist's top songs from your ranking
- a `Play` button that opens the artist in Spotify

This is based on your ranking, not Spotify popularity.

### Album progress

Album progress helps you finish ranking albums that already have at least one rated song.

Each album row shows:

- position in the dashboard table
- album name
- artist
- average rank
- completion percentage and rated-track count

You can expand an album row to see:

- `Rated`
- `Unrated`
- `DO NOT RATE`
- `Open album`
- `Rate next song`

Inside the expanded view:

- rated songs show their rank and `Play`
- unrated songs can be sent into the ranking flow with `Rate`
- `DO NOT RATE` songs can also be restored and ranked again

Album progress uses cached full album tracklists when needed, so it can be more complete than a single playlist copy of an album.

## Export and Import

The `Back up & Restore` menu saves or restores the local app state for the current browser.

Export includes:

- ranking data
- local playlist state
- related local app data used by the interface

Import replaces the current local state with the imported file.

## Rules that matter

### One global ranking

Songs are ranked in one shared order across all added playlists.

### Do not rate

Songs in `Do not rate` stay out of the ranking flow until restored.

### Duplicate handling

Spotify often exposes multiple variants of what is effectively the same song.

The app tries to collapse those variants into one song identity so you do not keep re-ranking duplicates.

### Albums use the same song identity

The app tries to preserve one ranking identity for a song even when it appears across playlists, album caches, or alternate album memberships.

## Saving and persistence

For every user:

- rankings are stored in browser storage
- playlist and track caches are stored locally in the browser

For the configured owner account:

- rankings can also be backed up on the server
- the backend can maintain shared demo cache data used by `Try Demo`

## Recommended flow

If you are new to the app, use this order:

1. Sign in with Spotify or click `Try Demo`
2. Open `Playlists`
3. Add one or more playlists with `Add to Global Ranking`
4. Open `Rank Songs`
5. Start placing songs from `Unranked`
6. Use `Do not rate` for songs you do not want in the final order
7. Open `Dashboard` to review top songs, artists, and album progress
8. Use `Rate next song` inside albums to finish more of the library
9. Export your data occasionally if you want a manual backup

## Short description

Use this if you want a compact summary to share:

> Rankify turns playlists into one personal song ranking. You add playlists, place songs with a fast binary comparison flow, and then review the results through top songs, artist summaries, and album progress. It also supports demo mode, Do not rate, and local export/import.
