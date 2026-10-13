const fs = require('fs');
const { JSDOM } = require('jsdom');
process.on('uncaughtException', e => console.log('UNCAUGHT:', e.stack.split('\n').slice(0, 5).join('\n')));
const SRC = fs.readFileSync('/workspace/content.js', 'utf8');
const dom = new JSDOM('<html><body></body></html>', { url: 'https://www.youtube.com/', runScripts: 'outside-only', pretendToBeVisual: true });
const win = dom.window;
win.fetch = async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => 'x' });

// bisect: try evaluating progressively larger prefixes? Simpler: wrap eval and log timing.
console.log('about to eval, SRC length', SRC.length);
try { win.eval(SRC); console.log('eval OK'); } catch (e) { console.log('EVAL THREW:', e.message, '\n', e.stack.split('\n')[1]); }
console.log('after eval sync');
setTimeout(() => { console.log('tick 1s'); }, 1000);
setTimeout(() => { console.log('done'); process.exit(0); }, 4000);
