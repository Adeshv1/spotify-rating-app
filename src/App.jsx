import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import "./App.css";
import "./Dashboard.css";
import {
  clearPlaylistsCache,
  formatDateTime,
  getSpotifyCooldownUntil,
  readPlaylistsCache,
  setSpotifyCooldown,
  setPlaylistIngestedAt,
  writePlaylistsCache,
} from "./lib/spotifyPlaylistsCache";
import {
  clearPlaylistTracksCache,
  readPlaylistTracksCache,
  readPlaylistTracksCacheMeta,
  readPlaylistTracksErrorCache,
  writePlaylistTracksCache,
  writePlaylistTracksErrorCache,
} from "./lib/spotifyPlaylistTracksCache";
import {
  openAlbumInSpotify,
  openArtistInSpotify,
  openPlaylistInSpotify,
  openTrackInSpotify,
} from "./lib/openInSpotify";
import {
  readAlbumTracksCache,
  writeAlbumTracksCache,
} from "./lib/spotifyAlbumTracksCache";
import {
  excludeTrack,
  createEmptyUserRanking,
  getTrackState,
  mergeLegacyPlaylistRanking,
  reconcileRankingTrackKeys,
  readUserRanking,
  resetTrackState,
  setTrackBucket,
  songIdentityOfTrack,
  trackKeyOfTrack,
  mergeUserRankings,
  writeUserRanking,
} from "./lib/userRankingStore";
import { readPlaylistRanking as readLegacyPlaylistRanking } from "./lib/playlistRankingStore";
import { computeTopArtistsFromTracks } from "./lib/dashboardSelectors";
import {
  mergeArtistIdByNameCache,
  readArtistIdByNameCache,
} from "./lib/spotifyArtistIdCache";
import {
  readGlobalSongs,
  replaceGlobalSongs,
  upsertGlobalSongs,
} from "./lib/globalSongsStore";

function normalizedRankValue(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function normalizeArtistNameKey(name) {
  if (typeof name !== "string") return "";
  return name.trim().toLowerCase().replaceAll(/\s+/g, " ");
}

function findScrollableAncestor(node) {
  if (!node || typeof window === "undefined") return null;
  let current = node.parentElement;
  while (current) {
    const style = window.getComputedStyle(current);
    const overflowY = style?.overflowY || "";
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      current.scrollHeight > current.clientHeight + 2
    ) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function formatCountdown(targetMs, nowMs) {
  if (!Number.isFinite(targetMs) || !Number.isFinite(nowMs)) return "not scheduled";
  const totalSeconds = Math.max(0, Math.ceil((targetMs - nowMs) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

const PLAYLIST_ACTION_COOLDOWN_MS = 5_000;
const MOCK_DEMO_USER_ID = "mock_demo";

function getIngestedPlaylistIds(playlistsCache) {
  return Array.isArray(playlistsCache?.items)
    ? playlistsCache.items
        .filter(playlist => typeof playlist?.ingestedAt === "string" && playlist.ingestedAt)
        .map(playlist => playlist?.id)
        .filter(Boolean)
    : [];
}

function rebuildGlobalSongsFromIngestedPlaylists(userId, playlistsCache) {
  if (!userId) return { total: 0 };

  const existingItems = readGlobalSongs(userId)?.items;
  const existingById =
    existingItems && typeof existingItems === "object" ? existingItems : {};
  const nextTracks = [];

  for (const playlistId of getIngestedPlaylistIds(playlistsCache)) {
    const cachedTracks = readPlaylistTracksCache(userId, playlistId);
    const items = Array.isArray(cachedTracks?.items) ? cachedTracks.items : [];

    for (const track of items) {
      const trackId = typeof track?.id === "string" ? track.id : null;
      if (!trackId) continue;
      const existingTrack = existingById[trackId] || null;
      nextTracks.push({
        id: trackId,
        name:
          typeof track?.name === "string"
            ? track.name
            : typeof existingTrack?.name === "string"
              ? existingTrack.name
              : null,
        artists: Array.isArray(track?.artists)
          ? track.artists.filter(Boolean)
          : Array.isArray(existingTrack?.artists)
            ? existingTrack.artists
            : [],
        albumMemberships: Array.isArray(existingTrack?.albumMemberships)
          ? existingTrack.albumMemberships
          : undefined,
        albumId:
          typeof track?.albumId === "string"
            ? track.albumId
            : typeof existingTrack?.albumId === "string"
              ? existingTrack.albumId
              : null,
        album:
          typeof track?.album === "string"
            ? track.album
            : typeof existingTrack?.album === "string"
              ? existingTrack.album
              : null,
        albumTrackCount: Number.isFinite(track?.albumTrackCount)
          ? track.albumTrackCount
          : Number.isFinite(existingTrack?.albumTrackCount)
            ? existingTrack.albumTrackCount
            : null,
        durationMs: Number.isFinite(track?.durationMs)
          ? track.durationMs
          : Number.isFinite(existingTrack?.durationMs)
            ? existingTrack.durationMs
            : null,
        explicit:
          typeof track?.explicit === "boolean"
            ? track.explicit
            : typeof existingTrack?.explicit === "boolean"
              ? existingTrack.explicit
              : null,
        externalUrl:
          typeof track?.externalUrl === "string"
            ? track.externalUrl
            : typeof existingTrack?.externalUrl === "string"
              ? existingTrack.externalUrl
              : null,
        sourcePlaylistIds: [playlistId],
      });
    }
  }

  return replaceGlobalSongs(userId, nextTracks);
}

function readVisibleGlobalTracks(userId) {
  if (!userId) return [];
  const items = readGlobalSongs(userId)?.items;
  return items && typeof items === "object"
    ? Object.values(items).filter(Boolean)
    : [];
}

function getTiedRanks(items, getScore) {
  let lastScore = null;
  let lastRank = 0;
  return items.map((item, idx) => {
    const score = normalizedRankValue(getScore(item));
    if (idx === 0) {
      lastRank = 1;
      lastScore = score;
      return lastRank;
    }
    if (score !== lastScore) {
      lastRank = idx + 1;
      lastScore = score;
    }
    return lastRank;
  });
}

function getAlbumAvgRankSortValue(album) {
  return Number.isFinite(album?.avgRank)
    ? Number(album.avgRank)
    : Number.POSITIVE_INFINITY;
}

function getAlbumRatedShare(album) {
  const totalTracks = Number(album?.totalTracks) || 0;
  return totalTracks > 0 ? (Number(album?.ratedCount) || 0) / totalTracks : 0;
}

function pickAlbumArtistLabel(tracks) {
  const counts = new Map();
  for (const track of tracks || []) {
    const label = Array.isArray(track?.artists)
      ? track.artists.filter(Boolean).join(", ")
      : "";
    if (!label) continue;
    counts.set(label, (counts.get(label) || 0) + 1);
  }

  let bestLabel = null;
  let bestCount = 0;
  for (const [label, count] of counts.entries()) {
    if (
      count > bestCount ||
      (count === bestCount &&
        bestLabel &&
        label.localeCompare(bestLabel, "en", { numeric: true }) < 0) ||
      !bestLabel
    ) {
      bestLabel = label;
      bestCount = count;
    }
  }

  return bestLabel || "Unknown artist";
}

function normalizeLooseString(value) {
  if (typeof value !== "string") return "";
  return value.trim().replaceAll(/\s+/g, " ");
}

function albumNameKey(name) {
  return normalizeLooseString(name).toLowerCase();
}

function mergeAlbumTrackItems(existing, incoming) {
  if (!existing) return incoming;
  return {
    trackKey:
      (typeof existing?.trackKey === "string" && existing.trackKey) ||
      incoming?.trackKey ||
      null,
    id:
      (typeof existing?.id === "string" && existing.id) ||
      (typeof incoming?.id === "string" ? incoming.id : null),
    name:
      normalizeTrackName(existing?.name, existing?.id || incoming?.id) ||
      normalizeTrackName(incoming?.name, existing?.id || incoming?.id) ||
      null,
    artists:
      Array.isArray(existing?.artists) && existing.artists.length
        ? existing.artists
        : Array.isArray(incoming?.artists)
          ? incoming.artists.filter(Boolean)
          : [],
    rank: Number.isFinite(Number(existing?.rank))
      ? Number(existing.rank)
      : Number.isFinite(Number(incoming?.rank))
        ? Number(incoming.rank)
        : null,
  };
}

function albumTrackIdentity(track) {
  const identity = songIdentityOfTrack(track);
  if (typeof identity === "string" && identity) return identity;
  if (typeof track?.trackKey === "string" && track.trackKey) {
    return `track:${track.trackKey}`;
  }
  if (typeof track?.id === "string" && track.id) return `id:${track.id}`;
  return "";
}

function dedupeAlbumTrackList(tracks) {
  const map = new Map();
  for (const track of tracks || []) {
    const key =
      typeof track?.trackKey === "string" && track.trackKey
        ? track.trackKey
        : null;
    if (!key) continue;
    map.set(key, mergeAlbumTrackItems(map.get(key) || null, track));
  }
  return Array.from(map.values());
}

function normalizeAlbumTrackBuckets(album) {
  const grouped = new Map();

  const addTracks = (bucket, tracks) => {
    for (const track of tracks || []) {
      const identity = albumTrackIdentity(track);
      if (!identity) continue;
      const existing = grouped.get(identity) || null;
      if (!existing) {
        grouped.set(identity, { bucket, track });
        continue;
      }

      if (existing.bucket === bucket) {
        grouped.set(identity, {
          bucket,
          track: mergeAlbumTrackItems(existing.track, track),
        });
        continue;
      }

      const priority = { rated: 3, doNotRate: 2, unrated: 1 };
      const keepExisting =
        (priority[existing.bucket] || 0) >= (priority[bucket] || 0);

      grouped.set(identity, {
        bucket: keepExisting ? existing.bucket : bucket,
        track: keepExisting
          ? mergeAlbumTrackItems(existing.track, track)
          : mergeAlbumTrackItems(track, existing.track),
      });
    }
  };

  addTracks("rated", dedupeAlbumTrackList(album?.ratedTracks));
  addTracks("doNotRate", dedupeAlbumTrackList(album?.doNotRateTracks));
  addTracks("unrated", dedupeAlbumTrackList(album?.unratedTracks));

  const ratedTracks = [];
  const unratedTracks = [];
  const doNotRateTracks = [];

  for (const entry of grouped.values()) {
    if (entry.bucket === "rated") ratedTracks.push(entry.track);
    else if (entry.bucket === "doNotRate") doNotRateTracks.push(entry.track);
    else unratedTracks.push(entry.track);
  }

  return { ratedTracks, unratedTracks, doNotRateTracks };
}

function finalizeAlbumRow(album) {
  const normalizedBuckets = normalizeAlbumTrackBuckets(album);
  const ratedTracks = normalizedBuckets.ratedTracks.sort(
    (left, right) => left.rank - right.rank,
  );
  const unratedTracks = normalizedBuckets.unratedTracks.sort(
    (left, right) =>
      (left.name || "").localeCompare(right.name || "", "en", {
        numeric: true,
      }),
  );
  const doNotRateTracks = normalizedBuckets.doNotRateTracks.sort(
    (left, right) =>
      (left.name || "").localeCompare(right.name || "", "en", {
        numeric: true,
      }),
  );
  const ratedCount = ratedTracks.length;
  const doNotRateCount = doNotRateTracks.length;
  const totalTracks = Math.max(
    Number(album?.totalTracks) || 0,
    ratedCount + unratedTracks.length + doNotRateTracks.length,
  );
  const unratedCount = Math.max(
    totalTracks - ratedCount - doNotRateCount,
    unratedTracks.length,
  );
  const avgRank = ratedCount
    ? ratedTracks.reduce((sum, track) => sum + Number(track.rank || 0), 0) /
      ratedCount
    : null;
  const artistLabel = pickAlbumArtistLabel([
    ...ratedTracks,
    ...unratedTracks,
    ...doNotRateTracks,
  ]);

  return {
    ...album,
    artistLabel,
    totalTracks,
    ratedCount,
    unratedCount,
    doNotRateCount,
    avgRank,
    completion:
      totalTracks > 0 ? (ratedCount + doNotRateCount) / totalTracks : 0,
    ratedTracks,
    unratedTracks,
    doNotRateTracks,
  };
}

function mergeAlbumRows(existing, incoming) {
  const merged = {
    ...existing,
    key: existing.albumId ? existing.key : incoming.albumId ? incoming.key : existing.key,
    name:
      (typeof existing?.name === "string" && existing.name) ||
      incoming?.name ||
      "Unknown album",
    albumId:
      (typeof existing?.albumId === "string" && existing.albumId) ||
      (typeof incoming?.albumId === "string" ? incoming.albumId : null),
    totalTracks: Math.max(
      Number(existing?.totalTracks) || 0,
      Number(incoming?.totalTracks) || 0,
    ),
    albumTracksLoaded:
      Boolean(existing?.albumTracksLoaded) || Boolean(incoming?.albumTracksLoaded),
    ratedTracks: [
      ...(Array.isArray(existing?.ratedTracks) ? existing.ratedTracks : []),
      ...(Array.isArray(incoming?.ratedTracks) ? incoming.ratedTracks : []),
    ],
    unratedTracks: [
      ...(Array.isArray(existing?.unratedTracks) ? existing.unratedTracks : []),
      ...(Array.isArray(incoming?.unratedTracks) ? incoming.unratedTracks : []),
    ],
    doNotRateTracks: [
      ...(Array.isArray(existing?.doNotRateTracks)
        ? existing.doNotRateTracks
        : []),
      ...(Array.isArray(incoming?.doNotRateTracks)
        ? incoming.doNotRateTracks
        : []),
    ],
  };

  return finalizeAlbumRow(merged);
}

function getAlbumRowTrackRefs(album) {
  return [
    ...(Array.isArray(album?.ratedTracks) ? album.ratedTracks : []),
    ...(Array.isArray(album?.unratedTracks) ? album.unratedTracks : []),
    ...(Array.isArray(album?.doNotRateTracks) ? album.doNotRateTracks : []),
  ];
}

function albumRowsShareTrackIdentity(left, right) {
  const leftRefs = getAlbumRowTrackRefs(left);
  const rightRefs = getAlbumRowTrackRefs(right);
  if (leftRefs.length === 0 || rightRefs.length === 0) return false;

  const leftKeys = new Set(
    leftRefs
      .map(track => (typeof track?.trackKey === "string" ? track.trackKey : null))
      .filter(Boolean),
  );
  const leftIds = new Set(
    leftRefs
      .map(track => (typeof track?.id === "string" ? track.id : null))
      .filter(Boolean),
  );
  const leftIdentities = new Set(
    leftRefs.map(track => albumTrackIdentity(track)).filter(Boolean),
  );

  return rightRefs.some(track => {
    const trackKey =
      typeof track?.trackKey === "string" ? track.trackKey : null;
    const trackId = typeof track?.id === "string" ? track.id : null;
    const identity = albumTrackIdentity(track);
    return (
      (trackKey && leftKeys.has(trackKey)) ||
      (trackId && leftIds.has(trackId)) ||
      (identity && leftIdentities.has(identity))
    );
  });
}

function albumRowsCanMerge(left, right) {
  if (!left || !right) return false;

  if (
    typeof left?.albumId === "string" &&
    left.albumId &&
    typeof right?.albumId === "string" &&
    right.albumId &&
    left.albumId === right.albumId
  ) {
    return true;
  }

  const leftName = albumNameKey(left?.name);
  const rightName = albumNameKey(right?.name);
  if (!leftName || !rightName || leftName !== rightName) return false;

  return albumRowsShareTrackIdentity(left, right);
}

function normalizeTrackName(name, id = null) {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("spid:")) return null;
  if (id && trimmed === id) return null;
  if (id && trimmed === `spid:${id}`) return null;
  return trimmed;
}

function spotifyIdFromTrackKey(trackKey) {
  if (typeof trackKey !== "string" || !trackKey.startsWith("spid:")) {
    return null;
  }
  const id = trackKey.slice("spid:".length).trim();
  return id || null;
}

function getTrackDisplayName(track, trackKey = null) {
  const fallbackId =
    (typeof track?.id === "string" && track.id) ||
    spotifyIdFromTrackKey(trackKey);
  return (
    normalizeTrackName(track?.name, fallbackId) ||
    (fallbackId ? "Unknown Spotify track" : "(untitled track)")
  );
}

function getTrackAlbumMemberships(track) {
  const rawMemberships =
    Array.isArray(track?.albumMemberships) && track.albumMemberships.length
      ? track.albumMemberships
      : [track];

  return rawMemberships
    .map(membership => {
      const albumId =
        typeof membership?.albumId === "string" && membership.albumId
          ? membership.albumId
          : null;
      const album =
        typeof membership?.album === "string" && membership.album.trim()
          ? membership.album
          : null;
      const albumTrackCount = Number.isFinite(membership?.albumTrackCount)
        ? membership.albumTrackCount
        : null;
      if (!albumId && !album) return null;
      return { albumId, album, albumTrackCount };
    })
    .filter(Boolean);
}

function mergeTrackIndexEntry(existing, track) {
  const incomingId = typeof track?.id === "string" ? track.id : null;
  const existingId = typeof existing?.id === "string" ? existing.id : null;
  const id = existingId || incomingId;

  const incomingArtists = Array.isArray(track?.artists)
    ? track.artists.filter(Boolean)
    : [];
  const incomingArtistIds = Array.isArray(track?.artistIds)
    ? track.artistIds.map(value =>
        typeof value === "string" ? value : null,
      )
    : [];
  const incomingArtistsDetailed = incomingArtists.map((name, idx) => ({
    name,
    id: typeof incomingArtistIds?.[idx] === "string"
      ? incomingArtistIds[idx]
      : null,
  }));

  const existingArtists = Array.isArray(existing?.artists)
    ? existing.artists.filter(Boolean)
    : [];
  const existingArtistIds = Array.isArray(existing?.artistIds)
    ? existing.artistIds
    : [];
  const existingArtistsDetailed = Array.isArray(existing?.artistsDetailed)
    ? existing.artistsDetailed
    : [];

  return {
    id,
    name:
      normalizeTrackName(track?.name, id) ||
      normalizeTrackName(existing?.name, id) ||
      null,
    artists: incomingArtists.length ? incomingArtists : existingArtists,
    artistIds: incomingArtistIds.length ? incomingArtistIds : existingArtistIds,
    artistsDetailed: incomingArtistsDetailed.length
      ? incomingArtistsDetailed
      : existingArtistsDetailed,
    albumId:
      (typeof track?.albumId === "string" ? track.albumId : null) ||
      (typeof existing?.albumId === "string" ? existing.albumId : null),
    album:
      (typeof track?.album === "string" && track.album.trim()
        ? track.album
        : null) ||
      (typeof existing?.album === "string" && existing.album.trim()
        ? existing.album
        : null),
    albumTrackCount: Number.isFinite(track?.albumTrackCount)
      ? track.albumTrackCount
      : Number.isFinite(existing?.albumTrackCount)
        ? existing.albumTrackCount
        : null,
  };
}

function mergeTrackIntoIndex(map, track) {
  if (!track || typeof track !== "object") return;
  const key = trackKeyOfTrack(track);
  map.set(key, mergeTrackIndexEntry(map.get(key) || null, track));
}

const ORDER_BASE_ELO = 1001;

function isRankedState(state) {
  if (!state || typeof state !== "object") return false;
  if (state.bucket && state.bucket !== "U" && state.bucket !== "X") return true;
  const rating = Number(state.rating);
  if (Number.isFinite(rating) && Math.round(rating) !== 1000) return true;
  if (Number(state.games) > 0) return true;
  return typeof state.lastComparedAt === "string" && state.lastComparedAt;
}

function compareTrackKeysForCanonical(leftKey, rightKey, ranking) {
  const leftState = getTrackState(ranking, leftKey);
  const rightState = getTrackState(ranking, rightKey);
  const leftRanked = isRankedState(leftState);
  const rightRanked = isRankedState(rightState);
  if (leftRanked !== rightRanked) return leftRanked ? -1 : 1;

  const leftExcluded = leftState.bucket === "X";
  const rightExcluded = rightState.bucket === "X";
  if (leftExcluded !== rightExcluded) return leftExcluded ? -1 : 1;

  const leftHasState = leftExcluded || leftRanked;
  const rightHasState = rightExcluded || rightRanked;
  if (leftHasState !== rightHasState) return leftHasState ? -1 : 1;

  const leftSpid = leftKey.startsWith("spid:");
  const rightSpid = rightKey.startsWith("spid:");
  if (leftSpid !== rightSpid) return leftSpid ? -1 : 1;

  return leftKey.localeCompare(rightKey, "en", { numeric: true });
}

function mergeAlbumMembershipLists(tracks) {
  const map = new Map();
  for (const track of tracks) {
    for (const membership of getTrackAlbumMemberships(track)) {
      const key = membership.albumId
        ? `id:${membership.albumId}`
        : `name:${membership.album}`;
      const existing = map.get(key) || null;
      map.set(key, {
        albumId: membership.albumId || existing?.albumId || null,
        album: membership.album || existing?.album || null,
        albumTrackCount: Number.isFinite(membership?.albumTrackCount)
          ? membership.albumTrackCount
          : Number.isFinite(existing?.albumTrackCount)
            ? existing.albumTrackCount
            : null,
      });
    }
  }
  return Array.from(map.values());
}

function buildOrderedKeys(ranking) {
  if (!ranking?.tracks || typeof ranking.tracks !== "object") return [];
  const rows = [];
  for (const [key] of Object.entries(ranking.tracks)) {
    const state = getTrackState(ranking, key);
    if (state.bucket === "X") continue;
    const rating = Number(state.rating);
    const hasExplicitOrder =
      (state.bucket && state.bucket !== "U" && state.bucket !== "X") ||
      (Number.isFinite(rating) && Math.round(rating) !== 1000);
    if (!hasExplicitOrder) continue;
    rows.push({ key, rating: Number.isFinite(rating) ? rating : 0 });
  }
  rows.sort(
    (a, b) =>
      b.rating - a.rating ||
      a.key.localeCompare(b.key, "en", { numeric: true }),
  );
  return rows.map(r => r.key);
}

function applyOrderToRanking(ranking, orderedKeys) {
  if (!ranking || !Array.isArray(orderedKeys)) return ranking;
  const total = orderedKeys.length;
  if (!total) return ranking;
  const now = new Date().toISOString();
  const nextTracks = { ...ranking.tracks };
  for (let i = 0; i < total; i += 1) {
    const key = orderedKeys[i];
    const prev = getTrackState(ranking, key);
    const rating = ORDER_BASE_ELO + (total - i - 1);
    nextTracks[key] = {
      ...prev,
      rating,
      bucket: prev.bucket === "X" ? "X" : "U",
      lastComparedAt: now,
    };
  }
  return { ...ranking, tracks: nextTracks, updatedAt: now };
}

function moveOrderedKey(orderedKeys, trackKey, direction) {
  if (!Array.isArray(orderedKeys) || !trackKey) return orderedKeys;
  const index = orderedKeys.indexOf(trackKey);
  if (index < 0) return orderedKeys;
  const target = index + direction;
  if (target < 0 || target >= orderedKeys.length) return orderedKeys;
  const nextOrder = orderedKeys.slice();
  [nextOrder[index], nextOrder[target]] = [nextOrder[target], nextOrder[index]];
  return nextOrder;
}

function loadLocalRankingWithLegacy(userId) {
  if (!userId) return null;
  let local = readUserRanking(userId) ?? createEmptyUserRanking({ userId });
  const legacyPrefix = `sp_rank_v1_${userId}_`;

  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(legacyPrefix)) continue;
      const playlistId = k.slice(legacyPrefix.length);
      if (!playlistId) continue;
      const legacy = readLegacyPlaylistRanking(userId, playlistId);
      if (legacy) local = mergeLegacyPlaylistRanking(local, legacy, playlistId);
    }
  } catch {
    // ignore
  }

  return local;
}

function sanitizeImportedRankingState(state, userId) {
  const next = state && typeof state === "object" ? { ...state } : null;
  if (!next) return null;
  if (typeof next.schemaVersion !== "number") next.schemaVersion = 1;
  if (typeof next.userId !== "string") next.userId = userId;
  if (typeof next.createdAt !== "string")
    next.createdAt = new Date().toISOString();
  if (typeof next.updatedAt !== "string")
    next.updatedAt = new Date().toISOString();
  if (!next.tracks || typeof next.tracks !== "object") next.tracks = {};
  if (!Array.isArray(next.history)) next.history = [];
  if (!next.migratedPlaylists || typeof next.migratedPlaylists !== "object")
    next.migratedPlaylists = {};
  return next;
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function userStorageKeys(userId) {
  return {
    ranking: `sp_rank_v1_user_${userId}`,
    legacyPlaylistRankingPrefix: `sp_rank_v1_${userId}_`,
    playlists: `sp_cache_v1_me_playlists_${userId}`,
    cooldown: `sp_cache_v1_cooldown_${userId}`,
    playlistTracksPrefix: `sp_cache_v1_playlist_tracks_${userId}_`,
    playlistTracksMetaPrefix: `sp_cache_v1_playlist_tracks_meta_${userId}_`,
    playlistTracksErrorPrefix: `sp_cache_v1_playlist_tracks_error_${userId}_`,
    albumTracksPrefix: `sp_cache_v1_album_tracks_${userId}_`,
    artistIdsByName: `sp_cache_v1_artist_ids_by_name_${userId}`,
    globalSongs: `sp_global_songs_v1_${userId}`,
  };
}

function collectStorageRecordsByPrefix(prefix) {
  const items = {};
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(prefix)) continue;
    const suffix = key.slice(prefix.length);
    if (!suffix) continue;
    const raw = localStorage.getItem(key);
    if (raw == null) continue;
    items[suffix] = safeJsonParse(raw) ?? raw;
  }
  return items;
}

