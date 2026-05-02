/**
 * @fileoverview Main lyrics handling module for
 * Manages lyrics fetching, caching, processing, and rendering.
 */

import { FETCH_LYRICS_LOG, LOG_PREFIX, LYRICS_TAB_HIDDEN_LOG, SERVER_ERROR_LOG, TAB_HEADER_CLASS } from "@constants";
import { AppState, type PlayerDetails } from "@core/appState";
import { t } from "@core/i18n";
import { type LyricsData, processLyrics } from "@modules/lyrics/injectLyrics";
import { stringSimilarity } from "@modules/lyrics/lyricParseUtils";
import { registerThemeSetting } from "@modules/settings/themeOptions";
import { flushLoader, renderLoader, setSourceSwitchAvailability } from "@modules/ui/dom";
import { log } from "@utils";
import type { Lyric, LyricSourceKey, LyricSourceResult, ProviderParameters } from "./providers/shared";
import { getLyrics, newSourceMap, providerPriority } from "./providers/shared";
import type { YTLyricSourceResult } from "./providers/yt";
import { getSongAlbum, getSongMetadata, type SegmentMap } from "./requestSniffer/requestSniffer";
import { clearCache as clearTranslationCache } from "./translation";

const hideInstrumentalOnly = registerThemeSetting("blyrics-hide-instrumental-only", false, true);

function isInstrumentalOnly(lyrics: Lyric[]): boolean {
  if (lyrics.length !== 1) return false;
  return /^\[?instrumental\s*only\]?$/i.test(lyrics[0].words.trim());
}

export type LyricSourceResultWithMeta = LyricSourceResult & {
  song: string;
  artist: string;
  album: string;
  duration: number;
  videoId: string;
  segmentMap: SegmentMap | null;
  providerKey?: LyricSourceKey;
};

export function applySegmentMapToLyrics(lyricData: LyricsData | null, segmentMap: SegmentMap) {
  if (segmentMap && lyricData) {
    lyricData.isMusicVideoSynced = !lyricData.isMusicVideoSynced;
    // We're sync lyrics using segment map
    const allZero = lyricData.syncType === "none";

    if (!allZero) {
      for (let lyric of lyricData.lines) {
        lyric.accumulatedOffsetMs = 1000000; // Force resync by setting to a very large value
        let lastTimeChange = 0;
        for (let segment of segmentMap.segment) {
          let lyricTimeMs = lyric.time * 1000;
          if (lyricTimeMs >= segment.counterpartVideoStartTimeMilliseconds) {
            lastTimeChange = segment.primaryVideoStartTimeMilliseconds - segment.counterpartVideoStartTimeMilliseconds;
            if (lyricTimeMs <= segment.counterpartVideoStartTimeMilliseconds + segment.durationMilliseconds) {
              break;
            }
          }
        }

        let changeS = lastTimeChange / 1000;
        lyric.time = lyric.time + changeS;
        lyric.lyricElement.dataset.time = String(lyric.time);
        lyric.parts.forEach(part => {
          part.time = part.time + changeS;
          part.lyricElement.dataset.time = String(part.time);
        });
      }
    }
  }
}

type ProviderParametersBase = Omit<ProviderParameters, "signal">;

type ProviderSelectionResult = {
  lyrics: LyricSourceResult;
  providerKey: LyricSourceKey;
  ytLyrics: YTLyricSourceResult | null;
};

type ProviderSwitchContext = {
  providerParameters: ProviderParametersBase;
  segmentMap: SegmentMap | null;
  isMusicVideo: boolean;
  ytLyrics: YTLyricSourceResult | null;
};

let providerSwitchContext: ProviderSwitchContext | null = null;
let availabilityAbortController: AbortController | null = null;

function buildProviderParameters(base: ProviderParametersBase, signal: AbortSignal): ProviderParameters {
  return { ...base, signal };
}

