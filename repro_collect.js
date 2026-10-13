// Isolated repro of the collectVideosDeep traversal-order bug in content.js
'use strict';

// --- verbatim copies from content.js (current version) ---
function findPlaylistListInBrowse(d) {
  if (!d) return null;
  let found = null;
  (function walk(obj) {
    if (found || !obj || typeof obj !== 'object') return;
    if (obj.playlistVideoListRenderer) { found = obj.playlistVideoListRenderer; return; }
    if (obj.playlistPanelRenderer) { found = obj.playlistPanelRenderer; return; }
    for (const k in obj) walk(obj[k]);
  })(d);
  return found || d;
}
function parseRow(r) { return { videoId: r.videoId }; }
function collectVideosDeep(obj, out = [], depth = 0, seen = new Set()) {
  if (!obj || typeof obj !== 'object' || depth > 16) return out;
  const renderer = obj.playlistVideoRenderer || obj.playlistPanelVideoRenderer || obj.videoRenderer || obj.lockupViewModel;
  if (renderer) {
    const id = renderer.videoId || renderer.contentId;
    if (id && !seen.has(id)) {
      const v = parseRow(renderer);
      if (v) { seen.add(id); out.push(v); }
      return out; // no videos nested inside a video
    }
  }
  for (const k in obj) collectVideosDeep(obj[k], out, depth + 1, seen);
  return out;
}

// Realistic browse response shape: header sibling of contents.
const vids = [ { playlistVideoRenderer: { videoId: 'A' } }, { playlistVideoRenderer: { videoId: 'B' } } ];
const listR = { playlistVideoListRenderer: { contents: vids } };
const itemSec = { itemSectionRenderer: { contents: [listR] } };
const secList = { sectionListRenderer: { contents: [itemSec] } };
const tab = { tabRenderer: { content: secList } };
const twoCol = { twoColumnBrowseResultsRenderer: { tabs: [tab] } };
const data = {
  contents: twoCol,
  header: { playlistHeaderRenderer: { title: { simpleText: 'T' } } },
};

const list = findPlaylistListInBrowse(data);
console.log('container keys:', Object.keys(list));            // expect ['contents','isPlaylist']
console.log('collected:', JSON.stringify(collectVideosDeep(list).map(v => v.videoId)));

// Also test continuation token extraction order issue:
function findContinuationTokenDeep(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 20) return null;
  if (obj.continuationCommand?.token) return obj.continuationCommand.token;
  if (Array.isArray(obj)) { for (const it of obj) { const t = findContinuationTokenDeep(it, depth + 1); if (t) return t; } }
  else { for (const k in obj) { if (k === 'token' && typeof obj[k] === 'string' && obj[k].length > 40) return obj[k]; const t = findContinuationTokenDeep(obj[k], depth + 1); if (t) return t; } }
  return null;
}
const contData = {
  continuationContents: { appendContinuationItemsAction: { continuationItems: [
    { playlistVideoRenderer: { videoId: 'C' } },
    { continuationItemRenderer: { continuationCommand: { token: 'NEXT_PAGE_TOKEN_'.repeat(5) } } },
  ] } },
};
console.log('continuation token found:', !!findContinuationTokenDeep(contData));