function clearUserLocalAppData(userId) {
  if (!userId) return;
  const keys = userStorageKeys(userId);
  const toRemove = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key) continue;
    if (
      key === keys.ranking ||
      key === keys.playlists ||
      key === keys.cooldown ||
      key === keys.artistIdsByName ||
      key === keys.globalSongs ||
      key.startsWith(keys.legacyPlaylistRankingPrefix) ||
      key.startsWith(keys.playlistTracksPrefix) ||
      key.startsWith(keys.playlistTracksMetaPrefix) ||
      key.startsWith(keys.playlistTracksErrorPrefix) ||
      key.startsWith(keys.albumTracksPrefix)
    ) {
      toRemove.push(key);
    }
  }
  toRemove.forEach(key => localStorage.removeItem(key));
}

function writeStorageJson(key, value) {
  if (!key || value == null) return;
  localStorage.setItem(key, JSON.stringify(value));
}

function collectFullUserExport(userId, ranking, profile, uiSnapshot = {}) {
  if (!userId) return null;
  const keys = userStorageKeys(userId);
  const rankingState = ranking ?? readUserRanking(userId) ?? createEmptyUserRanking({ userId });
  const playlistsCache = readPlaylistsCache(userId);
  const globalSongs = readGlobalSongs(userId);
  const artistIdByNameCache = readArtistIdByNameCache(userId);
  const cooldownUntilMs = getSpotifyCooldownUntil(userId);

  const rawLocalStorage = {};
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key) continue;
    if (
      key === keys.ranking ||
      key === keys.playlists ||
      key === keys.cooldown ||
      key === keys.artistIdsByName ||
      key === keys.globalSongs ||
      key.startsWith(keys.legacyPlaylistRankingPrefix) ||
      key.startsWith(keys.playlistTracksPrefix) ||
      key.startsWith(keys.playlistTracksMetaPrefix) ||
      key.startsWith(keys.playlistTracksErrorPrefix) ||
      key.startsWith(keys.albumTracksPrefix)
    ) {
      const raw = localStorage.getItem(key);
      if (raw != null) rawLocalStorage[key] = raw;
    }
  }

  return {
    version: 2,
    exportedAt: new Date().toISOString(),
    exportedForUserId: userId,
    profileSnapshot:
      profile && typeof profile === "object"
        ? {
            id: typeof profile.id === "string" ? profile.id : null,
            display_name:
              typeof profile.display_name === "string"
                ? profile.display_name
                : null,
          }
        : null,
    uiSnapshot,
    appData: {
      ranking: rankingState,
      playlistsCache,
      globalSongs,
      artistIdByNameCache,
      cooldownUntilMs: Number.isFinite(cooldownUntilMs) ? cooldownUntilMs : null,
      playlistTracksById: collectStorageRecordsByPrefix(keys.playlistTracksPrefix),
      playlistTrackMetaById: collectStorageRecordsByPrefix(keys.playlistTracksMetaPrefix),
      playlistTrackErrorsById: collectStorageRecordsByPrefix(keys.playlistTracksErrorPrefix),
      albumTracksById: collectStorageRecordsByPrefix(keys.albumTracksPrefix),
      legacyPlaylistRankingsById: collectStorageRecordsByPrefix(
        keys.legacyPlaylistRankingPrefix,
      ),
    },
    rawLocalStorage,
  };
}

function restoreFullUserImport(parsed, userId) {
  if (!parsed || typeof parsed !== "object" || !userId) return false;
  const keys = userStorageKeys(userId);
  const appData =
    parsed?.appData && typeof parsed.appData === "object" ? parsed.appData : {};

  clearUserLocalAppData(userId);

  const ranking = sanitizeImportedRankingState(appData.ranking, userId);
  if (ranking) {
    ranking.userId = userId;
    writeStorageJson(keys.ranking, ranking);
  }

  if (appData.playlistsCache && typeof appData.playlistsCache === "object") {
    writeStorageJson(keys.playlists, appData.playlistsCache);
  }

  if (Number.isFinite(appData.cooldownUntilMs)) {
    writeStorageJson(keys.cooldown, {
      cooldownUntilMs: Number(appData.cooldownUntilMs),
    });
  }

  if (appData.globalSongs && typeof appData.globalSongs === "object") {
    writeStorageJson(keys.globalSongs, appData.globalSongs);
  }

  if (
    appData.artistIdByNameCache &&
    typeof appData.artistIdByNameCache === "object"
  ) {
    writeStorageJson(keys.artistIdsByName, {
      ...appData.artistIdByNameCache,
      userId,
    });
  }

  for (const [playlistId, record] of Object.entries(
    appData.playlistTracksById || {},
  )) {
    if (!playlistId || !record || typeof record !== "object") continue;
    writeStorageJson(`${keys.playlistTracksPrefix}${playlistId}`, {
      ...record,
      playlistId,
    });
  }

  for (const [playlistId, record] of Object.entries(
    appData.playlistTrackMetaById || {},
  )) {
    if (!playlistId || !record || typeof record !== "object") continue;
    writeStorageJson(`${keys.playlistTracksMetaPrefix}${playlistId}`, {
      ...record,
      playlistId,
    });
  }

  for (const [playlistId, record] of Object.entries(
    appData.playlistTrackErrorsById || {},
  )) {
    if (!playlistId || !record || typeof record !== "object") continue;
    writeStorageJson(`${keys.playlistTracksErrorPrefix}${playlistId}`, {
      ...record,
      playlistId,
    });
  }

  for (const [albumId, record] of Object.entries(appData.albumTracksById || {})) {
    if (!albumId || !record || typeof record !== "object") continue;
    writeStorageJson(`${keys.albumTracksPrefix}${albumId}`, {
      ...record,
      albumId,
    });
  }

  for (const [playlistId, record] of Object.entries(
    appData.legacyPlaylistRankingsById || {},
  )) {
    if (!playlistId || !record || typeof record !== "object") continue;
    writeStorageJson(`${keys.legacyPlaylistRankingPrefix}${playlistId}`, {
      ...record,
      userId,
      playlistId,
    });
  }

  return true;
}

const PLAYLIST_AUTO_REFRESH_MS = 5 * 60 * 1000;
const HOW_TO_USE_STEPS = [
  "Open Playlists and add one or more Spotify playlists into your ranking pool.",
  "Go to Rank Songs and place unranked songs with the binary compare flow.",
  "Use Do not rate for songs you do not want in the final ranking.",
  "Open Dashboard to review top songs, top artists, and album progress.",
];

const HOW_TO_USE_PAGES = [
  {
    title: "Playlists",
    description:
      "Browse your Spotify playlists, search by name or owner, and import tracks with Add to Rankings.",
  },
  {
    title: "Rank Songs",
    description:
      "Work through the Unranked list, compare songs in the center column, and fine-tune order from Ranked.",
  },
  {
    title: "Dashboard",
    description:
      "See your global ranking as top songs, artist summaries, and album progress with album and single-song add-to-ranking actions.",
  },
];

const HOW_TO_USE_RULES = [
  "Your ranking is global, so the same song only needs to be ranked once even if it appears in multiple playlists.",
  "Do not rate removes a song from ranking until you restore it.",
  "Back up & Restore lets you save or restore your data on this device.",
];

function readAuthErrorFromLocation() {
  const params = new URLSearchParams(window.location.search || "");
  const authError = params.get("auth_error");
  if (!authError) return null;

  const authStatus = params.get("auth_status");
  const statusText = authStatus ? ` (Spotify ${authStatus})` : "";

  if (authError === "spotify_login_cancelled") {
    params.delete("auth_error");
    params.delete("auth_status");
    const nextSearch = params.toString();
    const nextUrl =
      window.location.pathname +
      (nextSearch ? `?${nextSearch}` : "") +
      window.location.hash;
    window.history.replaceState(null, "", nextUrl);
    return null;
  }

  let message = "Spotify login failed.";
  if (authError === "spotify_profile_forbidden") {
    message =
      "Spotify blocked this account right after login" +
      `${statusText}. ` +
      "For Development Mode apps, this usually means the account is not eligible: it may need Spotify Premium and may also need to be added to the app's user allowlist in the Spotify Developer Dashboard.";
  }

  params.delete("auth_error");
  params.delete("auth_status");
  const nextSearch = params.toString();
  const nextUrl =
    window.location.pathname +
    (nextSearch ? `?${nextSearch}` : "") +
    window.location.hash;
  window.history.replaceState(null, "", nextUrl);

  return message;
}

