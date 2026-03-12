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
  formatAge,
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
  recordDuel,
  resetTrackState,
  setTrackBucket,
  songIdentityOfTrack,
  trackKeyOfTrack,
  undoLast,
  mergeUserRankings,
  writeUserRanking,
} from "./lib/userRankingStore";
import { pickMatchup } from "./lib/matchup";
import { readPlaylistRanking as readLegacyPlaylistRanking } from "./lib/playlistRankingStore";
import { computeTopArtistsFromTracks } from "./lib/dashboardSelectors";
import {
  mergeArtistIdByNameCache,
  readArtistIdByNameCache,
} from "./lib/spotifyArtistIdCache";
import { readGlobalSongs, upsertGlobalSongs } from "./lib/globalSongsStore";

function normalizedRankValue(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function formatFutureRelativeAge(targetMs, nowMs) {
  if (!Number.isFinite(targetMs)) return "not scheduled";
  const remainingMs = targetMs - nowMs;
  if (remainingMs <= 15_000) return "soon";
  return `in ${formatAge(remainingMs)}`;
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

function albumIdentityKey(name, artistLabel) {
  const normalizedName = normalizeLooseString(name).toLowerCase();
  const normalizedArtist = normalizeLooseString(artistLabel).toLowerCase();
  if (!normalizedName) return "";
  return `${normalizedName}::${normalizedArtist}`;
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

function finalizeAlbumRow(album) {
  const ratedTracks = dedupeAlbumTrackList(album?.ratedTracks).sort(
    (left, right) => left.rank - right.rank,
  );
  const unratedTracks = dedupeAlbumTrackList(album?.unratedTracks).sort(
    (left, right) =>
      (left.name || "").localeCompare(right.name || "", "en", {
        numeric: true,
      }),
  );
  const doNotRateTracks = dedupeAlbumTrackList(album?.doNotRateTracks).sort(
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

function normalizeTrackName(name, id = null) {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (id && trimmed === id) return null;
  return trimmed;
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
    if (!isRankedState(state)) continue;
    rows.push({ key, rating: Number(state.rating) || 0 });
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

function App() {
  const [loading, setLoading] = useState(true);
  const [loggedIn, setLoggedIn] = useState(false);
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState(null);
  const [isOwnerUser, setIsOwnerUser] = useState(false);
  const [routePath, setRoutePath] = useState(
    () => window.location.pathname || "/",
  );
  const [publicPreview, setPublicPreview] = useState({
    status: "idle",
    data: null,
    error: null,
  });

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
  const importInputRef = useRef(null);
  const dataMenuRef = useRef(null);
  const [dashboardImportError, setDashboardImportError] = useState(null);
  const [dataImportDragActive, setDataImportDragActive] = useState(false);
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
  const isPublicDashboardRoute = !loggedIn && routePath === "/";
  const isDashboardLikeRoute = isDashboardRoute || isPublicDashboardRoute;

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

        if (session?.user && typeof session.user === "object") {
          setProfile(session.user);
          return;
        }

        const meRes = await fetch("/api/me");
        if (meRes.ok) {
          const me = await meRes.json();
          setProfile(me);
        }
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
    if (loggedIn) return;
    let cancelled = false;

    setPublicPreview(s =>
      s.status === "ok" ? s : { status: "loading", data: null, error: null },
    );
    (async () => {
      try {
        const res = await fetch("/api/public/preview");
        const data = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok || !data?.ok) {
          setPublicPreview({
            status: "error",
            data: null,
            error: data?.error || "Preview unavailable",
          });
          return;
        }
        setPublicPreview({ status: "ok", data, error: null });
      } catch (e) {
        if (cancelled) return;
        setPublicPreview({
          status: "error",
          data: null,
          error: e?.message || "Preview unavailable",
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loggedIn]);

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
      const res = await fetch("/api/me/playlists?all=1");

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
      const res = await fetch(
        `/api/playlists/${encodeURIComponent(playlistId)}/tracks?all=1`,
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
    const playlist =
      playlistsCache?.items?.find(p => p?.id === selectedPlaylistId) || null;
    const ownedByUser = playlist?.owner?.id && playlist.owner.id === userId;

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

    if (!ownedByUser) {
      setTracksError(
        "Spotify may forbid reading items for playlists you do not own (even if they appear in your list).",
      );
      return;
    }

    refreshPlaylistTracks({ playlistId: selectedPlaylistId, force: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loggedIn, profile?.id, selectedPlaylistId, playlistsCache]);

  async function logout() {
    await fetch("/auth/logout", { method: "POST" });
    window.location.href = "/";
  }

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
    if (dataMenuRef.current) dataMenuRef.current.open = false;
  }, [dataMenuRef, profile, routePath, selectedPlaylistId, userRanking]);

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
        if (dataMenuRef.current) dataMenuRef.current.open = false;
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
      if (dataMenuRef.current) dataMenuRef.current.open = false;
    },
    [dataMenuRef, profile?.id, selectedPlaylistId],
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

  return (
    <div className="appShell">
      <header className="topBar">
        <div className="topBarInner">
          <div className="topBarLeft">
            <div className="brand">
              <div className="brandTitle">Spotify Rating App</div>
              <div className="brandSub">
                {loggedIn ? (
                  <>
                    {profile?.display_name
                      ? `Signed in as ${profile.display_name}.`
                      : "Signed in."}
                  </>
                ) : (
                    "Rank your songs with binary sort and quick reordering."
                )}
              </div>
            </div>
            {loggedIn ? (
              <div className="headerUtilityActions">
                <details
                  ref={dataMenuRef}
                  className="headerDataMenu"
                >
                  <summary className="btn small">Export / Import</summary>
                  <div className="headerDataMenuPanel">
                    <div className="headerDataMenuTitle">Data backup</div>
                    <button
                      className="btn small"
                      onClick={exportDashboardJson}
                    >
                      Export Data
                    </button>
                    <label
                      className={`headerDataDropzone ${dataImportDragActive ? "active" : ""}`.trim()}
                      onDragEnter={onDataImportDragOver}
                      onDragOver={onDataImportDragOver}
                      onDragLeave={onDataImportDragLeave}
                      onDrop={onDataImportDrop}
                    >
                      <span className="headerDataDropzoneTitle">
                        Import Backup
                      </span>
                      <span className="headerDataDropzoneMeta">
                        Drag and drop a JSON backup here or click to browse.
                      </span>
                      <span className="headerDataDropzoneHint">Choose file</span>
                      <input
                        ref={importInputRef}
                        type="file"
                        accept="application/json"
                        onChange={onPickDashboardImportFile}
                        className="headerDataFileInput"
                      />
                    </label>
                  </div>
                </details>
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
                <button
                  className="btn danger"
                  onClick={logout}
                >
                  Log out
                </button>
              </>
            ) : null}
          </div>
        </div>
      </header>

      <main
        className={
          isDashboardLikeRoute
            ? "main mainDashboard"
            : isRankRoute
              ? "main mainRank"
              : "main"
        }
      >
        <div className="container">
          <div className={isDashboardLikeRoute ? "card cardDashboard" : "card"}>
            {error ? <p className="error">{error}</p> : null}

            {!loggedIn ? (
              <LandingPage publicPreview={publicPreview} />
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
                      if (!trackKey) return;
                      if (options?.restoreExcluded) {
                        setUserRanking(rk =>
                          rk ? setTrackBucket(rk, trackKey, "U") : rk,
                        );
                      }
                      setRankTrackRequest({
                        trackKey,
                        mode: "binary",
                        nonce: Date.now(),
                      });
                      navigate("/rank", { replace: true });
                    }}
                  />
                ) : selectedPlaylistId ? (
                  <PlaylistView
                    playlistsCache={playlistsCache}
                    playlistId={selectedPlaylistId}
                    ranking={userRanking}
                    cooldownUntilMs={cooldownUntilMs}
                    nowMs={nowMs}
                    tracksLoading={tracksLoading}
                    tracksError={tracksError}
                    tracksCache={tracksCache}
                    tracksSource={tracksSource}
                    onObservedTracks={tracks =>
                      setUserRanking(rk => reconcileRankingTrackKeys(rk, tracks))
                    }
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
                    nowMs={nowMs}
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

function DashboardPage({
  userId,
  ranking,
  localDataRevision,
  playlistsCache,
  onOverwriteRanking,
  onStartRankingTrack,
}) {
  const [artistCardsRootEl, setArtistCardsRootEl] = useState(null);
  const [expandedAlbumKey, setExpandedAlbumKey] = useState(null);
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
        upsertGlobalSongs(userId, cached.items);
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
          upsertGlobalSongs(userId, nextRecord.items);
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

  const computed = useMemo(() => {
    if (!ranking) return null;

    const orderedKeys = buildOrderedKeys(ranking);
    const rankByKey = new Map();
    orderedKeys.forEach((key, idx) => rankByKey.set(key, idx + 1));

    const rows = orderedKeys
      .filter(trackKey => !trackKey.startsWith("meta:"))
      .map(trackKey => {
        const meta = trackIndex.get(trackKey) || null;
        return {
          trackKey,
          id:
            meta?.id ||
            (trackKey.startsWith("spid:")
              ? trackKey.slice("spid:".length)
              : null),
          name: meta?.name || null,
          artists: meta?.artists || [],
          artistsDetailed: meta?.artistsDetailed || [],
          album: meta?.album || null,
          rank: rankByKey.get(trackKey) || null,
        };
      })
      .filter(r => Number.isFinite(Number(r.rank)));

    const hasAnyRatings = rows.length > 0;

    const albumAgg = new Map();

    for (const track of canonicalGlobalTracks) {
      const state = getTrackState(ranking, track.trackKey);
      const rank = rankByKey.get(track.trackKey) || null;
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
        } else if (Number.isFinite(Number(rank)) && isRankedState(state)) {
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
            const rank = rankByKey.get(trackKey) || null;
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
            } else if (
              Number.isFinite(Number(rank)) &&
              isRankedState(state)
            ) {
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

    const albumsByIdentityWithId = new Map();
    for (const album of rawTopAlbums) {
      if (!album.albumId) continue;
      const identity = albumIdentityKey(album.name, album.artistLabel);
      if (identity) albumsByIdentityWithId.set(identity, album.key);
    }

    const mergedTopAlbums = new Map();
    for (const album of rawTopAlbums) {
      const identity = albumIdentityKey(album.name, album.artistLabel);
      const canonicalKey =
        !album.albumId && identity && albumsByIdentityWithId.has(identity)
          ? albumsByIdentityWithId.get(identity)
          : identity && !album.albumId
            ? `meta:${identity}`
            : album.key;
      const existing = mergedTopAlbums.get(canonicalKey) || null;
      mergedTopAlbums.set(
        canonicalKey,
        existing ? mergeAlbumRows(existing, album) : { ...album, key: canonicalKey },
      );
    }

    const topAlbums = Array.from(mergedTopAlbums.values())
      .sort(
        (a, b) =>
          b.completion - a.completion ||
          b.ratedCount - a.ratedCount ||
          (Number.isFinite(a.avgRank) ? a.avgRank : Number.POSITIVE_INFINITY) -
            (Number.isFinite(b.avgRank)
              ? b.avgRank
              : Number.POSITIVE_INFINITY) ||
          b.totalTracks - a.totalTracks ||
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

  const topAlbumRanks = useMemo(
    () =>
      Array.isArray(computed?.topAlbums)
        ? getTiedRanks(computed.topAlbums, a => a.avgRank)
        : [],
    [computed?.topAlbums],
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

  return (
    <div className="section dashboardPage">
      <div
        className="dashboardColumns"
        role="region"
        aria-label="Dashboard columns"
      >
        <div className="dashPanel">
          <div className="dashPanelHeader">
            <h3>Top songs ({computed.topSongs.length})</h3>
          </div>
          <div
            className="dashPanelBody dashPanelBodyTight"
            role="region"
            aria-label="Top songs list"
            tabIndex={0}
          >
            <table className="dashTable">
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

        <div className="dashPanel dashPanelArtists">
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
                  (typeof resolvedArtistByName?.[artistKey]?.artistId ===
                  "string"
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

        <div className="dashPanel">
          <div className="dashPanelHeader">
            <h3>Album progress ({computed.topAlbums.length})</h3>
          </div>
          <div
            className="dashPanelBody dashPanelBodyTight"
            role="region"
            aria-label="Album progress list"
            tabIndex={0}
          >
            <table className="dashTable">
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
                  const nextTrackToRate = a.unratedTracks[0]?.trackKey || null;
                  const hasPendingAlbumTracks =
                    a.unratedCount > 0 || a.doNotRateCount > 0;
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
                            {topAlbumRanks[idx] ?? idx + 1}
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
                            <div className="albumExpandHeader">
                              <div className="albumPromptGroup">
                                {a.unratedCount > 0 ? (
                                  <p className="meta albumPrompt">
                                    {a.unratedCount} song
                                    {a.unratedCount === 1 ? "" : "s"} still need
                                    ranking. Finish this album from here.
                                  </p>
                                ) : a.doNotRateCount > 0 ? (
                                  <p className="meta albumPrompt">
                                    {a.doNotRateCount} song
                                    {a.doNotRateCount === 1 ? "" : "s"} marked
                                    Do not rate for this album.
                                  </p>
                                ) : (
                                  <p className="meta albumPrompt">
                                    All songs from this album are rated.
                                  </p>
                                )}
                                {!a.albumTracksLoaded &&
                                a.totalTracks >
                                  a.ratedTracks.length +
                                    a.unratedTracks.length +
                                    a.doNotRateTracks.length ? (
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
                                {a.albumId ? (
                                  <button
                                    className="btn small"
                                    onClick={() =>
                                      openAlbumInSpotify(a.albumId)
                                    }
                                  >
                                    Open album
                                  </button>
                                ) : null}
                                {nextTrackToRate ? (
                                  <button
                                    className="btn small"
                                    onClick={() =>
                                      onStartRankingTrack?.(nextTrackToRate)
                                    }
                                  >
                                    Rate next song
                                  </button>
                                ) : null}
                              </span>
                            </div>
                            <div
                              className={`albumExpandGrid ${hasPendingAlbumTracks ? "" : "albumExpandGridSingle"}`.trim()}
                            >
                              <div className="albumSection">
                                <div className="albumSectionTitle">
                                  Rated ({a.ratedCount})
                                </div>
                                {a.ratedTracks.length ? (
                                  <ul className="albumTrackList">
                                    {a.ratedTracks.map(track => {
                                      const trackId =
                                        (typeof track?.id === "string"
                                          ? track.id
                                          : null) ||
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
                                                onClick={() =>
                                                  openTrackInSpotify(trackId)
                                                }
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
                                    Unrated ({a.unratedCount})
                                  </div>
                                  {a.unratedTracks.length ? (
                                    <ul className="albumTrackList">
                                      {a.unratedTracks.map(track => (
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
                                                onStartRankingTrack?.(
                                                  track.trackKey,
                                                )
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
                                      Nothing left to rate.
                                    </p>
                                  )}
                                  {a.doNotRateCount > 0 ? (
                                    <Fragment>
                                      <div className="albumSectionDivider" />
                                      <div className="albumSectionSubTitle">
                                        DO NOT RATE ({a.doNotRateCount})
                                      </div>
                                      {a.doNotRateTracks.length ? (
                                        <ul className="albumTrackList">
                                          {a.doNotRateTracks.map(track => (
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
                                                    onStartRankingTrack?.(
                                                      track.trackKey,
                                                      {
                                                        restoreExcluded: true,
                                                      },
                                                    )
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
      </div>
    </div>
  );
}

function LandingPage({ publicPreview }) {
  const [artistCardsRootEl, setArtistCardsRootEl] = useState(null);
  const data = publicPreview?.data;
  const topSongs = Array.isArray(data?.topSongs) ? data.topSongs : [];
  const topArtists = Array.isArray(data?.topArtists) ? data.topArtists : [];
  const topAlbums = Array.isArray(data?.topAlbums) ? data.topAlbums : [];
  const topSongRanks = useMemo(
    () =>
      topSongs.map((t, idx) => {
        const rank = Number(t?.rank);
        return Number.isFinite(rank) ? rank : idx + 1;
      }),
    [topSongs],
  );
  const topAlbumRanks = useMemo(
    () =>
      topAlbums.map((a, idx) => {
        const rank = Number(a?.rank);
        if (Number.isFinite(rank)) return rank;
        const avgRank = Number(a?.avgRank);
        return Number.isFinite(avgRank) ? Math.round(avgRank) : idx + 1;
      }),
    [topAlbums],
  );

  return (
    <div className="section dashboardPage">
      <div className="cardSub">
        <h3>Rate your music with binary sort</h3>
        <p className="meta">
          Build an initial global order with binary insertion, then make quick
          one-step adjustments from the ranked list. Rankings are stored
          locally, and the owner account also gets a server backup.
        </p>
        <div className="controls">
          <a
            className="btn primary"
            href="/auth/login"
          >
            Sign in with Spotify
          </a>
        </div>
        <p className="meta">
          Preview dashboard (read-only).{" "}
          {publicPreview?.status === "loading"
            ? "Loading…"
            : publicPreview?.status === "error"
              ? publicPreview.error || "Preview unavailable."
              : publicPreview?.status === "ok"
                ? `Updated ${
                    data?.updatedAt
                      ? formatDateTime(data.updatedAt)
                      : data?.rankingUpdatedAt
                        ? formatDateTime(data.rankingUpdatedAt)
                        : "recently"
                  }.`
                : ""}
        </p>
      </div>

      {publicPreview?.status === "ok" ? (
        <div
          className="dashboardColumns"
          role="region"
          aria-label="Dashboard columns"
        >
          <div className="dashPanel">
            <div className="dashPanelHeader">
              <h3>Top songs ({topSongs.length})</h3>
            </div>
            <div
              className="dashPanelBody dashPanelBodyTight"
              role="region"
              aria-label="Top songs list"
              tabIndex={0}
            >
              <table className="dashTable">
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
                  {topSongs.map((t, idx) => {
                    const trackId =
                      (typeof t?.id === "string" ? t.id : null) ||
                      (typeof t?.trackKey === "string" &&
                      t.trackKey.startsWith("spid:")
                        ? t.trackKey.slice("spid:".length)
                        : null);
                    return (
                      <tr
                        key={t.trackKey || t.id || idx}
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
                            {Array.isArray(t.artists) && t.artists.length
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

          <div className="dashPanel dashPanelArtists">
            <div className="dashPanelHeader">
              <h3>Top artists ({topArtists.length})</h3>
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
                {topArtists.map(a => {
                  const artistId =
                    typeof a?.artistId === "string" ? a.artistId : null;
                  const imageUrl =
                    typeof a?.imageUrl === "string" ? a.imageUrl : null;
                  const imageState = imageUrl
                    ? { status: "loaded", imageUrl }
                    : null;
                  return (
                    <TopArtistCard
                      key={a.name}
                      artist={a}
                      artistId={artistId}
                      rootEl={artistCardsRootEl}
                      imageState={imageState}
                      onVisible={null}
                    />
                  );
                })}
              </div>
            </div>
          </div>

          <div className="dashPanel">
            <div className="dashPanelHeader">
              <h3>Top albums ({topAlbums.length})</h3>
            </div>
            <div
              className="dashPanelBody dashPanelBodyTight"
              role="region"
              aria-label="Top albums list"
              tabIndex={0}
            >
              <table className="dashTable">
                <colgroup>
                  <col className="dashColIndex" />
                  <col />
                  <col className="dashColPlay" />
                </colgroup>
                <thead>
                  <tr>
                    <th className="right dashColIndex">#</th>
                    <th>Album</th>
                    <th
                      className="right dashColPlay"
                      aria-label="Play column"
                    />
                  </tr>
                </thead>
                <tbody>
                  {topAlbums.map((a, idx) => (
                    <tr
                      key={a.name || idx}
                      className="dashTableRow"
                    >
                      <td className="right">
                        <span className="cellSub">
                          {topAlbumRanks[idx] ?? idx + 1}
                        </span>
                      </td>
                      <td>
                        <div className="cellTitle">{a.name}</div>
                        <div className="cellSub">
                          {Number(a.tracks) === 1
                            ? "1 track"
                            : `${Number(a.tracks) || 0} tracks`}
                        </div>
                      </td>
                      <td className="right">
                        {typeof a?.bestTrackId === "string" ? (
                          <button
                            className="btn small rowPlayBtn"
                            onClick={() => openTrackInSpotify(a.bestTrackId)}
                            title="Open a track from this album in Spotify"
                          >
                            Play
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}
    </div>
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
    const canonicalKey =
      canonicalKeyByObservedKey.get(trackRequest.trackKey) || trackRequest.trackKey;
    if (!trackByKey.has(canonicalKey)) return;
    setActiveKey(canonicalKey);
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
      const key = trackKeyOfTrack(t);
      if (!map.has(key)) {
        const artists = Array.isArray(t?.artists)
          ? t.artists.filter(Boolean)
          : [];
        map.set(key, {
          id: typeof t?.id === "string" ? t.id : null,
          name: typeof t?.name === "string" ? t.name : null,
          artists,
          album: typeof t?.album === "string" ? t.album : null,
        });
      }
    }
    return map;
  }, [globalSongs]);

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
        const track = trackByKey.get(key) || null;
        if (!track) return null;
        return {
          key,
          track,
          state: getTrackState(ranking, key),
          artists: Array.isArray(track?.artists)
            ? track.artists.join(", ")
            : "",
        };
      })
      .filter(Boolean);
  }, [orderedKeys, ranking, trackByKey]);

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
        <div
          className="dashboardColumns rankSongsColumns"
          role="region"
          aria-label="Rank songs columns"
        >
          <div className="dashPanel">
            <div className="dashPanelHeader">
              <div className="dashPanelHeaderRow">
                <h3>Unranked ({unrankedRows.length})</h3>
                <input
                  className="textInput"
                  value={unrankedQuery}
                  onChange={e => setUnrankedQuery(e.target.value)}
                  placeholder="Search unranked…"
                  aria-label="Search unranked songs"
                />
              </div>
            </div>
            <div
              className="dashPanelBody dashPanelBodyTight rankSongsScroll"
              role="region"
              aria-label="Unranked songs list"
              tabIndex={0}
            >
              <div className="rankSongsListStack">
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
                    {filteredUnrankedRows.map(r => (
                      <tr
                        key={r.key}
                        className="dashTableRow"
                      >
                        <td className="rankSongsCellWithCornerAction">
                          <div className="rankSongsCellTitle rankSongsCellTitleWithCornerAction">
                            <button
                              className="rankSongsExcludeBtn"
                              onClick={() => moveTrackToExcluded(r.key)}
                              title="Move to Do not rate"
                              aria-label={`Move ${r.track?.name || r.key} to Do not rate`}
                            >
                              ×
                            </button>
                            <div className="rankSongsCellText">
                              <div className="cellTitle">
                                {r.track?.name || r.key}
                              </div>
                              <div className="cellSub">
                                {r.artists || "Unknown artist"}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="right">
                          <span className="btnRow">
                            <button
                              className="btn"
                              onClick={() => setActiveKey(r.key)}
                              disabled={activeKey === r.key}
                              title="Rank this song"
                            >
                              Rank
                            </button>
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

                <div className="rankSongsExcludedPanel">
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
                                  {r.track?.name || r.key}
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

          <div className="dashPanel">
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

          <div className="dashPanel">
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
              <table className="dashTable">
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
                                aria-label={`Play ${r.track?.name || r.key}`}
                              >
                                Play
                              </button>
                            ) : null}
                          </span>
                        </td>
                        <td>
                          <div className="cellTitle">
                            {r.track?.name || r.key}
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
                              aria-label={`Move ${r.track?.name || r.key} up one position`}
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
                              aria-label={`Move ${r.track?.name || r.key} down one position`}
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
  nowMs,
  onObservedTracks,
  onUpdatePlaylistsCache,
  onSelect,
}) {
  const userId = profile?.id ?? null;
  const [ingestStateById, setIngestStateById] = useState({});
  const [cooldownNowMs, setCooldownNowMs] = useState(() => Date.now());
  const [playlistQuery, setPlaylistQuery] = useState("");

  useEffect(() => {
    const id = setInterval(() => setCooldownNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  function updateIngestState(playlistId, patch) {
    setIngestStateById(prev => ({
      ...prev,
      [playlistId]: { ...(prev?.[playlistId] ?? {}), ...patch },
    }));
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
  const spotifyFetchedLabel = spotifyFetchedAt
    ? formatDateTime(spotifyFetchedAt)
    : "unknown";
  const spotifyFetchedAgeLabel = spotifyFetchedAt
    ? formatAge(nowMs - Date.parse(spotifyFetchedAt))
    : "unknown";
  const spotifyFetchedAgeText =
    spotifyFetchedAgeLabel === "unknown"
      ? "time unknown"
      : `${spotifyFetchedAgeLabel} ago`;
  const nextPlaylistsRefreshLabel = Number.isFinite(nextPlaylistsRefreshAt)
    ? formatDateTime(nextPlaylistsRefreshAt)
    : "not scheduled";

  async function ingestPlaylist(playlistId) {
    if (!userId || !playlistId) return;
    const cooldownUntilMs = Date.now() + 10_000;
    updateIngestState(playlistId, {
      status: "fetching",
      cooldownUntilMs,
      error: null,
    });

    try {
      const res = await fetch(
        `/api/playlists/${encodeURIComponent(playlistId)}/tracks?all=1`,
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
      upsertGlobalSongs(userId, tracks);
      onObservedTracks?.(tracks);

      const ingestedAt = new Date().toISOString();
      const updated = setPlaylistIngestedAt(userId, playlistId, ingestedAt);
      if (updated) onUpdatePlaylistsCache?.(updated);

      updateIngestState(playlistId, { status: "idle", error: null });
    } catch (err) {
      updateIngestState(playlistId, {
        status: "idle",
        error: err?.message || "Ingestion failed",
      });
    }
  }
  return (
    <div className="section">
      <h2>Your playlists</h2>

      {playlistsError ? <p className="error">{playlistsError}</p> : null}

      {playlistsCache ? (
        <p className="meta">
          Last retrieved from Spotify{" "}
          <strong>{spotifyFetchedLabel}</strong> ({spotifyFetchedAgeText}).
          Next fetch scheduled for <strong>{nextPlaylistsRefreshLabel}</strong>{" "}
          ({formatFutureRelativeAge(nextPlaylistsRefreshAt, nowMs)}).{" "}
          {playlistsCache.isComplete
            ? `All ${playlistsCache.total} playlist(s) cached.`
            : `Showing ${playlistsCache.items.length} of ${playlistsCache.total} (partial).`}
        </p>
      ) : playlistsLoading ? (
        <p className="meta">Fetching playlists…</p>
      ) : (
        <p className="meta">No playlist cache yet.</p>
      )}

      {playlistsCache?.items?.length ? (
        <Fragment>
          <div className="controls">
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
              const hasTracksCache = Boolean(tracksMeta?.fetchedAt);
              const snapshotMismatch =
                hasTracksCache &&
                typeof p.snapshotId === "string" &&
                typeof tracksMeta?.snapshotId === "string" &&
                p.snapshotId !== tracksMeta.snapshotId;
              const ownedByUser =
                userId && p.owner?.id && p.owner.id === userId;
              const ingestState = p.id ? ingestStateById?.[p.id] : null;
              const cooldownUntilMs =
                typeof ingestState?.cooldownUntilMs === "number"
                  ? ingestState.cooldownUntilMs
                  : null;
              const cooldownRemaining =
                cooldownUntilMs && cooldownUntilMs > cooldownNowMs
                  ? Math.ceil((cooldownUntilMs - cooldownNowMs) / 1000)
                  : 0;
              const isCooling = cooldownRemaining > 0;
              const isFetching = ingestState?.status === "fetching";
              const ingestedAt =
                typeof p?.ingestedAt === "string" ? p.ingestedAt : null;
              const actionLabel = isFetching
                ? "Fetching..."
                : isCooling
                  ? `Cooling down (${cooldownRemaining}s)`
                  : ingestedAt
                    ? "Refresh Playlist"
                    : "Add to Rankings";
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

                  <div className="playlistCardBody">
                    <div className="playlistCardTitleRow">
                      <button
                        className="playlistCardTitle"
                        onClick={() => onSelect(p.id)}
                        disabled={!p.id}
                      >
                        {p.name || "(untitled playlist)"}
                      </button>
                      {p.externalUrl ? (
                        <a
                          className="subLink"
                          href={p.externalUrl}
                          target="_blank"
                          rel="noreferrer"
                          title="Open in Spotify"
                        >
                          open
                        </a>
                      ) : null}
                    </div>

                    <div className="playlistCardMeta">
                      {p.owner?.display_name || "Unknown"}
                      {ownedByUser ? " · owned by you" : ""}
                      {typeof p.public === "boolean"
                        ? ` · ${p.public ? "public" : "private"}`
                        : ""}
                    </div>

                    <div className="playlistCardStatus">
                      {ingestedAt ? `Added ${formatDateTime(ingestedAt)}` : "Not added"}
                    </div>
                    <div className="playlistCardCache">
                      {hasTracksCache
                        ? `Tracks cached ${formatAge(
                            nowMs - Date.parse(tracksMeta.fetchedAt),
                          )} ago${snapshotMismatch ? " (playlist changed)" : ""}`
                        : "Tracks not cached"}
                    </div>

                    <div className="playlistCardActions">
                      <button
                        className="btn"
                        onClick={() => p.id && ingestPlaylist(p.id)}
                        disabled={!p.id || isFetching || isCooling}
                      >
                        {actionLabel}
                      </button>
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
    </div>
  );
}

function PlaylistView({
  playlistsCache,
  playlistId,
  ranking,
  nowMs,
  tracksLoading,
  tracksError,
  tracksCache,
  tracksSource,
  onBack,
}) {
  const playlist =
    playlistsCache?.items?.find(p => p?.id === playlistId) || null;
  const playlistSnapshotId =
    typeof playlist?.snapshotId === "string" ? playlist.snapshotId : null;
  const cachedSnapshotId =
    typeof tracksCache?.snapshotId === "string" ? tracksCache.snapshotId : null;
  const snapshotMismatch =
    playlistSnapshotId &&
    cachedSnapshotId &&
    playlistSnapshotId !== cachedSnapshotId;

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

      <h2>{playlist?.name || "Playlist"}</h2>

      {tracksError ? <p className="error">{tracksError}</p> : null}

      {tracksCache ? (
        <p className="meta">
          Loaded from{" "}
          <strong>{tracksSource === "cache" ? "cache" : "Spotify API"}</strong>.
          Cached at {formatDateTime(tracksCache.fetchedAt)} (
          {formatAge(nowMs - Date.parse(tracksCache.fetchedAt))} ago).{" "}
          {tracksCache.isComplete
            ? `All ${tracksCache.total} track(s) cached.`
            : `Showing ${tracksCache.items.length} of ${tracksCache.total} (partial).`}{" "}
          {tracksCache.latestAddedAt
            ? `Newest added: ${formatDateTime(tracksCache.latestAddedAt)}.`
            : ""}
          {snapshotMismatch
            ? " Playlist has changed since this cache (snapshot mismatch)."
            : ""}
        </p>
      ) : tracksLoading ? (
        <p className="meta">Fetching tracks…</p>
      ) : (
        <p className="meta">No track cache for this playlist yet.</p>
      )}

      <PlaylistTracksTable
        uniqueTracks={uniqueTracks}
        globalRankByKey={globalRankByKey}
      />
    </div>
  );
}

function TracksTable({ uniqueTracks }) {
  const rows = useMemo(() => {
    return uniqueTracks.map(({ key, track }) => ({
      key,
      track,
      artists: Array.isArray(track?.artists) ? track.artists.join(", ") : "",
    }));
  }, [uniqueTracks]);

  if (!uniqueTracks?.length) return <p className="meta">No tracks found.</p>;

  return (
    <div className="cardSub">
      <div
        className="tableWrap"
        role="region"
        aria-label="Tracks table"
        tabIndex={0}
      >
        <table className="table">
          <thead>
            <tr>
              <th className="colSong">Song</th>
              <th className="colArtist">Artist</th>
              <th className="colAlbum">Album</th>
              <th className="right colActions">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.key}>
                <td>
                  <div className="cellTitle">
                    {r.track?.name || "(untitled track)"}
                  </div>
                </td>
                <td>
                  <div className="cellSub">{r.artists || "Unknown artist"}</div>
                </td>
                <td>
                  <div className="cellSub">
                    {r.track?.album || "Unknown album"}
                  </div>
                </td>
                <td className="right">
                  <span className="btnRow">
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

function PlaylistTracksTable({ uniqueTracks, globalRankByKey }) {
  const rows = useMemo(() => {
    const list = uniqueTracks.map(({ key, track }) => {
      const globalRank = globalRankByKey?.get?.(key) ?? null;
      return {
        key,
        track,
        globalRank,
        artists: Array.isArray(track?.artists) ? track.artists.join(", ") : "",
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
  }, [uniqueTracks, globalRankByKey]);

  if (!uniqueTracks?.length) return <p className="meta">No tracks found.</p>;

  return (
    <div className="cardSub">
      <div
        className="tableWrap"
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
                  <div className="cellSub">{r.artists || "Unknown artist"}</div>
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
  const baseOrder = useMemo(() => {
    if (!activeKey) return orderedKeys;
    return orderedKeys.filter(k => k !== activeKey);
  }, [orderedKeys, activeKey]);
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

  const midIndex =
    session && baseOrder.length
      ? Math.floor((session.low + session.high) / 2)
      : null;
  const midKey = session && midIndex != null ? baseOrder[midIndex] : null;
  const midTrack =
    (midKey && trackIndex?.get?.(midKey)) ||
    (midKey && trackByKey.get(midKey)) ||
    null;

  function insertAt(position) {
    if (!ranking || !activeKey) return;
    const nextOrder = baseOrder.slice();
    nextOrder.splice(position, 0, activeKey);
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
    <div className="cardSub">
      <p className="meta">
        {session && midIndex != null
          ? ` Comparing against rank ${midIndex + 1} of ${baseOrder.length}.`
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
                {activeTrack?.name || activeKey || "(untitled track)"}
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
                {activeTrack?.id ? (
                  <button
                    className="btn duelSecondaryBtn"
                    onClick={() => openTrackInSpotify(activeTrack.id)}
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
                {midTrack?.name || midKey || "(untitled track)"}
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
                {midTrack?.id ? (
                  <button
                    className="btn duelSecondaryBtn"
                    onClick={() => openTrackInSpotify(midTrack.id)}
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

function Leaderboard({ uniqueTracks, ranking, onChange }) {
  const [query, setQuery] = useState("");

  const rows = useMemo(() => {
    if (!ranking) return [];
    const q = query.trim().toLowerCase();
    return uniqueTracks
      .map(({ key, track }) => ({
        key,
        track,
        state: getTrackState(ranking, key),
        artists: Array.isArray(track?.artists) ? track.artists.join(", ") : "",
      }))
      .filter(r => r.state.bucket !== "X")
      .filter(r => {
        if (!q) return true;
        const hay = `${r.track?.name ?? ""} ${r.artists}`.toLowerCase();
        return hay.includes(q);
      })
      .sort((a, b) => b.state.rating - a.state.rating);
  }, [uniqueTracks, ranking, query]);

  const ranks = useMemo(() => rows.map((_, idx) => idx + 1), [rows]);

  return (
    <div className="cardSub">
      <div className="controls">
        <input
          className="textInput"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search leaderboard…"
          aria-label="Search leaderboard"
        />
      </div>

      {!ranking ? <p className="meta">Loading ranking…</p> : null}

      {ranking && rows.length ? (
        <div
          className="tableWrap"
          role="region"
          aria-label="Leaderboard table"
          tabIndex={0}
        >
          <table className="table">
            <thead>
              <tr>
                <th className="right colIndex">Rank</th>
                <th className="colSong">Song</th>
                <th className="colArtist">Artist</th>
                <th className="colAlbum">Album</th>
                <th className="right colMatches">Matches</th>
                <th className="right colActions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 250).map((r, idx) => (
                <tr key={r.key}>
                  <td className="right">
                    <span className="cellSub">{ranks[idx] ?? idx + 1}</span>
                  </td>
                  <td>
                    <div className="cellTitle">
                      {r.track?.name || "(untitled track)"}
                    </div>
                  </td>
                  <td>
                    <div className="cellSub">
                      {r.artists || "Unknown artist"}
                    </div>
                  </td>
                  <td>
                    <div className="cellSub">
                      {r.track?.album || "Unknown album"}
                    </div>
                  </td>
                  <td className="right">
                    <span className="cellSub">{r.state.games}</span>
                  </td>
                  <td className="right">
                    <span className="btnRow">
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
      ) : ranking ? (
        <p className="meta">No tracks to show yet.</p>
      ) : null}
    </div>
  );
}

function HeadToHead({ uniqueTracks, ranking, onChange }) {
  const [seed, setSeed] = useState(0);
  const [sessionTarget, setSessionTarget] = useState(25);
  const [sessionDone, setSessionDone] = useState(0);

  const trackByKey = useMemo(() => {
    const map = new Map();
    for (const u of uniqueTracks) map.set(u.key, u.track);
    return map;
  }, [uniqueTracks]);

  const trackKeys = useMemo(() => uniqueTracks.map(t => t.key), [uniqueTracks]);

  const matchup = useMemo(() => {
    if (!ranking) return null;
    return pickMatchup({ trackKeys, ranking, seed });
  }, [ranking, trackKeys, seed]);

  const leftTrack = matchup ? trackByKey.get(matchup.leftKey) : null;
  const rightTrack = matchup ? trackByKey.get(matchup.rightKey) : null;

  const leftState =
    matchup && ranking ? getTrackState(ranking, matchup.leftKey) : null;
  const rightState =
    matchup && ranking ? getTrackState(ranking, matchup.rightKey) : null;

  const canUndo = Boolean(ranking?.history?.length);

  function vote(winnerKey) {
    if (!matchup) return;
    onChange(r =>
      r
        ? recordDuel(r, {
            leftKey: matchup.leftKey,
            rightKey: matchup.rightKey,
            winnerKey,
          })
        : r,
    );
    setSessionDone(n => n + 1);
  }

  function skip() {
    setSeed(s => s + 1);
  }

  function undo() {
    onChange(r => {
      const next = r ? undoLast(r) : r;
      if (next !== r) setSessionDone(n => Math.max(0, n - 1));
      return next;
    });
  }

  function doNotRate(trackKey) {
    onChange(r => (r ? excludeTrack(r, trackKey) : r));
    setSeed(s => s + 1);
  }

  return (
    <div className="cardSub">
      <p className="meta">
        Use head-to-head comparisons to fine-tune the global order once you’ve
        done an initial binary sort.
      </p>

      <div className="controls">
        <button
          className="btn"
          onClick={() => setSessionDone(0)}
          title="Resets the in-session counter only (does not affect rankings)."
        >
          Reset session
        </button>

        <label className="inlineLabel">
          Target
          <select
            value={sessionTarget}
            onChange={e => setSessionTarget(Number(e.target.value) || 25)}
          >
            <option value={10}>10</option>
            <option value={25}>25</option>
            <option value={50}>50</option>
          </select>
        </label>

        <button
          className="btn"
          onClick={undo}
          disabled={!canUndo}
          title="Undo last comparison"
        >
          Undo
        </button>
      </div>

      {ranking ? (
        <p className="meta">
          Session: {sessionDone}/{sessionTarget}. Total comparisons:{" "}
          {ranking.history.length}.
        </p>
      ) : null}

      {!ranking ? (
        <p className="meta">Loading ranking…</p>
      ) : !matchup || !leftTrack || !rightTrack ? (
        <p className="meta">
          Not enough eligible tracks for a matchup yet. Add at least 2
          non-excluded songs.
        </p>
      ) : (
        <>
          <div className="duelGrid">
            <div className="duelCard">
              <div className="duelTitle">
                {leftTrack?.name || "(untitled track)"}
              </div>
              {(leftTrack?.artists ?? []).length ? (
                <div className="duelMeta">{leftTrack.artists.join(", ")}</div>
              ) : null}
              {leftState ? (
                <div className="duelStats">
                  <span className="cellSub">matches {leftState.games}</span>
                </div>
              ) : null}
              <div className="controls">
                {leftTrack?.id ? (
                  <button
                    className="btn"
                    onClick={() => openTrackInSpotify(leftTrack.id)}
                    title="Play in Spotify"
                  >
                    Play
                  </button>
                ) : null}
                <button
                  className="btn primary"
                  onClick={() => vote(matchup.leftKey)}
                >
                  Left wins
                </button>
                <button
                  className="btn danger"
                  onClick={() => doNotRate(matchup.leftKey)}
                  title="Exclude this track forever"
                >
                  Do not rate
                </button>
              </div>
            </div>

            <div className="duelVs">vs</div>

            <div className="duelCard">
              <div className="duelTitle">
                {rightTrack?.name || "(untitled track)"}
              </div>
              {(rightTrack?.artists ?? []).length ? (
                <div className="duelMeta">{rightTrack.artists.join(", ")}</div>
              ) : null}
              {rightState ? (
                <div className="duelStats">
                  <span className="cellSub">matches {rightState.games}</span>
                </div>
              ) : null}
              <div className="controls">
                {rightTrack?.id ? (
                  <button
                    className="btn"
                    onClick={() => openTrackInSpotify(rightTrack.id)}
                    title="Play in Spotify"
                  >
                    Play
                  </button>
                ) : null}
                <button
                  className="btn primary"
                  onClick={() => vote(matchup.rightKey)}
                >
                  Right wins
                </button>
                <button
                  className="btn danger"
                  onClick={() => doNotRate(matchup.rightKey)}
                  title="Exclude this track forever"
                >
                  Do not rate
                </button>
              </div>
            </div>
          </div>

          <div className="controls">
            <button
              className="btn"
              onClick={skip}
              title="Skip this matchup and ask again later"
            >
              Skip
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default App;
