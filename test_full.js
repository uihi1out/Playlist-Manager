// Full functionality test harness for Playlist Pro content.js
// Runs the extension inside jsdom with a mocked InnerTube API and drives
// every feature: parsing, boot paths (hard load / SPA), selection, drag
// reorder action building, toolbar actions (top/bottom/add/move/remove/
// clear), watchdog recovery, history patching, validation sinks.
'use strict';
const fs = require('fs');
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync('/workspace/content.js', 'utf8');

let PASS = 0, FAIL = 0;
function ok(name, cond, extra) {
  if (cond) { PASS++; console.log(`PASS: ${name}`); }
  else { FAIL++; console.log(`FAIL: ${name}${extra ? ' -> ' + extra : ''}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, stepMs = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    let v; try { v = fn(); } catch (_) { v = false; }
    if (v) return v;
    await sleep(stepMs);
  }
  return false;
}

// ---------- fixtures ----------
const VID = i => `vid${String(i).padStart(5, '0')}xx`; // 11 chars [a-zA-Z0-9_-]
function makeVideos(n, { owner = true } = {}) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    out.push({
      playlistVideoRenderer: {
        videoId: VID(i),
        setVideoId: owner ? `SVI${i}` : undefined,
        title: { runs: [{ text: `Video ${i}` }] },
        shortBylineText: { runs: [{ text: `Channel ${i}` }] },
        lengthText: { simpleText: i % 2 ? '3:45' : '1:02:30' },
        lengthSeconds: String(i % 2 ? 225 : 3750),
        index: { simpleText: String(i) },
        thumbnail: { thumbnails: [{ url: `https://i.ytimg.com/vi/${VID(i)}/mqdefault.jpg`, width: 320, height: 180 }] },
      },
    });
  }
  return out;
}
function browseResponse(listId, videos, { continuation = null } = {}) {
  const items = videos.map(v => ({ ...v }));
  if (continuation) {
    items.push({ continuationItemRenderer: { continuationCommand: { token: continuation, commandMetadata: {} } } });
  }
  return {
    contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: [{ playlistVideoListRenderer: { contents: items, isPlaylist: true } }] } }] } } } }] } },
    header: { playlistHeaderRenderer: { title: { simpleText: 'My Test Playlist' } } },
    onResponseReceivedActions: [],
  };
}
function continuationResponse(videos, nextToken) {
  const items = videos.map(v => ({ ...v }));
  if (nextToken) items.push({ continuationItemRenderer: { continuationCommand: { token: nextToken } } });
  return { continuationContents: { appendContinuationItemsAction: { targetId: 'x', continuationItems: items } } };
}

// Build a fake YouTube DOM with a native playlist section containing rows
// linking to this playlist.
function buildYoutubeDom(doc, listId, count = 3) {
  doc.body.innerHTML = '';
  const app = doc.createElement('ytd-app');
  const browse = doc.createElement('ytd-browse');
  browse.setAttribute('page-subtype', 'playlist');
  const sec = doc.createElement('ytd-item-section-renderer');
  const hdr = doc.createElement('ytd-playlist-header-renderer');
  const mw = doc.createElement('div'); mw.className = 'metadata-wrapper';
  const yt = doc.createElement('yt-formatted-string'); yt.className = 'title'; yt.textContent = 'My Test Playlist';
  mw.appendChild(yt);
  const stats = doc.createElement('div'); stats.className = 'metadata-stats'; stats.textContent = '10 videos • 1 hr';
  hdr.appendChild(mw); hdr.appendChild(stats);
  const list = doc.createElement('ytd-playlist-video-list-renderer');
  for (let i = 1; i <= count; i++) {
    const row = doc.createElement('ytd-playlist-video-renderer');
    const a = doc.createElement('a');
    a.href = `/watch?v=${VID(i)}&list=${listId}&index=${i}`;
    a.textContent = `Native Video ${i}`;
    const img = doc.createElement('img'); img.src = `https://i.ytimg.com/vi/${VID(i)}/default.jpg`;
    row.appendChild(img); row.appendChild(a);
    list.appendChild(row);
  }
  sec.appendChild(hdr); sec.appendChild(list);
  browse.appendChild(sec);
  app.appendChild(browse);
  doc.body.appendChild(app);
  return { browse, sec, list };
}