async function selectProviderFromList(
  providerParameters: ProviderParameters,
  providers: LyricSourceKey[],
  ytLyricsPromise: Promise<YTLyricSourceResult | null>,
  signal: AbortSignal
): Promise<ProviderSelectionResult | null> {
  let resolvedYtLyrics: YTLyricSourceResult | null | undefined;

  const resolveYtLyrics = async (): Promise<YTLyricSourceResult | null> => {
    if (resolvedYtLyrics === undefined) {
      resolvedYtLyrics = await ytLyricsPromise;
    }
    return resolvedYtLyrics;
  };

  for (const provider of providers) {
    if (signal.aborted) {
      return null;
    }

    try {
      const sourceLyrics = await getLyrics(providerParameters, provider);

      if (!sourceLyrics || !sourceLyrics.lyrics || sourceLyrics.lyrics.length === 0) {
        continue;
      }

      if (hideInstrumentalOnly.getBooleanValue() && isInstrumentalOnly(sourceLyrics.lyrics)) {
        continue;
      }

      const ytLyrics = await resolveYtLyrics();
      if (ytLyrics) {
        let lyricText = "";
        sourceLyrics.lyrics.forEach(lyric => {
          lyricText += lyric.words + "\n";
        });

        const matchAmount = stringSimilarity(lyricText.toLowerCase(), ytLyrics.text.toLowerCase());
        if (matchAmount < 0.5) {
          log(
            `Got lyrics from ${sourceLyrics.source}, but they don't match YT lyrics. Rejecting: Match: ${matchAmount}%`
          );
          continue;
        }
      }

      return {
        lyrics: sourceLyrics,
        providerKey: provider,
        ytLyrics: ytLyrics ?? null,
      };
    } catch (err) {
      log(err);
    }
  }

  return null;
}

async function refreshProviderAvailability(
  currentProvider: LyricSourceKey | null,
  knownAvailableDirection?: "prev" | "next"
): Promise<void> {
  if (!providerSwitchContext || !currentProvider) {
    return;
  }

  if (availabilityAbortController) {
    availabilityAbortController.abort("Refreshing provider availability");
  }

  const abortController = new AbortController();
  availabilityAbortController = abortController;
  const { signal } = abortController;
  const injectionId = AppState.currentInjectionId;

  const providerIndex = providerPriority.indexOf(currentProvider);
  if (providerIndex < 0) {
    setSourceSwitchAvailability(false, false);
    return;
  }

  const candidatesPrev = providerPriority.slice(0, providerIndex).reverse();
  const candidatesNext = providerPriority.slice(providerIndex + 1);

  const providerParameters = buildProviderParameters(providerSwitchContext.providerParameters, signal);
  const ytLyricsPromise = Promise.resolve(providerSwitchContext.ytLyrics);

  const shouldCheckPrev = knownAvailableDirection !== "prev";
  const shouldCheckNext = knownAvailableDirection !== "next";

  let prevAvailable = knownAvailableDirection === "prev" && candidatesPrev.length > 0;
  let nextAvailable = knownAvailableDirection === "next" && candidatesNext.length > 0;

  if (shouldCheckPrev) {
    const prevSelection = candidatesPrev.length
      ? await selectProviderFromList(providerParameters, candidatesPrev, ytLyricsPromise, signal)
      : null;
    prevAvailable = Boolean(prevSelection);
  }

  if (signal.aborted || AppState.currentInjectionId !== injectionId) {
    return;
  }

  if (shouldCheckNext) {
    const nextSelection = candidatesNext.length
      ? await selectProviderFromList(providerParameters, candidatesNext, ytLyricsPromise, signal)
      : null;
    nextAvailable = Boolean(nextSelection);
  }

  if (signal.aborted || AppState.currentInjectionId !== injectionId) {
    return;
  }

  setSourceSwitchAvailability(prevAvailable, nextAvailable);
}

/**
 * Main function to create and inject lyrics for the current song.
 * Handles caching, API requests, and fallback mechanisms.
 *
 * @param detail - Song and player details
 * @param signal - signal to cancel injection
 */
