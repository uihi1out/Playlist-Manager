// Simulates YouTube SPA navigation to verify the extension auto-triggers
// without a page reload. Scenarios:
//  A) SPA nav, yt-navigate-* events DO fire (finish before section renders)
//  B) SPA nav, NO yt-navigate-* events at all (pushState only)
//  C) Section appears very late (>5s after boot bails) — watchdog recovers
'use strict';
const fs = require('fs');
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync('/workspace/content.js', 'utf8');

function makeDom(initialUrl) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`, {
    url: initialUrl,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const win = dom.window;
  // fetch stub: return empty-but-valid InnerTube response quickly
  win.fetch = async () => ({
    ok: true,
    json: async () => ({ contents: {} }),
  });
  win.eval(SRC);
  return { dom, win };
}

function renderPlaylistSection(win, listId, delayMs) {
  setTimeout(() => {
    const d = win.document;
    if (!d.querySelector('ytd-app')) {
      d.body.innerHTML = '<ytd-app><ytd-browse id="browse"></ytd-browse></ytd-app>';
    }
    const browse = d.querySelector('ytd-browse');
    browse.setAttribute('page-subtype', 'playlist');
    const sec = d.createElement('ytd-item-section-renderer');
    const list = d.createElement('ytd-playlist-video-list-renderer');
    const row = d.createElement('div');
    row.className = 'style-scope ytd-playlist-video-list-renderer';
    const a = d.createElement('a');
    a.href = `/watch?v=dQw4w9WgXcQ&list=${listId}&index=1`;
    row.appendChild(a);
    list.appendChild(row);
    sec.appendChild(list);
    browse.appendChild(sec);
  }, delayMs);
}

function isMounted(win) {
  return !!win.document.getElementById('ytpp-root') &&
         win.document.body.contains(win.document.getElementById('ytpp-root'));
}

async function scenario(name, fn) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (e) {
    console.log(`FAIL: ${name} -> ${e.message}`);
    process.exitCode = 1;
  } finally {
    // give pending timers a beat then let GC handle it
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // ---------- Scenario A: events fire, finish BEFORE section renders ----------
  await scenario('A: SPA nav with yt-navigate events -> mounts without reload', async () => {
    const { win } = makeDom('https://www.youtube.com/watch?v=abc');
    renderPlaylistSection(win, 'PL_TEST_A', 3000); // section 3s after nav event
    await sleep(1200); // on home page initially
    // simulate SPA nav to playlist: pushState + yt-navigate lifecycle
    win.history.pushState({}, '', '/playlist?list=PL_TEST_A');
    win.document.dispatchEvent(new win.Event('yt-navigate-start'));
    await sleep(100);
    win.document.dispatchEvent(new win.Event('yt-navigate-finish'));
    // At this point section doesn't exist yet; old code would bail forever.
    for (let i = 0; i < 120; i++) {
      if (isMounted(win)) break;
      await sleep(250);
    }
    if (!isMounted(win)) throw new Error('never mounted after SPA nav w/ events');
  });

  // ---------- Scenario B: no yt-navigate events at all (pushState only) ----------
  await scenario('B: SPA nav WITHOUT any yt-navigate events -> pushState hook mounts', async () => {
    const { win } = makeDom('https://www.youtube.com/feed/subscriptions');
    renderPlaylistSection(win, 'PL_TEST_B', 800);
    win.history.pushState({}, '', '/playlist?list=PL_TEST_B');
    for (let i = 0; i < 60; i++) {
      if (isMounted(win)) break;
      await sleep(250);
    }
    if (!isMounted(win)) throw new Error('never mounted after pushState-only nav');
  });

  // ---------- Scenario C: section arrives way after boot's 5s wait ----------
  await scenario('C: section renders >5s after boot bailed -> watchdog retries', async () => {
    const { win } = makeDom('https://www.youtube.com/');
    // hard-load straight into playlist: navigate first, then dispatch finish
    win.history.pushState({}, '', '/playlist?list=PL_TEST_C');
    win.document.dispatchEvent(new win.Event('yt-navigate-finish'));
    // section shows up after boot's 50x100ms loop has given up
    renderPlaylistSection(win, 'PL_TEST_C', 7000);
    for (let i = 0; i < 80; i++) {
      if (isMounted(win)) break;
      await sleep(250);
    }
    if (!isMounted(win)) throw new Error('watchdog never recovered from late section');
  });

  console.log('done');
})();