// ---------- environment factory ----------
function makeEnv({ playlists = {}, authCookies = true } = {}) {
  // playlists: map listId -> total video count (served in pages of 100)
  const apiLog = { edit_playlist: [], browse: [], get_add_to_playlist: 0 };
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    url: 'https://www.youtube.com/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    cookieJar: (() => {
      const { CookieJar } = require('jsdom');
      const jar = new CookieJar();
      if (authCookies) {
        jar.setCookie('SAPISID=abc123', 'https://www.youtube.com');
        jar.setCookie('__Secure-1PAPISID=def456', 'https://www.youtube.com');
        jar.setCookie('__Secure-3PAPISID=ghi789', 'https://www.youtube.com');
      }
      return jar;
    })(),
  });
  const win = dom.window;
  if (!win.crypto || !win.crypto.subtle) {
    Object.defineProperty(win, 'crypto', { value: require('crypto').webcrypto, configurable: true });
  }
  // Real YouTube pages always expose ytcfg — provide the same globals.
  win.ytcfg = {
    _d: { INNERTUBE_API_KEY: 'TEST_API_KEY', INNERTUBE_CONTEXT: { client: { clientName: 'WEB', clientVersion: '2.20241101.00.00', hl: 'en', gl: 'US', visitorData: 'test' } }, SESSION_INDEX: 0 },
    get(k) { return this._d[k]; },
  };
  win.h = {}; // some yt code paths reference window.h; harmless here

  win.fetch = async (url, opts) => {
    const u = new URL(url);
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    const headers = (opts && opts.headers) || {};
    if (!u.pathname.startsWith('/youtubei/v1/')) return { ok: false, status: 404, text: async () => 'nf' };
    apiLog.browse.push({ path: u.pathname, body });
    // auth sanity check
    const auth = headers.Authorization || (headers.get && headers.get('Authorization'));
    if (u.pathname.includes('edit_playlist') && !auth) {
      return { ok: true, status: 200, json: async () => ({ status: 'STATUS_SUCCEEDED' }) };
    }
    if (u.pathname === '/youtubei/v1/browse' && body.continuation) {
      // token format: CONT:<listId>:<offset>:<total>
      const [, lid, off, total] = body.continuation.split(':');
      const o = parseInt(off, 10), t = parseInt(total, 10);
      const n = Math.min(100, t - o);
      const vids = makeVideos(n).map((v, i) => { // renumber to global index
        const g = o + i + 1;
        v.playlistVideoRenderer.videoId = VID(g);
        v.playlistVideoRenderer.setVideoId = `SVI${g}`;
        v.playlistVideoRenderer.index.simpleText = String(g);
        return v;
      });
      const next = o + n < t ? `CONT:${lid}:${o + n}:${t}` : null;
      return { ok: true, json: async () => continuationResponse(vids, next) };
    }
    if (u.pathname === '/youtubei/v1/browse' && body.browseId) {
      const lid = body.browseId.replace(/^VL/, '');
      const t = playlists[lid] != null ? playlists[lid] : 3;
      const n = Math.min(100, t);
      const resp = browseResponse(lid, makeVideos(n), { continuation: t > n ? `CONT:${lid}:${n}:${t}` : null });
      return { ok: true, json: async () => resp };
    }
    if (u.pathname === '/youtubei/v1/browse/edit_playlist') {
      apiLog.edit_playlist.push({ playlistId: body.playlistId, actions: body.actions, auth: !!auth });
      return { ok: true, json: async () => ({ status: 'STATUS_SUCCEEDED', playlistEditPlaylistAction: { targetPlaylist: { videoCount: 10 } } }) };
    }
    if (u.pathname === '/youtubei/v1/playlist/get_add_to_playlist') {
      apiLog.get_add_to_playlist++;
      return { ok: true, json: async () => ({
        playlists: [
          { playlistAddToOptionRenderer: { playlistId: 'PL_OWN_1', title: { simpleText: 'Own List 1' } } },
          { playlistAddToOptionRenderer: { playlistId: 'PL_OWN_2', title: { simpleText: 'Own List 2' } } },
          { playlistAddToOptionRenderer: { playlistId: 'RDWMAG5', title: { simpleText: 'Mix' } } },
        ],
      }) };
    }
    return { ok: false, status: 404, text: async () => 'unhandled ' + u.pathname };
  };

  win.eval(SRC);
  return { dom, win, apiLog };
}
const envs = []; // keep refs so we can destroy() at the end (watchdog intervals otherwise keep node alive)
const makeEnvTracked = (opts) => { const e = makeEnv(opts); envs.push(e); return e; };