export async function createLyrics(detail: PlayerDetails, signal: AbortSignal): Promise<void> {
  let song = detail.song;
  let artist = detail.artist;
  let videoId = detail.videoId;
  let duration = Number(detail.duration);
  const audioTrackData = detail.audioTrackData;
  const isMusicVideo = detail.contentRect.width !== 0 && detail.contentRect.height !== 0;

  if (!videoId) {
    log(SERVER_ERROR_LOG, "Invalid video id");
    return;
  }

  let shouldCleanupLoader = false;

  try {
    // We should get recalled if we were executed without a valid song/artist and aren't able to get lyrics

    let matchingSong = await getSongMetadata(videoId, 1, signal);
    let swappedVideoId = false;
    let isAVSwitch =
      (matchingSong &&
        matchingSong.counterpartVideoId &&
        matchingSong.counterpartVideoId === AppState.lastLoadedVideoId) ||
      AppState.lastLoadedVideoId === videoId;

    let segmentMap = matchingSong?.segmentMap || null;

    if (isAVSwitch && segmentMap) {
      applySegmentMapToLyrics(AppState.lyricData, segmentMap);
      AppState.suppressZeroTime = Date.now() + 5000;
      AppState.areLyricsTicking = true; // Keep lyrics ticking while new lyrics are fetched.
      log("Switching between audio/video: Skipping Loader", segmentMap);
    } else {
      log("Not Switching between audio/video", isAVSwitch, segmentMap);
      renderLoader();
      shouldCleanupLoader = true;
      clearTranslationCache();
      matchingSong = await getSongMetadata(videoId, 250, signal);
      segmentMap = matchingSong?.segmentMap || null;
      AppState.areLyricsLoaded = false;
      AppState.areLyricsTicking = false;
      AppState.suppressZeroTime = 0;
    }

    if (matchingSong) {
      song = matchingSong.title;
      artist = matchingSong.artist;

      if (isMusicVideo && matchingSong.counterpartVideoId && matchingSong.segmentMap) {
        log("Switching VideoId to Audio Id");
        swappedVideoId = true;
        videoId = matchingSong.counterpartVideoId;
      }
    }

    const tabSelector = document.getElementsByClassName(TAB_HEADER_CLASS)[1];
    console.assert(tabSelector != null);
    if (tabSelector.getAttribute("aria-selected") !== "true") {
      AppState.areLyricsLoaded = false;
      AppState.areLyricsTicking = false;
      AppState.lyricInjectionFailed = true;
      log(LYRICS_TAB_HIDDEN_LOG);
      return;
    }

    song = song.trim();
    artist = artist.trim();
    artist = artist.replace(", & ", ", ");
    let album = await getSongAlbum(videoId, signal);
    if (!album) {
      album = "";
    }

    // Check for empty strings after trimming
    if (!song || !artist) {
      log(SERVER_ERROR_LOG, "Empty song or artist name");
      return;
    }

    if (signal.aborted) {
      return;
    }

    log(FETCH_LYRICS_LOG, song, artist);

    let lyrics: LyricSourceResult | null = null;
    let sourceMap = newSourceMap();

    // We depend on the cubey lyrics to fetch certain metadata, so we always call it even if it isn't the top priority
    let providerParameters: ProviderParameters = {
      song,
      artist,
      duration,
      videoId,
      audioTrackData,
      album,
      sourceMap,
      alwaysFetchMetadata: swappedVideoId,
      signal,
    };
    let ytLyricsEarlyInjectAbortController = new AbortController();

    const ytLyricsPromise = getLyrics(providerParameters, "yt-lyrics").then(lyrics => {
      if (!AppState.areLyricsLoaded && lyrics && !signal.aborted) {
        if (!ytLyricsEarlyInjectAbortController.signal.aborted) {
          log(LOG_PREFIX, "Temporarily Using YT Music Lyrics while we wait for synced lyrics to load");
          let lyricsWithMeta = {
            ...lyrics,
            song: providerParameters.song,
            artist: providerParameters.artist,
            duration: providerParameters.duration,
            videoId: providerParameters.videoId,
            album: providerParameters.album || "",
            segmentMap: null,
          };

          processLyrics(lyricsWithMeta, true, signal);
        }
      }
      return lyrics;
    }) as Promise<YTLyricSourceResult | null>;

    try {
      let meta = await getLyrics(providerParameters, "metadata");
      if (meta && meta.album && meta.album.length > 0) {
        providerParameters.album = meta.album;
      }
      if (meta && meta.song && meta.song.length > 0 && song !== meta.song) {
        log("Using '" + meta.song + "' for song instead of '" + song + "'");
        providerParameters.song = meta.song;
      }

      if (meta && meta.artist && meta.artist.length > 0 && artist !== meta.artist) {
        log("Using '" + meta.artist + "' for artist instead of '" + artist + "'");
        providerParameters.artist = meta.artist;
      }

      if (meta && meta.duration && duration !== meta.duration) {
        log("Using '" + meta.duration + "' for duration instead of '" + duration + "'");
        providerParameters.duration = meta.duration;
      }
    } catch (err) {
      log(err);
    }

    let selectedProvider: LyricSourceKey | undefined;
    let resolvedYtLyrics: YTLyricSourceResult | null = null;

    const selection = await selectProviderFromList(providerParameters, providerPriority, ytLyricsPromise, signal);
    if (selection) {
      ytLyricsEarlyInjectAbortController.abort("Lyrics are ready");
      lyrics = selection.lyrics;
      selectedProvider = selection.providerKey;
      resolvedYtLyrics = selection.ytLyrics;
    }

    if (!lyrics) {
      lyrics = {
        lyrics: [
          {
            startTimeMs: 0,
            words: t("lyrics_notFound"),
            durationMs: 0,
          },
        ],
        source: "Unknown",
        sourceHref: "",
        musicVideoSynced: false,
        cacheAllowed: false,
      };
    }

    if (!lyrics.lyrics) {
      throw new Error("Lyrics.lyrics is null or undefined. Report this bug");
    }

    const baseSegmentMap = segmentMap;
    if (isMusicVideo === (lyrics.musicVideoSynced === true)) {
      segmentMap = null; // The timing matches, we don't need to apply a segment map!
    }

    log("Got Lyrics from " + lyrics.source);

    // Preserve song and artist information in the lyrics data for the "Add Lyrics" button

    let lyricsWithMeta: LyricSourceResultWithMeta = {
      song: providerParameters.song,
      artist: providerParameters.artist,
      album: providerParameters.album || "",
      duration: providerParameters.duration,
      videoId: providerParameters.videoId,
      segmentMap,
      providerKey: selectedProvider,
      ...lyrics,
    };

    const { signal: _signal, ...providerParametersBase } = providerParameters;
    providerSwitchContext = selectedProvider
      ? {
          providerParameters: providerParametersBase,
          segmentMap: baseSegmentMap,
          isMusicVideo,
          ytLyrics: resolvedYtLyrics,
        }
      : null;
    AppState.currentProviderKey = selectedProvider ?? null;
    AppState.providerPrioritySnapshot = [...providerPriority];

    AppState.lastLoadedVideoId = detail.videoId;
    if (signal.aborted) {
      return;
    }
    processLyrics(lyricsWithMeta, false, signal);
    shouldCleanupLoader = false;
    refreshProviderAvailability(selectedProvider ?? null);
  } finally {
    if (shouldCleanupLoader) {
      flushLoader();
    }
  }
}

