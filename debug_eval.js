const fs = require('fs');
const { JSDOM } = require('jsdom');
process.on('uncaughtException', e => console.log('UNCAUGHT:', e.stack.split('\n').slice(0, 5).join('\n')));
const SRC = fs.readFileSync('/workspace/content.js', 'utf8');
const dom = new JSDOM('<html><body></body></html>', { url: 'https://www.youtube.com/', runScripts: 'outside-only', pretendToBeVisual: true });
const win = dom.window;
win.fetch = async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => 'x' });
try { win.eval(SRC); console.log('eval OK'); } catch (e) { console.log('EVAL THREW:', e.message, e.stack.split('\n')[1]); }
setTimeout(() => { console.log('done waiting'); process.exit(0); }, 3000);
