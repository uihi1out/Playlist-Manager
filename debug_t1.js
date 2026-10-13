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
  const { win, apiLog } = makeEnv({ playlists: { PL_T1: 5 } });
  buildYoutubeDom(win.document, 'PL_T1', 5);
  win.history.pushState({}, '', '/playlist?list=PL_T1');
  win.document.dispatchEvent(new win.Event('yt-navigate-finish'));
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 200));
    const rows = Array.from(win.document.querySelectorAll('#ytpp-root .ytpp-row')).length;
    if (i % 5 === 0 || rows > 0) console.log(`t=${i*200}ms rows=${rows} mounted=${!!win.document.getElementById('ytpp-root')}`);
    if (rows >= 5) break;
  }
  console.log('api browse calls:', JSON.stringify(apiLog.browse.map(b => b.path + ':' + JSON.stringify(b.body).slice(0,60))));
  const em = win.document.querySelector('.ytpp-empty');
  console.log('empty msg:', em ? em.textContent : null);
  process.exit(0);
})();