export async function switchLyricsProvider(direction: "prev" | "next"): Promise<void> {
  if (!providerSwitchContext) {
    return;
  }

  const currentProvider = AppState.currentProviderKey as LyricSourceKey | null;
  if (!currentProvider) {
    return;
  }

  const providerIndex = providerPriority.indexOf(currentProvider);
  if (providerIndex < 0) {
    return;
  }

  const candidates =
    direction === "prev"
      ? providerPriority.slice(0, providerIndex).reverse()
      : providerPriority.slice(providerIndex + 1);

  if (candidates.length === 0) {
    return;
  }

  const switchAbortController = new AbortController();
  const providerParameters = buildProviderParameters(
    providerSwitchContext.providerParameters,
    switchAbortController.signal
  );

  const selection = await selectProviderFromList(
    providerParameters,
    candidates,
    Promise.resolve(providerSwitchContext.ytLyrics),
    switchAbortController.signal
  );

  if (!selection || switchAbortController.signal.aborted) {
    return;
  }

  AppState.lyricAbortController?.abort("Switching provider");
  AppState.lyricAbortController = switchAbortController;
  AppState.currentInjectionId++;

  let switchSegmentMap = providerSwitchContext.segmentMap;
  if (providerSwitchContext.isMusicVideo === (selection.lyrics.musicVideoSynced === true)) {
    switchSegmentMap = null;
  }

  const lyricsWithMeta: LyricSourceResultWithMeta = {
    song: providerParameters.song,
    artist: providerParameters.artist,
    album: providerParameters.album || "",
    duration: providerParameters.duration,
    videoId: providerParameters.videoId,
    segmentMap: switchSegmentMap,
    providerKey: selection.providerKey,
    ...selection.lyrics,
  };

  AppState.currentProviderKey = selection.providerKey;
  AppState.providerPrioritySnapshot = [...providerPriority];
  providerSwitchContext.ytLyrics = selection.ytLyrics;

  if (switchAbortController.signal.aborted) {
    return;
  }

  processLyrics(lyricsWithMeta, false, switchAbortController.signal);
  const knownAvailableDirection = direction === "next" ? "prev" : "next";
  refreshProviderAvailability(selection.providerKey, knownAvailableDirection);
}