const mounted = win => { const r = win.document.getElementById('ytpp-root'); return r && win.document.body.contains(r); };
const rowsOf = win => Array.from(win.document.querySelectorAll('#ytpp-root .ytpp-row'));
const rowIds = win => rowsOf(win).map(r => r.dataset.videoId);
const checkedRows = win => rowsOf(win).filter(r => r.querySelector('.ytpp-check input').checked);

(async () => {
  // ============================================================
  // T1: Hard page load into /playlist (initial boot, ytInitialData absent)
  // ============================================================
  {
    const { win, apiLog } = makeEnv({ playlists: { PL_T1: 5 } });
    buildYoutubeDom(win.document, 'PL_T1', 5);
    win.history.pushState({}, '', '/playlist?list=PL_T1');
    win.document.dispatchEvent(new win.Event('yt-navigate-finish'));
    const m = await waitFor(() => mounted(win), 8000);
    ok('T1 UI mounts on hard-load-equivalent nav', !!m);
    const gotRows = await waitFor(() => rowsOf(win).length === 5, 8000);
    ok('T1 renders all 5 rows via API fetch', !!gotRows, `rows=${rowsOf(win).length}`);
    ok('T1 checkboxes present on every row', rowsOf(win).every(r => r.querySelector('.ytpp-check input')));
    ok('T1 watch links include list param', rowsOf(win).every(r => r.querySelector('a.ytpp-title').getAttribute('href').includes('list=PL_T1')));
    ok('T1 thumbs are https', rowsOf(win).every(r => r.querySelector('img.ytpp-thumb').src.startsWith('https://')));
    ok('T1 native section hidden', !!win.document.querySelector('.ytpp-hide-native'));
    const metaTxt = win.document.querySelector('#ytpp-root .ytpp-meta').textContent;
    ok('T1 header shows count+duration', metaTxt.includes('5 videos') && /\dh \d+m/.test(metaTxt), metaTxt);
    ok('T1 ownerView detected (setVideoId present)', !metaTxt.includes('read-only'), metaTxt);
    win.__cleanup && win.__cleanup();
  }

  // ============================================================
  // T2: ytInitialData fast path (matches URL) — no browse fetch needed
  // ============================================================
  {
    const { win, apiLog } = makeEnv({});
    buildYoutubeDom(win.document, 'PL_T2', 4);
    win.ytInitialData = {
      microformat: { microformatDataRenderer: { urlCanonical: 'https://www.youtube.com/playlist?list=PL_T2' } },
      ...browseResponse('PL_T2', makeVideos(4)),
    };
    win.history.pushState({}, '', '/playlist?list=PL_T2');
    win.document.dispatchEvent(new win.Event('yt-navigate-finish'));
    const gotRows = await waitFor(() => rowsOf(win).length === 4, 8000);
    ok('T2 renders from ytInitialData', !!gotRows, `rows=${rowsOf(win).length}`);
    const fetchedBrowse = apiLog.browse.some(c => c.body.browseId);
    ok('T2 skips API browse when ytInitialData fresh', !fetchedBrowse);
  }

  // ============================================================
  // T3: Continuation pagination — 250 videos across 3 pages
  // ============================================================
  {
    const { win } = makeEnv({ playlists: { PL_T3: 250 } });
    buildYoutubeDom(win.document, 'PL_T3', 3);
    win.history.pushState({}, '', '/playlist?list=PL_T3');
    win.document.dispatchEvent(new win.Event('yt-navigate-finish'));
    const done = await waitFor(() => rowsOf(win).length === 250, 15000);
    ok('T3 paginated load reaches 250 rows', !!done, `rows=${rowsOf(win).length}`);
    const ids = rowIds(win);
    ok('T3 no duplicate videoIds', new Set(ids).size === ids.length);
    ok('T3 order preserved (first/last)', ids[0] === VID(1) && ids[249] === VID(250));
  }

  // ============================================================
  // T4: Selection logic — click, ctrl, shift-range, Esc, clear btn
  // ============================================================
  {
    const { win } = makeEnv({ playlists: { PL_T4: 6 } });
    buildYoutubeDom(win.document, 'PL_T4', 6);
    win.history.pushState({}, '', '/playlist?list=PL_T4');
    win.document.dispatchEvent(new win.Event('yt-navigate-finish'));
    await waitFor(() => rowsOf(win).length === 6, 8000);
    const rows = rowsOf(win);
    const clickLabel = (r, mods = {}) => {
      const label = r.querySelector('.ytpp-check');
      label.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, ...mods }));
    };
    clickLabel(rows[0]);
    ok('T4 single select -> toolbar visible w/ "1 selected"',
      !win.document.querySelector('.ytpp-toolbar').hidden &&
      win.document.querySelector('.ytpp-count').textContent === '1 selected');
    clickLabel(rows[2], { ctrlKey: true });
    ok('T4 ctrl-click adds to selection', checkedRows(win).length === 2);
    clickLabel(rows[5], { shiftKey: true });
    ok('T4 shift-click range-selects 2..5', checkedRows(win).length === 4);
    clickLabel(rows[5], { shiftKey: true }); // deselect range
    ok('T4 shift-click toggles range off', checkedRows(win).length === 2);
    rows[0].dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    ok('T4 Escape clears selection', checkedRows(win).length === 0 && win.document.querySelector('.ytpp-toolbar').hidden);
    // click again then use ✕ button
    clickLabel(rows[1]);
    win.document.querySelector('.ytpp-toolbar button[data-act="clear"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    ok('T4 clear button works', checkedRows(win).length === 0);
  }

  // ============================================================
  // T5: Drag reorder — simulate dragstart/dragover/drop end-to-end
  // ============================================================
  {
    const { win, apiLog } = makeEnv({ playlists: { PL_T5: 5 } });
    buildYoutubeDom(win.document, 'PL_T5', 5);
    win.history.pushState({}, '', '/playlist?list=PL_T5');
    win.document.dispatchEvent(new win.Event('yt-navigate-finish'));
    await waitFor(() => rowsOf(win).length === 5, 8000);
    const before = rowIds(win);
    // drag row 0 onto bottom half of row 3 => dropIndex 4
    const src = rowsOf(win)[0], tgt = rowsOf(win)[3];
    const mkDragEvt = (type, clientY) => {
      const ev = new win.Event(type, { bubbles: true, cancelable: true });
      ev.clientY = clientY;
      ev.dataTransfer = { setData: () => {}, getData: () => '', effectAllowed: '', dropEffect: '', setDragImage: () => {} };
      return ev;
    };
    // give rows fake bounding boxes (jsdom returns zeros)
    [src, tgt].forEach((r, i) => { r.getBoundingClientRect = () => ({ top: i * 60, bottom: i * 60 + 60, height: 60, left: 0, right: 100, width: 100 }); });
    win.requestAnimationFrame = cb => setTimeout(cb, 0);
    src.dispatchEvent(mkDragEvt('dragstart', 0));
    tgt.dispatchEvent(mkDragEvt('dragover', 50)); // bottom half => after target
    tgt.dispatchEvent(mkDragEvt('drop', 50));
    const moved = await waitFor(() => apiLog.edit_playlist.some(c => c.actions.length), 5000);
    ok('T5 drag triggers edit_playlist call', !!moved);
    if (moved) {
      const call = apiLog.edit_playlist.find(c => c.actions.length);
      const acts = call.actions;
      ok('T5 action uses ACTION_MOVE_VIDEO_BEFORE with successor anchor',
        acts[0].action === 'ACTION_MOVE_VIDEO_BEFORE' && acts[0].setVideoId === 'SVI1' && acts[0].movedSetVideoIdSuccessor === 'SVI5',
        JSON.stringify(acts));
      ok('T5 request authenticated', call.auth === true);
      ok('T5 optimistic UI reordered row1 -> position4', rowIds(win)[3] === VID(1) || rowIds(win)[4] === VID(1), rowIds(win).join(','));
    }
  }

  // ============================================================
  // T6: buildMoveActions pure logic (via top/bottom toolbar instead)
  // ============================================================
  {
    const { win, apiLog } = makeEnv({ playlists: { PL_T6: 5 } });
    buildYoutubeDom(win.document, 'PL_T6', 5);
    win.history.pushState({}, '', '/playlist?list=PL_T6');
    win.document.dispatchEvent(new win.Event('yt-navigate-finish'));
    await waitFor(() => rowsOf(win).length === 5, 8000);
    const rows = rowsOf(win);
    const clickLabel = (r) => r.querySelector('.ytpp-check').dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    clickLabel(rows[2]); clickLabel(rows[3]); // select SVI3, SVI4
    win.document.querySelector('.ytpp-toolbar button[data-act="top"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    const called = await waitFor(() => apiLog.edit_playlist.length >= 1, 5000);
    ok('T6 "Top" calls edit_playlist', !!called);
    if (called) {
      const acts = apiLog.edit_playlist[0].actions;
      ok('T6 Top anchors BEFORE first non-moving row (SVI1)',
        acts.length === 2 && acts.every(a => a.action === 'ACTION_MOVE_VIDEO_BEFORE' && a.movedSetVideoIdSuccessor === 'SVI1'),
        JSON.stringify(acts));
      ok('T6 Top preserves moving group order', acts[0].setVideoId === 'SVI3' && acts[1].setVideoId === 'SVI4');
    }
    apiLog.edit_playlist.length = 0;
    win.document.querySelector('.ytpp-toolbar button[data-act="bottom"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    const called2 = await waitFor(() => apiLog.edit_playlist.length >= 1, 5000);
    ok('T6 "Bottom" calls edit_playlist', !!called2);
    if (called2) {
      const acts = apiLog.edit_playlist[0].actions;
      ok('T6 Bottom uses AFTER w/ predecessor SVI5 & reverse order',
        acts.length === 2 && acts.every(a => a.action === 'ACTION_MOVE_VIDEO_AFTER' && a.movedSetVideoIdPredecessor === 'SVI5') &&
        acts[0].setVideoId === 'SVI4' && acts[1].setVideoId === 'SVI3', JSON.stringify(acts));
    }
  }

  // ============================================================
  // T7: Remove flow (confirm stubbed true) + optimistic removal
  // ============================================================
  {
    const { win, apiLog } = makeEnv({ playlists: { PL_T7: 4 } });
    buildYoutubeDom(win.document, 'PL_T7', 4);
    win.history.pushState({}, '', '/playlist?list=PL_T7');
    win.document.dispatchEvent(new win.Event('yt-navigate-finish'));
    await waitFor(() => rowsOf(win).length === 4, 8000);
    win.confirm = () => true;
    rowsOf(win)[1].querySelector('.ytpp-check').dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    win.document.querySelector('.ytpp-toolbar button[data-act="remove"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    const called = await waitFor(() => apiLog.edit_playlist.some(c => c.actions.some(a => a.action === 'ACTION_REMOVE_VIDEO')), 5000);
    ok('T7 remove sends ACTION_REMOVE_VIDEO w/ setVideoId', !!called &&
      apiLog.edit_playlist.flatMap(c => c.actions).some(a => a.action === 'ACTION_REMOVE_VIDEO' && a.setVideoId === 'SVI2'));
    const shrunk = await waitFor(() => rowsOf(win).length === 3, 5000);
    ok('T7 optimistic UI removes row', !!shrunk);
    // confirm=false path: nothing sent
    apiLog.edit_playlist.length = 0;
    win.confirm = () => false;
    rowsOf(win)[0].querySelector('.ytpp-check').dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    win.document.querySelector('.ytpp-toolbar button[data-act="remove"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(400);
    ok('T7 cancel-confirm sends nothing', apiLog.edit_playlist.length === 0);
  }

  // ============================================================
  // T8: Add-to / Move-to flows via pickPlaylist menu
  // ============================================================
  {
    const { win, apiLog } = makeEnv({ playlists: { PL_T8: 3 } });
    buildYoutubeDom(win.document, 'PL_T8', 3);
    win.history.pushState({}, '', '/playlist?list=PL_T8');
    win.document.dispatchEvent(new win.Event('yt-navigate-finish'));
    await waitFor(() => rowsOf(win).length === 3, 8000);
    rowsOf(win)[0].querySelector('.ytpp-check').dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    win.document.querySelector('.ytpp-toolbar button[data-act="add"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    const menuShown = await waitFor(() => win.document.querySelector('.ytpp-menu'), 5000);
    ok('T8 add opens playlist menu', !!menuShown);
    if (menuShown) {
      const items = Array.from(win.document.querySelectorAll('.ytpp-menu-item')).map(b => b.textContent);
      ok('T8 menu excludes current playlist & includes own lists', items.includes('Own List 1') && items.includes('Own List 2'), items.join('|'));
      win.document.querySelectorAll('.ytpp-menu-item')[0].dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      const added = await waitFor(() => apiLog.edit_playlist.some(c => c.playlistId === 'PL_OWN_1'), 5000);
      ok('T8 add posts ACTION_ADD_VIDEO to target playlist only', !!added &&
        apiLog.edit_playlist.filter(c => c.playlistId === 'PL_OWN_1').flatMap(c => c.actions)
          .every(a => a.action === 'ACTION_ADD_VIDEO' && a.addedVideoId === VID(1)));
      const noRemove = !apiLog.edit_playlist.some(c => c.playlistId === 'PL_T8');
      ok('T8 add does NOT remove from source playlist', noRemove);
      ok('T8 add clears selection', checkedRows(win).length === 0);
    }
    // move: add then remove from source
    apiLog.edit_playlist.length = 0;
    rowsOf(win)[1].querySelector('.ytpp-check').dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    win.document.querySelector('.ytpp-toolbar button[data-act="move"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    const menu2 = await waitFor(() => win.document.querySelector('.ytpp-menu'), 5000);
    if (menu2) {
      win.document.querySelectorAll('.ytpp-menu-item')[1].dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      const both = await waitFor(() =>
        apiLog.edit_playlist.some(c => c.playlistId === 'PL_OWN_2' && c.actions.some(a => a.action === 'ACTION_ADD_VIDEO')) &&
        apiLog.edit_playlist.some(c => c.playlistId === 'PL_T8' && c.actions.some(a => a.action === 'ACTION_REMOVE_VIDEO')), 6000);
      ok('T8 move = add to target THEN remove from source', !!both);
      const gone = await waitFor(() => rowsOf(win).length === 2, 5000);
      ok('T8 move updates local list optimistically', !!gone);
    }
    // escape closes menu without action
    apiLog.edit_playlist.length = 0;
    rowsOf(win)[0].querySelector('.ytpp-check').dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    win.document.querySelector('.ytpp-toolbar button[data-act="add"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await waitFor(() => win.document.querySelector('.ytpp-menu'), 3000);
    win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(300);
    ok('T8 Escape dismisses picker w/o API edits', !win.document.querySelector('.ytpp-menu') && apiLog.edit_playlist.length === 0);
  }

  // ============================================================
  // T9: Read-only playlist (no setVideoId) disables destructive buttons
  // ============================================================
  {
    const { win, apiLog } = makeEnv({});
    buildYoutubeDom(win.document, 'RD_MIX', 3);
    // serve a NON-owner playlist: strip setVideoId
    const origFetch = win.fetch;
    win.fetch = async (url, opts) => {
      const res = await origFetch(url, opts);
      const j = await res.json().catch(() => null);
      if (j && j.contents) {
        (function strip(o) {
          if (!o || typeof o !== 'object') return;
          if (o.playlistVideoRenderer) delete o.playlistVideoRenderer.setVideoId;
          for (const k in o) strip(o[k]);
        })(j);
      }
      return { ok: true, json: async () => j, text: async () => '' };
    };
    win.history.pushState({}, '', '/playlist?list=RD_MIX');
    win.document.dispatchEvent(new win.Event('yt-navigate-finish'));
    await waitFor(() => rowsOf(win).length === 3, 8000);
    const metaTxt = win.document.querySelector('#ytpp-root .ytpp-meta').textContent;
    ok('T9 read-only banner shown', metaTxt.includes('read-only'), metaTxt);
    rowsOf(win)[0].querySelector('.ytpp-check').dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    const disabled = ['top', 'bottom', 'move', 'remove'].every(a =>
      win.document.querySelector(`.ytpp-toolbar button[data-act="${a}"]`).disabled);
    ok('T9 destructive buttons disabled in read-only', disabled);
    ok('T9 add stays enabled in read-only', !win.document.querySelector('.ytpp-toolbar button[data-act="add"]').disabled);
    ok('T9 no grip handles rendered', win.document.querySelectorAll('#ytpp-root .ytpp-grip').length === 0);
  }

  // ============================================================
  // T10: Error handling — API failure keeps native list visible
  // ============================================================
  {
    const { win } = makeEnv({});
    buildYoutubeDom(win.document, 'PL_ERR', 2);
    win.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom', json: async () => ({}) });
    win.history.pushState({}, '', '/playlist?list=PL_ERR');
    win.document.dispatchEvent(new win.Event('yt-navigate-finish'));
    const errShown = await waitFor(() => win.document.querySelector('#ytpp-root .ytpp-error'), 8000);
    ok('T10 API error shows inline error message', !!errShown);
    ok('T10 native list NOT hidden on error', !win.document.querySelector('ytd-playlist-video-list-renderer').classList.contains('ytpp-hide-native'));
  }

  // ============================================================
  // T11: DOM-scrape fallback when API yields 0 videos
  // ============================================================
  {
    const { win } = makeEnv({});
    buildYoutubeDom(win.document, 'PL_SC', 3);
    win.fetch = async () => ({ ok: true, json: async () => ({ contents: { weird: { shape: 1 } } }), text: async () => '' });
    win.history.pushState({}, '', '/playlist?list=PL_SC');
    win.document.dispatchEvent(new win.Event('yt-navigate-finish'));
    const scraped = await waitFor(() => rowsOf(win).length === 3, 8000);
    ok('T11 DOM scrape fallback recovers native rows', !!scraped, `rows=${rowsOf(win).length}`);
    const metaTxt = win.document.querySelector('#ytpp-root .ytpp-meta').textContent;
    ok('T11 scraped list marked read-only', metaTxt.includes('read-only'), metaTxt);
  }

  // ============================================================
  // T12: Navigation guards
  // ============================================================
  {
    const { win, apiLog } = makeEnv({ playlists: { PL_A: 2, PL_B: 2 } });
    buildYoutubeDom(win.document, 'PL_A', 2);
    win.history.pushState({}, '', '/playlist?list=PL_A');
    win.document.dispatchEvent(new win.Event('yt-navigate-finish'));
    await waitFor(() => rowsOf(win).length === 2, 8000);
    ok('T12 mounted on PL_A', rowIds(win)[0] === VID(1));
    // SPA-nav to PL_B: replace section content accordingly
    buildYoutubeDom(win.document, 'PL_B', 2);
    win.history.pushState({}, '', '/playlist?list=PL_B');
    win.document.dispatchEvent(new win.Event('yt-navigate-start'));
    win.document.dispatchEvent(new win.Event('yt-navigate-finish'));
    const remountB = await waitFor(() => mounted(win) && rowIds(win).length === 2 && win.document.querySelector('a.ytpp-title').getAttribute('href').includes('list=PL_B'), 10000);
    ok('T12 SPA nav between playlists re-mounts with new data', !!remountB);
    // navigate to a watch page -> unmount
    win.history.pushState({}, '', '/watch?v=' + VID(1));
    win.document.dispatchEvent(new win.Event('yt-navigate-finish'));
    const unmounted = await waitFor(() => !mounted(win), 5000);
    ok('T12 leaves playlist page -> UI unmounts', !!unmounted);
    // back to playlist via popstate only (no yt events)
    buildYoutubeDom(win.document, 'PL_A', 2);
    win.history.pushState({}, '', '/playlist?list=PL_A');
    win.dispatchEvent(new win.Event('popstate'));
    const remountA = await waitFor(() => mounted(win) && rowsOf(win).length === 2, 10000);
    ok('T12 popstate-only navigation triggers mount', !!remountA);
    // spam redundant finish events — must not double-append rows
    for (let i = 0; i < 6; i++) win.document.dispatchEvent(new win.Event('yt-navigate-finish'));
    await sleep(1500);
    ok('T12 redundant events do not duplicate rows', rowsOf(win).length === 2, `rows=${rowsOf(win).length}`);
  }

  // ============================================================
  // T13: Watchdog recovery when NO events fire at all
  // ============================================================
  {
    const { win } = makeEnv({ playlists: { PL_WD: 2 } });
    // start on home; then plain location change simulated by pushState WITHOUT dispatching any yt event AND our wrapper event... to truly bypass, temporarily set history patched flag off? Simpler: rely on href-diff poller: assign via replaceState fires ytpp-location-changed too. To test the pure polling net, we mutate URL through history before listeners... Instead emulate worst case: section appears very late.
    win.history.pushState({}, '', '/playlist?list=PL_WD');
    win.document.dispatchEvent(new win.Event('yt-navigate-finish')); // boot bails: no section yet
    await sleep(600);
    ok('T13 not mounted while section missing', !mounted(win));
    buildYoutubeDom(win.document, 'PL_WD', 2); // section appears late, no events
    const recovered = await waitFor(() => mounted(win) && rowsOf(win).length === 2, 15000);
    ok('T13 watchdog auto-recovers late section (no reload needed)', !!recovered);
  }

  // ============================================================
  // T14: Security/validation regressions
  // ============================================================
  {
    const { win } = makeEnv({});
    buildYoutubeDom(win.document, 'PL_SEC', 1);
    // inject hostile ytInitialData
    const bad = makeVideos(1)[0];
    bad.playlistVideoRenderer.videoId = 'javascript:alert(1)'; // invalid id
    const good = makeVideos(1)[0];
    good.playlistVideoRenderer.thumbnail.thumbnails[0].url = 'javascript:evil()';
    good.playlistVideoRenderer.title.runs[0].text = '<img src=x onerror=alert(1)>';
    win.ytInitialData = {
      microformat: { microformatDataRenderer: { urlCanonical: 'https://www.youtube.com/playlist?list=PL_SEC' } },
      ...browseResponse('PL_SEC', [bad, good]),
    };
    win.history.pushState({}, '', '/playlist?list=PL_SEC');
    win.document.dispatchEvent(new win.Event('yt-navigate-finish'));
    await waitFor(() => rowsOf(win).length >= 1, 8000);
    const rs = rowsOf(win);
    ok('T14 invalid videoId row rejected', !rs.some(r => r.dataset.videoId.includes('javascript')));
    ok('T14 evil thumb URL sanitized to https fallback',
      rs.every(r => r.querySelector('img.ytpp-thumb').src.startsWith('https://')));
    ok('T14 HTML in title rendered as text (no XSS node)',
      !win.document.querySelector('#ytpp-root img[src="x"]') &&
      rs.every(r => !r.querySelector('a.ytpp-title').innerHTML.includes('<img')));
  }

  // ============================================================
  // T15: Reload button refreshes data (force=true path)
  // ============================================================
  {
    const { win, apiLog } = makeEnv({ playlists: { PL_RL: 2 } });
    buildYoutubeDom(win.document, 'PL_RL', 2);
    win.history.pushState({}, '', '/playlist?list=PL_RL');
    win.document.dispatchEvent(new win.Event('yt-navigate-finish'));
    await waitFor(() => rowsOf(win).length === 2, 8000);
    const browseBefore = apiLog.browse.filter(c => c.body.browseId).length;
    win.document.querySelector('.ytpp-reload').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    const refetched = await waitFor(() => apiLog.browse.filter(c => c.body.browseId).length > browseBefore, 6000);
    ok('T15 Reload button forces fresh API fetch', !!refetched);
    await sleep(500);
    ok('T15 Reload keeps exactly one set of rows', rowsOf(win).length === 2, `rows=${rowsOf(win).length}`);
  }

  // ============================================================
  // T16: No auth cookies -> write still attempted but reads fine; also
  //      SAPISIDHASH built correctly when logged in (check header format)
  // ============================================================
  {
    const { win } = makeEnv({ playlists: { PL_H: 1 } });
    buildYoutubeDom(win.document, 'PL_H', 1);
    let seenAuth = null;
    const orig = win.fetch;
    win.fetch = async (u, o) => { if (o && o.headers && o.headers.Authorization) seenAuth = o.headers.Authorization; return orig(u, o); };
    win.history.pushState({}, '', '/playlist?list=PL_H');
    win.document.dispatchEvent(new win.Event('yt-navigate-finish'));
    await waitFor(() => rowsOf(win).length === 1, 8000);
    ok('T16 Authorization contains all three hash forms',
      !!seenAuth && seenAuth.includes('SAPISIDHASH') && seenAuth.includes('SAPISID1PHASH') && seenAuth.includes('SAPISID3PHASH'),
      seenAuth);
  }

  console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
  process.exitCode = FAIL ? 1 : 0;
})().catch(e => { console.error('HARNESS ERROR:', e); process.exitCode = 2; });
