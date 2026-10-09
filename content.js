// Playlist Pro for YouTube
// Replaces the playlist video list with a custom UI that uses YouTube's
// internal InnerTube API (youtubei/v1/...) to load and reorder videos.
// Runs in MAIN world so we have direct access to ytcfg and ytInitialData.

(() => {
  'use strict';
  if (window.__ytPlaylistProInstalled) return;
  window.__ytPlaylistProInstalled = true;

  // ============================================================
  // CONFIG / CONSTANTS
  // ============================================================
  const ROOT_ID = 'ytpp-root';
  const STYLE_GUARD_CLASS = 'ytpp-active';

  // ============================================================
  // STATE
  // ============================================================
  const state = {
    nextUid: 1,
    playlistId: null,
    ownerView: false,        // do we have setVideoId on rows? if so, we can reorder
    videos: [],              // [{ videoId, setVideoId, uid, title, channel, duration, durationSec, thumb, index }]
    selected: new Set(),     // uid values
    lastClickedId: null,
    rendering: false,
    busy: false,
    loading: false,
    error: null,
    title: '',
    metaLine: '',
  };

  // ============================================================
  // DOM HELPERS — required because YouTube enforces Trusted Types,
  // which forbids any element.innerHTML = "<string>". So we build
  // every node via createElement instead.
  // ============================================================
  function h(tag, attrs, children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k.startsWith('on') && typeof v === 'function') {
          el.addEventListener(k.slice(2).toLowerCase(), v);
        }
        else if (k === 'dataset' && typeof v === 'object') {
          for (const dk in v) el.dataset[dk] = v[dk];
        }
        else if (typeof v === 'boolean') { if (v) el.setAttribute(k, ''); }
        else el.setAttribute(k, v);
      }
    }
    if (children != null) {
      const arr = Array.isArray(children) ? children : [children];
      for (const c of arr) {
        if (c == null || c === false) continue;
        el.appendChild(typeof c === 'string' || typeof c === 'number'
          ? document.createTextNode(String(c))
          : c);
      }
    }
    return el;
  }

  function clearChildren(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function setEmpty(msg) {
    if (!listEl) return;
    listEl.replaceChildren(h('div', { class: 'ytpp-empty' }, msg));
  }

  // ============================================================
  // INNERTUBE / AUTH HELPERS
  // ============================================================
  function getApiKey() {
    if (window.ytcfg && typeof window.ytcfg.get === 'function') {
      const k = window.ytcfg.get('INNERTUBE_API_KEY');
      if (k) return k;
    }
    // Fallback: scan ytcfg.set(...) script blocks
    const m = document.documentElement.innerHTML.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
    return m ? m[1] : null;
  }

  function getInnertubeContext() {
    if (window.ytcfg && typeof window.ytcfg.get === 'function') {
      const ctx = window.ytcfg.get('INNERTUBE_CONTEXT');
      if (ctx) return ctx;
    }
    // Fallback: a minimal context that usually works
    return {
      client: {
        clientName: 'WEB',
        clientVersion: '2.20240101.00.00',
        hl: 'en',
        gl: 'US',
      },
    };
  }

  function readCookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)'));
    return m ? m[1] : null;
  }

  async function sha1Hex(str) {
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // YouTube's web frontend uses a combined auth header that includes hashes
  // for both 1P (first-party) and 3P (third-party) SAPISIDs. The server
  // accepts any of the three forms, but unlisted-playlist endpoints
  // are pickier and want the multi-hash combo.
  async function buildAuthHash() {
    const ts = Math.floor(Date.now() / 1000);
    const origin = 'https://www.youtube.com';

    const sapisid = readCookie('SAPISID');
    const sapisid1p = readCookie('__Secure-1PAPISID');
    const sapisid3p = readCookie('__Secure-3PAPISID');

    const parts = [];
    if (sapisid) {
      parts.push(`SAPISIDHASH ${ts}_${await sha1Hex(`${ts} ${sapisid} ${origin}`)}`);
    }
    if (sapisid1p) {
      parts.push(`SAPISID1PHASH ${ts}_${await sha1Hex(`${ts} ${sapisid1p} ${origin}`)}`);
    }
    if (sapisid3p) {
      parts.push(`SAPISID3PHASH ${ts}_${await sha1Hex(`${ts} ${sapisid3p} ${origin}`)}`);
    }
    return parts.length ? parts.join(' ') : null;
  }

  async function ytApiPost(endpoint, body, { auth = true } = {}) {
    const apiKey = getApiKey();
    if (!apiKey) throw new Error('INNERTUBE_API_KEY not found — reload the page');

    const ctx = getInnertubeContext();
    const headers = {
      'Content-Type': 'application/json',
      'X-YouTube-Client-Name': '1',
      'X-YouTube-Client-Version': ctx?.client?.clientVersion || '2.20240101.00.00',
      'X-Origin': 'https://www.youtube.com',
      'X-Goog-Visitor-Id': ctx?.client?.visitorData || '',
    };
    if (auth) {
      const a = await buildAuthHash();
      if (a) {
        headers['Authorization'] = a;
        // Tell YouTube which logged-in account index to use (for multi-account)
        if (window.ytcfg && window.ytcfg.get) {
          const idx = window.ytcfg.get('SESSION_INDEX');
          if (idx != null) headers['X-Goog-AuthUser'] = String(idx);
          const psd = window.ytcfg.get('DELEGATED_SESSION_ID');
          if (psd) headers['X-Goog-PageId'] = String(psd);
        }
      }
    }

    const url = `https://www.youtube.com/youtubei/v1/${endpoint}?key=${apiKey}&prettyPrint=false`;
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({ context: ctx, ...body }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`API ${endpoint} failed: ${res.status} ${txt.slice(0, 300)}`);
    }
    return res.json();
  }

  // ============================================================
  // PARSING ytInitialData & continuations
  // ============================================================
  // Walk a browse-response shape (ytInitialData OR a /browse API response)
  // and return the playlistVideoListRenderer for the playlist we're on.
  function findPlaylistListInBrowse(d) {
    if (!d) return null;
    // Walk the tree instead of relying on a brittle path.
    // Different playlist types (mixes, recaps, user playlists) nest their lists differently.
    let found = null;
    (function walk(obj) {
      if (found || !obj || typeof obj !== 'object') return;
      if (obj.playlistVideoListRenderer) {
        found = obj.playlistVideoListRenderer;
        return;
      }
      if (obj.playlistPanelRenderer) {
        // Some mixes render as a panel
        found = obj.playlistPanelRenderer;
        return;
      }
      if (obj.sectionListRenderer) {
        // If it's a section list, we might want to capture the whole thing if it contains playlist videos,
        // but `collectVideosDeep` will find `playlistVideoRenderer`s anywhere.
        // Returning the container that holds the videos is enough.
        // We will just keep searching inside.
      }
      for (const k in obj) {
        walk(obj[k]);
      }
    })(d);

    // If we didn't find a dedicated playlist list renderer, but we DID find
    // something containing `playlistVideoRenderer`s or `playlistPanelVideoRenderer`s,
    // we can just return the entire document as the "list data" and let `extractVideos`
    // find them. `extractVideos` already searches deeply!
    return found || d;
  }

  function getInitialPlaylistList() {
    return findPlaylistListInBrowse(window.ytInitialData);
  }

  // Whether `ytInitialData` matches the playlist currently in the URL.
  // YouTube's SPA navigation does NOT refresh `ytInitialData` between
  // playlists, so we use this to detect when we need to fetch fresh.
  function ytInitialDataMatchesUrl(playlistId) {
    const canonical = window.ytInitialData?.microformat?.microformatDataRenderer?.urlCanonical
                  || window.ytInitialData?.microformat?.microformatDataRenderer?.url;
    if (canonical) {
      const m = canonical.match(/[?&]list=([^&]+)/);
      if (m) return m[1] === playlistId;
    }
    return false;
  }

  // Fetch the playlist directly via the InnerTube API. Used on SPA
  // navigation and when the user clicks Reload.
  async function fetchPlaylistDataFresh(playlistId) {
    const json = await ytApiPost('browse', { browseId: 'VL' + playlistId });
    return findPlaylistListInBrowse(json);
  }


  function parseRow(r) {
    if (!r || !r.videoId) return null;
    const titleRuns = r.title?.runs || [];
    const title = titleRuns.map(x => x.text).join('') || r.title?.simpleText || '';
    const channel = r.shortBylineText?.runs?.[0]?.text ||
                    r.videoInfo?.runs?.[0]?.text || '';
    const duration = r.lengthText?.simpleText || '';
    const durationSec = parseInt(r.lengthSeconds || '0', 10) || 0;
    const thumb = r.thumbnail?.thumbnails?.[0]?.url ||
                  `https://i.ytimg.com/vi/${r.videoId}/mqdefault.jpg`;
    const idxStr = r.index?.simpleText || r.indexText?.simpleText || '0';
    const index = parseInt(idxStr, 10) || 0;
    return {
      videoId: r.videoId,
      uid: String(state.nextUid++),

      setVideoId: r.setVideoId || null,
      title, channel, duration, durationSec, thumb, index,
    };
  }

  // Recursively search any object for the first continuation token we can find.
  // Used as a fallback when the path varies between YouTube backend versions.
  function findContinuationTokenDeep(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 8) return null;
    // Direct hits we know about
    if (obj.continuationCommand?.token) return obj.continuationCommand.token;
    if (obj.nextContinuationData?.continuation) return obj.nextContinuationData.continuation;
    if (obj.reloadContinuationData?.continuation) return obj.reloadContinuationData.continuation;
    if (Array.isArray(obj)) {
      for (const item of obj) {
        const t = findContinuationTokenDeep(item, depth + 1);
        if (t) return t;
      }
    } else {
      for (const k in obj) {
        if (k === 'token' && typeof obj[k] === 'string' && obj[k].length > 40) return obj[k];
        const t = findContinuationTokenDeep(obj[k], depth + 1);
        if (t) return t;
      }
    }
    return null;
  }

  // Collect every playlistVideoRenderer anywhere in a response, in order.
  // We walk the tree instead of matching YouTube's container shapes
  // (playlistVideoListRenderer / appendContinuationItemsAction /
  // reloadContinuationItemsCommand / continuationContents / whatever ships
  // next quarter) because those vary by backend version and an unrecognized
  // one silently truncated the playlist at the first page.
  function collectVideosDeep(obj, out = [], depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 16) return out;
    const renderer = obj.playlistVideoRenderer || obj.playlistPanelVideoRenderer || obj.videoRenderer;
    if (renderer && renderer.videoId) {
      const v = parseRow(renderer);
      if (v) out.push(v);
      return out; // no videos nested inside a video
    }
    for (const k in obj) collectVideosDeep(obj[k], out, depth + 1);
    return out;
  }

  // Works on ytInitialData's playlistVideoListRenderer and on any
  // continuation response alike.
  function extractVideos(json) {
    return {
      videos: collectVideosDeep(json),
      continuationToken: findContinuationTokenDeep(json),
    };
  }

  // Fetches continuation pages one at a time (YouTube requires the previous
  // page's token to request the next, so this can't be parallelized) and
  // calls onPage with the cumulative list after every page so the caller
  // can render incrementally instead of waiting for the whole playlist.
  async function loadAllVideos(initialList, onPage) {
    if (!initialList) throw new Error('No playlist data');

    let { videos, continuationToken } = extractVideos(initialList);
    console.log(`[Playlist Pro] Initial load: ${videos.length} videos, continuationToken=${!!continuationToken}`);
    // onPage returns false to cancel (a newer boot() took over)
    if (onPage && onPage(videos) === false) return videos;

    // A token we've already spent means YouTube looped us; stop rather than
    // re-appending the same page forever.
    const spentTokens = new Set();
    let pageCount = 0;
    while (continuationToken && !spentTokens.has(continuationToken)) {
      spentTokens.add(continuationToken);
      pageCount++;
      let json;
      try {
        json = await ytApiPost('browse', { continuation: continuationToken });
      } catch (e) {
        console.warn('[Playlist Pro] Continuation failed:', e);
        // Rows are already on screen, so a silent break would look like a
        // complete playlist. Tell the user it's partial.
        showToast(`Loaded ${videos.length} — couldn't load the rest (${e.message})`, 'error');
        break;
      }
      const next = extractVideos(json);
      console.log(`[Playlist Pro] Continuation page ${pageCount}: got ${next.videos.length} more, hasMore=${!!next.continuationToken}`);
      if (!next.videos.length) {
        // Either we've genuinely reached the end, or we failed to read a
        // response shape. Say so instead of passing off a partial playlist
        // as the whole thing.
        if (next.continuationToken) {
          console.warn('[Playlist Pro] unreadable continuation response:', Object.keys(json || {}));
          showToast(`Loaded ${videos.length} — YouTube says there are more, but the page couldn't be read`, 'error');
        }
        break;
      }
      videos = videos.concat(next.videos);
      continuationToken = next.continuationToken;
      if (onPage && onPage(videos) === false) return videos;
    }
    console.log(`[Playlist Pro] Final video count: ${videos.length}`);
    return videos;
  }

  // ============================================================
  // EDIT PLAYLIST API
  // ============================================================
  // Each action is one of:
  //   ACTION_MOVE_VIDEO    + setVideoId + (movedSetVideoSuccessorId | movedSetVideoPredecessorId)
  //   ACTION_REMOVE_VIDEO  + setVideoId
  //   ACTION_ADD_VIDEO     + addedVideoId
  async function editPlaylist(actions, playlistId = state.playlistId) {
    console.log('[Playlist Pro] edit_playlist actions:', JSON.parse(JSON.stringify(actions)));
    const res = await ytApiPost('browse/edit_playlist', {
      playlistId,
      actions,
    }, { auth: true });
    console.log('[Playlist Pro] edit_playlist response:', res);
    // Server may return status to indicate partial failure
    if (res?.status && res.status !== 'STATUS_SUCCEEDED') {
      console.warn('[Playlist Pro] non-success status:', res.status);
    }
    return res;
  }

  // The user's own playlists, as listed in YouTube's "Save to…" dialog.
  // Walks the tree for the same reason collectVideosDeep does: the wrapper
  // shape around playlistAddToOptionRenderer changes between versions.
  // Takes one videoId: the endpoint 400s on multiple, like YouTube's own
  // dialog never sends more. The playlist list doesn't depend on which video.
  async function fetchOwnPlaylists(videoId) {
    const res = await ytApiPost('playlist/get_add_to_playlist', {
      videoIds: [videoId],
      excludeWatchLater: false,
    }, { auth: true });
    const out = [];
    (function walk(o) {
      if (!o || typeof o !== 'object') return;
      const r = o.playlistAddToOptionRenderer;
      if (r?.playlistId) {
        const t = r.title?.simpleText || (r.title?.runs || []).map(x => x.text).join('');
        out.push({ playlistId: r.playlistId, title: t || r.playlistId });
        return;
      }
      for (const k in o) walk(o[k]);
    })(res);
    if (!out.length) console.warn('[Playlist Pro] no playlists parsed from get_add_to_playlist:', res);
    return out;
  }

  // Build the action list for moving a contiguous group of setVideoIds to
  // a new position in the array. We compute the action sequence based on
  // the *original* indices, since each move only takes effect after the
  // server applies it. To keep relative order of the moved group, we move
  // items one at a time, anchoring to a specific successor/predecessor that
  // does NOT change between actions (a video that's not in the moved set).
  function buildMoveActions(allVideos, movingIds, dropIndex) {
    const movingSet = new Set(movingIds);
    let successor = null;
    for (let i = dropIndex; i < allVideos.length; i++) {
      const v = allVideos[i];
      if (v.setVideoId && !movingSet.has(v.setVideoId)) {
        successor = v;
        break;
      }
    }
    let predecessor = null;
    if (!successor) {
      for (let i = dropIndex - 1; i >= 0; i--) {
        const v = allVideos[i];
        if (v.setVideoId && !movingSet.has(v.setVideoId)) {
          predecessor = v;
          break;
        }
      }
    }

    if (!successor && !predecessor) {
      console.warn('[Playlist Pro] No anchor found; not building actions');
      return [];
    }

    const orderedMoving = movingIds.slice();
    const actions = [];
    // YouTube protobuf field names use _Id suffix at the END of camelCase noun:
    //   moved_set_video_id_successor → movedSetVideoIdSuccessor
    // Sending the wrong field name causes YouTube to silently fall back
    // to "append to end of playlist" — which is what was happening before.
    if (successor) {
      for (const id of orderedMoving) {
        actions.push({
          action: 'ACTION_MOVE_VIDEO_BEFORE',
          setVideoId: id,
          movedSetVideoIdSuccessor: successor.setVideoId,
        });
      }
    } else {
      for (const id of [...orderedMoving].reverse()) {
        actions.push({
          action: 'ACTION_MOVE_VIDEO_AFTER',
          setVideoId: id,
          movedSetVideoIdPredecessor: predecessor.setVideoId,
        });
      }
    }
    return actions;
  }

  // ============================================================
  // DOM: TAKE OVER THE PLAYLIST PAGE
  // ============================================================
  // Find the EXACT element we want to replace: the item-section containing
  // the playlist video list. We want this specific element so we can:
  //   1. insert our UI right before it (so it appears in the right spot)
  //   2. hide ONLY this element (not anything else in the column)
  // If we can't find it, we don't hide anything — better the user sees
  // YouTube's UI than a blank page.
  function findNativePlaylistSection() {
    // The list renderer itself (the most specific match)
    const listRenderer = document.querySelector(
      'ytd-browse[page-subtype="playlist"] ytd-playlist-video-list-renderer, ' +
      'ytd-playlist-video-list-renderer, ' +
      'ytd-playlist-panel-renderer, ' +
      'ytd-section-list-renderer[page-subtype="playlist"]'
    );
    if (!listRenderer) {
      // Fallback: look for the main content area if we are on a /playlist page but lack known renderers
      // Some generated lists render as standard section lists without page-subtype
      if (isPlaylistPage()) {
         const fallback = document.querySelector('ytd-browse ytd-section-list-renderer') ||
                          document.querySelector('ytd-browse[page-subtype="playlist"] #primary') ||
                          document.querySelector('ytd-playlist-panel-renderer') ||
                          document.querySelector('ytd-browse');
         if (fallback) return fallback.closest('ytd-item-section-renderer') || fallback;
      }
      return null;
    }
    // Walk up to its containing item-section so we hide the whole block
    // (including the section header, etc.), not just the list rows.
    return listRenderer.closest('ytd-item-section-renderer') || listRenderer;
  }

  // Mark a specific element as hidden via class. Avoids :has() and CSS-wide
  // rules that could miss-target stuff if YouTube changes their DOM.
  let hiddenNativeEl = null;
  function hideNativeSection(el) {
    if (!el) return;
    el.classList.add('ytpp-hide-native');
    hiddenNativeEl = el;
  }
  function unhideNativeSection() {
    if (hiddenNativeEl) hiddenNativeEl.classList.remove('ytpp-hide-native');
    // Also clear any lingering class on any element (safety net)
    document.querySelectorAll('.ytpp-hide-native').forEach(e => e.classList.remove('ytpp-hide-native'));
    hiddenNativeEl = null;
  }

  function gatherHeaderInfo() {
    // Grab the playlist title/meta from the existing page header (which we leave alone)
    const title = document.querySelector('ytd-playlist-header-renderer .metadata-wrapper yt-formatted-string.title, ytd-playlist-header-renderer h1, .yt-playlist-header-renderer-text-content yt-formatted-string')?.textContent?.trim() || '';
    const stats = document.querySelector('ytd-playlist-header-renderer .metadata-stats, ytd-playlist-header-renderer #stats')?.textContent?.replace(/\s+/g, ' ').trim() || '';
    return { title, metaLine: stats };
  }

  // ============================================================
  // CUSTOM UI
  // ============================================================
  let root, listEl, headerEl, toolbarEl, toastEl;

  function ensureRoot() {
    if (root && document.body.contains(root)) return root;
    root = document.createElement('div');
    root.id = ROOT_ID;

    const reloadBtn = h('button', {
      class: 'ytpp-btn ytpp-reload',
      title: 'Reload videos from YouTube',
      onclick: () => boot(true),
    }, '↻ Reload');

    const toggleBtn = h('button', {
      class: 'ytpp-btn ytpp-toggle-native',
      title: "Show YouTube's original list view",
      onclick: (e) => {
        const btn = e.currentTarget;
        const isHidden = !!document.querySelector('.ytpp-hide-native');
        if (!isHidden) {
          const native = findNativePlaylistSection();
          if (native) hideNativeSection(native);
          btn.textContent = '👁 Show original';
          btn.title = "Show YouTube's original list view";
        } else {
          unhideNativeSection();
          btn.textContent = '🙈 Hide original';
          btn.title = "Hide YouTube's list and show only Playlist Pro";
        }
      },
    }, '👁 Show original');

    const h1Div = h('div', { class: 'ytpp-h1' });
    const metaDiv = h('div', { class: 'ytpp-meta' });
    headerEl = h('div', { class: 'ytpp-header' }, [
      h('div', { class: 'ytpp-titles' }, [h1Div, metaDiv]),
      h('div', { class: 'ytpp-actions' }, [toggleBtn, reloadBtn]),
    ]);

    listEl = h('div', {
      class: 'ytpp-list',
      role: 'listbox',
      'aria-multiselectable': 'true',
    });

    toolbarEl = h('div', { class: 'ytpp-toolbar', hidden: true }, [
      h('span', { class: 'ytpp-count' }, '0 selected'),
      h('button', { class: 'ytpp-btn', 'data-act': 'top', title: 'Move to top' }, '⤒ Top'),
      h('button', { class: 'ytpp-btn', 'data-act': 'bottom', title: 'Move to bottom' }, '⤓ Bottom'),
      h('button', { class: 'ytpp-btn', 'data-act': 'add', title: 'Add to another playlist' }, '＋ Add to…'),
      h('button', { class: 'ytpp-btn', 'data-act': 'move', title: 'Move to another playlist' }, '↪ Move to…'),
      h('button', { class: 'ytpp-btn ytpp-danger', 'data-act': 'remove', title: 'Remove from playlist' }, '🗑 Remove'),
      h('button', { class: 'ytpp-btn', 'data-act': 'clear', title: 'Clear selection (Esc)' }, '✕'),
    ]);

    toastEl = h('div', { class: 'ytpp-toast', hidden: true });

    root.appendChild(headerEl);
    root.appendChild(listEl);
    root.appendChild(toolbarEl);
    root.appendChild(toastEl);

    toolbarEl.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (btn && !state.busy) handleToolbarAction(btn.dataset.act);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.selected.size && !state.busy) {
        state.selected.clear();
        syncSelection();
      }
    });

    return root;
  }

  function mountRoot() {
    ensureRoot();
    const nativeSection = findNativePlaylistSection();
    if (nativeSection && nativeSection.parentNode) {
      // Insert our UI in the exact spot where YouTube's list lives
      if (root.parentNode !== nativeSection.parentNode || root.nextElementSibling !== nativeSection) {
        nativeSection.parentNode.insertBefore(root, nativeSection);
      }
      document.documentElement.classList.add(STYLE_GUARD_CLASS);
      return true;
    }
    // Fallback: at least mount somewhere visible so the user sees an error
    const fallback = document.querySelector('ytd-browse[page-subtype="playlist"] ytd-section-list-renderer') ||
                     document.querySelector('ytd-browse[page-subtype="playlist"] #primary');
    if (fallback) {
      if (root.parentNode !== fallback) fallback.prepend(root);
      document.documentElement.classList.add(STYLE_GUARD_CLASS);
      return true;
    }
    return false;
  }

  function unmountRoot() {
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = null;
    document.documentElement.classList.remove(STYLE_GUARD_CLASS);
    unhideNativeSection();
  }

  function showToast(msg, kind = 'info') {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.dataset.kind = kind;
    toastEl.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { toastEl.hidden = true; }, 3500);
  }

  function setHeader() {
    if (!headerEl) return;
    headerEl.querySelector('.ytpp-h1').textContent = state.title || 'Playlist';
    const totalSec = state.videos.reduce((a, v) => a + (v.durationSec || 0), 0);
    const meta = `${state.videos.length} video${state.videos.length === 1 ? '' : 's'}` +
                 (state.loading ? ' • loading more…' : '') +
                 (totalSec > 0 ? ` • ${formatDuration(totalSec)}` : '') +
                 (state.ownerView ? '' : ' • read-only (not your playlist)');
    headerEl.querySelector('.ytpp-meta').textContent = meta;
  }

  function formatDuration(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s.toString().padStart(2, '0')}s`;
    return `${s}s`;
  }

  // ============================================================
  // RENDER LIST
  // ============================================================
  function buildRow(v, i) {
    const isSelected = !!(v.uid && state.selected.has(v.uid));
    const canDrag = !!(state.ownerView && v.setVideoId);
    const watchUrl = `/watch?v=${encodeURIComponent(v.videoId)}&list=${encodeURIComponent(state.playlistId)}&index=${i + 1}`;

    const children = [];

    if (v.uid) {
      const cb = h('input', { type: 'checkbox', tabindex: '-1' });
      cb.checked = isSelected;
      children.push(h('label', {
        class: 'ytpp-check',
        onclick: (e) => {
          e.stopPropagation();
          e.preventDefault();
          handleSelectClick(v, i, e);
        },
      }, [cb]));
    }

    children.push(h('span', { class: 'ytpp-num' }, String(i + 1)));

    const img = h('img', { class: 'ytpp-thumb', loading: 'lazy', alt: '' });
    img.src = v.thumb;
    children.push(h('a', { class: 'ytpp-thumb-link', href: watchUrl }, [
      img,
      h('span', { class: 'ytpp-thumb-time' }, v.duration || ''),
    ]));

    children.push(h('div', { class: 'ytpp-text' }, [
      h('a', { class: 'ytpp-title', href: watchUrl, title: v.title }, v.title),
      h('div', { class: 'ytpp-channel' }, v.channel || ''),
    ]));

    if (canDrag) {
      children.push(h('span', { class: 'ytpp-grip', title: 'Drag to reorder' }, '⋮⋮'));
    }

    const row = h('div', {
      class: 'ytpp-row' + (isSelected ? ' ytpp-selected' : ''),
      role: 'option',
      'aria-selected': isSelected ? 'true' : 'false',
      dataset: {
        uid: v.uid,

        setVideoId: v.setVideoId || '',
        videoId: v.videoId,
        index: String(i),
      },
    }, children);

    if (canDrag) row.draggable = true;

    // row-level click for cmd/ctrl/shift to toggle selection
    row.addEventListener('click', (e) => {
      if (e.target.closest('a')) return; // let links work
      if (!state.ownerView) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey) {
        e.preventDefault();
        handleSelectClick(v, i, e);
      }
    });

    if (canDrag) attachDragHandlers(row, v, i);

    return row;
  }

  function renderList() {
    if (!listEl) return;
    state.rendering = true;

    const frag = document.createDocumentFragment();
    state.videos.forEach((v, i) => frag.appendChild(buildRow(v, i)));
    listEl.replaceChildren(frag);

    state.rendering = false;
    setHeader();
    refreshToolbar();
  }

  // Selection-only changes update rows in place. A full renderList() replaces
  // every row, including the one just clicked, so the browser loses its
  // scroll anchor and the page jumps.
  function syncSelection() {
    if (!listEl) return;
    for (const row of listEl.children) {
      const on = !!row.dataset.uid && state.selected.has(row.dataset.uid);
      row.classList.toggle('ytpp-selected', on);
      row.setAttribute('aria-selected', on ? 'true' : 'false');
      const cb = row.querySelector('.ytpp-check input');
      if (cb) cb.checked = on;
    }
    refreshToolbar();
  }

  // Append only the rows we haven't built yet. Used while pages stream in —
  // a full renderList() per page would be O(n²) over the whole load.
  function appendRows(fromIndex) {
    if (!listEl) return;
    if (fromIndex === 0) listEl.replaceChildren();
    const frag = document.createDocumentFragment();
    for (let i = fromIndex; i < state.videos.length; i++) {
      frag.appendChild(buildRow(state.videos[i], i));
    }
    listEl.appendChild(frag);
    setHeader();
  }

  // Popup menu above the toolbar. Resolves with the chosen playlist, or null
  // on outside click / Escape.
  function pickPlaylist(playlists) {
    return new Promise(resolve => {
      const done = (choice) => {
        menu.remove();
        document.removeEventListener('mousedown', onOutside, true);
        document.removeEventListener('keydown', onKey, true);
        resolve(choice);
      };
      const onOutside = (e) => { if (!menu.contains(e.target)) done(null); };
      const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } };
      const menu = h('div', { class: 'ytpp-menu', role: 'menu' },
        playlists.map(p => h('button', { class: 'ytpp-menu-item', role: 'menuitem', onClick: () => done(p) }, p.title)));
      toolbarEl.appendChild(menu);
      document.addEventListener('mousedown', onOutside, true);
      document.addEventListener('keydown', onKey, true);
      menu.querySelector('button')?.focus();
    });
  }

  function refreshToolbar() {
    const n = state.selected.size;
    toolbarEl.hidden = (n === 0);
    toolbarEl.querySelector('.ytpp-count').textContent = `${n} selected`;

    const selectedVideos = state.videos.filter(v => state.selected.has(v.uid));
    const allHaveSetVideoId = selectedVideos.every(v => !!v.setVideoId);
    const hasValidAdd = selectedVideos.some(v => !!v.videoId);

    toolbarEl.querySelectorAll('button[data-act]').forEach(b => {
      if (state.busy) {
        b.disabled = true;
        return;
      }
      const act = b.dataset.act;
      if (act === 'clear') {
        b.disabled = false;
      } else if (act === 'add') {
        b.disabled = !hasValidAdd;
      } else {
        // move, top, bottom, remove require ownerView and valid setVideoId for all selected items
        b.disabled = !(state.ownerView && allHaveSetVideoId && selectedVideos.length > 0);
      }
    });
  }

  // ============================================================
  // SELECTION
  // ============================================================
  function handleSelectClick(video, idx, ev) {
    if (!video.uid) return; // shouldn\'t happen, but just in case

    if (ev.shiftKey && state.lastClickedId) {
      const lastIdx = state.videos.findIndex(v => v.uid === state.lastClickedId);
      if (lastIdx >= 0) {
        const [lo, hi] = lastIdx < idx ? [lastIdx, idx] : [idx, lastIdx];
        const adding = !state.selected.has(video.uid);
        for (let i = lo; i <= hi; i++) {
          const sid = state.videos[i].uid;
          if (!sid) continue;
          if (adding) state.selected.add(sid);
          else state.selected.delete(sid);
        }
      }
    } else {
      if (state.selected.has(video.uid)) state.selected.delete(video.uid);
      else state.selected.add(video.uid);
    }
    state.lastClickedId = video.uid;
    syncSelection();
  }

  // ============================================================
  // DRAG AND DROP
  // ============================================================
  let dragState = null;

  // Edge auto-scroll: while dragging, if the cursor enters a "hot zone" at
  // the top or bottom of the viewport, scroll the window in that direction
  // continuously. Speed ramps up the closer you get to the edge.
  const autoScroll = {
    rafId: null,
    cursorY: -1,
    enabled: false,
    HOT_ZONE: 110,   // px from edge that triggers scroll
    MAX_SPEED: 26,   // px per frame at the very edge
    enable() {
      this.enabled = true;
      this.cursorY = -1;
    },
    disable() {
      this.enabled = false;
      this.cursorY = -1;
      if (this.rafId) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
    },
    update(clientY) {
      this.cursorY = clientY;
      if (this.enabled && this.rafId == null) {
        this.rafId = requestAnimationFrame(() => this._tick());
      }
    },
    _tick() {
      this.rafId = null;
      if (!this.enabled || this.cursorY < 0) return;
      const vh = window.innerHeight;
      let dy = 0;
      if (this.cursorY < this.HOT_ZONE) {
        // Linear ramp: 0 at hot zone boundary, MAX_SPEED at viewport edge
        const ratio = (this.HOT_ZONE - this.cursorY) / this.HOT_ZONE;
        dy = -Math.ceil(this.MAX_SPEED * Math.max(0.1, ratio));
      } else if (this.cursorY > vh - this.HOT_ZONE) {
        const ratio = (this.cursorY - (vh - this.HOT_ZONE)) / this.HOT_ZONE;
        dy = Math.ceil(this.MAX_SPEED * Math.max(0.1, ratio));
      }
      if (dy !== 0) window.scrollBy(0, dy);
      // Keep ticking as long as we're enabled — dragover will refresh cursorY
      // when the user moves, but we want to keep scrolling even if they hold
      // the cursor still in the hot zone.
      this.rafId = requestAnimationFrame(() => this._tick());
    },
  };

  // Document-level dragover listener — fires no matter which element is
  // under the cursor, so auto-scroll works even outside our list rows.
  document.addEventListener('dragover', (e) => {
    if (autoScroll.enabled) autoScroll.update(e.clientY);
  });

  function attachDragHandlers(row, video, idx) {
    row.addEventListener('dragstart', (e) => {
      // If the dragged row is part of the selection, drag the whole selection.
      // Otherwise, drag just this row (and clear selection).
      let movingIds;
      if (state.selected.has(video.uid)) {
        movingIds = state.videos
          .filter(v => v.setVideoId && state.selected.has(v.uid))
          .map(v => v.setVideoId);
      } else {
        movingIds = [video.setVideoId];
        state.selected.clear();
        state.lastClickedId = video.uid;
      }
      dragState = { movingIds, sourceIdx: idx };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', video.setVideoId);
      // Set a custom drag image showing the count
      if (movingIds.length > 1) {
        const ghost = document.createElement('div');
        ghost.className = 'ytpp-drag-ghost';
        ghost.textContent = `Move ${movingIds.length} videos`;
        document.body.appendChild(ghost);
        e.dataTransfer.setDragImage(ghost, 12, 12);
        setTimeout(() => ghost.remove(), 0);
      }
      // Mark dragging rows
      requestAnimationFrame(() => {
        listEl.querySelectorAll('.ytpp-row').forEach(r => {
          if (movingIds.includes(r.dataset.setVideoId)) r.classList.add('ytpp-dragging');
        });
      });
      // Turn on edge auto-scroll for the duration of this drag
      autoScroll.enable();
    });

    row.addEventListener('dragover', (e) => {
      if (!dragState) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      // Feed the cursor position into the auto-scroller
      autoScroll.update(e.clientY);
      const rect = row.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      showInsertionLine(row, before);
    });

    row.addEventListener('dragleave', () => {
      // Don't hide on every leave — the line moves with dragover on the next row
    });

    row.addEventListener('drop', (e) => {
      if (!dragState) return;
      e.preventDefault();
      autoScroll.disable();
      const rect = row.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      const targetIdx = parseInt(row.dataset.index, 10);
      const dropIndex = before ? targetIdx : targetIdx + 1;
      finishDrag(dropIndex);
    });

    row.addEventListener('dragend', () => {
      autoScroll.disable();
      cleanupDragVisuals();
    });
  }

  function showInsertionLine(targetRow, before) {
    let line = listEl.querySelector('.ytpp-insertion-line');
    if (!line) {
      line = document.createElement('div');
      line.className = 'ytpp-insertion-line';
      listEl.appendChild(line);
    }
    const rect = targetRow.getBoundingClientRect();
    const listRect = listEl.getBoundingClientRect();
    const y = before ? rect.top - listRect.top : rect.bottom - listRect.top;
    line.style.transform = `translateY(${y + listEl.scrollTop}px)`;
    line.style.opacity = '1';
  }

  function cleanupDragVisuals() {
    listEl.querySelectorAll('.ytpp-dragging').forEach(r => r.classList.remove('ytpp-dragging'));
    const line = listEl.querySelector('.ytpp-insertion-line');
    if (line) line.remove();
  }

  async function finishDrag(dropIndex) {
    const ds = dragState;
    dragState = null;
    autoScroll.disable();
    cleanupDragVisuals();
    if (!ds) return;

    const { movingIds } = ds;
    if (!movingIds.length) return;

    // Compute the optimistic new array
    const newOrder = computeReorderedArray(state.videos, movingIds, dropIndex);
    const previous = state.videos;
    state.videos = newOrder;
    renderList();

    state.busy = true;
    refreshToolbar();
    try {
      const actions = buildMoveActions(previous, movingIds, dropIndex);
      if (!actions.length) return;
      await editPlaylist(actions);
      showToast(`Moved ${movingIds.length} video${movingIds.length === 1 ? '' : 's'}`);
    } catch (err) {
      console.error(err);
      state.videos = previous;
      renderList();
      showToast(`Move failed — ${err.message}`, 'error');
    } finally {
      state.busy = false;
      refreshToolbar();
    }
  }

  // Pure function: returns a new array with movingIds removed and reinserted at dropIndex
  function computeReorderedArray(videos, movingIds, dropIndex) {
    const movingSet = new Set(movingIds);
    const moving = [];
    const remaining = [];
    let removedBeforeDrop = 0;
    videos.forEach((v, i) => {
      if (movingSet.has(v.setVideoId)) {
        moving.push(v);
        if (i < dropIndex) removedBeforeDrop++;
      } else {
        remaining.push(v);
      }
    });
    // Preserve original order of moving items
    moving.sort((a, b) => movingIds.indexOf(a.setVideoId) - movingIds.indexOf(b.setVideoId));
    const insertAt = dropIndex - removedBeforeDrop;
    const out = remaining.slice();
    out.splice(insertAt, 0, ...moving);
    return out;
  }

  // ============================================================
  // TOOLBAR ACTIONS
  // ============================================================
  async function handleToolbarAction(act) {
    const selectedUids = Array.from(state.selected);
    const selectedVideos = state.videos.filter(v => state.selected.has(v.uid));

    // For Move/Remove/Top/Bottom, we strictly need setVideoIds
    const ids = selectedVideos
      .filter(v => v.setVideoId)
      .map(v => v.setVideoId);

    // For Add, we only need valid videoIds
    const validAddVideos = selectedVideos.filter(v => v.videoId);

    if (act !== 'clear' && act !== 'add' && !ids.length) return;
    if (act === 'add' && !validAddVideos.length) return;

    if (act === 'clear') {
      state.selected.clear();
      state.lastClickedId = null;
      syncSelection();
      return;
    }

    if (act === 'top') {
      state.busy = true; refreshToolbar();
      try {
        const previous = state.videos;
        const newOrder = computeReorderedArray(previous, ids, 0);
        state.videos = newOrder; renderList();
        const actions = buildMoveActions(previous, ids, 0);
        await editPlaylist(actions);
        showToast(`Moved ${ids.length} to top`);
      } catch (err) {
        await reload(); // reload to be safe on error
        showToast(`Failed: ${err.message}`, 'error');
      } finally {
        state.busy = false; refreshToolbar();
      }
      return;
    }

    if (act === 'bottom') {
      state.busy = true; refreshToolbar();
      try {
        const previous = state.videos;
        const newOrder = computeReorderedArray(previous, ids, previous.length);
        state.videos = newOrder; renderList();
        const actions = buildMoveActions(previous, ids, previous.length);
        await editPlaylist(actions);
        showToast(`Moved ${ids.length} to bottom`);
      } catch (err) {
        await reload();
        showToast(`Failed: ${err.message}`, 'error');
      } finally {
        state.busy = false; refreshToolbar();
      }
      return;
    }

    // 'add' and 'move' share everything up to removing from this playlist.
    if (act === 'add' || act === 'move') {
      const activeVideos = act === 'add' ? validAddVideos : selectedVideos.filter(v => v.setVideoId);
      if (!activeVideos.length) return;

      let target;
      try {
        const playlists = (await fetchOwnPlaylists(activeVideos[0].videoId))
          .filter(p => p.playlistId !== state.playlistId);
        if (!playlists.length) { showToast('No other playlists found', 'error'); return; }
        target = await pickPlaylist(playlists);
      } catch (err) {
        showToast(`Couldn't load playlists: ${err.message}`, 'error');
        return;
      }
      if (!target) return;

      state.busy = true; refreshToolbar();
      try {
        // Add first, remove only once the add succeeded: a failure halfway
        // leaves duplicates, never lost videos.
        // ponytail: one request for the whole batch, chunk if huge selections start failing
        const addRes = await editPlaylist(
          activeVideos.map(v => ({ action: 'ACTION_ADD_VIDEO', addedVideoId: v.videoId })),
          target.playlistId);
        if (addRes?.status && addRes.status !== 'STATUS_SUCCEEDED') {
          throw new Error(`couldn't add to "${target.title}" (${addRes.status})`);
        }
        if (act === 'add') {
          const addedCount = activeVideos.length;
          state.selected.clear();
          syncSelection();
          showToast(`Added ${addedCount} to "${target.title}"`);
          return;
        }
        const removeSet = new Set(ids);
        state.videos = state.videos.filter(v => !removeSet.has(v.setVideoId));
        state.selected.clear();
        renderList();
        await editPlaylist(ids.map(setVideoId => ({ action: 'ACTION_REMOVE_VIDEO', setVideoId })));
        showToast(`Moved ${ids.length} to "${target.title}"`);
      } catch (err) {
        await reload();
        showToast(`${act === 'add' ? 'Add' : 'Move'} failed: ${err.message}`, 'error');
      } finally {
        state.busy = false; refreshToolbar();
      }
      return;
    }

    if (act === 'remove') {
      const ok = confirm(`Remove ${ids.length} video${ids.length === 1 ? '' : 's'} from this playlist?`);
      if (!ok) return;
      state.busy = true; refreshToolbar();
      try {
        const removeSet = new Set(ids);
        const previous = state.videos;
        state.videos = previous.filter(v => !removeSet.has(v.setVideoId));
        state.selected.clear();
        renderList();
        const actions = ids.map(setVideoId => ({
          action: 'ACTION_REMOVE_VIDEO',
          setVideoId,
        }));
        await editPlaylist(actions);
        showToast(`Removed ${ids.length} video${ids.length === 1 ? '' : 's'}`);
      } catch (err) {
        await reload();
        showToast(`Failed: ${err.message}`, 'error');
      } finally {
        state.busy = false; refreshToolbar();
      }
      return;
    }
  }

  // ============================================================
  // BOOT / RELOAD
  // ============================================================
  function isPlaylistPage() {
    return location.pathname === '/playlist' &&
           new URLSearchParams(location.search).has('list');
  }

  // YouTube fires yt-navigate-finish on the initial load too, so boot() can
  // run twice concurrently. Each call bumps bootGen; an older run bails at
  // its next await instead of appending its pages into the same list
  // (which showed up as rows 101-200 repeated after 200).
  let bootGen = 0;

  async function boot(force = false) {
    const gen = ++bootGen;
    const stale = () => gen !== bootGen;
    if (!isPlaylistPage()) { unmountRoot(); return; }
    const playlistId = new URLSearchParams(location.search).get('list');
    state.playlistId = playlistId;
    state.nextUid = 1;
    state.selected.clear();
    state.lastClickedId = null;
    state.videos = [];
    state.loading = false;
    // SPA navigation may have replaced the DOM — drop any stale ref to the
    // previous playlist's "hidden native" element.
    unhideNativeSection();

    // Wait for the native section to exist (we use it as our mount anchor
    // and to hide the original list once we render). We do NOT wait for
    // ytInitialData here because on SPA navigation it stays stale forever.
    let tries = 0;
    let nativeSection = null;
    while (tries < 50) {
      nativeSection = findNativePlaylistSection();
      if (nativeSection) break;
      await new Promise(r => setTimeout(r, 100));
      tries++;
    }
    if (stale()) return;

    if (!nativeSection) {
      console.warn('[Playlist Pro] No native playlist section found; staying out of the way');
      unmountRoot();
      return;
    }

    ensureRoot();
    if (!mountRoot()) {
      console.warn('[Playlist Pro] Could not mount root');
      return;
    }

    const info = gatherHeaderInfo();
    state.title = info.title;
    state.metaLine = info.metaLine;
    setHeader();

    setEmpty('Loading playlist…');

    try {
      // Pick the data source:
      //   - User clicked Reload (force=true) → always fresh API fetch
      //   - ytInitialData matches the URL's playlistId → use it (fast path on first load)
      //   - Otherwise → fresh API fetch (covers SPA navigation between playlists)
      let initialList = null;
      if (!force && ytInitialDataMatchesUrl(playlistId)) {
        initialList = getInitialPlaylistList();
        console.log('[Playlist Pro] Using ytInitialData (fresh)');
      }
      if (!initialList) {
        console.log('[Playlist Pro] Fetching playlist via API…');
        initialList = await fetchPlaylistDataFresh(playlistId);
        if (stale()) return;
      }
      if (!initialList) throw new Error("Couldn't get playlist data from API or page");

      let rendered = 0;
      state.loading = true;
      const videos = await loadAllVideos(initialList, (soFar) => {
        if (stale()) return false;
        if (!soFar.length) return;
        state.videos = soFar;
        if (rendered === 0) {
          state.ownerView = soFar.some(v => !!v.setVideoId);
          // Only hide YouTube's list once we have rows to show in its place
          hideNativeSection(nativeSection);
        }
        appendRows(rendered);
        rendered = soFar.length;
      });
      if (stale()) return;
      state.loading = false;
      setHeader();

      if (!videos.length) {
        setEmpty('No videos found.');
        // Keep native list visible as a fallback
        return;
      }
    } catch (err) {
      if (stale()) return;
      console.error('[Playlist Pro]', err);
      state.loading = false;
      listEl.replaceChildren(h('div', { class: 'ytpp-empty ytpp-error' }, [
        h('div', null, `Couldn't load via API: ${err.message}`),
        h('div', { style: { marginTop: '8px', fontSize: '12px', opacity: '0.8' } },
          "YouTube's original list is still shown below."),
      ]));
      // Don't hide native — leave the user with a working playlist UI
    }
  }

  async function reload() {
    return boot(true);
  }

  // ============================================================
  // SPA NAVIGATION
  // ============================================================
  document.addEventListener('yt-navigate-finish', () => {
    setTimeout(() => boot(false), 300);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => boot());
  } else {
    boot();
  }
})();
