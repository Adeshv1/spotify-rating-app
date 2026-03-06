import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { openArtistInSpotify, openTrackInSpotify } from "./lib/openInSpotify";
import {
  excludeTrack,
  createEmptyUserRanking,
  getTrackState,
  mergeLegacyPlaylistRanking,
  readUserRanking,
  recordDuel,
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

const ORDER_BASE_ELO = 1001;

function isRankedState(state) {
  if (!state || typeof state !== "object") return false;
  if (state.bucket && state.bucket !== "U" && state.bucket !== "X") return true;
  const rating = Number(state.rating);
  if (Number.isFinite(rating) && Math.round(rating) !== 1000) return true;
  if (Number(state.games) > 0) return true;
  return typeof state.lastComparedAt === "string" && state.lastComparedAt;
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

  const [selectedPlaylistId, setSelectedPlaylistId] = useState(null);
  const [tracksLoading, setTracksLoading] = useState(false);
  const [tracksError, setTracksError] = useState(null);
  const [tracksCache, setTracksCache] = useState(null);
  const [tracksSource, setTracksSource] = useState(null); // 'cache' | 'api'

  const [rankingSync, setRankingSync] = useState({
    status: "idle",
    lastSyncedAt: null,
    message: null,
  });
  const [userRanking, setUserRanking] = useState(null);
  const saveTimerRef = useRef(null);
  const pendingSaveRef = useRef(false);

  const isDashboardRoute = routePath === "/app/dashboard";
  const isRankRoute = routePath === "/rank";
  const isPublicDashboardRoute = !loggedIn && routePath === "/";
  const isDashboardLikeRoute = isDashboardRoute || isPublicDashboardRoute;
  const headerTitle = loggedIn
    ? isDashboardRoute
      ? "Dashboard"
      : isRankRoute
        ? "Rank Songs"
        : "Playlists"
    : isPublicDashboardRoute
      ? "Dashboard"
      : "";

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
      setUserRanking(null);
      setRankingSync({ status: "idle", lastSyncedAt: null, message: null });
      setIsOwnerUser(false);
    }
  }, [loggedIn]);

  async function refreshPlaylistsCache({ force = false } = {}) {
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
      const apiItemsCount = Array.isArray(data?.items) ? data.items.length : 0;
      const apiTotal = Number(data?.total) || apiItemsCount;
      const isComplete = !data?.partial && apiItemsCount >= apiTotal;

      writePlaylistsCache(userId, data, { fetchedAt, isComplete });
      const cached = readPlaylistsCache(userId);
      setPlaylistsCache(cached);
      setPlaylistsSource("api");
      setCooldownUntilMs(getSpotifyCooldownUntil(userId));
    } catch (e) {
      setPlaylistsError(e?.message || "Failed to fetch playlists");
    } finally {
      setPlaylistsLoading(false);
    }
  }

  useEffect(() => {
    if (!loggedIn || !profile?.id) return;

    const userId = profile.id;
    const cached = readPlaylistsCache(userId);
    setCooldownUntilMs(getSpotifyCooldownUntil(userId));

    if (cached) {
      setPlaylistsCache(cached);
      setPlaylistsSource("cache");
      if (!isOwnerUser) refreshPlaylistsCache({ force: false });
      return;
    }

    // No cache yet: do a fetch to seed the cache.
    refreshPlaylistsCache({ force: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loggedIn, profile?.id, isOwnerUser]);

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
        isOwnerUser
          ? "Spotify may forbid reading items for playlists you do not own (even if they appear in your list). Click “Refresh playlist cache” to try anyway."
          : "Spotify may forbid reading items for playlists you do not own (even if they appear in your list).",
      );
      return;
    }

    refreshPlaylistTracks({ playlistId: selectedPlaylistId, force: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loggedIn, profile?.id, selectedPlaylistId, playlistsCache, isOwnerUser]);

  async function logout() {
    await fetch("/auth/logout", { method: "POST" });
    window.location.href = "/";
  }

  const syncRankings = useCallback(
    async ({ force = false } = {}) => {
      if (!loggedIn || !profile?.id) return;
      const userId = profile.id;

      setRankingSync(s => ({
        status: "syncing",
        lastSyncedAt: s.lastSyncedAt,
        message: null,
      }));

      let local = readUserRanking(userId) ?? createEmptyUserRanking({ userId });

      const legacyPrefix = `sp_rank_v1_${userId}_`;
      try {
        for (let i = 0; i < localStorage.length; i += 1) {
          const k = localStorage.key(i);
          if (!k || !k.startsWith(legacyPrefix)) continue;
          const playlistId = k.slice(legacyPrefix.length);
          if (!playlistId) continue;
          const legacy = readLegacyPlaylistRanking(userId, playlistId);
          if (legacy)
            local = mergeLegacyPlaylistRanking(local, legacy, playlistId);
        }
      } catch {
        // ignore
      }

      setUserRanking(local);

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
    [loggedIn, profile?.id],
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
    if (!loggedIn || !profile?.id || !userRanking) return;
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
  }, [loggedIn, profile?.id, userRanking, rankingSync.status]);

  useEffect(() => {
    if (!loggedIn || !profile?.id) return;

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
  }, [loggedIn, profile?.id, userRanking]);

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
                "Rank your songs with binary sort + refine."
              )}
            </div>
          </div>

          <div
            className="headerTitle"
            aria-label="Page title"
          >
            {headerTitle}
          </div>

          <div className="topActions">
            {loggedIn ? (
              <>
                <button
                  className="btn"
                  onClick={() => navigate("/app/dashboard", { replace: true })}
                >
                  Dashboard
                </button>
                <button
                  className="btn"
                  onClick={() => navigate("/app", { replace: true })}
                >
                  Playlists
                </button>
                <button
                  className="btn"
                  onClick={() => navigate("/rank", { replace: true })}
                >
                  Rank Songs
                </button>
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
                    onChangeRanking={setUserRanking}
                  />
                ) : routePath === "/app/dashboard" ? (
                  <DashboardPage
                    userId={profile?.id}
                    isOwnerUser={isOwnerUser}
                    ranking={userRanking}
                    playlistsCache={playlistsCache}
                    onOverwriteRanking={next => setUserRanking(next)}
                  />
                ) : selectedPlaylistId ? (
                  <PlaylistView
                    playlistsCache={playlistsCache}
                    playlistId={selectedPlaylistId}
                    isOwnerUser={isOwnerUser}
                    ranking={userRanking}
                    cooldownUntilMs={cooldownUntilMs}
                    nowMs={nowMs}
                    tracksLoading={tracksLoading}
                    tracksError={tracksError}
                    tracksCache={tracksCache}
                    tracksSource={tracksSource}
                    onBack={() => {
                      setSelectedPlaylistId(null);
                      setTracksError(null);
                      setTracksCache(null);
                      setTracksSource(null);
                    }}
                    onRefresh={() =>
                      refreshPlaylistTracks({
                        playlistId: selectedPlaylistId,
                        force: true,
                      })
                    }
                  />
                ) : (
                  <PlaylistsView
                    profile={profile}
                    playlistsLoading={playlistsLoading}
                    playlistsError={playlistsError}
                    playlistsCache={playlistsCache}
                    playlistsSource={playlistsSource}
                    isOwnerUser={isOwnerUser}
                    cooldownUntilMs={cooldownUntilMs}
                    nowMs={nowMs}
                    onRefresh={() => refreshPlaylistsCache({ force: true })}
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
  isOwnerUser,
  ranking,
  playlistsCache,
  onOverwriteRanking,
}) {
  const importInputRef = useRef(null);
  const [importError, setImportError] = useState(null);
  const [artistCardsRootEl, setArtistCardsRootEl] = useState(null);
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

  function exportJson() {
    if (!ranking) return;
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      state: ranking,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `spotify-rating-export-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function sanitizeImportedState(state) {
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

  function importFromText(text) {
    setImportError(null);
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      setImportError("Invalid JSON.");
      return;
    }

    if (!parsed || typeof parsed !== "object") {
      setImportError("Invalid export format.");
      return;
    }

    if (parsed.version !== 1) {
      setImportError("Unsupported export version.");
      return;
    }

    const importedState = sanitizeImportedState(parsed.state);
    if (!importedState) {
      setImportError("Missing state.");
      return;
    }

    if (importedState.schemaVersion !== 1) {
      setImportError("Unsupported state schemaVersion.");
      return;
    }

    importedState.userId = userId;

    const ok = window.confirm(
      "Import will overwrite your current ranking on this device (and sync to the server). Continue?",
    );
    if (!ok) return;

    onOverwriteRanking?.(importedState);
  }

  async function onPickImportFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      importFromText(text);
    } catch (err) {
      setImportError(err?.message || "Failed to read file.");
    }
  }

  const trackIndex = useMemo(() => {
    const map = new Map();
    if (!userId) return map;

    const playlistIds = Array.isArray(playlistsCache?.items)
      ? playlistsCache.items.map(p => p?.id).filter(Boolean)
      : [];

    for (const playlistId of playlistIds) {
      const cachedTracks = readPlaylistTracksCache(userId, playlistId);
      const items = Array.isArray(cachedTracks?.items)
        ? cachedTracks.items
        : [];
      for (const t of items) {
        const id = typeof t?.id === "string" ? t.id : null;
        if (!id) continue;
        const key = trackKeyOfTrack(t);
        if (!map.has(key)) {
          const artistNames = Array.isArray(t?.artists)
            ? t.artists.filter(Boolean)
            : [];
          const artistIds = Array.isArray(t?.artistIds) ? t.artistIds : [];
          const artistsDetailed = artistNames.map((name, idx) => ({
            name,
            id: typeof artistIds?.[idx] === "string" ? artistIds[idx] : null,
          }));
          map.set(key, {
            id,
            name: typeof t?.name === "string" ? t.name : null,
            artists: artistNames,
            artistIds,
            artistsDetailed,
            album: typeof t?.album === "string" ? t.album : null,
          });
        }
      }
    }

    return map;
  }, [userId, playlistsCache]);

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

    for (const r of rows) {
      if (r.album) {
        const prev = albumAgg.get(r.album) || {
          name: r.album,
          tracks: 0,
          sumRank: 0,
          bestTrackId: null,
          bestRank: Number.POSITIVE_INFINITY,
        };
        prev.tracks += 1;
        prev.sumRank += r.rank;
        if (r.id && r.rank < prev.bestRank) {
          prev.bestRank = r.rank;
          prev.bestTrackId = r.id;
        }
        albumAgg.set(r.album, prev);
      }
    }

    const topSongs = rows;
    const topArtists = computeTopArtistsFromTracks(rows, {
      maxSongsPerArtist: 5,
      maxArtists: Number.POSITIVE_INFINITY,
    });

    const topAlbums = Array.from(albumAgg.values())
      .map(a => ({ ...a, avgRank: a.tracks ? a.sumRank / a.tracks : 0 }))
      .sort((a, b) => a.avgRank - b.avgRank);

    return { hasAnyRatings, topSongs, topArtists, topAlbums };
  }, [ranking, trackIndex]);

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
    if (initialArtistPrefetchDone.current) return;
    const list = computed?.topArtists;
    if (!Array.isArray(list) || list.length === 0) return;
    initialArtistPrefetchDone.current = true;
    const count = isOwnerUser ? 12 : 6;
    for (const a of list.slice(0, count)) ensureArtistImageForArtist(a);
  }, [computed, ensureArtistImageForArtist, isOwnerUser]);

  if (!userId) return <p className="meta">Loading…</p>;
  if (!ranking) return <p className="meta">Loading ranking…</p>;
  if (!computed?.hasAnyRatings) {
    return (
      <div className="section dashboardPage">
        <p className="meta">
          No rankings yet. Run a binary sort or do a few head-to-head
          refinements first.
        </p>
      </div>
    );
  }

  return (
    <div className="section dashboardPage">
      {!isOwnerUser ? (
        <div className="cardSub">
          <h3>Export / Import</h3>
          <div className="controls">
            <button
              className="btn"
              onClick={exportJson}
              disabled={!ranking}
            >
              Export JSON
            </button>
            <button
              className="btn"
              onClick={() => importInputRef.current?.click()}
            >
              Import JSON
            </button>
            <input
              ref={importInputRef}
              type="file"
              accept="application/json"
              onChange={onPickImportFile}
              style={{ display: "none" }}
            />
          </div>
          {importError ? <p className="error">{importError}</p> : null}
        </div>
      ) : null}

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
            <h3>Top albums ({computed.topAlbums.length})</h3>
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
                {computed.topAlbums.map((a, idx) => (
                  <tr
                    key={a.name}
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
                      {a?.bestTrackId ? (
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
        <h3>Rate your music with binary sort + refine</h3>
        <p className="meta">
          Build an initial global order with binary insertion, then refine with
          head-to-head matchups. Your ranking syncs across devices when you sign
          in.
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
                    data?.rankingUpdatedAt
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

function RankSongsPage({ userId, ranking, onChangeRanking }) {
  const [activeKey, setActiveKey] = useState(null);
  const [rankMode, setRankMode] = useState("binary");
  const [rankInfoOpen, setRankInfoOpen] = useState(false);
  const [unrankedQuery, setUnrankedQuery] = useState("");
  const [rankedQuery, setRankedQuery] = useState("");

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
  }, [userId]);

  const trackByKey = useMemo(() => {
    const map = new Map();
    for (const t of globalSongs) {
      const key = trackKeyOfTrack(t);
      if (!map.has(key)) map.set(key, t);
    }
    return map;
  }, [globalSongs]);

  const uniqueTracks = useMemo(() => {
    const map = new Map();
    for (const t of globalSongs) {
      const key = trackKeyOfTrack(t);
      if (!map.has(key)) map.set(key, { key, track: t, count: 1 });
    }
    return Array.from(map.values());
  }, [globalSongs]);

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

  useEffect(() => {
    if (activeKey) return;
    if (rankMode !== "binary") return;
    if (rankedRows.length === 0) return;
    if (unrankedRows.length === 0) return;
    const pick =
      unrankedRows[Math.floor(Math.random() * unrankedRows.length)]?.key ??
      null;
    if (pick) setActiveKey(pick);
  }, [
    activeKey,
    rankMode,
    rankedRows.length,
    unrankedRows.length,
    unrankedRows,
  ]);

  useEffect(() => {
    if (!activeKey) return;
    if (rankMode !== "refine") return;
    const isRanked = rankedRows.some(r => r.key === activeKey);
    if (!isRanked) setActiveKey(null);
  }, [activeKey, rankMode, rankedRows]);

  return (
    <div className="section dashboardPage rankSongsPage">
      {!userId || uniqueTracks.length === 0 ? null : (
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
              <table className="dashTable">
                <colgroup>
                  <col />
                  <col className="dashColPlay" />
                </colgroup>
                <thead>
                  <tr>
                    <th>Song</th>
                    <th className="right dashColPlay">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUnrankedRows.map(r => (
                    <tr
                      key={r.key}
                      className="dashTableRow"
                    >
                      <td>
                        <div className="cellTitle">
                          {r.track?.name || r.key}
                        </div>
                        <div className="cellSub">
                          {r.artists || "Unknown artist"}
                        </div>
                      </td>
                      <td className="right">
                        <button
                          className="btn"
                          onClick={() => {
                            setRankMode("binary");
                            setActiveKey(r.key);
                          }}
                          disabled={activeKey === r.key}
                          title="Rank this song"
                        >
                          Rank
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="dashPanel">
            <div className="dashPanelHeader">
              <div className="dashPanelHeaderRow">
                <h3>Rank — {rankMode === "refine" ? "Refine" : "Binary"}</h3>
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
              <div className="controls">
                <button
                  className={`btn ${rankMode === "binary" ? "active" : ""}`}
                  onClick={() => setRankMode("binary")}
                >
                  Binary sort
                </button>
                <button
                  className={`btn ${rankMode === "refine" ? "active" : ""}`}
                  onClick={() => setRankMode("refine")}
                >
                  Refine
                </button>
              </div>
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
                    <strong>Refine</strong> focuses on a local window around the
                    song’s current rank. You compare it only against nearby
                    ranks to tighten precision without disturbing the rest of
                    the list. This is best once you already like the overall
                    order but want to fine-tune individual songs.
                  </p>
                  <p className="meta">
                    Tip: Use <strong>Redo</strong> for a full re-placement
                    (global binary insert) and <strong>Refine</strong> to make
                    smaller local adjustments.
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
                mode={rankMode}
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
                        <td className="right">
                          <span className="cellSub">{idx + 1}</span>
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
                              onClick={() => {
                                setRankMode("binary");
                                setActiveKey(r.key);
                              }}
                              title="Redo the binary placement"
                            >
                              Redo
                            </button>
                            <button
                              className="btn compact"
                              onClick={() => {
                                setRankMode("refine");
                                setActiveKey(r.key);
                              }}
                              title="Refine within nearby ranks"
                            >
                              Refine
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
  playlistsSource,
  isOwnerUser,
  cooldownUntilMs,
  nowMs,
  onRefresh,
  onUpdatePlaylistsCache,
  onSelect,
}) {
  const userId = profile?.id ?? null;
  const [ingestStateById, setIngestStateById] = useState({});
  const [cooldownNowMs, setCooldownNowMs] = useState(() => Date.now());

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

      <div className="controls">
        {isOwnerUser ? (
          <button
            className="btn"
            onClick={onRefresh}
            disabled={
              playlistsLoading || (cooldownUntilMs && nowMs < cooldownUntilMs)
            }
            title="Re-fetches playlists from Spotify and overwrites the local cache."
          >
            Refresh playlists cache
          </button>
        ) : null}
      </div>

      {playlistsError ? <p className="error">{playlistsError}</p> : null}

      {playlistsCache ? (
        <p className="meta">
          Loaded from{" "}
          <strong>
            {playlistsSource === "cache" ? "cache" : "Spotify API"}
          </strong>
          . Cached at {formatDateTime(playlistsCache.fetchedAt)} (
          {formatAge(nowMs - Date.parse(playlistsCache.fetchedAt))} ago).{" "}
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
        <div
          className="tableWrap"
          role="region"
          aria-label="Playlists table"
          tabIndex={0}
        >
          <table className="table">
            <thead>
              <tr>
                <th>Playlist</th>
                <th>Owner</th>
                <th>Status</th>
                <th className="right">Action</th>
              </tr>
            </thead>
            <tbody>
              {playlistsCache.items.map(p => {
                const tracksMeta =
                  userId && p.id
                    ? readPlaylistTracksCacheMeta(userId, p.id)
                    : null;
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
                const statusText = ingestedAt
                  ? `Added: ${formatDateTime(ingestedAt)}`
                  : "Not added";
                const actionLabel = isFetching
                  ? "Fetching..."
                  : isCooling
                    ? `Cooling down (${cooldownRemaining}s)`
                    : ingestedAt
                      ? "Refresh Playlist"
                      : "Add to Rankings";

                return (
                  <tr key={p.id || p.name}>
                    <td>
                      <button
                        className="linkButton"
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
                      <div className="cellSub">
                        {typeof p.tracksTotal === "number"
                          ? `${p.tracksTotal} tracks`
                          : "Unknown size"}
                        {typeof p.public === "boolean"
                          ? ` · ${p.public ? "public" : "private"}`
                          : ""}
                        {ownedByUser ? " · owned by you" : ""}
                        {hasTracksCache
                          ? ` · cached ${formatAge(
                              nowMs - Date.parse(tracksMeta.fetchedAt),
                            )} ago${snapshotMismatch ? " (playlist changed)" : ""}`
                          : " · tracks not cached"}
                      </div>
                    </td>
                    <td>{p.owner?.display_name || "Unknown"}</td>
                    <td>{statusText}</td>
                    <td className="right">
                      <button
                        className="btn"
                        onClick={() => p.id && ingestPlaylist(p.id)}
                        disabled={!p.id || isFetching || isCooling}
                      >
                        {actionLabel}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function PlaylistView({
  playlistsCache,
  playlistId,
  isOwnerUser,
  ranking,
  cooldownUntilMs,
  nowMs,
  tracksLoading,
  tracksError,
  tracksCache,
  tracksSource,
  onBack,
  onRefresh,
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
        {isOwnerUser ? (
          <button
            className="btn"
            onClick={onRefresh}
            disabled={
              tracksLoading || (cooldownUntilMs && nowMs < cooldownUntilMs)
            }
            title="Re-fetches playlist tracks from Spotify and overwrites the local cache for this playlist."
          >
            Refresh playlist cache
          </button>
        ) : null}
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
  mode = "binary",
}) {
  const [session, setSession] = useState(null);
  const lastActiveRef = useRef(null);
  const lastModeRef = useRef(mode);
  const isRefine = mode === "refine";
  const refineWindow = 6;

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
  const activeIndex = useMemo(() => {
    if (!activeKey) return -1;
    return orderedKeys.indexOf(activeKey);
  }, [orderedKeys, activeKey]);
  const refineLow = useMemo(() => {
    if (!isRefine || activeIndex < 0) return 0;
    return Math.max(0, activeIndex - refineWindow);
  }, [activeIndex, isRefine, refineWindow]);
  const refineHigh = useMemo(() => {
    if (!isRefine || activeIndex < 0) return baseOrder.length;
    return Math.min(baseOrder.length, activeIndex + refineWindow);
  }, [activeIndex, baseOrder.length, isRefine, refineWindow]);
  useEffect(() => {
    if (!activeKey || !ranking) {
      lastActiveRef.current = activeKey;
      lastModeRef.current = mode;
      setSession(null);
      return;
    }
    if (isRefine && activeIndex < 0) {
      lastActiveRef.current = activeKey;
      lastModeRef.current = mode;
      setSession(null);
      return;
    }
    if (baseOrder.length === 0) {
      onChange?.(rk => (rk ? applyOrderToRanking(rk, [activeKey]) : rk));
      setSession(null);
      onActiveKeyChange?.(null);
      lastActiveRef.current = activeKey;
      lastModeRef.current = mode;
      return;
    }
    if (lastActiveRef.current !== activeKey || lastModeRef.current !== mode) {
      const low = isRefine ? refineLow : 0;
      const high = isRefine ? refineHigh : baseOrder.length;
      setSession({ key: activeKey, low, high, mode });
      lastActiveRef.current = activeKey;
      lastModeRef.current = mode;
    }
  }, [
    activeKey,
    activeIndex,
    baseOrder.length,
    isRefine,
    mode,
    refineHigh,
    refineLow,
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
          ? isRefine
            ? ` Refine window: ranks ${session.low + 1}–${session.high} of ${baseOrder.length}. Comparing against rank ${midIndex + 1}.`
            : ` Comparing against rank ${midIndex + 1} of ${baseOrder.length}.`
          : activeKey
            ? " Ready to compare."
            : isRefine
              ? " Pick a song from the right to start."
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
        Use head-to-head comparisons to refine the global order once you’ve done
        an initial binary sort.
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
