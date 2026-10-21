import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const root = process.cwd();
const outDir = path.join(root, '.shots');
const port = 9333;
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
  '--no-first-run', `--remote-debugging-port=${port}`,
  `--user-data-dir=${path.join(outDir, 'ud2')}`, 'about:blank'
], { stdio: 'ignore' });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find(t => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('Chrome DevTools port never came up');
}

const url = 'file:///' + path.join(root, 'pages', 'dashboard.html').replace(/\\/g, '/');
const wsUrl = await getWsUrl();
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
const waiters = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  } else if (msg.method && waiters.has(msg.method)) {
    const arr = waiters.get(msg.method);
    waiters.delete(msg.method);
    arr.forEach(fn => fn(msg.params));
  }
};
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}
function once(method) {
  return new Promise(resolve => {
    if (!waiters.has(method)) waiters.set(method, []);
    waiters.get(method).push(resolve);
  });
}

await send('Page.enable');
await send('Runtime.enable');

async function setup(width, height) {
  await send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: true
  });
  const loaded = once('Page.loadEventFired');
  await send('Page.navigate', { url });
  await loaded;
  await sleep(1400);
}

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return res.result.value;
}

async function capture(name, clip) {
  const params = { format: 'png', fromSurface: true, captureBeyondViewport: true };
  if (clip) params.clip = { ...clip, scale: 1 };
  const { data } = await send('Page.captureScreenshot', params);
  fs.writeFileSync(path.join(outDir, name), Buffer.from(data, 'base64'));
}

async function review(width, height, label) {
  await setup(width, height);

  // Walk the page so every scroll-reveal fires, then return to the top.
  const total = await evaluate('document.body.scrollHeight');
  for (let y = 0; y < total; y += 500) {
    await evaluate(`window.scrollTo(0, ${y})`);
    await sleep(90);
  }
  await evaluate('window.scrollTo(0, 0)');
  await sleep(700);

  const metrics = await evaluate(`(() => {
    const vw = document.documentElement.clientWidth;
    const bad = [];
    document.querySelectorAll('body *').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > vw + 1 || r.left < -1)) {
        bad.push({ tag: el.tagName, cls: String(el.className).slice(0, 55), left: Math.round(r.left), right: Math.round(r.right) });
      }
    });
    const hidden = [...document.querySelectorAll('[data-animate].animate-init')].filter(el => !el.classList.contains('animated')).length;
    return { vw, scrollW: document.documentElement.scrollWidth, scrollH: document.body.scrollHeight, badCount: bad.length, bad: bad.slice(0, 8), unrevealed: hidden };
  })()`);

  await capture(`cdp-${label}-full.png`, { x: 0, y: 0, width, height: Math.min(metrics.scrollH, 12000) });
  for (const y of [0, Math.round(height * 0.45), height]) {
    await evaluate(`window.scrollTo(0, ${y})`);
    await sleep(350);
    await capture(`cdp-${label}-${y}.png`, { x: 0, y, width, height });
  }
  return metrics;
}

const results = {};
results['390'] = await review(390, 844, '390');
results['360'] = await review(360, 780, '360');

console.log(JSON.stringify(results, null, 2));
ws.close();
chrome.kill();
process.exit(0);