/**
 * Warms caches so lyric fetching is faster
 *
 * @param detail - Song and player details
 * @param isMusicVideo
 */
export async function preFetchLyrics(
  detail: Pick<PlayerDetails, "song" | "artist" | "videoId" | "duration">,
  isMusicVideo: boolean
): Promise<void> {
  log(LOG_PREFIX, "Prefetching next song", detail, isMusicVideo);
  let song = detail.song;
  let artist = detail.artist;
  let videoId = detail.videoId;
  let duration = Number(detail.duration);
  let signal = new AbortController().signal; // create a signal to pass to other funcs, not used

  let matchingSong = await getSongMetadata(videoId, 250, signal);
  let swappedVideoId = false;

  if (matchingSong) {
    song = matchingSong.title;
    artist = matchingSong.artist;

    if (isMusicVideo && matchingSong.counterpartVideoId && matchingSong.segmentMap) {
      swappedVideoId = true;
      videoId = matchingSong.counterpartVideoId;
    }
  }

  song = song.trim();
  artist = artist.trim();
  artist = artist.replace(", & ", ", ");
  let album = await getSongAlbum(videoId, signal);
  if (!album) {
    album = "";
  }

  log("Prefetching for: ", song, artist);

  let sourceMap = newSourceMap();
  // We depend on the cubey lyrics to fetch certain metadata, so we always call it even if it isn't the top priority
  let providerParameters: ProviderParameters = {
    song,
    artist,
    duration,
    videoId,
    audioTrackData: null,
    album,
    sourceMap,
    alwaysFetchMetadata: swappedVideoId,
    signal,
  };

  try {
    let meta = await getLyrics(providerParameters, "metadata");
    if (meta && meta.album && meta.album.length > 0 && album !== meta.album) {
      providerParameters.album = meta.album;
    }
    if (meta && meta.song && meta.song.length > 0 && song !== meta.song) {
      providerParameters.song = meta.song;
    }

    if (meta && meta.artist && meta.artist.length > 0 && artist !== meta.artist) {
      providerParameters.artist = meta.artist;
    }

    if (meta && meta.duration && duration !== meta.duration) {
      providerParameters.duration = meta.duration;
    }
  } catch (err) {
    log(err);
  }

  for (let provider of providerPriority) {
    if (signal.aborted) {
      return;
    }

    try {
      let sourceLyrics = await getLyrics(providerParameters, provider);

      if (sourceLyrics && sourceLyrics.lyrics && sourceLyrics.lyrics.length > 0) {
        break;
      }
    } catch (err) {
      log(err);
    }
  }
}