function App() {
  const [loading, setLoading] = useState(true);
  const [loggedIn, setLoggedIn] = useState(false);
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState(null);
  const [isOwnerUser, setIsOwnerUser] = useState(false);
  const [routePath, setRoutePath] = useState(
    () => window.location.pathname || "/",
  );
  const [nowMs, setNowMs] = useState(() => Date.now());

  const [playlistsLoading, setPlaylistsLoading] = useState(false);
  const [playlistsError, setPlaylistsError] = useState(null);
  const [playlistsCache, setPlaylistsCache] = useState(null);
  const [playlistsSource, setPlaylistsSource] = useState(null); // 'cache' | 'api'
  const [cooldownUntilMs, setCooldownUntilMs] = useState(null);
  const [nextPlaylistsRefreshAt, setNextPlaylistsRefreshAt] = useState(null);

  const [selectedPlaylistId, setSelectedPlaylistId] = useState(null);
  const [tracksLoading, setTracksLoading] = useState(false);
  const [tracksError, setTracksError] = useState(null);
  const [tracksCache, setTracksCache] = useState(null);
  const [tracksSource, setTracksSource] = useState(null); // 'cache' | 'api'
  const [dashboardImportError, setDashboardImportError] = useState(null);
  const [dataImportDragActive, setDataImportDragActive] = useState(false);
  const [isHowToUseOpen, setIsHowToUseOpen] = useState(false);
  const [localDataRevision, setLocalDataRevision] = useState(0);

  const [rankingSync, setRankingSync] = useState({
    status: "idle",
    lastSyncedAt: null,
    message: null,
  });
  const [userRanking, setUserRanking] = useState(null);
  const [rankTrackRequest, setRankTrackRequest] = useState(null);
  const saveTimerRef = useRef(null);
  const pendingSaveRef = useRef(false);

  const isDashboardRoute = routePath === "/app/dashboard";
  const isRankRoute = routePath === "/rank";
  const isDashboardLikeRoute = isDashboardRoute;
  const isPublicLanding = !loggedIn;
  const isPlaylistsRoute =
    loggedIn && routePath === "/app" && !selectedPlaylistId;
  const isPlaylistDetailRoute =
    loggedIn && routePath === "/app" && Boolean(selectedPlaylistId);

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const onPop = () => setRoutePath(window.location.pathname || "/");
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  function navigate(to, { replace = false } = {}) {
    if (!to || to === routePath) return;
    if (replace) window.history.replaceState(null, "", to);
    else window.history.pushState(null, "", to);
    setRoutePath(to);
  }

  useEffect(() => {
    const authError = readAuthErrorFromLocation();
    if (authError) setError(authError);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const sessionRes = await fetch("/api/session");
        const session = await sessionRes.json();

        if (!session?.loggedIn) {
          setLoggedIn(false);
          setIsOwnerUser(false);
          return;
        }

        setLoggedIn(true);
        setIsOwnerUser(Boolean(session?.isOwnerUser));
        setError(null);

        if (session?.user && typeof session.user === "object") {
          setProfile(session.user);
          return;
        }

        const meRes = await fetch("/api/me");
        if (meRes.ok) {
          const me = await meRes.json();
          setProfile(me);
          setError(null);
          return;
        }

        const meData = await meRes.json().catch(() => null);
        const meMessage =
          typeof meData?.details?.error?.message === "string"
            ? meData.details.error.message
            : typeof meData?.message === "string"
              ? meData.message
              : typeof meData?.error === "string"
                ? meData.error
                : null;
        if (meRes.status === 401 || meRes.status === 403) {
          await fetch("/auth/logout", { method: "POST" }).catch(() => null);
          setLoggedIn(false);
          setProfile(null);
          setIsOwnerUser(false);
        }
        setError(
          meRes.status === 403
            ? "Spotify denied access to this account after login (Spotify 403). For Development Mode apps, the account may need Spotify Premium and may also need to be allowlisted in the Spotify Developer Dashboard."
            : meMessage || "Failed to load your Spotify profile",
        );
      } catch (e) {
        setError(e?.message || "Something went wrong");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (loading) return;
    if (!loggedIn && routePath !== "/") navigate("/", { replace: true });
    if (loggedIn && !routePath.startsWith("/app") && routePath !== "/rank")
      navigate("/app", { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, loggedIn, routePath]);

  useEffect(() => {
    if (!loggedIn) {
      setPlaylistsCache(null);
      setPlaylistsError(null);
      setPlaylistsSource(null);
      setCooldownUntilMs(null);
      setSelectedPlaylistId(null);
      setTracksCache(null);
      setTracksError(null);
      setTracksSource(null);
      setNextPlaylistsRefreshAt(null);
      setUserRanking(null);
      setDashboardImportError(null);
      setRankingSync({ status: "idle", lastSyncedAt: null, message: null });
      setIsOwnerUser(false);
    }
  }, [loggedIn]);

  useEffect(() => {
    document.body.classList.toggle("publicLandingBody", isPublicLanding);
    return () => {
      document.body.classList.remove("publicLandingBody");
    };
  }, [isPublicLanding]);

  const refreshPlaylistsCache = useCallback(async ({ force = false } = {}) => {
    if (!loggedIn || !profile?.id) return;

    const userId = profile.id;
    if (force) {
      clearPlaylistsCache(userId);
      setPlaylistsCache(null);
      setPlaylistsSource(null);
    }

    const now = Date.now();
    const cooldownUntil = getSpotifyCooldownUntil(userId);
    if (cooldownUntil && now < cooldownUntil) {
      setCooldownUntilMs(cooldownUntil);
      setPlaylistsError(
        `Spotify rate limit cooldown active until ${new Date(cooldownUntil).toLocaleString()}. Avoid refreshing until then.`,
      );
      return;
    }

    setPlaylistsLoading(true);
    setPlaylistsError(null);

    try {
      const params = new URLSearchParams({ all: "1" });
      if (force) params.set("force", "1");
      const res = await fetch(`/api/me/playlists?${params.toString()}`);

      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }

      if (res.status === 429) {
        const retryAfterSeconds = Number(data?.retryAfterSeconds);
        const until = Number.isFinite(retryAfterSeconds)
          ? Date.now() + retryAfterSeconds * 1000
          : Date.now() + 60_000;
        setSpotifyCooldown(userId, until);
        setCooldownUntilMs(until);
        setPlaylistsError(
          `Spotify rate limited this request (HTTP 429). Next safe refresh: ${new Date(until).toLocaleString()}.`,
        );
        return;
      }

      if (!res.ok) {
        const detailsMessage =
          typeof data?.details?.error?.message === "string"
            ? data.details.error.message
            : typeof data?.details?.error_description === "string"
              ? data.details.error_description
              : null;
        const msg =
          detailsMessage ||
          (typeof data?.message === "string"
            ? data.message
            : typeof data?.error === "string"
              ? data.error
              : "Failed to fetch playlists");
        setPlaylistsError(
          res.status === 403
            ? `${msg} (Spotify 403). If you recently changed scopes, click “Log out” and log back in.`
            : msg,
        );
        return;
      }

      const fetchedAt = new Date().toISOString();
      const spotifyFetchedAt =
        res.headers.get("x-sp-cache-fetched-at") || fetchedAt;
      const spotifyLastRefreshedAt =
        res.headers.get("x-sp-cache-last-refreshed-at") || spotifyFetchedAt;
      const apiItemsCount = Array.isArray(data?.items) ? data.items.length : 0;
      const apiTotal = Number(data?.total) || apiItemsCount;
      const isComplete = !data?.partial && apiItemsCount >= apiTotal;

      writePlaylistsCache(userId, data, {
        fetchedAt,
        isComplete,
        spotifyFetchedAt,
        spotifyLastRefreshedAt,
      });
      const cached = readPlaylistsCache(userId);
      setPlaylistsCache(cached);
      setPlaylistsSource("api");
      setCooldownUntilMs(getSpotifyCooldownUntil(userId));
    } catch (e) {
      setPlaylistsError(e?.message || "Failed to fetch playlists");
    } finally {
      setPlaylistsLoading(false);
    }
  }, [loggedIn, profile?.id]);

  useEffect(() => {
    if (!loggedIn || !profile?.id) return;

    const userId = profile.id;
    const cached = readPlaylistsCache(userId);
    setCooldownUntilMs(getSpotifyCooldownUntil(userId));

    if (cached) {
      setPlaylistsCache(cached);
      setPlaylistsSource("cache");
      refreshPlaylistsCache({ force: false });
      return;
    }

    // No cache yet: do a fetch to seed the cache.
    refreshPlaylistsCache({ force: false });
  }, [loggedIn, profile?.id, refreshPlaylistsCache]);

  useEffect(() => {
    if (!loggedIn || !profile?.id) {
      setNextPlaylistsRefreshAt(null);
      return;
    }

    setNextPlaylistsRefreshAt(Date.now() + PLAYLIST_AUTO_REFRESH_MS);
    const id = window.setInterval(() => {
      setNextPlaylistsRefreshAt(Date.now() + PLAYLIST_AUTO_REFRESH_MS);
      refreshPlaylistsCache({ force: false });
    }, PLAYLIST_AUTO_REFRESH_MS);

    return () => window.clearInterval(id);
  }, [loggedIn, profile?.id, refreshPlaylistsCache]);

  async function refreshPlaylistTracks({ playlistId, force = false } = {}) {
    if (!loggedIn || !profile?.id || !playlistId) return;

    const userId = profile.id;
    if (force) {
      clearPlaylistTracksCache(userId, playlistId);
      setTracksCache(null);
      setTracksSource(null);
      setTracksError(null);
    }

    const now = Date.now();
    const cooldownUntil = getSpotifyCooldownUntil(userId);
    if (cooldownUntil && now < cooldownUntil) {
      setCooldownUntilMs(cooldownUntil);
      setTracksError(
        `Spotify rate limit cooldown active until ${new Date(cooldownUntil).toLocaleString()}. Avoid refreshing until then.`,
      );
      return;
    }

    setTracksLoading(true);
    setTracksError(null);

    try {
      const params = new URLSearchParams({ all: "1" });
      if (force) params.set("force", "1");
      const res = await fetch(
        `/api/playlists/${encodeURIComponent(playlistId)}/tracks?${params.toString()}`,
      );

      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }

      if (res.status === 429) {
        const retryAfterSeconds = Number(data?.retryAfterSeconds);
        const until = Number.isFinite(retryAfterSeconds)
          ? Date.now() + retryAfterSeconds * 1000
          : Date.now() + 60_000;
        setSpotifyCooldown(userId, until);
        setCooldownUntilMs(until);
        setTracksError(
          `Spotify rate limited this request (HTTP 429). Next safe refresh: ${new Date(until).toLocaleString()}.`,
        );
        return;
      }

      if (!res.ok) {
        const detailsMessage =
          typeof data?.details?.error?.message === "string"
            ? data.details.error.message
            : typeof data?.details?.error_description === "string"
              ? data.details.error_description
              : null;
        const msg =
          detailsMessage ||
          (typeof data?.message === "string"
            ? data.message
            : typeof data?.error === "string"
              ? data.error
              : "Failed to fetch playlist tracks");
        const finalMsg =
          res.status === 403
            ? `${msg} (Spotify 403). This can happen if Spotify restricts access to playlist items unless you own/collaborate on the playlist, or if scopes are missing. Try “Log out” + log back in.`
            : msg;

        if (res.status === 403 || res.status === 404) {
          writePlaylistTracksErrorCache(userId, playlistId, {
            status: res.status,
            message: finalMsg,
          });
        }

        setTracksError(finalMsg);
        return;
      }

      const fetchedAt = new Date().toISOString();
      const apiItemsCount = Array.isArray(data?.items) ? data.items.length : 0;
      const apiTotal = Number(data?.total) || apiItemsCount;
      const isComplete = !data?.partial && apiItemsCount >= apiTotal;

      writePlaylistTracksCache(userId, playlistId, data, {
        fetchedAt,
        isComplete,
      });
      const cachedTracks = readPlaylistTracksCache(userId, playlistId);
      setTracksCache(cachedTracks);
      setTracksSource("api");
      setCooldownUntilMs(getSpotifyCooldownUntil(userId));
    } catch (e) {
      setTracksError(e?.message || "Failed to fetch playlist tracks");
    } finally {
      setTracksLoading(false);
    }
  }

  useEffect(() => {
    if (!loggedIn || !profile?.id || !selectedPlaylistId) return;

    const userId = profile.id;
    const cachedError = readPlaylistTracksErrorCache(
      userId,
      selectedPlaylistId,
    );
    if (cachedError) {
      setTracksError(
        cachedError.message ||
          `Playlist tracks previously failed (HTTP ${cachedError.status}).`,
      );
      setTracksSource("cache");
      return;
    }

    const cachedTracks = readPlaylistTracksCache(userId, selectedPlaylistId);
    if (cachedTracks) {
      setTracksCache(cachedTracks);
      setTracksSource("cache");
      refreshPlaylistTracks({ playlistId: selectedPlaylistId, force: false });
      return;
    }

    setTracksCache(null);
    setTracksSource(null);
    refreshPlaylistTracks({ playlistId: selectedPlaylistId, force: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loggedIn, profile?.id, selectedPlaylistId, playlistsCache]);

  useEffect(() => {
    if (loggedIn) return;
    setIsHowToUseOpen(false);
  }, [loggedIn]);

  useEffect(() => {
    if (!isHowToUseOpen) return;

    const onKeyDown = e => {
      if (e.key === "Escape") setIsHowToUseOpen(false);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isHowToUseOpen]);

  async function logout() {
    await fetch("/auth/logout", { method: "POST" });
    window.location.href = "/";
  }

  const closeHeaderDataMenus = useCallback(() => {
    document.querySelectorAll(".headerDataMenu[open]").forEach(menu => {
      menu.open = false;
    });
  }, []);

  const exportDashboardJson = useCallback(() => {
    const userId = profile?.id ?? null;
    if (!userId) return;
    const payload = collectFullUserExport(userId, userRanking, profile, {
      routePath,
      selectedPlaylistId,
    });
    if (!payload) return;
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `spotify-rating-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    closeHeaderDataMenus();
  }, [
    closeHeaderDataMenus,
    profile,
    routePath,
    selectedPlaylistId,
    userRanking,
  ]);

  const importDashboardFromText = useCallback(
    text => {
      setDashboardImportError(null);
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        setDashboardImportError("Invalid JSON.");
        return;
      }

      if (!parsed || typeof parsed !== "object") {
        setDashboardImportError("Invalid export format.");
        return;
      }

      if (![1, 2].includes(parsed.version)) {
        setDashboardImportError("Unsupported export version.");
        return;
      }

      const userId = profile?.id ?? null;
      const ok = window.confirm(
        parsed.version === 2
          ? "Import will overwrite your local ranking and cached app data on this device. Continue?"
          : "Import will overwrite your current ranking on this device. Continue?",
      );
      if (!ok) return;

      if (parsed.version === 2) {
        if (!userId) {
          setDashboardImportError("You must be signed in to import.");
          return;
        }
        const restored = restoreFullUserImport(parsed, userId);
        if (!restored) {
          setDashboardImportError("Import data could not be restored.");
          return;
        }

        const nextPlaylistsCache = readPlaylistsCache(userId);
        const nextRanking = loadLocalRankingWithLegacy(userId);
        const currentPlaylistStillExists = Boolean(
          selectedPlaylistId &&
            nextPlaylistsCache?.items?.some(p => p?.id === selectedPlaylistId),
        );

        setUserRanking(nextRanking);
        setPlaylistsCache(nextPlaylistsCache);
        setPlaylistsSource(nextPlaylistsCache ? "cache" : null);
        setPlaylistsError(null);
        setCooldownUntilMs(getSpotifyCooldownUntil(userId));
        setTracksError(null);
        if (currentPlaylistStillExists) {
          const nextTracks = readPlaylistTracksCache(userId, selectedPlaylistId);
          const nextTracksError = readPlaylistTracksErrorCache(
            userId,
            selectedPlaylistId,
          );
          setTracksCache(nextTracks);
          setTracksSource(nextTracks ? "cache" : null);
          setTracksError(
            nextTracksError
              ? nextTracksError.message ||
                  `Playlist tracks previously failed (HTTP ${nextTracksError.status}).`
              : null,
          );
        } else {
          setSelectedPlaylistId(null);
          setTracksCache(null);
          setTracksSource(null);
        }
        setLocalDataRevision(value => value + 1);
        closeHeaderDataMenus();
        return;
      }

      const importedState = sanitizeImportedRankingState(parsed.state, userId);
      if (!importedState) {
        setDashboardImportError("Missing state.");
        return;
      }

      if (importedState.schemaVersion !== 1) {
        setDashboardImportError("Unsupported state schemaVersion.");
        return;
      }

      if (userId) importedState.userId = userId;

      setUserRanking(importedState);
      closeHeaderDataMenus();
    },
    [closeHeaderDataMenus, profile?.id, selectedPlaylistId],
  );

  const importDashboardFile = useCallback(
    async file => {
      if (!file) return;
      try {
        const text = await file.text();
        importDashboardFromText(text);
      } catch (err) {
        setDashboardImportError(err?.message || "Failed to read file.");
      }
    },
    [importDashboardFromText],
  );

  const onPickDashboardImportFile = useCallback(
    async e => {
      const file = e.target.files?.[0];
      e.target.value = "";
      await importDashboardFile(file);
    },
    [importDashboardFile],
  );

  const onDataImportDragOver = useCallback(e => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    setDataImportDragActive(true);
  }, []);

  const onDataImportDragLeave = useCallback(e => {
    e.preventDefault();
    e.stopPropagation();
    setDataImportDragActive(false);
  }, []);

  const onDataImportDrop = useCallback(
    async e => {
      e.preventDefault();
      e.stopPropagation();
      setDataImportDragActive(false);
      const file = e.dataTransfer?.files?.[0];
      await importDashboardFile(file);
    },
    [importDashboardFile],
  );

  const syncRankings = useCallback(
    async ({ force = false } = {}) => {
      if (!loggedIn || !profile?.id) return;
      const userId = profile.id;
      const local = loadLocalRankingWithLegacy(userId);

      setUserRanking(local);
      writeUserRanking(userId, local);

      if (!isOwnerUser) {
        pendingSaveRef.current = false;
        setRankingSync({
          status: "idle",
          lastSyncedAt: null,
          message: null,
        });
        return;
      }

      setRankingSync(s => ({
        status: "syncing",
        lastSyncedAt: s.lastSyncedAt,
        message: null,
      }));

      try {
        const res = await fetch("/api/ranking");
        const data = await res.json().catch(() => null);
        if (!res.ok)
          throw new Error(
            data?.error || data?.message || "ranking_fetch_failed",
          );

        const serverRanking = data?.exists ? data?.ranking : null;
        const merged = serverRanking
          ? mergeUserRankings(local, serverRanking)
          : local;

        const hasAny = Boolean(Object.keys(merged?.tracks ?? {}).length);
        if (hasAny || force) {
          const putRes = await fetch("/api/ranking", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(merged),
          });
          const putData = await putRes.json().catch(() => null);
          if (!putRes.ok)
            throw new Error(
              putData?.error || putData?.message || "ranking_save_failed",
            );
        }

        writeUserRanking(userId, merged);
        setUserRanking(merged);
        setRankingSync({
          status: "ok",
          lastSyncedAt: new Date().toISOString(),
          message: null,
        });
      } catch (e) {
        setRankingSync(s => ({
          status: "error",
          lastSyncedAt: s.lastSyncedAt,
          message: e?.message || "Sync failed",
        }));
      }
    },
    [isOwnerUser, loggedIn, profile?.id],
  );

  useEffect(() => {
    if (!loggedIn || !profile?.id) return;
    (async () => {
      await syncRankings({ force: false });
    })();
  }, [loggedIn, profile?.id, syncRankings]);

  useEffect(() => {
    if (!loggedIn || !profile?.id || !userRanking) return;
    writeUserRanking(profile.id, userRanking);
  }, [loggedIn, profile?.id, userRanking]);

  useEffect(() => {
    if (!isOwnerUser || !loggedIn || !profile?.id || !userRanking) return;
    if (rankingSync.status === "syncing") return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);

    pendingSaveRef.current = true;
    saveTimerRef.current = setTimeout(() => {
      (async () => {
        try {
          await fetch("/api/ranking", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(userRanking),
          });
          setRankingSync(() => ({
            status: "ok",
            lastSyncedAt: new Date().toISOString(),
            message: null,
          }));
          pendingSaveRef.current = false;
        } catch (e) {
          setRankingSync(s => ({
            status: "error",
            lastSyncedAt: s.lastSyncedAt,
            message: e?.message || "Sync failed",
          }));
        }
      })();
    }, 800);

    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [isOwnerUser, loggedIn, profile?.id, userRanking, rankingSync.status]);

  useEffect(() => {
    if (!isOwnerUser || !loggedIn || !profile?.id) return;

    const onBeforeUnload = () => {
      if (!pendingSaveRef.current) return;
      try {
        fetch("/api/ranking", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(userRanking),
          keepalive: true,
        });
      } catch {
        // ignore
      }
    };

    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isOwnerUser, loggedIn, profile?.id, userRanking]);

  if (loading) {
    return (
      <div className="appShell">
        <div className="container">
          <div className="card">
            <p>Loading…</p>
          </div>
        </div>
      </div>
    );
  }

  const closeHeaderStorageNotice = event => {
    closeHeaderDataMenus();
    const details = event.currentTarget.closest("details");
    if (details) details.open = false;
  };

  const renderHeaderDataMenu = className => (
    <details className={`headerDataMenu ${className}`.trim()}>
      <summary className="btn small">Back up & Restore</summary>
      <div className="headerDataMenuPanel">
        <div className="headerDataMenuTitle">Backup and restore</div>
        <button
          className="btn small"
          onClick={exportDashboardJson}
        >
          Export Backup
        </button>
        <label
          className={`headerDataDropzone ${dataImportDragActive ? "active" : ""}`.trim()}
          onDragEnter={onDataImportDragOver}
          onDragOver={onDataImportDragOver}
          onDragLeave={onDataImportDragLeave}
          onDrop={onDataImportDrop}
        >
          <span className="headerDataDropzoneTitle">Import Backup</span>
          <span className="headerDataDropzoneMeta">
            Drag and drop a JSON backup here or click to browse.
          </span>
          <span className="headerDataDropzoneHint">Choose file</span>
          <input
            type="file"
            accept="application/json"
            onChange={onPickDashboardImportFile}
            className="headerDataFileInput"
          />
        </label>
      </div>
    </details>
  );

  const renderHeaderStorageNotice = (className, { includeDataMenu = false } = {}) => (
    <details className={`headerStorageNotice ${className}`.trim()}>
      <summary
        className="headerStorageNoticeBtn"
        aria-label="Storage and backup notice"
        title="Storage and backup notice"
      >
        !
      </summary>
      <div className="headerStorageNoticePanel">
        <div className="headerStorageNoticePanelHeader">
          <div className="headerStorageNoticeTitle">Back up & restore</div>
          <button
            type="button"
            className="headerStorageNoticeClose"
            aria-label="Close storage and backup notice"
            onClick={closeHeaderStorageNotice}
          >
            X
          </button>
        </div>
        <p className="headerStorageNoticeText">
          {isOwnerUser
            ? "This owner account also syncs changes to the server, but you should still use Back up & Restore regularly."
            : "Your rankings and playlist data stay in this browser on this device."}
        </p>
        <p className="headerStorageNoticeText">
          Use Back up & Restore regularly so you have a local backup if this
          browser's stored site data is cleared or the browser resets.
        </p>
        <p className="headerStorageNoticeText headerStorageNoticeTextSubtle">
          This normally should not happen as long as the browser's stored data
          is not cleared.
        </p>
        {includeDataMenu ? (
          <div className="headerStorageNoticeActions">
            {renderHeaderDataMenu("headerDataMenuNoticeMobile")}
          </div>
        ) : null}
      </div>
    </details>
  );

  return (
    <div
      className={`appShell ${isPublicLanding ? "appShellPublicLanding" : ""} ${isPlaylistsRoute ? "appShellPlaylistsRoute" : ""} ${isPlaylistDetailRoute ? "appShellPlaylistDetailRoute" : ""}`.trim()}
    >
      <header className={`topBar ${!loggedIn ? "topBarPublic" : ""}`.trim()}>
        <div className={`topBarInner ${!loggedIn ? "topBarInnerPublic" : ""}`.trim()}>
          <div className="topBarLeft">
            <div className="brand">
              <div className="brandTitle">Rankify</div>
              {loggedIn ? (
                <div className="brandSub">
                  {profile?.display_name
                    ? `Signed in as ${profile.display_name}.`
                    : "Signed in."}
                </div>
              ) : null}
            </div>
            {loggedIn ? (
              <div className="headerUtilityActions">
                {renderHeaderDataMenu("headerDataMenuDesktop")}
                {renderHeaderStorageNotice("headerStorageNoticeDesktop")}
              </div>
            ) : null}
          </div>

          <div className="topBarCenter">
            {loggedIn ? (
              <nav
                className="headerNav"
                aria-label="Primary"
              >
                <button
                  className={`headerNavBtn ${routePath === "/app" ? "active" : ""}`.trim()}
                  onClick={() => navigate("/app", { replace: true })}
                >
                  Playlists
                </button>
                <button
                  className={`headerNavBtn ${isRankRoute ? "active" : ""}`.trim()}
                  onClick={() => navigate("/rank", { replace: true })}
                >
                  Rank Songs
                </button>
                <button
                  className={`headerNavBtn ${isDashboardRoute ? "active" : ""}`.trim()}
                  onClick={() => navigate("/app/dashboard", { replace: true })}
                >
                  Dashboard
                </button>
              </nav>
            ) : null}
          </div>

          <div className="topActions">
            {loggedIn && dashboardImportError ? (
              <span
                className="saveStatus err"
                title={dashboardImportError}
              >
                {dashboardImportError}
              </span>
            ) : null}
            {loggedIn ? (
              <>
                {rankingSync.status === "error" ? (
                  <span
                    className="saveStatus err"
                    title={rankingSync.message || "Save failed"}
                  >
                    Save failed (will retry)
                  </span>
                ) : null}
                <div className="topActionButtons">
                  <button
                    className="btn"
                    onClick={() => setIsHowToUseOpen(true)}
                  >
                    How to use
                  </button>
                  {renderHeaderStorageNotice("headerStorageNoticeMobile", {
                    includeDataMenu: true,
                  })}
                  <button
                    className="btn danger"
                    onClick={logout}
                  >
                    Log out
                  </button>
                </div>
              </>
            ) : (
              <a
                className="navbarLink"
                href="https://github.com/Adeshv1/spotify-rating-app"
                target="_blank"
                rel="noreferrer"
              >
                GitHub
              </a>
            )}
          </div>
        </div>
      </header>

      <main
        className={
          !loggedIn
            ? "main mainLanding"
            : isDashboardLikeRoute
            ? "main mainDashboard"
            : isRankRoute
              ? "main mainRank"
              : "main"
        }
      >
        <div className={`container ${!loggedIn ? "containerLanding" : ""}`.trim()}>
          <div
            className={
              !loggedIn
                ? "card cardLanding"
                : isDashboardLikeRoute
                  ? "card cardDashboard"
                  : "card"
            }
          >
            {error ? <p className="error">{error}</p> : null}

            {!loggedIn ? (
              <LandingPage />
            ) : (
              <>
                {routePath === "/rank" ? (
                  <RankSongsPage
                    userId={profile?.id}
                    ranking={userRanking}
                    localDataRevision={localDataRevision}
                    onChangeRanking={setUserRanking}
                    trackRequest={rankTrackRequest}
                    onTrackRequestHandled={() => setRankTrackRequest(null)}
                  />
                ) : routePath === "/app/dashboard" ? (
                  <DashboardPage
                    userId={profile?.id}
                    ranking={userRanking}
                    localDataRevision={localDataRevision}
                    playlistsCache={playlistsCache}
                    onOverwriteRanking={next => setUserRanking(next)}
                    onStartRankingTrack={(trackKey, options = {}) => {
                      const currentUserId = profile?.id;
                      if (
                        currentUserId &&
                        Array.isArray(options?.tracksToAdd) &&
                        options.tracksToAdd.length
                      ) {
                        upsertGlobalSongs(currentUserId, options.tracksToAdd);
                        setLocalDataRevision(value => value + 1);
                      }
                      if (!trackKey && !options?.tracksToAdd?.length) return;
                      if (options?.restoreExcluded) {
                        setUserRanking(rk =>
                          rk ? setTrackBucket(rk, trackKey, "U") : rk,
                        );
                      }
                      setRankTrackRequest(
                        trackKey
                          ? {
                              trackKey,
                              mode: "binary",
                              nonce: Date.now(),
                            }
                          : null,
                      );
                      navigate("/rank", { replace: true });
                    }}
                  />
                ) : selectedPlaylistId ? (
                  <PlaylistView
                    userId={profile?.id}
                    playlistsCache={playlistsCache}
                    playlistId={selectedPlaylistId}
                    ranking={userRanking}
                    tracksError={tracksError}
                    tracksCache={tracksCache}
                    onBack={() => {
                      setSelectedPlaylistId(null);
                      setTracksError(null);
                      setTracksCache(null);
                      setTracksSource(null);
                    }}
                  />
                ) : (
                  <PlaylistsView
                    profile={profile}
                    playlistsLoading={playlistsLoading}
                    playlistsError={playlistsError}
                    playlistsCache={playlistsCache}
                    cooldownUntilMs={cooldownUntilMs}
                    nextPlaylistsRefreshAt={nextPlaylistsRefreshAt}
                    onGlobalSongsChanged={() =>
                      setLocalDataRevision(value => value + 1)
                    }
                    onUpdatePlaylistsCache={next => setPlaylistsCache(next)}
                    onSelect={playlistId => {
                      setSelectedPlaylistId(playlistId);
                      setTracksError(null);
                      setTracksCache(null);
                      setTracksSource(null);
                    }}
                  />
                )}
              </>
            )}
          </div>
        </div>
      </main>

      {loggedIn && isHowToUseOpen ? (
        <div
          className="helpOverlay"
          role="presentation"
          onClick={() => setIsHowToUseOpen(false)}
        >
          <section
            className="helpDialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="how-to-use-title"
            onClick={e => e.stopPropagation()}
          >
            <div className="helpDialogHeader">
              <div>
                <div className="helpDialogEyebrow">How it works</div>
                <h2 id="how-to-use-title">How to use Rankify</h2>
              </div>
              <button
                type="button"
                className="btn small helpDialogClose"
                onClick={() => setIsHowToUseOpen(false)}
                aria-label="Close how to use dialog"
              >
                Close
              </button>
            </div>

            <p className="helpDialogIntro">
              Add playlists from Spotify, rank songs into one global order, then
              use the dashboard to review your best songs, artists, and albums.
            </p>

            <div className="helpDialogGrid">
              <section className="helpCard">
                <h3>Recommended flow</h3>
                <ol className="helpList helpOrderedList">
                  {HOW_TO_USE_STEPS.map(step => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
              </section>

              <section className="helpCard">
                <h3>Main pages</h3>
                <ul className="helpList">
                  {HOW_TO_USE_PAGES.map(page => (
                    <li key={page.title}>
                      <strong>{page.title}:</strong> {page.description}
                    </li>
                  ))}
                </ul>
              </section>
            </div>

            <section className="helpCard helpCardWide">
              <h3>Important rules</h3>
              <ul className="helpList">
                {HOW_TO_USE_RULES.map(rule => (
                  <li key={rule}>{rule}</li>
                ))}
              </ul>
            </section>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function TopArtistCard({ artist, artistId, rootEl, imageState, onVisible }) {
  const cardRef = useRef(null);
  const artistName =
    typeof artist?.name === "string" ? artist.name : "Unknown artist";
  const tracks = Array.isArray(artist?.topTracks)
    ? artist.topTracks
    : Array.isArray(artist?.topSongs)
      ? artist.topSongs
      : [];
  const imageUrl =
    typeof imageState?.imageUrl === "string" ? imageState.imageUrl : null;
  const rankedTrackCount = Number.isFinite(Number(artist?.totalTracks))
    ? Number(artist.totalTracks)
    : Number.isFinite(Number(artist?.n))
      ? Number(artist.n)
      : null;

  useEffect(() => {
    if (!cardRef.current) return;
    if (
      imageState?.status === "loaded" ||
      imageState?.status === "loading" ||
      imageState?.status === "error"
    )
      return;

    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(e => e.isIntersecting)) {
          onVisible?.(artist);
          observer.disconnect();
        }
      },
      { root: rootEl || null, rootMargin: "200px 0px", threshold: 0.01 },
    );

    observer.observe(cardRef.current);
    return () => observer.disconnect();
  }, [rootEl, onVisible, artist, imageState?.status]);

  return (
    <div
      ref={cardRef}
      className="artistCard"
      role="listitem"
    >
      <div className="artistCardImage">
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={`${artistName}`}
            loading="lazy"
          />
        ) : (
          <div
            className="artistCardPlaceholder"
            aria-hidden="true"
          >
            {artistName.slice(0, 1).toUpperCase()}
          </div>
        )}
      </div>
      <div className="artistCardBody">
        <div className="artistCardHeaderRow">
          <div className="artistCardName">{artistName}</div>
          {artistId ? (
            <button
              className="btn small artistCardPlayBtn"
              onClick={() => openArtistInSpotify(artistId)}
              title="Open artist in Spotify"
            >
              Play
            </button>
          ) : null}
        </div>
        {Number.isFinite(Number(artist?.adjustedAvgRank)) ? (
          <div className="artistCardScore">
            <span className="artistCardScoreLabel">AVG RANK (Top 5):</span>{" "}
            <span className="rankValue">
              {Math.round(Number(artist.adjustedAvgRank) || 0)}
            </span>
          </div>
        ) : null}
        {rankedTrackCount ? (
          <div className="artistCardTrackCount">
            {rankedTrackCount} ranked track{rankedTrackCount === 1 ? "" : "s"}
          </div>
        ) : null}
        <ul
          className="artistCardTracks"
          aria-label={`${artistName} top songs`}
        >
          {tracks.slice(0, 5).map(s => (
            <li
              key={s.trackKey}
              className="artistCardTrack"
            >
              <span className="artistCardTrackName">
                {s.name || s.trackKey}
              </span>
              <span className="artistCardTrackRight">
                <span className="artistCardTrackScore rankValue">
                  #{Math.round(Number(s.rank) || 0)}
                </span>
                {(() => {
                  const trackId =
                    (typeof s?.id === "string" ? s.id : null) ||
                    (typeof s?.trackKey === "string" &&
                    s.trackKey.startsWith("spid:")
                      ? s.trackKey.slice("spid:".length)
                      : null);
                  if (!trackId) return null;
                  return (
                    <button
                      className="btn small artistCardTrackPlayBtn"
                      onClick={() => openTrackInSpotify(trackId)}
                      title="Open track in Spotify"
                    >
                      Play
                    </button>
                  );
                })()}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function AlbumProgressExpandedContent({
  album,
  albumLoadState,
  onOpenAlbum,
  onRankWholeAlbum,
  onRateTrack,
}) {
  const hasPendingAlbumTracks =
    album.unratedCount > 0 || album.doNotRateCount > 0;

  return (
    <Fragment>
      <div className="albumExpandHeader">
        <div className="albumPromptGroup">
          {album.unratedCount > 0 ? (
            <p className="meta albumPrompt">
              {album.unratedCount} song
              {album.unratedCount === 1 ? "" : "s"} still need
              ranking. Finish this album from here.
            </p>
          ) : album.doNotRateCount > 0 ? (
            <p className="meta albumPrompt">
              {album.doNotRateCount} song
              {album.doNotRateCount === 1 ? "" : "s"} marked
              Do not rate for this album.
            </p>
          ) : (
            <p className="meta albumPrompt">
              All songs from this album are rated.
            </p>
          )}
          {!album.albumTracksLoaded &&
          album.totalTracks >
            album.ratedTracks.length +
              album.unratedTracks.length +
              album.doNotRateTracks.length ? (
            <p className="meta albumPromptSecondary">
              {albumLoadState?.status === "loading"
                ? "Loading full album tracklist…"
                : albumLoadState?.status === "error"
                  ? albumLoadState.error
                  : "Expanding this album fetches the remaining songs from Spotify once, then caches them."}
            </p>
          ) : null}
        </div>
        <span className="albumHeaderActions">
          {album.albumId ? (
            <button
              className="btn small"
              onClick={() => onOpenAlbum?.(album.albumId)}
            >
              Open album
            </button>
          ) : null}
          {album.unratedCount > 0 ? (
            <button
              className="btn small"
              onClick={() => onRankWholeAlbum?.(album)}
            >
              Rank whole album
            </button>
          ) : null}
        </span>
      </div>
      <div
        className={`albumExpandGrid ${hasPendingAlbumTracks ? "" : "albumExpandGridSingle"}`.trim()}
      >
        <div className="albumSection">
          <div className="albumSectionTitle">
            Rated ({album.ratedCount})
          </div>
          {album.ratedTracks.length ? (
            <ul className="albumTrackList">
              {album.ratedTracks.map(track => {
                const trackId =
                  (typeof track?.id === "string" ? track.id : null) ||
                  (typeof track?.trackKey === "string" &&
                  track.trackKey.startsWith("spid:")
                    ? track.trackKey.slice("spid:".length)
                    : null);
                return (
                  <li
                    key={track.trackKey}
                    className="albumTrackRow"
                  >
                    <div className="albumTrackMain">
                      <span className="albumTrackName">
                        {track.name || track.trackKey}
                      </span>
                      <span className="albumTrackMeta">
                        {track.artists?.length
                          ? track.artists.join(", ")
                          : "Unknown artist"}
                      </span>
                    </div>
                    <span className="albumTrackActions">
                      <span className="rankValue">
                        #{Math.round(track.rank || 0)}
                      </span>
                      {trackId ? (
                        <button
                          className="btn small compact"
                          onClick={() => openTrackInSpotify(trackId)}
                          title="Open in Spotify"
                        >
                          Play
                        </button>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="meta">No rated songs yet.</p>
          )}
        </div>
        {hasPendingAlbumTracks ? (
          <div className="albumSection">
            <div className="albumSectionTitle">
              Unrated ({album.unratedCount})
            </div>
            {album.unratedTracks.length ? (
              <ul className="albumTrackList">
                {album.unratedTracks.map(track => (
                  <li
                    key={track.trackKey}
                    className="albumTrackRow"
                  >
                    <div className="albumTrackMain">
                      <span className="albumTrackName">
                        {track.name || track.trackKey}
                      </span>
                      <span className="albumTrackMeta">
                        {track.artists?.length
                          ? track.artists.join(", ")
                          : "Unknown artist"}
                      </span>
                    </div>
                    <span className="albumTrackActions">
                      <button
                        className="btn small compact"
                        onClick={() => onRateTrack?.(album, track)}
                      >
                        Rate
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="meta">
                Nothing left to rate.
              </p>
            )}
            {album.doNotRateCount > 0 ? (
              <Fragment>
                <div className="albumSectionDivider" />
                <div className="albumSectionSubTitle">
                  DO NOT RATE ({album.doNotRateCount})
                </div>
                {album.doNotRateTracks.length ? (
                  <ul className="albumTrackList">
                    {album.doNotRateTracks.map(track => (
                      <li
                        key={track.trackKey}
                        className="albumTrackRow"
                      >
                        <div className="albumTrackMain">
                          <span className="albumTrackName">
                            {track.name || track.trackKey}
                          </span>
                          <span className="albumTrackMeta">
                            {track.artists?.length
                              ? track.artists.join(", ")
                              : "Unknown artist"}
                          </span>
                        </div>
                        <span className="albumTrackActions">
                          <button
                            className="btn small compact"
                            onClick={() =>
                              onRateTrack?.(album, track, {
                                restoreExcluded: true,
                              })
                            }
                          >
                            Rate
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="meta">
                    No songs are marked Do not rate.
                  </p>
                )}
              </Fragment>
            ) : null}
          </div>
        ) : null}
      </div>
    </Fragment>
  );
}

function DashboardPage({
  userId,
  ranking,
  localDataRevision,
  playlistsCache,
  onOverwriteRanking,
  onStartRankingTrack,
}) {
  const [mobileDashboardTab, setMobileDashboardTab] = useState("songs");
  const [isMobileDashboardLayout, setIsMobileDashboardLayout] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth <= 768 : false,
  );
  const [artistCardsRootEl, setArtistCardsRootEl] = useState(null);
  const [expandedAlbumKey, setExpandedAlbumKey] = useState(null);
  const [albumProgressInfoOpen, setAlbumProgressInfoOpen] = useState(false);
  const [albumTracksById, setAlbumTracksById] = useState(() => ({}));
  const [albumLoadStateById, setAlbumLoadStateById] = useState(() => ({}));
  const [artistImagesById, setArtistImagesById] = useState(() => ({}));
  const [resolvedArtistByName, setResolvedArtistByName] = useState(() => {
    const cached = readArtistIdByNameCache(userId);
    const items =
      cached?.items && typeof cached.items === "object" ? cached.items : {};
    const next = {};
    for (const [nameKey, artistId] of Object.entries(items)) {
      if (typeof artistId !== "string" || !artistId) continue;
      next[nameKey] = { status: "loaded", artistId };
    }
    return next;
  });
  const artistImageInFlight = useRef(new Map());
  const trackResolveInFlight = useRef(new Map());
  const initialArtistPrefetchDone = useRef(false);
  const artistImagesByIdRef = useRef({});
  const resolvedArtistByNameRef = useRef({});
  const artistRetryTimers = useRef(new Map());
  const ensureArtistImageForArtistRef = useRef(null);

  const normalizeArtistNameKey = useCallback(name => {
    if (typeof name !== "string") return "";
    return name.trim().toLowerCase().replaceAll(/\s+/g, " ");
  }, []);

  useEffect(() => {
    artistImagesByIdRef.current = artistImagesById || {};
  }, [artistImagesById]);

  useEffect(() => {
    resolvedArtistByNameRef.current = resolvedArtistByName || {};
  }, [resolvedArtistByName]);

  useEffect(() => {
    const cached = readArtistIdByNameCache(userId);
    const items =
      cached?.items && typeof cached.items === "object" ? cached.items : {};
    const next = {};
    for (const [nameKey, artistId] of Object.entries(items)) {
      if (typeof artistId !== "string" || !artistId) continue;
      next[nameKey] = { status: "loaded", artistId };
    }
    setResolvedArtistByName(next);
  }, [userId]);

  useEffect(() => {
    const timers = artistRetryTimers.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  useEffect(() => {
    setExpandedAlbumKey(null);
    setAlbumProgressInfoOpen(false);
    setAlbumTracksById({});
    setAlbumLoadStateById({});
  }, [userId]);

  const scheduleArtistRetry = useCallback((key, delayMs, artist) => {
    if (!key) return;
    const safeDelayMs = Math.max(250, Math.min(120_000, Number(delayMs) || 0));
    if (!Number.isFinite(safeDelayMs) || safeDelayMs <= 0) return;
    if (artistRetryTimers.current.has(key)) return;

    const jitter = Math.floor(Math.random() * 350);
    const timeoutId = window.setTimeout(() => {
      artistRetryTimers.current.delete(key);
      ensureArtistImageForArtistRef.current?.(artist);
    }, safeDelayMs + jitter);

    artistRetryTimers.current.set(key, timeoutId);
  }, []);

  const ensureArtistImage = useCallback(async artistId => {
    if (!artistId) return { ok: false, retryAfterMs: null };

    const nowMs = Date.now();
    const existing = artistImagesByIdRef.current?.[artistId] || null;
    if (existing?.status === "loaded") return { ok: true, retryAfterMs: null };
    if (existing?.status === "loading") {
      const inflight = artistImageInFlight.current.get(artistId);
      if (inflight) return inflight;
      return { ok: true, retryAfterMs: null };
    }
    if (
      existing?.status === "error" &&
      Number.isFinite(existing?.nextRetryAtMs) &&
      nowMs < existing.nextRetryAtMs
    ) {
      return { ok: false, retryAfterMs: existing.nextRetryAtMs - nowMs };
    }

    setArtistImagesById(prev => {
      const existing = prev?.[artistId];
      if (
        existing &&
        (existing.status === "loading" || existing.status === "loaded")
      )
        return prev;
      return {
        ...prev,
        [artistId]: {
          status: "loading",
          imageUrl:
            typeof existing?.imageUrl === "string" ? existing.imageUrl : null,
        },
      };
    });

    if (artistImageInFlight.current.has(artistId))
      return artistImageInFlight.current.get(artistId);

    const p = (async () => {
      try {
        const res = await fetch(
          `/artist-image/${encodeURIComponent(artistId)}`,
        );
        let data = null;
        try {
          data = await res.json();
        } catch {
          data = null;
        }

        if (!res.ok) {
          const retryAfterSeconds = Number(data?.retryAfterSeconds);
          const retryAfterMs = Number.isFinite(retryAfterSeconds)
            ? retryAfterSeconds * 1000
            : 60_000;
          setArtistImagesById(prev => ({
            ...prev,
            [artistId]: {
              status: "error",
              imageUrl: null,
              nextRetryAtMs: Date.now() + retryAfterMs,
            },
          }));
          return { ok: false, retryAfterMs };
        }

        const imageUrl =
          typeof data?.imageUrl === "string" ? data.imageUrl : null;
        setArtistImagesById(prev => ({
          ...prev,
          [artistId]: { status: "loaded", imageUrl },
        }));
        return { ok: true, retryAfterMs: null };
      } catch {
        const retryAfterMs = 60_000;
        setArtistImagesById(prev => ({
          ...prev,
          [artistId]: {
            status: "error",
            imageUrl: null,
            nextRetryAtMs: Date.now() + retryAfterMs,
          },
        }));
        return { ok: false, retryAfterMs };
      } finally {
        artistImageInFlight.current.delete(artistId);
      }
    })();

    artistImageInFlight.current.set(artistId, p);
    return p;
  }, []);

  const ensureTrackArtists = useCallback(async trackId => {
    if (!trackId)
      return { ok: false, status: 0, retryAfterSeconds: null, artists: [] };

    const existing = trackResolveInFlight.current.get(trackId);
    if (existing) return existing;

    const p = (async () => {
      try {
        const res = await fetch(`/api/tracks/${encodeURIComponent(trackId)}`);
        let data = null;
        try {
          data = await res.json();
        } catch {
          data = null;
        }

        if (!res.ok) {
          const retryAfterSeconds = Number(data?.retryAfterSeconds);
          return {
            ok: false,
            status: res.status,
            retryAfterSeconds: Number.isFinite(retryAfterSeconds)
              ? retryAfterSeconds
              : null,
            artists: [],
          };
        }

        const artists = Array.isArray(data?.artists) ? data.artists : [];
        return {
          ok: true,
          status: res.status,
          retryAfterSeconds: null,
          artists,
        };
      } catch {
        return { ok: false, status: 0, retryAfterSeconds: null, artists: [] };
      } finally {
        trackResolveInFlight.current.delete(trackId);
      }
    })();

    trackResolveInFlight.current.set(trackId, p);
    return p;
  }, []);

  const ensureArtistIdForName = useCallback(
    async ({ artistName, tracks }) => {
      if (!artistName || artistName === "Unknown artist")
        return { artistId: null, retryAfterMs: null };
      const artistKey = normalizeArtistNameKey(artistName);
      if (!artistKey) return { artistId: null, retryAfterMs: 60_000 };

      const existing = resolvedArtistByNameRef.current?.[artistKey];
      if (existing?.status === "loaded")
        return { artistId: existing.artistId || null, retryAfterMs: null };
      if (existing?.status === "loading")
        return { artistId: null, retryAfterMs: null };
      if (
        existing?.status === "error" &&
        Number.isFinite(existing?.nextRetryAtMs) &&
        Date.now() < existing.nextRetryAtMs
      )
        return {
          artistId: null,
          retryAfterMs: Math.max(250, existing.nextRetryAtMs - Date.now()),
        };

      const candidateTrackKey =
        tracks
          ?.map(t => t?.trackKey)
          .find(k => typeof k === "string" && k.startsWith("spid:")) || null;
      const trackId = candidateTrackKey
        ? candidateTrackKey.slice("spid:".length)
        : null;
      if (!trackId) {
        const retryAfterMs = 60_000;
        setResolvedArtistByName(prev => ({
          ...prev,
          [artistKey]: {
            status: "error",
            artistId: null,
            nextRetryAtMs: Date.now() + retryAfterMs,
          },
        }));
        return { artistId: null, retryAfterMs };
      }

      setResolvedArtistByName(prev => ({
        ...prev,
        [artistKey]: { status: "loading", artistId: null },
      }));

      const result = await ensureTrackArtists(trackId);
      if (!result?.ok) {
        const retryAfterMs = Number.isFinite(result?.retryAfterSeconds)
          ? result.retryAfterSeconds * 1000
          : 30_000;
        setResolvedArtistByName(prev => ({
          ...prev,
          [artistKey]: {
            status: "error",
            artistId: null,
            nextRetryAtMs: Date.now() + retryAfterMs,
          },
        }));
        return { artistId: null, retryAfterMs };
      }

      const artists = Array.isArray(result?.artists) ? result.artists : [];
      const wanted = normalizeArtistNameKey(artistName);
      const match =
        artists.find(
          a =>
            typeof a?.name === "string" &&
            normalizeArtistNameKey(a.name) === wanted,
        ) || null;
      const artistId = typeof match?.id === "string" ? match.id : null;

      const toCache = {};
      for (const a of artists) {
        const name = typeof a?.name === "string" ? a.name : null;
        if (!name) continue;
        const key = normalizeArtistNameKey(name);
        if (!key) continue;
        const id = typeof a?.id === "string" ? a.id : null;
        if (id) toCache[key] = id;
      }
      if (artistId) toCache[artistKey] = artistId;

      setResolvedArtistByName(prev => {
        const next = { ...prev };
        for (const [key, id] of Object.entries(toCache)) {
          const existing = next[key];
          if (!existing || existing.status !== "loaded")
            next[key] = { status: "loaded", artistId: id };
        }
        next[artistKey] = { status: "loaded", artistId };
        return next;
      });

      mergeArtistIdByNameCache(userId, toCache);
      return { artistId, retryAfterMs: null };
    },
    [ensureTrackArtists, normalizeArtistNameKey, userId],
  );

  const ensureArtistImageForArtist = useCallback(
    async artist => {
      const artistName = typeof artist?.name === "string" ? artist.name : null;
      const tracks = Array.isArray(artist?.topTracks)
        ? artist.topTracks
        : Array.isArray(artist?.topSongs)
          ? artist.topSongs
          : [];
      const directId =
        typeof artist?.artistId === "string" ? artist.artistId : null;
      const artistKey = artistName ? normalizeArtistNameKey(artistName) : "";
      const resolvedId = artistKey
        ? resolvedArtistByNameRef.current?.[artistKey]?.artistId
        : null;
      const artistId = directId || resolvedId || null;

      if (artistId) {
        const result = await ensureArtistImage(artistId);
        if (!result?.ok && Number.isFinite(result?.retryAfterMs))
          scheduleArtistRetry(artistId, result.retryAfterMs, artist);
        return;
      }

      const resolved = await ensureArtistIdForName({ artistName, tracks });
      const nextId = resolved?.artistId || null;
      const retryAfterMs = resolved?.retryAfterMs ?? null;

      if (nextId) {
        const img = await ensureArtistImage(nextId);
        if (!img?.ok && Number.isFinite(img?.retryAfterMs))
          scheduleArtistRetry(nextId, img.retryAfterMs, artist);
        return;
      }

      if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
        scheduleArtistRetry(
          artistKey || artistName || "artist",
          retryAfterMs,
          artist,
        );
      }
    },
    [
      ensureArtistIdForName,
      ensureArtistImage,
      normalizeArtistNameKey,
      scheduleArtistRetry,
    ],
  );

  useEffect(() => {
    ensureArtistImageForArtistRef.current = ensureArtistImageForArtist;
  }, [ensureArtistImageForArtist]);

  const trackIndex = useMemo(() => {
    const map = new Map();
    if (!userId) return map;

    const globalSongItems = readGlobalSongs(userId)?.items;
    const globalTracks = globalSongItems && typeof globalSongItems === "object"
      ? Object.values(globalSongItems).filter(Boolean)
      : [];

    const playlistIds = Array.isArray(playlistsCache?.items)
      ? playlistsCache.items.map(p => p?.id).filter(Boolean)
      : [];

    for (const track of globalTracks) {
      mergeTrackIntoIndex(map, track);
    }

    for (const playlistId of playlistIds) {
      const cachedTracks = readPlaylistTracksCache(userId, playlistId);
      const items = Array.isArray(cachedTracks?.items)
        ? cachedTracks.items
        : [];
      for (const t of items) {
        mergeTrackIntoIndex(map, t);
      }
    }

    const albumIds = new Set(
      globalTracks.flatMap(track =>
        getTrackAlbumMemberships(track)
          .map(membership => membership.albumId)
          .filter(Boolean),
      ),
    );

    for (const albumId of Object.keys(albumTracksById || {})) {
      if (albumId) albumIds.add(albumId);
    }

    for (const albumId of albumIds) {
      const cachedAlbum =
        albumTracksById?.[albumId] || readAlbumTracksCache(userId, albumId);
      const items = Array.isArray(cachedAlbum?.items) ? cachedAlbum.items : [];
      for (const track of items) {
        mergeTrackIntoIndex(map, track);
      }
    }

    return map;
  }, [albumTracksById, localDataRevision, userId, playlistsCache]);

  const globalTracks = useMemo(() => {
    if (!userId) return [];
    const items = readGlobalSongs(userId)?.items;
    if (!items || typeof items !== "object") return [];
    return Object.values(items)
      .filter(Boolean)
      .map(track => {
        const trackKey = trackKeyOfTrack(track);
        const meta = trackIndex.get(trackKey) || null;
        const id =
          meta?.id || (typeof track?.id === "string" ? track.id : null);
        return {
          trackKey,
          id,
          name: meta?.name || normalizeTrackName(track?.name, id),
          artists:
            meta?.artists ||
            (Array.isArray(track?.artists) ? track.artists.filter(Boolean) : []),
          albumMemberships: getTrackAlbumMemberships(track),
          albumId:
            meta?.albumId ||
            (typeof track?.albumId === "string" ? track.albumId : null),
          album:
            meta?.album ||
            (typeof track?.album === "string" ? track.album : null),
          albumTrackCount: Number.isFinite(meta?.albumTrackCount)
            ? meta.albumTrackCount
            : Number.isFinite(track?.albumTrackCount)
              ? track.albumTrackCount
              : null,
        };
      });
  }, [localDataRevision, trackIndex, userId]);

  useEffect(() => {
    if (!ranking || globalTracks.length === 0) return;
    onOverwriteRanking?.(rk => reconcileRankingTrackKeys(rk, globalTracks));
  }, [globalTracks, onOverwriteRanking, ranking]);

  const canonicalGlobalTracks = useMemo(() => {
    const groups = new Map();
    for (const track of globalTracks) {
      const identity = songIdentityOfTrack(track);
      const group = groups.get(identity) || [];
      group.push(track);
      groups.set(identity, group);
    }

    return Array.from(groups.values()).map(group => {
      const canonicalKey = group
        .map(track => track.trackKey)
        .sort((left, right) => compareTrackKeysForCanonical(left, right, ranking))[0];
      const representative =
        group.find(track => track.trackKey === canonicalKey) || group[0];
      return {
        ...representative,
        trackKey: canonicalKey,
        albumMemberships: mergeAlbumMembershipLists(group),
      };
    });
  }, [globalTracks, ranking]);

  const canonicalTrackKeyByIdentity = useMemo(() => {
    const map = new Map();
    for (const track of canonicalGlobalTracks) {
      map.set(songIdentityOfTrack(track), track.trackKey);
    }
    return map;
  }, [canonicalGlobalTracks]);

  const ensureAlbumTracks = useCallback(
    async album => {
      let albumId = typeof album?.albumId === "string" ? album.albumId : null;
      const albumName =
        typeof album?.name === "string" ? album.name : "Unknown album";
      if (!userId) return null;

      if (!albumId) {
        const seedTrackId =
          (typeof album?.ratedTracks?.[0]?.id === "string"
            ? album.ratedTracks[0].id
            : null) ||
          (typeof album?.unratedTracks?.[0]?.id === "string"
            ? album.unratedTracks[0].id
            : null);

        if (seedTrackId) {
          try {
            const res = await fetch(
              `/api/tracks/${encodeURIComponent(seedTrackId)}`,
            );
            const data = await res.json().catch(() => null);
            const resolvedAlbumId =
              typeof data?.album?.id === "string" ? data.album.id : null;
            const resolvedAlbumTrackCount = Number.isFinite(
              data?.album?.totalTracks,
            )
              ? data.album.totalTracks
              : null;

            if (resolvedAlbumId) {
              albumId = resolvedAlbumId;
              const observedTrackKeys = new Set(
                [
                  ...(Array.isArray(album?.ratedTracks) ? album.ratedTracks : []),
                  ...(Array.isArray(album?.unratedTracks)
                    ? album.unratedTracks
                    : []),
                  ...(Array.isArray(album?.doNotRateTracks)
                    ? album.doNotRateTracks
                    : []),
                ]
                  .map(track =>
                    typeof track?.trackKey === "string" ? track.trackKey : null,
                  )
                  .filter(Boolean),
              );
              const existingSongs = readGlobalSongs(userId)?.items;
              const observedTracks =
                existingSongs && typeof existingSongs === "object"
                  ? Object.values(existingSongs).filter(
                      track => observedTrackKeys.has(trackKeyOfTrack(track)),
                    )
                  : [];
              if (observedTracks.length) {
                upsertGlobalSongs(
                  userId,
                  observedTracks.map(track => ({
                    id: typeof track?.id === "string" ? track.id : null,
                    name: typeof track?.name === "string" ? track.name : null,
                    artists: Array.isArray(track?.artists)
                      ? track.artists.filter(Boolean)
                      : [],
                    albumId: resolvedAlbumId,
                    album: albumName,
                    albumTrackCount: resolvedAlbumTrackCount,
                    durationMs: Number.isFinite(track?.durationMs)
                      ? track.durationMs
                      : null,
                    explicit:
                      typeof track?.explicit === "boolean"
                        ? track.explicit
                        : null,
                    externalUrl:
                      typeof track?.externalUrl === "string"
                        ? track.externalUrl
                        : null,
                  })),
                );
              }
            }
          } catch {
            // ignore seed lookup failures; album expansion can still show observed tracks.
          }
        }
      }

      if (!albumId) return null;

      const existing = albumTracksById?.[albumId];
      if (existing?.items?.length) return existing;
      if (albumLoadStateById?.[albumId]?.status === "loading") return null;

      const cached = readAlbumTracksCache(userId, albumId);
      if (cached?.items?.length) {
        setAlbumTracksById(prev => ({ ...prev, [albumId]: cached }));
        return cached;
      }

      setAlbumLoadStateById(prev => ({
        ...prev,
        [albumId]: { status: "loading", error: null },
      }));

      try {
        const res = await fetch(
          `/api/albums/${encodeURIComponent(albumId)}/tracks`,
        );
        let data = null;
        try {
          data = await res.json();
        } catch {
          data = null;
        }

        if (!res.ok) {
          const message =
            typeof data?.details?.error?.message === "string"
              ? data.details.error.message
              : typeof data?.message === "string"
                ? data.message
                : typeof data?.error === "string"
                  ? data.error
                  : "Failed to fetch album tracks";
          setAlbumLoadStateById(prev => ({
            ...prev,
            [albumId]: { status: "error", error: message },
          }));
          return null;
        }

        const fetchedAt = new Date().toISOString();
        const record = writeAlbumTracksCache(userId, albumId, albumName, data, {
          fetchedAt,
        });
        const nextRecord = record || readAlbumTracksCache(userId, albumId);
        if (nextRecord?.items?.length) {
          setAlbumTracksById(prev => ({ ...prev, [albumId]: nextRecord }));
        }
        setAlbumLoadStateById(prev => ({
          ...prev,
          [albumId]: { status: "loaded", error: null },
        }));
        return nextRecord;
      } catch (error) {
        setAlbumLoadStateById(prev => ({
          ...prev,
          [albumId]: {
            status: "error",
            error: error?.message || "Failed to fetch album tracks",
          },
        }));
        return null;
      }
    },
    [albumLoadStateById, albumTracksById, userId],
  );

  const buildTrackUpsertPayload = useCallback((track, albumOverride = null) => {
    if (!track || typeof track !== "object") return null;
    const id = typeof track?.id === "string" ? track.id : null;
    if (!id) return null;

    const resolvedAlbumId =
      typeof albumOverride?.albumId === "string" && albumOverride.albumId
        ? albumOverride.albumId
        : typeof track?.albumId === "string" && track.albumId
          ? track.albumId
          : null;
    const resolvedAlbumName =
      typeof albumOverride?.album === "string" && albumOverride.album
        ? albumOverride.album
        : typeof track?.album === "string" && track.album
          ? track.album
          : null;
    const resolvedAlbumTrackCount = Number.isFinite(albumOverride?.albumTrackCount)
      ? albumOverride.albumTrackCount
      : Number.isFinite(track?.albumTrackCount)
        ? track.albumTrackCount
        : null;

    return {
      id,
      name: typeof track?.name === "string" ? track.name : null,
      artists: Array.isArray(track?.artists) ? track.artists.filter(Boolean) : [],
      artistIds: Array.isArray(track?.artistIds)
        ? track.artistIds.map(value => (typeof value === "string" ? value : null))
        : [],
      albumId: resolvedAlbumId,
      album: resolvedAlbumName,
      albumTrackCount: resolvedAlbumTrackCount,
      durationMs: Number.isFinite(track?.durationMs) ? track.durationMs : null,
      explicit: typeof track?.explicit === "boolean" ? track.explicit : null,
      externalUrl:
        typeof track?.externalUrl === "string" ? track.externalUrl : null,
    };
  }, []);

  const addTracksToRankingFromAlbum = useCallback(
    async (album, trackFilter = null) => {
      if (!userId) return [];

      const record = await ensureAlbumTracks(album);
      const items = Array.isArray(record?.items) ? record.items : [];
      if (!items.length) return [];

      const albumOverride = {
        albumId:
          typeof album?.albumId === "string" && album.albumId
            ? album.albumId
            : typeof record?.albumId === "string" && record.albumId
              ? record.albumId
              : null,
        album:
          typeof album?.name === "string" && album.name
            ? album.name
            : typeof record?.albumName === "string" && record.albumName
              ? record.albumName
              : null,
        albumTrackCount: Number.isFinite(record?.total) ? record.total : null,
      };

      const selectedItems = trackFilter ? items.filter(trackFilter) : items;
      return selectedItems
        .map(track => buildTrackUpsertPayload(track, albumOverride))
        .filter(Boolean);
    },
    [buildTrackUpsertPayload, ensureAlbumTracks, userId],
  );

  const addSingleTrackToRanking = useCallback(
    async (album, track, options = {}) => {
      if (!track) return;

      const selectedIdentity = albumTrackIdentity(track);
      const selectedId =
        typeof track?.id === "string" && track.id ? track.id : null;
      const selectedKey =
        typeof track?.trackKey === "string" && track.trackKey
          ? track.trackKey
          : null;

      let tracksToAdd = await addTracksToRankingFromAlbum(album, candidate => {
        const candidateId =
          typeof candidate?.id === "string" && candidate.id ? candidate.id : null;
        const candidateKey = trackKeyOfTrack(candidate);
        const candidateIdentity = albumTrackIdentity({
          ...candidate,
          trackKey: candidateKey,
        });
        return (
          (selectedId && candidateId === selectedId) ||
          (selectedKey && candidateKey === selectedKey) ||
          (selectedIdentity && candidateIdentity === selectedIdentity)
        );
      });

      if (!tracksToAdd.length) {
        const fallback = buildTrackUpsertPayload(track, {
          albumId: typeof album?.albumId === "string" ? album.albumId : null,
          album: typeof album?.name === "string" ? album.name : null,
          albumTrackCount: Number.isFinite(album?.totalTracks)
            ? album.totalTracks
            : null,
        });
        tracksToAdd = fallback ? [fallback] : [];
      }

      if (!tracksToAdd.length) return;
      const requestedTrackKey = trackKeyOfTrack(tracksToAdd[0]);
      onStartRankingTrack?.(requestedTrackKey, {
        tracksToAdd,
        restoreExcluded: Boolean(options?.restoreExcluded),
      });
    },
    [addTracksToRankingFromAlbum, buildTrackUpsertPayload, onStartRankingTrack],
  );

  const addWholeAlbumToRanking = useCallback(
    async album => {
      const tracksToAdd = await addTracksToRankingFromAlbum(album);
      if (!tracksToAdd.length) return;
      onStartRankingTrack?.(null, { tracksToAdd });
    },
    [addTracksToRankingFromAlbum, onStartRankingTrack],
  );

  const computed = useMemo(() => {
    if (!ranking) return null;

    const orderedKeys = buildOrderedKeys(ranking);
    const rankByKey = new Map();
    orderedKeys.forEach((key, idx) => rankByKey.set(key, idx + 1));

    const rows = canonicalGlobalTracks
      .map(track => {
        const meta = trackIndex.get(track.trackKey) || null;
        return {
          trackKey: track.trackKey,
          id:
            meta?.id ||
            track.id ||
            (track.trackKey.startsWith("spid:")
              ? track.trackKey.slice("spid:".length)
              : null),
          name: track.name || meta?.name || null,
          artists: track.artists || meta?.artists || [],
          artistsDetailed: meta?.artistsDetailed || [],
          album: track.album || meta?.album || null,
          rank: rankByKey.get(track.trackKey) ?? null,
        };
      })
      .filter(r => Number.isFinite(r.rank))
      .sort((left, right) => left.rank - right.rank);

    const hasAnyRatings = rows.length > 0;

    const albumAgg = new Map();

    for (const track of canonicalGlobalTracks) {
      const state = getTrackState(ranking, track.trackKey);
      const rank = rankByKey.get(track.trackKey) ?? null;
      const item = {
        trackKey: track.trackKey,
        id: track.id,
        name: track.name,
        artists: track.artists,
        rank,
      };
      const memberships = getTrackAlbumMemberships(track);

      for (const membership of memberships) {
        const albumKey = membership.albumId
          ? `album:${membership.albumId}`
          : `name:${membership.album}`;
        const prev = albumAgg.get(albumKey) || {
          key: albumKey,
          name: membership.album,
          albumId: membership.albumId,
          totalTracksHint: 0,
          sumRankObserved: 0,
          observedRatedTracks: [],
          observedUnratedTracks: [],
          observedDoNotRateTracks: [],
        };

        if (state.bucket === "X") {
          prev.observedDoNotRateTracks.push(item);
        } else if (Number.isFinite(rank) && isRankedState(state)) {
          prev.sumRankObserved += Number(rank);
          prev.observedRatedTracks.push(item);
        } else {
          prev.observedUnratedTracks.push(item);
        }
        prev.totalTracksHint = Math.max(
          prev.totalTracksHint,
          Number.isFinite(membership?.albumTrackCount)
            ? membership.albumTrackCount
            : 0,
          prev.observedRatedTracks.length +
            prev.observedUnratedTracks.length +
            prev.observedDoNotRateTracks.length,
        );
        albumAgg.set(albumKey, prev);
      }
    }

    const topSongs = rows;
    const topArtists = computeTopArtistsFromTracks(rows, {
      maxSongsPerArtist: 5,
      maxArtists: Number.POSITIVE_INFINITY,
    });

    const rawTopAlbums = Array.from(albumAgg.values())
      .map(album => {
        const cachedAlbumTracks = album.albumId
          ? albumTracksById?.[album.albumId] ||
            readAlbumTracksCache(userId, album.albumId)
          : null;

        let ratedTracks = album.observedRatedTracks.slice();
        let unratedTracks = album.observedUnratedTracks.slice();
        let doNotRateTracks = album.observedDoNotRateTracks.slice();
        let ratedCount = ratedTracks.length;
        let doNotRateCount = doNotRateTracks.length;
        let sumRank = album.sumRankObserved;
        let totalTracks = Math.max(
          album.totalTracksHint,
          ratedTracks.length + unratedTracks.length + doNotRateTracks.length,
        );

        if (cachedAlbumTracks?.items?.length) {
          ratedTracks = [];
          unratedTracks = [];
          doNotRateTracks = [];
          sumRank = 0;

          for (const track of cachedAlbumTracks.items) {
            const trackKey =
              canonicalTrackKeyByIdentity.get(songIdentityOfTrack(track)) ||
              trackKeyOfTrack(track);
            const rank = rankByKey.get(trackKey) ?? null;
            const item = {
              trackKey,
              id: typeof track?.id === "string" ? track.id : null,
              name: typeof track?.name === "string" ? track.name : null,
              artists: Array.isArray(track?.artists)
                ? track.artists.filter(Boolean)
                : [],
              rank,
            };
            const state = getTrackState(ranking, trackKey);

            if (state.bucket === "X") {
              doNotRateTracks.push(item);
            } else if (Number.isFinite(rank) && isRankedState(state)) {
              ratedTracks.push(item);
              sumRank += Number(rank);
            } else {
              unratedTracks.push(item);
            }
          }

          ratedCount = ratedTracks.length;
          doNotRateCount = doNotRateTracks.length;
          totalTracks = Math.max(
            Number(cachedAlbumTracks.total) || 0,
            ratedTracks.length + unratedTracks.length + doNotRateTracks.length,
          );
        }

        return finalizeAlbumRow({
          key: album.key,
          name: album.name,
          albumId: album.albumId,
          totalTracks,
          ratedTracks,
          unratedTracks,
          doNotRateTracks,
          albumTracksLoaded: Boolean(cachedAlbumTracks?.items?.length),
        });
      })
      .filter(a => a.totalTracks >= 2 && a.ratedCount > 0);

    const mergedTopAlbums = new Map();
    for (const album of rawTopAlbums) {
      const matchedEntry =
        Array.from(mergedTopAlbums.entries()).find(([, existing]) =>
          albumRowsCanMerge(existing, album),
        ) || null;
      const canonicalKey = matchedEntry?.[0] || album.key;
      const existing = matchedEntry?.[1] || null;
      mergedTopAlbums.set(
        canonicalKey,
        existing ? mergeAlbumRows(existing, album) : { ...album, key: canonicalKey },
      );
    }

    const topAlbums = Array.from(mergedTopAlbums.values())
      .sort(
        (a, b) =>
          getAlbumRatedShare(b) - getAlbumRatedShare(a) ||
          getAlbumAvgRankSortValue(a) - getAlbumAvgRankSortValue(b) ||
          a.name.localeCompare(b.name, "en", { numeric: true }),
      );

    return { hasAnyRatings, topSongs, topArtists, topAlbums };
  }, [albumTracksById, canonicalGlobalTracks, canonicalTrackKeyByIdentity, ranking, trackIndex, userId]);

  const topSongRanks = useMemo(
    () =>
      Array.isArray(computed?.topSongs)
        ? getTiedRanks(computed.topSongs, t => t.rank)
        : [],
    [computed?.topSongs],
  );

  useEffect(() => {
    if (!expandedAlbumKey) return;
    const exists = computed?.topAlbums?.some(a => a.key === expandedAlbumKey);
    if (!exists) setExpandedAlbumKey(null);
  }, [computed?.topAlbums, expandedAlbumKey]);

  useEffect(() => {
    if (initialArtistPrefetchDone.current) return;
    const list = computed?.topArtists;
    if (!Array.isArray(list) || list.length === 0) return;
    initialArtistPrefetchDone.current = true;
    const count = 6;
    for (const a of list.slice(0, count)) ensureArtistImageForArtist(a);
  }, [computed, ensureArtistImageForArtist]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;

    const media = window.matchMedia("(max-width: 768px)");
    const sync = event => {
      setIsMobileDashboardLayout(Boolean(event?.matches));
    };

    setIsMobileDashboardLayout(media.matches);
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", sync);
      return () => media.removeEventListener("change", sync);
    }

    media.addListener(sync);
    return () => media.removeListener(sync);
  }, []);

  if (!userId) return <p className="meta">Loading…</p>;
  if (!ranking) return <p className="meta">Loading ranking…</p>;
  if (!computed?.hasAnyRatings) {
    return (
      <div className="section dashboardPage pageEmptyStateWrap">
        <div className="pageEmptyStateCard">
          <h3>Dashboard is empty</h3>
          <p className="meta">
            Open <strong>Playlists</strong> to add music, then use{" "}
            <strong>Rank Songs</strong> to build your first ranking.
          </p>
        </div>
      </div>
    );
  }

  const renderSongsPanel = (panelClassName = "dashPanel") => (
    <div className={panelClassName}>
      <div className="dashPanelHeader">
        <h3>Top songs ({computed.topSongs.length})</h3>
      </div>
      <div
        className="dashPanelBody dashPanelBodyTight"
        role="region"
        aria-label="Top songs list"
        tabIndex={0}
      >
        <div
          className="dashboardSongsMobileList"
          role="list"
          aria-label="Top songs cards"
        >
          {computed.topSongs.map((t, idx) => {
            const trackId =
              (typeof t?.id === "string" ? t.id : null) ||
              (typeof t?.trackKey === "string" &&
              t.trackKey.startsWith("spid:")
                ? t.trackKey.slice("spid:".length)
                : null);
            return (
              <article
                key={t.trackKey}
                className="dashboardSongMobileCard"
                role="listitem"
              >
                <div className="dashboardSongMobileTop">
                  <span className="dashboardSongMobileRank">
                    #{topSongRanks[idx] ?? idx + 1}
                  </span>
                  {trackId ? (
                    <button
                      className="btn small"
                      onClick={() => openTrackInSpotify(trackId)}
                      title="Open in Spotify"
                    >
                      Play
                    </button>
                  ) : null}
                </div>
                <div className="dashboardSongMobileTitle">
                  {t.name || t.id || t.trackKey}
                </div>
                <div className="dashboardSongMobileMeta">
                  {t.artists?.length
                    ? t.artists.join(", ")
                    : "Unknown artist"}
                </div>
              </article>
            );
          })}
        </div>

        <table className="dashTable dashboardTopSongsDesktopTable">
          <colgroup>
            <col className="dashColIndex" />
            <col />
            <col className="dashColPlay" />
          </colgroup>
          <thead>
            <tr>
              <th className="right dashColIndex">#</th>
              <th>Song</th>
              <th
                className="right dashColPlay"
                aria-label="Play column"
              />
            </tr>
          </thead>
          <tbody>
            {computed.topSongs.map((t, idx) => {
              const trackId =
                (typeof t?.id === "string" ? t.id : null) ||
                (typeof t?.trackKey === "string" &&
                t.trackKey.startsWith("spid:")
                  ? t.trackKey.slice("spid:".length)
                  : null);
              return (
                <tr
                  key={t.trackKey}
                  className="dashTableRow"
                >
                  <td className="right">
                    <span className="cellSub">
                      {topSongRanks[idx] ?? idx + 1}
                    </span>
                  </td>
                  <td>
                    <div className="cellTitle">
                      {t.name || t.id || t.trackKey}
                    </div>
                    <div className="cellSub">
                      {t.artists?.length
                        ? t.artists.join(", ")
                        : "Unknown artist"}
                    </div>
                  </td>
                  <td className="right">
                    {trackId ? (
                      <button
                        className="btn small rowPlayBtn"
                        onClick={() => openTrackInSpotify(trackId)}
                        title="Open in Spotify"
                      >
                        Play
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );

  const renderArtistsPanel = (panelClassName = "dashPanel dashPanelArtists") => (
    <div className={panelClassName}>
      <div className="dashPanelHeader">
        <h3>Top artists ({computed.topArtists.length})</h3>
      </div>
      <div
        ref={setArtistCardsRootEl}
        className="dashPanelBody"
        role="region"
        aria-label="Top artists list"
        tabIndex={0}
      >
        <div
          className="artistGrid"
          role="list"
          aria-label="Top artists cards"
        >
          {computed.topArtists.map(a => {
            const artistName =
              typeof a?.name === "string" ? a.name : "Unknown artist";
            const artistKey = normalizeArtistNameKey(artistName);
            const effectiveArtistId =
              (typeof a?.artistId === "string" ? a.artistId : null) ||
              (typeof resolvedArtistByName?.[artistKey]?.artistId === "string"
                ? resolvedArtistByName[artistKey].artistId
                : null) ||
              null;
            const imageState = effectiveArtistId
              ? artistImagesById?.[effectiveArtistId]
              : null;
            return (
              <TopArtistCard
                key={a.name}
                artist={a}
                artistId={effectiveArtistId}
                rootEl={artistCardsRootEl}
                imageState={imageState}
                onVisible={ensureArtistImageForArtist}
              />
            );
          })}
        </div>
      </div>
    </div>
  );

  const renderAlbumsPanel = (panelClassName = "dashPanel") => (
    <div className={panelClassName}>
      <div className="dashPanelHeader">
        <div className="dashPanelHeaderRow">
          <h3>Album progress ({computed.topAlbums.length})</h3>
          <button
            className="albumProgressInfoButton"
            type="button"
            onClick={() => setAlbumProgressInfoOpen(v => !v)}
            aria-expanded={albumProgressInfoOpen}
            aria-controls="album-progress-info"
            aria-label="Show album progress sorting info"
            title="How album progress is sorted"
          >
            i
          </button>
        </div>
      </div>
      <div
        className="dashPanelBody dashPanelBodyTight"
        role="region"
        aria-label="Album progress list"
        tabIndex={0}
      >
        {albumProgressInfoOpen ? (
          <div
            id="album-progress-info"
            className="albumProgressInfoPanel"
          >
            <p className="meta">
              Album progress is sorted by <strong>percent of the album rated</strong> first.
              Albums with the same completion percent are then sorted by{" "}
              <strong>average rank</strong>, where a lower average rank places higher.
            </p>
          </div>
        ) : null}
        <div
          className="dashboardAlbumsMobileList"
          role="list"
          aria-label="Album progress cards"
        >
          {computed.topAlbums.map((a, idx) => {
            const expanded = expandedAlbumKey === a.key;
            const albumLoadState =
              a.albumId && albumLoadStateById?.[a.albumId]
                ? albumLoadStateById[a.albumId]
                : null;
            return (
              <article
                key={a.key}
                className={`dashboardAlbumMobileCard ${
                  expanded ? "isExpanded" : ""
                }`.trim()}
                role="listitem"
              >
                <div className="dashboardAlbumMobileTop">
                  <span className="dashboardAlbumMobileRank">
                    #{idx + 1}
                  </span>
                  <button
                    className="btn small"
                    onClick={async () => {
                      const nextExpanded =
                        expandedAlbumKey === a.key ? null : a.key;
                      setExpandedAlbumKey(nextExpanded);
                      if (
                        nextExpanded &&
                        a.albumId &&
                        !a.albumTracksLoaded
                      ) {
                        await ensureAlbumTracks(a);
                      }
                    }}
                    title={
                      expanded ? "Hide album songs" : "Show album songs"
                    }
                  >
                    {expanded ? "Hide" : "Show"}
                  </button>
                </div>

                <div className="dashboardAlbumMobileTitle">{a.name}</div>
                <div className="dashboardAlbumMobileMeta">
                  {a.artistLabel}
                </div>

                <div className="dashboardAlbumMobileStats">
                  <div className="dashboardAlbumMobileStat">
                    <span className="dashboardAlbumMobileStatLabel">
                      Avg rank
                    </span>
                    <span className="dashboardAlbumMobileStatValue">
                      {Number.isFinite(a.avgRank)
                        ? Math.round(a.avgRank)
                        : "-"}
                    </span>
                  </div>
                  <div className="dashboardAlbumMobileStat">
                    <span className="dashboardAlbumMobileStatLabel">
                      Rated
                    </span>
                    <span className="dashboardAlbumMobileStatValue">
                      {a.ratedCount} / {a.totalTracks}
                    </span>
                  </div>
                </div>

                {expanded ? (
                  <div className="dashboardAlbumMobileExpanded">
                    <AlbumProgressExpandedContent
                      album={a}
                      albumLoadState={albumLoadState}
                      onOpenAlbum={openAlbumInSpotify}
                      onRankWholeAlbum={addWholeAlbumToRanking}
                      onRateTrack={addSingleTrackToRanking}
                    />
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>

        <table className="dashTable dashboardAlbumsDesktopTable">
          <colgroup>
            <col className="dashColIndex" />
            <col />
            <col className="dashColActions" />
            <col className="dashColPlay" />
          </colgroup>
          <thead>
            <tr>
              <th className="right dashColIndex">#</th>
              <th>Album</th>
              <th>Avg Rank</th>
              <th className="right dashColPlay">Action</th>
            </tr>
          </thead>
          <tbody>
            {computed.topAlbums.map((a, idx) => {
              const expanded = expandedAlbumKey === a.key;
              const albumLoadState =
                a.albumId && albumLoadStateById?.[a.albumId]
                  ? albumLoadStateById[a.albumId]
                  : null;
              return (
                <Fragment key={a.key}>
                  <tr
                    className={`dashTableRow ${expanded ? "albumRowOpen" : ""}`}
                  >
                    <td className="right">
                      <span className="cellSub">
                        {idx + 1}
                      </span>
                    </td>
                    <td>
                      <div className="cellTitle">{a.name}</div>
                      <div className="cellSub">{a.artistLabel}</div>
                    </td>
                    <td>
                      <div className="cellTitle albumProgressValue">
                        {Number.isFinite(a.avgRank)
                          ? ` ${Math.round(a.avgRank)}`
                          : "-"}
                      </div>
                      <div className="cellSub">
                        {a.ratedCount} / {a.totalTracks} rated
                      </div>
                    </td>
                    <td className="right">
                      <button
                        className="btn small"
                        onClick={async () => {
                          const nextExpanded =
                            expandedAlbumKey === a.key ? null : a.key;
                          setExpandedAlbumKey(nextExpanded);
                          if (
                            nextExpanded &&
                            a.albumId &&
                            !a.albumTracksLoaded
                          ) {
                            await ensureAlbumTracks(a);
                          }
                        }}
                        title={
                          expanded ? "Hide album songs" : "Show album songs"
                        }
                      >
                        {expanded ? "Hide" : "Show"}
                      </button>
                    </td>
                  </tr>
                  {expanded ? (
                    <tr className="albumRowExpanded">
                      <td
                        className="albumExpandCell"
                        colSpan={4}
                      >
                        <AlbumProgressExpandedContent
                          album={a}
                          albumLoadState={albumLoadState}
                          onOpenAlbum={openAlbumInSpotify}
                          onRankWholeAlbum={addWholeAlbumToRanking}
                          onRateTrack={addSingleTrackToRanking}
                        />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );

  const renderSongsMobileContent = () => (
    <div
      className="dashboardMobilePanelBody"
      role="region"
      aria-label="Top songs list"
      tabIndex={0}
    >
      <div className="dashboardMobileSectionLabel">
        Top songs ({computed.topSongs.length})
      </div>
      <div
        className="dashboardSongsMobileList"
        role="list"
        aria-label="Top songs cards"
      >
        {computed.topSongs.map((t, idx) => {
          const trackId =
            (typeof t?.id === "string" ? t.id : null) ||
            (typeof t?.trackKey === "string" &&
            t.trackKey.startsWith("spid:")
              ? t.trackKey.slice("spid:".length)
              : null);
          return (
            <article
              key={t.trackKey}
              className="dashboardSongMobileCard"
              role="listitem"
            >
              <div className="dashboardSongMobileTop">
                <span className="dashboardSongMobileRank">
                  #{topSongRanks[idx] ?? idx + 1}
                </span>
                {trackId ? (
                  <button
                    className="btn small"
                    onClick={() => openTrackInSpotify(trackId)}
                    title="Open in Spotify"
                  >
                    Play
                  </button>
                ) : null}
              </div>
              <div className="dashboardSongMobileTitle">
                {t.name || t.id || t.trackKey}
              </div>
              <div className="dashboardSongMobileMeta">
                {t.artists?.length
                  ? t.artists.join(", ")
                  : "Unknown artist"}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );

  const renderArtistsMobileContent = () => (
    <div
      ref={setArtistCardsRootEl}
      className="dashboardMobilePanelBody"
      role="region"
      aria-label="Top artists list"
      tabIndex={0}
    >
      <div className="dashboardMobileSectionLabel">
        Top artists ({computed.topArtists.length})
      </div>
      <div
        className="artistGrid"
        role="list"
        aria-label="Top artists cards"
      >
        {computed.topArtists.map(a => {
          const artistName =
            typeof a?.name === "string" ? a.name : "Unknown artist";
          const artistKey = normalizeArtistNameKey(artistName);
          const effectiveArtistId =
            (typeof a?.artistId === "string" ? a.artistId : null) ||
            (typeof resolvedArtistByName?.[artistKey]?.artistId === "string"
              ? resolvedArtistByName[artistKey].artistId
              : null) ||
            null;
          const imageState = effectiveArtistId
            ? artistImagesById?.[effectiveArtistId]
            : null;
          return (
            <TopArtistCard
              key={a.name}
              artist={a}
              artistId={effectiveArtistId}
              rootEl={artistCardsRootEl}
              imageState={imageState}
              onVisible={ensureArtistImageForArtist}
            />
          );
        })}
      </div>
    </div>
  );

  const renderAlbumsMobileContent = () => (
    <div
      className="dashboardMobilePanelBody"
      role="region"
      aria-label="Album progress list"
      tabIndex={0}
    >
      <div className="dashboardMobileSectionHeader">
        <div className="dashboardMobileSectionLabel">
          Album progress ({computed.topAlbums.length})
        </div>
        <button
          className="albumProgressInfoButton"
          type="button"
          onClick={() => setAlbumProgressInfoOpen(v => !v)}
          aria-expanded={albumProgressInfoOpen}
          aria-controls="album-progress-info-mobile"
          aria-label="Show album progress sorting info"
          title="How album progress is sorted"
        >
          i
        </button>
      </div>
      {albumProgressInfoOpen ? (
        <div
          id="album-progress-info-mobile"
          className="albumProgressInfoPanel"
        >
          <p className="meta">
            Album progress is sorted by <strong>percent of the album rated</strong> first.
            Albums with the same completion percent are then sorted by{" "}
            <strong>average rank</strong>, where a lower average rank places higher.
          </p>
        </div>
      ) : null}
      <div
        className="dashboardAlbumsMobileList"
        role="list"
        aria-label="Album progress cards"
      >
        {computed.topAlbums.map((a, idx) => {
          const expanded = expandedAlbumKey === a.key;
          const albumLoadState =
            a.albumId && albumLoadStateById?.[a.albumId]
              ? albumLoadStateById[a.albumId]
              : null;
          return (
            <article
              key={a.key}
              className={`dashboardAlbumMobileCard ${
                expanded ? "isExpanded" : ""
              }`.trim()}
              role="listitem"
            >
              <div className="dashboardAlbumMobileTop">
                <span className="dashboardAlbumMobileRank">
                  #{idx + 1}
                </span>
                <button
                  className="btn small"
                  onClick={async () => {
                    const nextExpanded =
                      expandedAlbumKey === a.key ? null : a.key;
                    setExpandedAlbumKey(nextExpanded);
                    if (
                      nextExpanded &&
                      a.albumId &&
                      !a.albumTracksLoaded
                    ) {
                      await ensureAlbumTracks(a);
                    }
                  }}
                  title={
                    expanded ? "Hide album songs" : "Show album songs"
                  }
                >
                  {expanded ? "Hide" : "Show"}
                </button>
              </div>

              <div className="dashboardAlbumMobileTitle">{a.name}</div>
              <div className="dashboardAlbumMobileMeta">
                {a.artistLabel}
              </div>

              <div className="dashboardAlbumMobileStats">
                <div className="dashboardAlbumMobileStat">
                  <span className="dashboardAlbumMobileStatLabel">
                    Avg rank
                  </span>
                  <span className="dashboardAlbumMobileStatValue">
                    {Number.isFinite(a.avgRank)
                      ? Math.round(a.avgRank)
                      : "-"}
                  </span>
                </div>
                <div className="dashboardAlbumMobileStat">
                  <span className="dashboardAlbumMobileStatLabel">
                    Rated
                  </span>
                  <span className="dashboardAlbumMobileStatValue">
                    {a.ratedCount} / {a.totalTracks}
                  </span>
                </div>
              </div>

              {expanded ? (
                <div className="dashboardAlbumMobileExpanded">
                  <AlbumProgressExpandedContent
                    album={a}
                    albumLoadState={albumLoadState}
                    onOpenAlbum={openAlbumInSpotify}
                    onRankWholeAlbum={addWholeAlbumToRanking}
                    onRateTrack={addSingleTrackToRanking}
                  />
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </div>
  );

  if (isMobileDashboardLayout) {
    return (
      <div className="section dashboardPage">
        <div
          className="dashboardMobileTabs"
          role="tablist"
          aria-label="Dashboard mobile sections"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mobileDashboardTab === "songs"}
            className={`dashboardMobileTabBtn ${
              mobileDashboardTab === "songs" ? "active" : ""
            }`.trim()}
            onClick={() => setMobileDashboardTab("songs")}
          >
            Songs
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mobileDashboardTab === "artists"}
            className={`dashboardMobileTabBtn ${
              mobileDashboardTab === "artists" ? "active" : ""
            }`.trim()}
            onClick={() => setMobileDashboardTab("artists")}
          >
            Artists
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mobileDashboardTab === "albums"}
            className={`dashboardMobileTabBtn ${
              mobileDashboardTab === "albums" ? "active" : ""
            }`.trim()}
            onClick={() => setMobileDashboardTab("albums")}
          >
            Albums
          </button>
        </div>

        <div className="dashboardColumns dashboardMobileColumns">
          <div className="dashPanel dashboardMobileSinglePanel">
            {mobileDashboardTab === "songs"
              ? renderSongsMobileContent()
              : mobileDashboardTab === "artists"
                ? renderArtistsMobileContent()
                : renderAlbumsMobileContent()}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="section dashboardPage">
      <div
        className="dashboardColumns"
        role="region"
        aria-label="Dashboard columns"
      >
        {renderSongsPanel()}
        {renderArtistsPanel()}
        {renderAlbumsPanel()}
      </div>
    </div>
  );
}

function LandingPage() {
  return (
    <section className="section landingPage">
      <div className="landingContent">
        <h1>Rank your Spotify songs.</h1>
        <p className="landingLead">
          Build a global ranking of your music using fast binary comparisons.
          Import playlists, compare songs, and see your top songs, artists, and
          albums automatically.
        </p>
        <div className="landingActions">
          <a
            className="btn primary"
            href="/auth/login"
          >
            Sign in with Spotify
          </a>
          <a
            className="btn"
            href="/auth/demo"
          >
            Try Demo
          </a>
        </div>
        <p className="landingAccessNote">
          <span className="landingAccessNoteWarning">
            <strong>⚠</strong> Spotify requires apps in development mode to
            manually approve users.
          </span>
          <span className="landingAccessNoteDetail">
            Email <a href="mailto:adeshvirk1@gmail.com">adeshvirk1@gmail.com</a>{" "}
            to use your own playlists, or click “Try Demo” to explore without
            login.
          </span>
        </p>
        <p className="landingCredibility">
          Built with React, Node.js, and the Spotify API.
        </p>
      </div>
    </section>
  );
}

function RankSongsPage({
  userId,
  ranking,
  localDataRevision,
  onChangeRanking,
  trackRequest,
  onTrackRequestHandled,
}) {
  const [activeKey, setActiveKey] = useState(null);
  const [rankInfoOpen, setRankInfoOpen] = useState(false);
  const [unrankedQuery, setUnrankedQuery] = useState("");
  const [rankedQuery, setRankedQuery] = useState("");
  const [excludedOpen, setExcludedOpen] = useState(false);
  const [mobileRankTab, setMobileRankTab] = useState("unranked");
  const [mobileUnrankedTab, setMobileUnrankedTab] = useState("unranked");
  const [rankedArtistImagesById, setRankedArtistImagesById] = useState(() => ({}));
  const [rankedResolvedArtistByName, setRankedResolvedArtistByName] = useState(() => {
    const cached = readArtistIdByNameCache(userId);
    const items =
      cached?.items && typeof cached.items === "object" ? cached.items : {};
    const next = {};
    for (const [nameKey, artistId] of Object.entries(items)) {
      if (typeof artistId !== "string" || !artistId) continue;
      next[nameKey] = { status: "loaded", artistId };
    }
    return next;
  });
  const excludedPanelRef = useRef(null);
  const previousExcludedOpenRef = useRef(false);
  const rankedArtistImageInFlight = useRef(new Map());
  const rankedTrackResolveInFlight = useRef(new Map());
  const rankedArtistImagesByIdRef = useRef({});
  const rankedResolvedArtistByNameRef = useRef({});

  const globalSongs = useMemo(() => {
    if (!userId) return [];
    const record = readGlobalSongs(userId);
    const items =
      record?.items && typeof record.items === "object"
        ? Object.values(record.items)
        : [];
    return items
      .filter(Boolean)
      .sort((a, b) =>
        (a?.name || "").localeCompare(b?.name || "", "en", { numeric: true }),
      );
  }, [localDataRevision, userId]);

  useEffect(() => {
    if (!ranking || globalSongs.length === 0) return;
    onChangeRanking?.(rk => reconcileRankingTrackKeys(rk, globalSongs));
  }, [globalSongs, onChangeRanking, ranking]);

  const groupedSongs = useMemo(() => {
    const groups = new Map();
    for (const track of globalSongs) {
      const identity = songIdentityOfTrack(track);
      const group = groups.get(identity) || [];
      group.push(track);
      groups.set(identity, group);
    }

    return Array.from(groups.values()).map(group => {
      const canonicalKey = group
        .map(track => trackKeyOfTrack(track))
        .sort((left, right) => compareTrackKeysForCanonical(left, right, ranking))[0];
      const representative =
        group.find(track => trackKeyOfTrack(track) === canonicalKey) || group[0];
      return {
        key: canonicalKey,
        track: representative,
        aliases: group.map(track => trackKeyOfTrack(track)),
      };
    });
  }, [globalSongs, ranking]);

  const canonicalKeyByObservedKey = useMemo(() => {
    const map = new Map();
    for (const group of groupedSongs) {
      map.set(group.key, group.key);
      for (const alias of group.aliases) {
        if (!map.has(alias)) map.set(alias, group.key);
      }
    }
    return map;
  }, [groupedSongs]);

  const trackByKey = useMemo(() => {
    const map = new Map();
    for (const group of groupedSongs) {
      map.set(group.key, group.track);
      for (const alias of group.aliases) {
        if (!map.has(alias)) map.set(alias, group.track);
      }
    }
    return map;
  }, [groupedSongs]);

  useEffect(() => {
    if (!trackRequest?.trackKey) return;
    if (trackByKey.size === 0) return;
    const canonicalKey =
      canonicalKeyByObservedKey.get(trackRequest.trackKey) || trackRequest.trackKey;
    if (trackByKey.has(canonicalKey)) {
      setActiveKey(canonicalKey);
      setMobileRankTab("rank");
    }
    onTrackRequestHandled?.();
  }, [canonicalKeyByObservedKey, trackByKey, trackRequest, onTrackRequestHandled]);

  const uniqueTracks = useMemo(() => {
    return groupedSongs.map(group => ({
      key: group.key,
      track: group.track,
      count: group.aliases.length,
    }));
  }, [groupedSongs]);

  const orderedKeys = useMemo(() => buildOrderedKeys(ranking), [ranking]);
  const orderedSet = useMemo(() => new Set(orderedKeys), [orderedKeys]);

  useEffect(() => {
    if (!activeKey) return;
    if (!trackByKey.has(activeKey)) setActiveKey(null);
  }, [activeKey, trackByKey]);

  useEffect(() => {
    if (!activeKey || !ranking) return;
    if (orderedKeys.length !== 0) return;
    onChangeRanking?.(rk => (rk ? applyOrderToRanking(rk, [activeKey]) : rk));
    setActiveKey(null);
  }, [activeKey, orderedKeys.length, ranking, onChangeRanking]);

  const trackIndex = useMemo(() => {
    const map = new Map();
    for (const t of globalSongs) {
      mergeTrackIntoIndex(map, t);
    }

    const playlistIds = Array.isArray(readPlaylistsCache(userId)?.items)
      ? readPlaylistsCache(userId)
          .items.map(playlist => playlist?.id)
          .filter(Boolean)
      : [];

    for (const playlistId of playlistIds) {
      const cachedTracks = readPlaylistTracksCache(userId, playlistId);
      const items = Array.isArray(cachedTracks?.items)
        ? cachedTracks.items
        : [];
      for (const track of items) {
        mergeTrackIntoIndex(map, track);
      }
    }

    return map;
  }, [globalSongs, localDataRevision, userId]);

  useEffect(() => {
    rankedArtistImagesByIdRef.current = rankedArtistImagesById || {};
  }, [rankedArtistImagesById]);

  useEffect(() => {
    rankedResolvedArtistByNameRef.current = rankedResolvedArtistByName || {};
  }, [rankedResolvedArtistByName]);

  useEffect(() => {
    const cached = readArtistIdByNameCache(userId);
    const items =
      cached?.items && typeof cached.items === "object" ? cached.items : {};
    const next = {};
    for (const [nameKey, artistId] of Object.entries(items)) {
      if (typeof artistId !== "string" || !artistId) continue;
      next[nameKey] = { status: "loaded", artistId };
    }
    setRankedResolvedArtistByName(next);
  }, [userId]);

  const ensureRankedArtistImage = useCallback(async artistId => {
    if (!artistId) return;

    const existing = rankedArtistImagesByIdRef.current?.[artistId] || null;
    if (existing?.status === "loaded") return;
    if (existing?.status === "loading") {
      const inflight = rankedArtistImageInFlight.current.get(artistId);
      if (inflight) return inflight;
      return;
    }

    setRankedArtistImagesById(prev => {
      const current = prev?.[artistId];
      if (
        current &&
        (current.status === "loading" || current.status === "loaded")
      ) {
        return prev;
      }
      return {
        ...prev,
        [artistId]: {
          status: "loading",
          imageUrl:
            typeof current?.imageUrl === "string" ? current.imageUrl : null,
        },
      };
    });

    if (rankedArtistImageInFlight.current.has(artistId))
      return rankedArtistImageInFlight.current.get(artistId);

    const request = (async () => {
      try {
        const res = await fetch(`/artist-image/${encodeURIComponent(artistId)}`);
        let data = null;
        try {
          data = await res.json();
        } catch {
          data = null;
        }

        if (!res.ok) {
          setRankedArtistImagesById(prev => ({
            ...prev,
            [artistId]: {
              status: "error",
              imageUrl: null,
            },
          }));
          return;
        }

        setRankedArtistImagesById(prev => ({
          ...prev,
          [artistId]: {
            status: "loaded",
            imageUrl: typeof data?.imageUrl === "string" ? data.imageUrl : null,
          },
        }));
      } catch {
        setRankedArtistImagesById(prev => ({
          ...prev,
          [artistId]: {
            status: "error",
            imageUrl: null,
          },
        }));
      } finally {
        rankedArtistImageInFlight.current.delete(artistId);
      }
    })();

    rankedArtistImageInFlight.current.set(artistId, request);
    return request;
  }, []);

  const ensureRankedTrackArtists = useCallback(async trackId => {
    if (!trackId) return { ok: false, artists: [] };

    const existing = rankedTrackResolveInFlight.current.get(trackId);
    if (existing) return existing;

    const request = (async () => {
      try {
        const res = await fetch(`/api/tracks/${encodeURIComponent(trackId)}`);
        let data = null;
        try {
          data = await res.json();
        } catch {
          data = null;
        }

        if (!res.ok) {
          return { ok: false, artists: [] };
        }

        return {
          ok: true,
          artists: Array.isArray(data?.artists) ? data.artists : [],
        };
      } catch {
        return { ok: false, artists: [] };
      } finally {
        rankedTrackResolveInFlight.current.delete(trackId);
      }
    })();

    rankedTrackResolveInFlight.current.set(trackId, request);
    return request;
  }, []);

  const ensureRankedArtistIdsForRow = useCallback(
    async row => {
      const trackId =
        typeof row?.track?.id === "string" && row.track.id ? row.track.id : null;
      const artistNames = Array.isArray(row?.artistNames) ? row.artistNames : [];
      if (!trackId || !artistNames.length) return;

      const unresolvedNames = artistNames.filter(name => {
        const key = normalizeArtistNameKey(name);
        return (
          key &&
          typeof rankedResolvedArtistByNameRef.current?.[key]?.artistId !== "string"
        );
      });
      if (!unresolvedNames.length) return;

      const result = await ensureRankedTrackArtists(trackId);
      if (!result?.ok) return;

      const artists = Array.isArray(result?.artists) ? result.artists : [];
      const toCache = {};
      for (const artist of artists) {
        const name = typeof artist?.name === "string" ? artist.name : null;
        const artistId = typeof artist?.id === "string" ? artist.id : null;
        const key = normalizeArtistNameKey(name);
        if (!key || !artistId) continue;
        toCache[key] = artistId;
      }
      if (!Object.keys(toCache).length) return;

      setRankedResolvedArtistByName(prev => {
        const next = { ...prev };
        for (const [nameKey, artistId] of Object.entries(toCache)) {
          next[nameKey] = { status: "loaded", artistId };
        }
        return next;
      });
      mergeArtistIdByNameCache(userId, toCache);
    },
    [ensureRankedTrackArtists, userId],
  );

  const unrankedRows = useMemo(() => {
    if (!ranking) return [];
    return uniqueTracks
      .map(({ key, track }) => ({
        key,
        track,
        state: getTrackState(ranking, key),
        artists: Array.isArray(track?.artists) ? track.artists.join(", ") : "",
      }))
      .filter(r => r.state.bucket !== "X")
      .filter(r => !orderedSet.has(r.key));
  }, [uniqueTracks, ranking, orderedSet]);

  const filteredUnrankedRows = useMemo(() => {
    if (!unrankedQuery.trim()) return unrankedRows;
    const q = unrankedQuery.trim().toLowerCase();
    return unrankedRows.filter(r => {
      const name = r.track?.name || "";
      const artists = r.artists || "";
      return `${name} ${artists}`.toLowerCase().includes(q);
    });
  }, [unrankedQuery, unrankedRows]);

  const excludedRows = useMemo(() => {
    if (!ranking) return [];
    return uniqueTracks
      .map(({ key, track }) => ({
        key,
        track,
        state: getTrackState(ranking, key),
        artists: Array.isArray(track?.artists) ? track.artists.join(", ") : "",
      }))
      .filter(r => r.state.bucket === "X");
  }, [uniqueTracks, ranking]);

  const filteredExcludedRows = useMemo(() => {
    if (!unrankedQuery.trim()) return excludedRows;
    const q = unrankedQuery.trim().toLowerCase();
    return excludedRows.filter(r => {
      const name = r.track?.name || "";
      const artists = r.artists || "";
      return `${name} ${artists}`.toLowerCase().includes(q);
    });
  }, [excludedRows, unrankedQuery]);

  const moveTrackToExcluded = useCallback(
    trackKey => {
      if (!trackKey) return;
      onChangeRanking?.(rk => (rk ? excludeTrack(rk, trackKey) : rk));
      if (activeKey === trackKey) setActiveKey(null);
    },
    [activeKey, onChangeRanking],
  );

  const restoreExcludedTrack = useCallback(
    trackKey => {
      if (!trackKey) return;
      onChangeRanking?.(rk =>
        rk ? setTrackBucket(rk, trackKey, "U") : rk,
      );
    },
    [onChangeRanking],
  );

  const rankedRows = useMemo(() => {
    if (!ranking) return [];
    return orderedKeys
      .map(key => {
        const track = trackIndex.get(key) || trackByKey.get(key) || null;
        if (!track) return null;
        const artistNames = Array.isArray(track?.artists)
          ? track.artists.filter(Boolean)
          : [];
        const artistIds = Array.isArray(track?.artistIds)
          ? track.artistIds.filter(
              artistId => typeof artistId === "string" && artistId,
            )
          : [];
        const primaryArtistName = artistNames[0] || "Unknown artist";
        const artistImageCandidateIds = Array.from(
          new Set(
            artistNames.flatMap((name, idx) => {
              const cachedId =
                rankedResolvedArtistByName?.[normalizeArtistNameKey(name)]?.artistId ||
                null;
              const directId =
                Array.isArray(track?.artistIds) &&
                Array.isArray(track?.artists) &&
                track.artists.length === track.artistIds.length
                  ? track.artistIds[idx] || null
                  : artistIds[idx] || null;
              return [cachedId, directId].filter(
                artistId => typeof artistId === "string" && artistId,
              );
            }),
          ),
        );
        return {
          key,
          track,
          state: getTrackState(ranking, key),
          artists: artistNames.join(", "),
          artistNames,
          primaryArtistName,
          artistImageCandidateIds,
        };
      })
      .filter(Boolean);
  }, [orderedKeys, rankedResolvedArtistByName, ranking, trackByKey, trackIndex]);

  const filteredRankedRows = useMemo(() => {
    if (!rankedQuery.trim()) return rankedRows;
    const q = rankedQuery.trim().toLowerCase();
    return rankedRows.filter(r => {
      const name = r.track?.name || "";
      const artists = r.artists || "";
      return `${name} ${artists}`.toLowerCase().includes(q);
    });
  }, [rankedQuery, rankedRows]);

  const orderedIndexByKey = useMemo(() => {
    const map = new Map();
    orderedKeys.forEach((key, idx) => map.set(key, idx));
    return map;
  }, [orderedKeys]);

  useEffect(() => {
    if (!userId || !rankedRows.length) return;

    rankedRows.forEach(row => {
      void ensureRankedArtistIdsForRow(row);
    });
  }, [ensureRankedArtistIdsForRow, rankedRows, userId]);

  useEffect(() => {
    if (!userId || !rankedRows.length) return;

    const artistIds = Array.from(
      new Set(
        rankedRows
          .flatMap(row => row.artistImageCandidateIds || [])
          .filter(artistId => typeof artistId === "string" && artistId),
      ),
    );

    artistIds.forEach(artistId => {
      void ensureRankedArtistImage(artistId);
    });
  }, [ensureRankedArtistImage, rankedRows, userId]);

  const getRankedArtistImageUrl = useCallback(
    row =>
      (row?.artistImageCandidateIds || [])
        .map(artistId => rankedArtistImagesById?.[artistId]?.imageUrl)
        .find(value => typeof value === "string" && value) || null,
    [rankedArtistImagesById],
  );

  const moveRankedTrack = useCallback(
    (trackKey, direction) => {
      if (!trackKey || !Number.isInteger(direction) || direction === 0) return;
      setActiveKey(current => (current === trackKey ? null : current));
      onChangeRanking?.(rk => {
        if (!rk) return rk;
        const ordered = buildOrderedKeys(rk);
        const nextOrder = moveOrderedKey(ordered, trackKey, direction);
        if (!nextOrder || nextOrder === ordered) return rk;
        return applyOrderToRanking(rk, nextOrder);
      });
    },
    [onChangeRanking],
  );

  useEffect(() => {
    if (activeKey) return;
    if (trackRequest?.trackKey) return;
    if (rankedRows.length === 0) return;
    if (unrankedRows.length === 0) return;
    const pick =
      unrankedRows[Math.floor(Math.random() * unrankedRows.length)]?.key ??
      null;
    if (pick) setActiveKey(pick);
  }, [
    activeKey,
    trackRequest,
    rankedRows.length,
    unrankedRows.length,
    unrankedRows,
  ]);

  useEffect(() => {
    if (mobileUnrankedTab !== "excluded") return;
    if (excludedRows.length > 0) return;
    setMobileUnrankedTab("unranked");
  }, [excludedRows.length, mobileUnrankedTab]);

  useEffect(() => {
    const wasOpen = previousExcludedOpenRef.current;
    previousExcludedOpenRef.current = excludedOpen;
    if (!excludedOpen || wasOpen) return;

    const panel = excludedPanelRef.current;
    if (!panel) return;

    const timeoutId = window.setTimeout(() => {
      const scrollContainer = findScrollableAncestor(panel);
      if (
        scrollContainer &&
        typeof scrollContainer.scrollBy === "function"
      ) {
        scrollContainer.scrollBy({
          top: 104,
          behavior: "smooth",
        });
        return;
      }

      window.scrollBy({
        top: 104,
        behavior: "smooth",
      });
    }, 40);

    return () => window.clearTimeout(timeoutId);
  }, [excludedOpen]);

  return (
    <div className="section dashboardPage rankSongsPage">
      {!userId ? null : uniqueTracks.length === 0 ? (
        <div className="pageEmptyStateWrap">
          <div className="pageEmptyStateCard">
            <h3>No songs to rank yet</h3>
            <p className="meta">
              Open <strong>Playlists</strong> and add a playlist to start building
              your ranking.
            </p>
          </div>
        </div>
      ) : (
        <Fragment>
          <div
            className="rankSongsMobileTabs"
            role="tablist"
            aria-label="Rank songs mobile sections"
          >
            <button
              type="button"
              role="tab"
              aria-selected={mobileRankTab === "unranked"}
              className={`rankSongsMobileTabBtn ${
                mobileRankTab === "unranked" ? "active" : ""
              }`.trim()}
              onClick={() => setMobileRankTab("unranked")}
            >
              Unranked
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mobileRankTab === "rank"}
              className={`rankSongsMobileTabBtn ${
                mobileRankTab === "rank" ? "active" : ""
              }`.trim()}
              onClick={() => setMobileRankTab("rank")}
            >
              Rank
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mobileRankTab === "ranked"}
              className={`rankSongsMobileTabBtn ${
                mobileRankTab === "ranked" ? "active" : ""
              }`.trim()}
              onClick={() => setMobileRankTab("ranked")}
            >
              Ranked
            </button>
          </div>

          <div
            className="dashboardColumns rankSongsColumns"
            role="region"
            aria-label="Rank songs columns"
          >
          <div
            className={`dashPanel rankSongsPanel rankSongsUnrankedPanel ${
              mobileUnrankedTab === "excluded" ? "isMobileExcludedTab" : ""
            } ${
              mobileRankTab === "unranked" ? "isMobileActive" : ""
            }`.trim()}
          >
            <div className="dashPanelHeader">
              <div
                className="rankSongsUnrankedMobileTabs"
                role="tablist"
                aria-label="Unranked and do not rate sections"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={mobileUnrankedTab === "unranked"}
                  className={`rankSongsUnrankedMobileTabBtn ${
                    mobileUnrankedTab === "unranked" ? "active" : ""
                  }`.trim()}
                  onClick={() => setMobileUnrankedTab("unranked")}
                >
                  Unranked ({unrankedRows.length})
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mobileUnrankedTab === "excluded"}
                  className={`rankSongsUnrankedMobileTabBtn ${
                    mobileUnrankedTab === "excluded" ? "active" : ""
                  }`.trim()}
                  onClick={() => setMobileUnrankedTab("excluded")}
                >
                  Do not rate ({excludedRows.length})
                </button>
              </div>
              <div className="dashPanelHeaderRow rankSongsUnrankedHeaderRow">
                <h3>
                  {mobileUnrankedTab === "excluded"
                    ? `Do not rate (${excludedRows.length})`
                    : `Unranked (${unrankedRows.length})`}
                </h3>
                <input
                  className="textInput rankSongsUnrankedSearch"
                  value={unrankedQuery}
                  onChange={e => setUnrankedQuery(e.target.value)}
                  placeholder={
                    mobileUnrankedTab === "excluded"
                      ? "Search do not rate…"
                      : "Search unranked…"
                  }
                  aria-label={
                    mobileUnrankedTab === "excluded"
                      ? "Search do not rate songs"
                      : "Search unranked songs"
                  }
                />
              </div>
            </div>
            <div
              className="dashPanelBody dashPanelBodyTight rankSongsScroll"
              role="region"
              aria-label={
                mobileUnrankedTab === "excluded"
                  ? "Do not rate songs list"
                  : "Unranked songs list"
              }
              tabIndex={0}
            >
              <div className="rankSongsListStack">
                <div className="rankSongsUnrankedTableBlock">
                  <table className="dashTable">
                    <colgroup>
                      <col />
                      <col className="dashColActions" />
                    </colgroup>
                    <thead>
                      <tr>
                        <th>Song</th>
                        <th className="right dashColActions">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(mobileUnrankedTab === "excluded"
                        ? filteredExcludedRows
                        : filteredUnrankedRows
                      ).map(r => (
                        <tr
                          key={r.key}
                          className="dashTableRow"
                        >
                          <td className="rankSongsCellWithCornerAction">
                            <div className="rankSongsCellTitle rankSongsCellTitleWithCornerAction">
                              {mobileUnrankedTab === "excluded" ? null : (
                                <button
                                  className="rankSongsExcludeBtn"
                                  onClick={() => moveTrackToExcluded(r.key)}
                                  title="Move to Do not rate"
                                  aria-label={`Move ${getTrackDisplayName(r.track, r.key)} to Do not rate`}
                                >
                                  ×
                                </button>
                              )}
                              <div className="rankSongsCellText">
                                <div className="cellTitle">
                                  {getTrackDisplayName(r.track, r.key)}
                                </div>
                                <div className="cellSub">
                                  {r.artists || "Unknown artist"}
                                </div>
                              </div>
                            </div>
                          </td>
                          <td className="right">
                            <span className="btnRow">
                              {mobileUnrankedTab === "excluded" ? (
                                <button
                                  className="btn compact"
                                  onClick={() => restoreExcludedTrack(r.key)}
                                  title="Add this song back to ranking"
                                >
                                  Restore
                                </button>
                              ) : (
                                <button
                                  className="btn"
                                  onClick={() => {
                                    setActiveKey(r.key);
                                    setMobileRankTab("rank");
                                  }}
                                  disabled={activeKey === r.key}
                                  title="Rank this song"
                                >
                                  Rank
                                </button>
                              )}
                              {typeof r.track?.id === "string" ? (
                                <button
                                  className="btn compact"
                                  onClick={() => openTrackInSpotify(r.track.id)}
                                  title="Play in Spotify"
                                >
                                  Play
                                </button>
                              ) : null}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div
                  ref={excludedPanelRef}
                  className="rankSongsExcludedPanel"
                >
                  <button
                    className="rankSongsExcludedToggle"
                    onClick={() => setExcludedOpen(open => !open)}
                    aria-expanded={excludedOpen}
                    aria-controls="excluded-songs-list"
                  >
                    <span>Do not rate ({excludedRows.length})</span>
                    <span className="rankSongsExcludedCaret">
                      {excludedOpen ? "Hide" : "Show"}
                    </span>
                  </button>
                  {excludedOpen ? (
                    <div
                      id="excluded-songs-list"
                      className="rankSongsExcludedBody"
                    >
                      {filteredExcludedRows.length ? (
                        <ul className="rankSongsExcludedList">
                          {filteredExcludedRows.map(r => (
                            <li
                              key={r.key}
                              className="rankSongsExcludedRow"
                            >
                              <div className="rankSongsExcludedMain">
                                <div className="cellTitle">
                                  {getTrackDisplayName(r.track, r.key)}
                                </div>
                                <div className="cellSub">
                                  {r.artists || "Unknown artist"}
                                </div>
                              </div>
                              <button
                                className="btn compact"
                                onClick={() => restoreExcludedTrack(r.key)}
                                title="Add this song back to ranking"
                              >
                                Add to Ranking
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="meta rankSongsExcludedEmpty">
                          No songs are in Do not rate.
                        </p>
                      )}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          </div>

          <div
            className={`dashPanel rankSongsPanel ${
              mobileRankTab === "rank" ? "isMobileActive" : ""
            }`.trim()}
          >
            <div className="dashPanelHeader">
              <div className="dashPanelHeaderRow">
                <h3>Rank</h3>
                <button
                  className="btn small"
                  onClick={() => setRankInfoOpen(v => !v)}
                  aria-expanded={rankInfoOpen}
                  aria-label="Show ranking mode info"
                >
                  Info
                </button>
              </div>
            </div>
            <div
              className="dashPanelBody rankSongsCenter"
              role="region"
              aria-label="Ranking interface"
              tabIndex={0}
            >
              {rankInfoOpen ? (
                <div className="cardSub rankInfoPanel">
                  <h4>How ranking works</h4>
                  <p className="meta">
                    <strong>Binary sort</strong> places a song into your global
                    order using mid-point comparisons. Each pick narrows the
                    range (like binary search), so it finds the right spot with
                    far fewer comparisons than head-to-head across the whole
                    list. Use this to get a strong baseline order quickly.
                  </p>
                  <p className="meta">
                    Tip: Use <strong>Reset</strong> to move a song back to
                    Unranked and place it from scratch again. Use the{" "}
                    <strong>up</strong> and <strong>down</strong> arrows in the
                    ranked list to nudge a song one position at a time.
                  </p>
                </div>
              ) : null}
              <BinarySorter
                uniqueTracks={uniqueTracks}
                trackIndex={trackIndex}
                ranking={ranking}
                onChange={onChangeRanking}
                activeKey={activeKey}
                onActiveKeyChange={setActiveKey}
              />
            </div>
          </div>

          <div
            className={`dashPanel rankSongsPanel ${
              mobileRankTab === "ranked" ? "isMobileActive" : ""
            }`.trim()}
          >
            <div className="dashPanelHeader">
              <div className="dashPanelHeaderRow">
                <h3>Ranked ({rankedRows.length})</h3>
                <input
                  className="textInput"
                  value={rankedQuery}
                  onChange={e => setRankedQuery(e.target.value)}
                  placeholder="Search ranked…"
                  aria-label="Search ranked songs"
                />
              </div>
            </div>
            <div
              className="dashPanelBody dashPanelBodyTight rankSongsScroll"
              role="region"
              aria-label="Ranked songs list"
              tabIndex={0}
            >
              <div
                className="rankSongsRankedMobileList"
                role="list"
                aria-label="Ranked songs cards"
              >
                {filteredRankedRows.map((r, idx) => {
                  const imageUrl = getRankedArtistImageUrl(r);
                  const displayRank = (orderedIndexByKey.get(r.key) ?? idx) + 1;
                  return (
                    <article
                      key={r.key}
                      className="rankSongsRankedMobileCard"
                      role="listitem"
                      aria-label={`Ranked song ${displayRank}: ${getTrackDisplayName(r.track, r.key)}`}
                    >
                      <div
                        className={`artistAvatar rankSongsRankedMobileAvatar ${
                          imageUrl ? "hasImage" : ""
                        }`.trim()}
                        aria-hidden="true"
                      >
                        {imageUrl ? (
                          <img
                            src={imageUrl}
                            alt=""
                            loading="lazy"
                          />
                        ) : (
                          <span>
                            {(r.primaryArtistName || "?").slice(0, 1).toUpperCase()}
                          </span>
                        )}
                      </div>

                      <div className="rankSongsRankedMobileMain">
                        <div className="rankSongsRankedMobileTop">
                          <div className="rankSongsRankedMobileCopy">
                            <div className="cellTitle">
                              {getTrackDisplayName(r.track, r.key)}
                            </div>
                            <div className="cellSub">
                              {r.artists || "Unknown artist"}
                            </div>
                          </div>
                          <span className="rankSongsRankedMobileRank">
                            #{displayRank}
                          </span>
                        </div>

                        <div className="btnRow rankSongsRankedMobileActions">
                          {typeof r.track?.id === "string" ? (
                            <button
                              className="btn compact"
                              onClick={() => openTrackInSpotify(r.track.id)}
                              title="Play in Spotify"
                              aria-label={`Play ${getTrackDisplayName(r.track, r.key)}`}
                            >
                              Play
                            </button>
                          ) : null}
                          <button
                            className="btn compact"
                            onClick={() => moveRankedTrack(r.key, -1)}
                            disabled={(orderedIndexByKey.get(r.key) ?? idx) <= 0}
                            title="Move this song up one position"
                            aria-label={`Move ${getTrackDisplayName(r.track, r.key)} up one position`}
                          >
                            ↑
                          </button>
                          <button
                            className="btn compact"
                            onClick={() => moveRankedTrack(r.key, 1)}
                            disabled={
                              (orderedIndexByKey.get(r.key) ?? idx) >=
                              orderedKeys.length - 1
                            }
                            title="Move this song down one position"
                            aria-label={`Move ${getTrackDisplayName(r.track, r.key)} down one position`}
                          >
                            ↓
                          </button>
                          <button
                            className="btn compact"
                            onClick={() => {
                              setActiveKey(null);
                              onChangeRanking?.(rk =>
                                rk ? resetTrackState(rk, r.key) : rk,
                              );
                            }}
                            title="Move this song back to unranked"
                          >
                            Reset
                          </button>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>

              <table className="dashTable rankSongsRankedDesktopTable">
                <colgroup>
                  <col className="dashColIndex" />
                  <col />
                  <col className="dashColActions" />
                </colgroup>
                <thead>
                  <tr>
                    <th className="right dashColIndex">#</th>
                    <th>Song</th>
                    <th className="right dashColActions">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRankedRows.map((r, idx) => {
                    return (
                      <tr
                        key={r.key}
                        className="dashTableRow"
                      >
                        <td className="right rankSongsRankCell">
                          <span className="rankSongsRankSwap">
                            <span className="cellSub rankSongsRankValue">
                              {idx + 1}
                            </span>
                            {typeof r.track?.id === "string" ? (
                              <button
                                className="btn small rowPlayBtn rankSongsHoverPlay"
                                onClick={() => openTrackInSpotify(r.track.id)}
                                title="Play in Spotify"
                                aria-label={`Play ${getTrackDisplayName(r.track, r.key)}`}
                              >
                                Play
                              </button>
                            ) : null}
                          </span>
                        </td>
                        <td>
                          <div className="cellTitle">
                            {getTrackDisplayName(r.track, r.key)}
                          </div>
                          <div className="cellSub">
                            {r.artists || "Unknown artist"}
                          </div>
                        </td>
                        <td className="right">
                          <span className="btnRow">
                            <button
                              className="btn compact"
                              onClick={() => moveRankedTrack(r.key, -1)}
                              disabled={(orderedIndexByKey.get(r.key) ?? idx) <= 0}
                              title="Move this song up one position"
                              aria-label={`Move ${getTrackDisplayName(r.track, r.key)} up one position`}
                            >
                              ↑
                            </button>
                            <button
                              className="btn compact"
                              onClick={() => moveRankedTrack(r.key, 1)}
                              disabled={
                                (orderedIndexByKey.get(r.key) ?? idx) >=
                                orderedKeys.length - 1
                              }
                              title="Move this song down one position"
                              aria-label={`Move ${getTrackDisplayName(r.track, r.key)} down one position`}
                            >
                              ↓
                            </button>
                            <button
                              className="btn compact"
                              onClick={() => {
                                setActiveKey(null);
                                onChangeRanking?.(rk =>
                                  rk ? resetTrackState(rk, r.key) : rk,
                                );
                              }}
                              title="Move this song back to unranked"
                            >
                              Reset
                            </button>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
          </div>
        </Fragment>
      )}
    </div>
  );
}

function PlaylistsView({
  profile,
  playlistsLoading,
  playlistsError,
  playlistsCache,
  cooldownUntilMs,
  nextPlaylistsRefreshAt,
  onGlobalSongsChanged,
  onObservedTracks,
  onUpdatePlaylistsCache,
  onSelect,
}) {
  const userId = profile?.id ?? null;
  const isMockDemoUser = userId === MOCK_DEMO_USER_ID;
  const [ingestStateById, setIngestStateById] = useState({});
  const [cooldownNowMs, setCooldownNowMs] = useState(() => Date.now());
  const [globalActionCooldownUntilMs, setGlobalActionCooldownUntilMs] = useState(null);
  const [playlistQuery, setPlaylistQuery] = useState("");
  const [playlistPendingRemoval, setPlaylistPendingRemoval] = useState(null);

  useEffect(() => {
    const id = setInterval(() => setCooldownNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!playlistPendingRemoval) return;

    const onKeyDown = event => {
      if (event.key === "Escape") setPlaylistPendingRemoval(null);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [playlistPendingRemoval]);

  function updateIngestState(playlistId, patch) {
    setIngestStateById(prev => ({
      ...prev,
      [playlistId]: { ...(prev?.[playlistId] ?? {}), ...patch },
    }));
  }

  function startGlobalActionCooldown() {
    setGlobalActionCooldownUntilMs(Date.now() + PLAYLIST_ACTION_COOLDOWN_MS);
  }

  async function confirmRemovePlaylistFromPool() {
    const playlist = playlistPendingRemoval;
    const playlistId =
      typeof playlist?.id === "string" && playlist.id ? playlist.id : null;
    if (!userId || !playlistId) return;

    updateIngestState(playlistId, { status: "removing", error: null });
    try {
      const updated = setPlaylistIngestedAt(userId, playlistId, null);
      if (updated) {
        rebuildGlobalSongsFromIngestedPlaylists(userId, updated);
        onObservedTracks?.(readVisibleGlobalTracks(userId));
        onGlobalSongsChanged?.();
        onUpdatePlaylistsCache?.(updated);
      }
      setPlaylistPendingRemoval(null);
      updateIngestState(playlistId, { status: "idle", error: null });
    } catch (error) {
      updateIngestState(playlistId, {
        status: "idle",
        error: error?.message || "Removal failed",
      });
    }
  }

  const filteredPlaylists = useMemo(() => {
    const items = Array.isArray(playlistsCache?.items) ? playlistsCache.items : [];
    const q = playlistQuery.trim().toLowerCase();
    if (!q) return items;
    return items.filter(p => {
      const name = typeof p?.name === "string" ? p.name : "";
      const owner =
        typeof p?.owner?.display_name === "string" ? p.owner.display_name : "";
      return `${name} ${owner}`.toLowerCase().includes(q);
    });
  }, [playlistQuery, playlistsCache?.items]);

  const spotifyFetchedAt =
    typeof playlistsCache?.spotifyFetchedAt === "string"
      ? playlistsCache.spotifyFetchedAt
      : typeof playlistsCache?.fetchedAt === "string"
        ? playlistsCache.fetchedAt
        : null;
  const updatedText = spotifyFetchedAt
    ? formatDateTime(spotifyFetchedAt)
    : "unknown";
  const nextRefreshCountdown = formatCountdown(
    nextPlaylistsRefreshAt,
    cooldownNowMs,
  );
  const globalActionCooldownRemaining =
    Number.isFinite(globalActionCooldownUntilMs) &&
    globalActionCooldownUntilMs > cooldownNowMs
      ? Math.ceil((globalActionCooldownUntilMs - cooldownNowMs) / 1000)
      : 0;
  const isGlobalActionCooling = globalActionCooldownRemaining > 0;

  async function ingestPlaylist(playlistId) {
    if (!userId || !playlistId || isGlobalActionCooling) return;
    updateIngestState(playlistId, {
      status: "fetching",
      error: null,
    });
    startGlobalActionCooldown();

    try {
      const res = await fetch(
        `/api/playlists/${encodeURIComponent(playlistId)}/tracks?all=1&force=1`,
      );

      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }

      if (res.status === 429) {
        const retryAfterSeconds = Number(data?.retryAfterSeconds);
        const until = Number.isFinite(retryAfterSeconds)
          ? Date.now() + retryAfterSeconds * 1000
          : Date.now() + 60_000;
        setSpotifyCooldown(userId, until);
        updateIngestState(playlistId, {
          status: "idle",
          error: "Spotify rate limited this request.",
        });
        return;
      }

      if (!res.ok) {
        const msg =
          typeof data?.message === "string"
            ? data.message
            : typeof data?.error === "string"
              ? data.error
              : "Failed to fetch playlist tracks";
        updateIngestState(playlistId, { status: "idle", error: msg });
        return;
      }

      const fetchedAt = new Date().toISOString();
      const apiItemsCount = Array.isArray(data?.items) ? data.items.length : 0;
      const apiTotal = Number(data?.total) || apiItemsCount;
      const isComplete = !data?.partial && apiItemsCount >= apiTotal;

      writePlaylistTracksCache(userId, playlistId, data, {
        fetchedAt,
        isComplete,
      });

      const cachedTracks = readPlaylistTracksCache(userId, playlistId);
      const tracks = Array.isArray(cachedTracks?.items)
        ? cachedTracks.items
        : [];
      const ingestedAt = new Date().toISOString();
      const updated = setPlaylistIngestedAt(userId, playlistId, ingestedAt);
      if (updated) {
        rebuildGlobalSongsFromIngestedPlaylists(userId, updated);
        onObservedTracks?.(readVisibleGlobalTracks(userId));
        onGlobalSongsChanged?.();
        onUpdatePlaylistsCache?.(updated);
      } else {
        upsertGlobalSongs(userId, tracks, { sourcePlaylistId: playlistId });
        onObservedTracks?.(readVisibleGlobalTracks(userId));
        onGlobalSongsChanged?.();
      }

      updateIngestState(playlistId, { status: "idle", error: null });
    } catch (err) {
      updateIngestState(playlistId, {
        status: "idle",
        error: err?.message || "Ingestion failed",
      });
    }
  }
  return (
    <div className="section playlistsPage">
      <h2>Your playlists</h2>

      {playlistsError ? <p className="error">{playlistsError}</p> : null}

      {playlistsCache ? (
        <p className="meta playlistStatusMeta">
          {isMockDemoUser ? (
            <span>
              These demo playlists were made on <strong>March 17, 2026</strong>.
            </span>
          ) : (
            <Fragment>
              <span>
                Updated <strong>{updatedText}</strong>
              </span>
              <span>
                Next update{" "}
                <strong>
                  {Number.isFinite(nextPlaylistsRefreshAt)
                    ? `in ${nextRefreshCountdown}`
                    : "not scheduled"}
                </strong>
              </span>
            </Fragment>
          )}
        </p>
      ) : playlistsLoading ? (
        <p className="meta">Fetching playlists…</p>
      ) : (
        <p className="meta">No playlist cache yet.</p>
      )}

      {playlistsCache?.items?.length ? (
        <Fragment>
          <div className="controls playlistsSearchControls">
            <input
              className="textInput"
              value={playlistQuery}
              onChange={e => setPlaylistQuery(e.target.value)}
              placeholder="Search playlists…"
              aria-label="Search playlists"
            />
          </div>

          <div
            className="playlistGrid"
            role="region"
            aria-label="Playlists"
          >
            {filteredPlaylists.map(p => {
              const tracksMeta =
                userId && p.id ? readPlaylistTracksCacheMeta(userId, p.id) : null;
              const snapshotMismatch =
                Boolean(tracksMeta?.fetchedAt) &&
                typeof p.snapshotId === "string" &&
                typeof tracksMeta?.snapshotId === "string" &&
                p.snapshotId !== tracksMeta.snapshotId;
              const ingestState = p.id ? ingestStateById?.[p.id] : null;
              const isFetching = ingestState?.status === "fetching";
              const isRemoving = ingestState?.status === "removing";
              const ingestedAt =
                typeof p?.ingestedAt === "string" ? p.ingestedAt : null;
              const inGlobalRankingPool = Boolean(ingestedAt);
              const lastSyncedAt =
                typeof tracksMeta?.fetchedAt === "string"
                  ? tracksMeta.fetchedAt
                  : ingestedAt;
              const visibilityLabel =
                typeof p.public === "boolean"
                  ? p.public
                    ? "Public"
                    : "Private"
                  : null;
              const trackCount =
                Number.isFinite(p?.tracksTotal) && p?.tracksTotal >= 0
                  ? Number(p.tracksTotal)
                  : null;
              const trackCountLabel = Number.isFinite(trackCount)
                ? `${trackCount} track${trackCount === 1 ? "" : "s"}`
                : null;
              const subtitle = [visibilityLabel, trackCountLabel]
                .filter(Boolean)
                .join(" · ");
              const actionLabel = isFetching
                ? "Syncing..."
                : isGlobalActionCooling
                  ? `Wait ${globalActionCooldownRemaining}s`
                  : isRemoving
                    ? "Removing..."
                  : inGlobalRankingPool
                    ? "Sync"
                    : "Add to Global Ranking";
              const mobilePoolLabel = inGlobalRankingPool
                ? "In pool"
                : "Not in pool";
              const mobilePoolTitle = inGlobalRankingPool
                ? "Remove playlist songs from the global pool"
                : "Add playlist songs to the global pool";
              const mobilePoolDisabled =
                !p.id ||
                isRemoving ||
                isFetching ||
                (!inGlobalRankingPool && isGlobalActionCooling);
              const imageUrl =
                Array.isArray(p?.images) && typeof p.images?.[0]?.url === "string"
                  ? p.images[0].url
                  : null;

              return (
                <article
                  key={p.id || p.name}
                  className="playlistCard"
                >
                  <button
                    type="button"
                    className={`playlistCardPoolToggleMobile ${
                      inGlobalRankingPool ? "isInPool" : "isOutOfPool"
                    }`.trim()}
                    onClick={() => {
                      if (!p.id) return;
                      if (inGlobalRankingPool) {
                        setPlaylistPendingRemoval(p);
                        return;
                      }
                      ingestPlaylist(p.id);
                    }}
                    disabled={mobilePoolDisabled}
                    title={mobilePoolTitle}
                  >
                    <span className="playlistCardPoolToggleMobileLabel">
                      {mobilePoolLabel}
                    </span>
                    <span
                      className="playlistCardPoolToggleMobileIcon"
                      aria-hidden="true"
                    >
                      {inGlobalRankingPool ? "✓" : "X"}
                    </span>
                  </button>

                  <div className="playlistCardMedia">
                    <button
                      className="playlistCardArt"
                      onClick={() => onSelect(p.id)}
                      disabled={!p.id}
                      aria-label={`Open ${p.name || "playlist"}`}
                    >
                      {imageUrl ? (
                        <img
                          src={imageUrl}
                          alt=""
                          loading="lazy"
                        />
                      ) : (
                        <span className="playlistCardPlaceholder" aria-hidden="true">
                          {(p.name || "?").slice(0, 1).toUpperCase()}
                        </span>
                      )}
                    </button>

                    {inGlobalRankingPool ? (
                      <button
                        type="button"
                        className="playlistCardPoolAction"
                        onClick={() => setPlaylistPendingRemoval(p)}
                        disabled={isRemoving || isFetching}
                        title="Remove playlist songs from the global pool"
                      >
                        <span className="playlistCardPoolActionDefault">✓ In pool</span>
                        <span className="playlistCardPoolActionHover">
                          {isRemoving ? "Removing..." : "Remove from Pool"}
                        </span>
                      </button>
                    ) : null}

                    {p.id ? (
                      <button
                        type="button"
                        className="btn small playlistCardSpotifyBtn"
                        onClick={() => openPlaylistInSpotify(p.id)}
                        title="Open playlist in Spotify"
                      >
                        Play
                      </button>
                    ) : null}
                  </div>

                  <div className="playlistCardBody">
                    <div className="playlistCardTitleRow">
                      <button
                        className="playlistCardTitle"
                        onClick={() => onSelect(p.id)}
                        disabled={!p.id}
                      >
                        {p.name || "(untitled playlist)"}
                      </button>
                    </div>

                    {subtitle ? <div className="playlistCardMeta">{subtitle}</div> : null}

                    {!inGlobalRankingPool ? (
                      <div className="playlistCardStatus">
                        Playlist songs not in global ranking pool
                      </div>
                    ) : null}
                    {inGlobalRankingPool ? (
                      <div className="playlistCardCache">
                        {lastSyncedAt
                          ? `Last synced ${formatDateTime(lastSyncedAt)}${
                              snapshotMismatch ? " · playlist changed on Spotify" : ""
                            }`
                          : "Ready to sync"}
                      </div>
                    ) : null}

                    <div
                      className={`playlistCardActions ${
                        inGlobalRankingPool ? "playlistCardActionsMobileDual" : ""
                      }`.trim()}
                    >
                      <button
                        className="btn"
                        onClick={() => p.id && ingestPlaylist(p.id)}
                        disabled={!p.id || isFetching || isGlobalActionCooling || isRemoving}
                      >
                        {actionLabel}
                      </button>
                      {inGlobalRankingPool ? (
                        <button
                          type="button"
                          className="btn danger playlistCardRemoveBtnMobile"
                          onClick={() => setPlaylistPendingRemoval(p)}
                          disabled={isRemoving || isFetching}
                        >
                          {isRemoving ? "Removing..." : "Remove from pool"}
                        </button>
                      ) : null}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>

          {filteredPlaylists.length === 0 ? (
            <p className="meta">No playlists match that search.</p>
          ) : null}
        </Fragment>
      ) : null}

      {playlistPendingRemoval ? (
        <div
          className="helpOverlay"
          role="presentation"
          onClick={() => setPlaylistPendingRemoval(null)}
        >
          <section
            className="helpDialog confirmDialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="remove-from-pool-title"
            onClick={event => event.stopPropagation()}
          >
            <div className="helpDialogHeader">
              <div>
                <div className="helpDialogEyebrow">Confirm action</div>
                <h2 id="remove-from-pool-title">Remove from Global Pool</h2>
              </div>
              <button
                type="button"
                className="btn small helpDialogClose"
                onClick={() => setPlaylistPendingRemoval(null)}
                aria-label="Close remove from pool dialog"
              >
                Close
              </button>
            </div>

            <p className="helpDialogIntro">
              Remove{" "}
              <strong>
                {playlistPendingRemoval?.name || "this playlist"}
              </strong>{" "}
              from the global pool?
            </p>

            <section className="helpCard helpCardWide">
              <ul className="helpList">
                <li>Any songs you already rated keep their ranking forever.</li>
                <li>
                  Songs that only came from this playlist will disappear from
                  Dashboard and Rank Songs.
                </li>
                <li>
                  If you sync another playlist containing those songs later,
                  they will become visible in the global pool again.
                </li>
              </ul>
            </section>

            <div className="confirmDialogActions">
              <button
                type="button"
                className="btn"
                onClick={() => setPlaylistPendingRemoval(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn danger"
                onClick={confirmRemovePlaylistFromPool}
              >
                Remove from Pool
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function PlaylistView({
  userId,
  playlistsCache,
  playlistId,
  ranking,
  tracksError,
  tracksCache,
  onBack,
}) {
  const playlist =
    playlistsCache?.items?.find(p => p?.id === playlistId) || null;
  const trackCount =
    Number.isFinite(tracksCache?.total) && Number(tracksCache.total) >= 0
      ? Number(tracksCache.total)
      : Number.isFinite(playlist?.tracksTotal) && Number(playlist.tracksTotal) >= 0
        ? Number(playlist.tracksTotal)
        : null;
  const playlistHeading = Number.isFinite(trackCount)
    ? `${playlist?.name || "Playlist"} (${trackCount} track${trackCount === 1 ? "" : "s"})`
    : playlist?.name || "Playlist";

  const uniqueTracks = useMemo(() => {
    const items = Array.isArray(tracksCache?.items) ? tracksCache.items : [];
    const map = new Map();
    for (const t of items) {
      const key = trackKeyOfTrack(t);
      const existing = map.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        map.set(key, { key, track: t, count: 1 });
      }
    }
    return Array.from(map.values());
  }, [tracksCache]);

  const globalRankByKey = useMemo(() => {
    if (!ranking) return new Map();
    const ordered = buildOrderedKeys(ranking);
    const map = new Map();
    ordered.forEach((key, idx) => {
      map.set(key, idx + 1);
    });
    return map;
  }, [ranking]);

  return (
    <div className="section">
      <div className="controls">
        <button
          className="btn"
          onClick={onBack}
        >
          ← Back
        </button>
      </div>

      <h2>{playlistHeading}</h2>

      {tracksError ? <p className="error">{tracksError}</p> : null}

      <PlaylistTracksTable
        userId={userId}
        uniqueTracks={uniqueTracks}
        globalRankByKey={globalRankByKey}
      />
    </div>
  );
}

function PlaylistTracksTable({ userId, uniqueTracks, globalRankByKey }) {
  const [artistImagesById, setArtistImagesById] = useState(() => ({}));
  const [resolvedArtistByName, setResolvedArtistByName] = useState(() => {
    const cached = readArtistIdByNameCache(userId);
    const items =
      cached?.items && typeof cached.items === "object" ? cached.items : {};
    const next = {};
    for (const [nameKey, artistId] of Object.entries(items)) {
      if (typeof artistId !== "string" || !artistId) continue;
      next[nameKey] = { status: "loaded", artistId };
    }
    return next;
  });
  const artistImageInFlight = useRef(new Map());
  const trackResolveInFlight = useRef(new Map());
  const artistImagesByIdRef = useRef({});
  const resolvedArtistByNameRef = useRef({});

  useEffect(() => {
    artistImagesByIdRef.current = artistImagesById || {};
  }, [artistImagesById]);

  useEffect(() => {
    resolvedArtistByNameRef.current = resolvedArtistByName || {};
  }, [resolvedArtistByName]);

  useEffect(() => {
    const cached = readArtistIdByNameCache(userId);
    const items =
      cached?.items && typeof cached.items === "object" ? cached.items : {};
    const next = {};
    for (const [nameKey, artistId] of Object.entries(items)) {
      if (typeof artistId !== "string" || !artistId) continue;
      next[nameKey] = { status: "loaded", artistId };
    }
    setResolvedArtistByName(next);
  }, [userId]);

  const ensureArtistImage = useCallback(async artistId => {
    if (!artistId) return;

    const existing = artistImagesByIdRef.current?.[artistId] || null;
    if (existing?.status === "loaded") return;
    if (existing?.status === "loading") {
      const inflight = artistImageInFlight.current.get(artistId);
      if (inflight) return inflight;
      return;
    }

    setArtistImagesById(prev => {
      const current = prev?.[artistId];
      if (
        current &&
        (current.status === "loading" || current.status === "loaded")
      ) {
        return prev;
      }
      return {
        ...prev,
        [artistId]: {
          status: "loading",
          imageUrl:
            typeof current?.imageUrl === "string" ? current.imageUrl : null,
        },
      };
    });

    if (artistImageInFlight.current.has(artistId))
      return artistImageInFlight.current.get(artistId);

    const request = (async () => {
      try {
        const res = await fetch(`/artist-image/${encodeURIComponent(artistId)}`);
        let data = null;
        try {
          data = await res.json();
        } catch {
          data = null;
        }

        if (!res.ok) {
          setArtistImagesById(prev => ({
            ...prev,
            [artistId]: {
              status: "error",
              imageUrl: null,
            },
          }));
          return;
        }

        setArtistImagesById(prev => ({
          ...prev,
          [artistId]: {
            status: "loaded",
            imageUrl: typeof data?.imageUrl === "string" ? data.imageUrl : null,
          },
        }));
      } catch {
        setArtistImagesById(prev => ({
          ...prev,
          [artistId]: {
            status: "error",
            imageUrl: null,
          },
        }));
      } finally {
        artistImageInFlight.current.delete(artistId);
      }
    })();

    artistImageInFlight.current.set(artistId, request);
    return request;
  }, []);

  const ensureTrackArtists = useCallback(async trackId => {
    if (!trackId) return { ok: false, artists: [] };

    const existing = trackResolveInFlight.current.get(trackId);
    if (existing) return existing;

    const request = (async () => {
      try {
        const res = await fetch(`/api/tracks/${encodeURIComponent(trackId)}`);
        let data = null;
        try {
          data = await res.json();
        } catch {
          data = null;
        }

        if (!res.ok) {
          return { ok: false, artists: [] };
        }

        return {
          ok: true,
          artists: Array.isArray(data?.artists) ? data.artists : [],
        };
      } catch {
        return { ok: false, artists: [] };
      } finally {
        trackResolveInFlight.current.delete(trackId);
      }
    })();

    trackResolveInFlight.current.set(trackId, request);
    return request;
  }, []);

  const ensureArtistIdsForRow = useCallback(
    async row => {
      const trackId =
        typeof row?.track?.id === "string" && row.track.id ? row.track.id : null;
      const artistNames = Array.isArray(row?.artistNames) ? row.artistNames : [];
      if (!trackId || !artistNames.length) return;

      const unresolvedNames = artistNames.filter(name => {
        const key = normalizeArtistNameKey(name);
        return (
          key &&
          typeof resolvedArtistByNameRef.current?.[key]?.artistId !== "string"
        );
      });
      if (!unresolvedNames.length) return;

      const result = await ensureTrackArtists(trackId);
      if (!result?.ok) return;

      const artists = Array.isArray(result?.artists) ? result.artists : [];
      const toCache = {};
      for (const artist of artists) {
        const name = typeof artist?.name === "string" ? artist.name : null;
        const artistId = typeof artist?.id === "string" ? artist.id : null;
        const key = normalizeArtistNameKey(name);
        if (!key || !artistId) continue;
        toCache[key] = artistId;
      }
      if (!Object.keys(toCache).length) return;

      setResolvedArtistByName(prev => {
        const next = { ...prev };
        for (const [nameKey, artistId] of Object.entries(toCache)) {
          next[nameKey] = { status: "loaded", artistId };
        }
        return next;
      });
      mergeArtistIdByNameCache(userId, toCache);
    },
    [ensureTrackArtists, userId],
  );

  const rows = useMemo(() => {
    const list = uniqueTracks.map(({ key, track }) => {
      const globalRank = globalRankByKey?.get?.(key) ?? null;
      const artistNames = Array.isArray(track?.artists)
        ? track.artists.filter(Boolean)
        : [];
      const artistIds = Array.isArray(track?.artistIds)
        ? track.artistIds.filter(
            artistId => typeof artistId === "string" && artistId,
          )
        : [];
      const primaryArtistName =
        artistNames[0] ||
        "Unknown artist";
      const artistImageCandidateIds = Array.from(
        new Set(
          artistNames.flatMap((name, idx) => {
            const cachedId =
              resolvedArtistByName?.[normalizeArtistNameKey(name)]?.artistId ||
              null;
            const directId =
              Array.isArray(track?.artistIds) &&
              Array.isArray(track?.artists) &&
              track.artists.length === track.artistIds.length
                ? track.artistIds[idx] || null
                : artistIds[idx] || null;
            return [cachedId, directId].filter(
              artistId => typeof artistId === "string" && artistId,
            );
          }),
        ),
      );

      return {
        key,
        track,
        globalRank,
        artists: artistNames.join(", "),
        artistNames,
        primaryArtistName,
        artistImageCandidateIds,
      };
    });
    list.sort((a, b) => {
      const ar = Number(a.globalRank);
      const br = Number(b.globalRank);
      const aMissing = !Number.isFinite(ar) || ar <= 0;
      const bMissing = !Number.isFinite(br) || br <= 0;
      if (aMissing && bMissing) return 0;
      if (aMissing) return 1;
      if (bMissing) return -1;
      return ar - br;
    });
    return list;
  }, [resolvedArtistByName, uniqueTracks, globalRankByKey]);

  useEffect(() => {
    if (!userId || !rows.length) return;

    rows.forEach(row => {
      void ensureArtistIdsForRow(row);
    });
  }, [ensureArtistIdsForRow, rows, userId]);

  useEffect(() => {
    if (!userId || !rows.length) return;

    const artistIds = Array.from(
      new Set(
        rows
          .flatMap(row => row.artistImageCandidateIds || [])
          .filter(artistId => typeof artistId === "string" && artistId),
      ),
    );

    artistIds.forEach(artistId => {
      void ensureArtistImage(artistId);
    });
  }, [ensureArtistImage, rows, userId]);

  const getArtistImageUrl = useCallback(
    row =>
      (row?.artistImageCandidateIds || [])
        .map(artistId => artistImagesById?.[artistId]?.imageUrl)
        .find(value => typeof value === "string" && value) || null,
    [artistImagesById],
  );

  if (!uniqueTracks?.length) return <p className="meta">No tracks found.</p>;

  return (
    <div className="cardSub playlistTracksTableShell">
      <div
        className="playlistTracksCards"
        role="list"
        aria-label="Playlist tracks cards"
      >
        {rows.map((r, idx) => {
          const imageUrl = getArtistImageUrl(r);
          const globalRankNumber = Number(r.globalRank);
          const isRanked =
            Number.isFinite(globalRankNumber) && globalRankNumber > 0;
          return (
            <article
              key={r.key}
              className="playlistTrackCard"
              role="listitem"
            >
              <div className="playlistTrackCardTop">
                <div className="playlistTrackCardBadges">
                  <span className="playlistTrackCardBadge">
                    Playlist #{idx + 1}
                  </span>
                  <span
                    className={`playlistTrackCardBadge playlistTrackCardGlobalBadge ${
                      isRanked ? "isRanked" : "isUnranked"
                    }`.trim()}
                  >
                    {isRanked ? `Global #${globalRankNumber}` : "Unranked"}
                  </span>
                </div>
                {r.track?.id ? (
                  <button
                    className="btn small playlistTrackCardPlayBtn"
                    onClick={() => openTrackInSpotify(r.track.id)}
                    title="Play in Spotify"
                  >
                    Play
                  </button>
                ) : null}
              </div>

              <div className="playlistTrackCardSong">
                {r.track?.name || "(untitled track)"}
              </div>

              <div className="artistCell playlistTrackCardArtist">
                <div
                  className={`artistAvatar ${imageUrl ? "hasImage" : ""}`.trim()}
                  aria-hidden="true"
                >
                  {imageUrl ? (
                    <img
                      src={imageUrl}
                      alt=""
                      loading="lazy"
                    />
                  ) : (
                    <span>
                      {(r.primaryArtistName || "?").slice(0, 1).toUpperCase()}
                    </span>
                  )}
                </div>
                <div className="artistCellText">
                  <div className="cellSub">{r.artists || "Unknown artist"}</div>
                </div>
              </div>

              <div className="playlistTrackCardMetaBlock">
                <div className="playlistTrackCardMetaLabel">Album</div>
                <div className="playlistTrackCardMetaValue">
                  {r.track?.album || "Unknown album"}
                </div>
              </div>
            </article>
          );
        })}
      </div>

      <div
        className="tableWrap playlistTracksTableDesktop"
        role="region"
        aria-label="Tracks table"
        tabIndex={0}
      >
        <table className="table">
          <thead>
            <tr>
              <th
                className="center colRankTiny"
                aria-label="Playlist rank"
              />
              <th className="center colRankCompact">Global Rank</th>
              <th className="colSong">Song</th>
              <th className="colArtist">Artist</th>
              <th className="colAlbum">Album</th>
              <th className="center colActions">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => (
              <tr key={r.key}>
                <td className="center">
                  <div className="cellSub">{idx + 1}</div>
                </td>
                <td className="center">
                  <div className="cellSub globalRankValue">
                    {r.globalRank ? r.globalRank : "—"}
                  </div>
                </td>
                <td>
                  <div className="cellTitle">
                    {r.track?.name || "(untitled track)"}
                  </div>
                </td>
                <td>
                  {(() => {
                    const imageUrl = getArtistImageUrl(r);
                    return (
                  <div className="artistCell">
                    <div
                      className={`artistAvatar ${imageUrl ? "hasImage" : ""}`.trim()}
                      aria-hidden="true"
                    >
                      {imageUrl ? (
                        <img
                          src={imageUrl}
                          alt=""
                          loading="lazy"
                        />
                      ) : (
                        <span>
                          {(r.primaryArtistName || "?").slice(0, 1).toUpperCase()}
                        </span>
                      )}
                    </div>
                    <div className="artistCellText">
                      <div className="cellSub">{r.artists || "Unknown artist"}</div>
                    </div>
                  </div>
                    );
                  })()}
                </td>
                <td>
                  <div className="cellSub">
                    {r.track?.album || "Unknown album"}
                  </div>
                </td>
                <td className="center">
                  <span className="btnRow center">
                    {r.track?.id ? (
                      <button
                        className="btn small"
                        onClick={() => openTrackInSpotify(r.track.id)}
                        title="Play in Spotify"
                      >
                        Play
                      </button>
                    ) : null}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BinarySorter({
  uniqueTracks,
  trackIndex,
  ranking,
  onChange,
  activeKey,
  onActiveKeyChange,
}) {
  const [session, setSession] = useState(null);
  const lastActiveRef = useRef(null);

  const trackByKey = useMemo(() => {
    const map = new Map();
    for (const u of uniqueTracks) map.set(u.key, u.track);
    return map;
  }, [uniqueTracks]);

  const orderedKeys = useMemo(() => buildOrderedKeys(ranking), [ranking]);
  const visibleOrderedKeys = useMemo(
    () =>
      orderedKeys.filter(
        key => (trackIndex?.get?.(key) || trackByKey.get(key)) && key !== activeKey,
      ),
    [activeKey, orderedKeys, trackByKey, trackIndex],
  );
  const hiddenOrderedKeys = useMemo(
    () =>
      orderedKeys.filter(
        key => !(trackIndex?.get?.(key) || trackByKey.get(key)) && key !== activeKey,
      ),
    [activeKey, orderedKeys, trackByKey, trackIndex],
  );
  const baseOrder = useMemo(() => {
    if (!activeKey) return orderedKeys;
    return visibleOrderedKeys;
  }, [orderedKeys, activeKey, visibleOrderedKeys]);
  useEffect(() => {
    if (!activeKey || !ranking) {
      lastActiveRef.current = activeKey;
      setSession(null);
      return;
    }
    if (baseOrder.length === 0) {
      onChange?.(rk => (rk ? applyOrderToRanking(rk, [activeKey]) : rk));
      setSession(null);
      onActiveKeyChange?.(null);
      lastActiveRef.current = activeKey;
      return;
    }
    if (lastActiveRef.current !== activeKey) {
      setSession({ key: activeKey, low: 0, high: baseOrder.length });
      lastActiveRef.current = activeKey;
    }
  }, [
    activeKey,
    baseOrder.length,
    ranking,
    onActiveKeyChange,
    onChange,
  ]);

  const activeTrack =
    (activeKey && trackIndex?.get?.(activeKey)) ||
    (activeKey && trackByKey.get(activeKey)) ||
    null;
  const activeTrackId =
    (typeof activeTrack?.id === "string" && activeTrack.id) ||
    spotifyIdFromTrackKey(activeKey);

  const midIndex =
    session && baseOrder.length
      ? Math.floor((session.low + session.high) / 2)
      : null;
  const midKey = session && midIndex != null ? baseOrder[midIndex] : null;
  const midTrack =
    (midKey && trackIndex?.get?.(midKey)) ||
    (midKey && trackByKey.get(midKey)) ||
    null;
  const midTrackId =
    (typeof midTrack?.id === "string" && midTrack.id) ||
    spotifyIdFromTrackKey(midKey);

  function insertAt(position) {
    if (!ranking || !activeKey) return;
    const nextOrder = baseOrder.slice();
    nextOrder.splice(position, 0, activeKey);
    nextOrder.push(...hiddenOrderedKeys);
    onChange?.(rk => (rk ? applyOrderToRanking(rk, nextOrder) : rk));
    setSession(null);
    onActiveKeyChange?.(null);
  }

  function compare(better) {
    if (!session || midIndex == null) return;
    let nextLow = session.low;
    let nextHigh = session.high;
    if (better === "active") nextHigh = midIndex;
    else nextLow = midIndex + 1;
    if (nextLow >= nextHigh) {
      insertAt(nextLow);
      return;
    }
    setSession({ ...session, low: nextLow, high: nextHigh });
  }

  function skip() {
    if (session) setSession(null);
    onActiveKeyChange?.(null);
  }

  function excludeActive() {
    if (!activeKey) return;
    onChange?.(rk => (rk ? excludeTrack(rk, activeKey) : rk));
    setSession(null);
    onActiveKeyChange?.(null);
  }

  return (
    <div className="cardSub binarySorterCard">
      <p className="meta binarySorterStatus">
        {session && midIndex != null
          ? `Comparing against rank ${midIndex + 1} of ${baseOrder.length}.`
          : activeKey
            ? " Ready to compare."
            : " Pick a song from the left to start."}
      </p>

      {!ranking ? (
        <p className="meta">Loading ranking…</p>
      ) : session && activeKey && midKey ? (
        <>
          <div className="duelGrid">
            <div className="duelCard duelCardLeft">
              <div className="duelTitle">
                {getTrackDisplayName(activeTrack, activeKey)}
              </div>
              {Array.isArray(activeTrack?.artists) &&
              activeTrack.artists.length ? (
                <div className="duelMeta">{activeTrack.artists.join(", ")}</div>
              ) : null}
              {activeTrack?.album ? (
                <div className="duelStats">
                  <span className="cellSub">{activeTrack.album}</span>
                </div>
              ) : null}
              <div className="duelActions">
                <button
                  className="btn primary duelPrimaryBtn"
                  onClick={() => compare("active")}
                >
                  Better
                </button>
                {activeTrackId ? (
                  <button
                    className="btn duelSecondaryBtn"
                    onClick={() => openTrackInSpotify(activeTrackId)}
                    title="Play in Spotify"
                  >
                    Play
                  </button>
                ) : null}
              </div>
              <div className="duelActionsFooter">
                <button
                  className="btn"
                  onClick={skip}
                  title="Pick a different pending song"
                >
                  Skip
                </button>
                <button
                  className="btn danger"
                  onClick={excludeActive}
                  title="Exclude this song from ranking"
                >
                  Do not rate
                </button>
              </div>
            </div>

            <div className="duelVs">vs</div>

            <div className="duelCard">
              <div className="duelTitle">
                {getTrackDisplayName(midTrack, midKey)}
              </div>
              {Array.isArray(midTrack?.artists) && midTrack.artists.length ? (
                <div className="duelMeta">{midTrack.artists.join(", ")}</div>
              ) : null}
              {midTrack?.album ? (
                <div className="duelStats">
                  <span className="cellSub">{midTrack.album}</span>
                </div>
              ) : null}
              <div className="duelActions">
                <button
                  className="btn primary duelPrimaryBtn"
                  onClick={() => compare("mid")}
                >
                  Better
                </button>
                {midTrackId ? (
                  <button
                    className="btn duelSecondaryBtn"
                    onClick={() => openTrackInSpotify(midTrackId)}
                    title="Play in Spotify"
                  >
                    Play
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </>
      ) : activeKey ? (
        <p className="meta">Pick a comparison to continue.</p>
      ) : null}
    </div>
  );
}

export default App;
