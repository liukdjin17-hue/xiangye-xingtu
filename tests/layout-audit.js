/* 布局体检：检查是否有元素超出父容器或页面宽度 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { pathToFileURL: fileURL } = require('url');
const { spawn } = require('child_process');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.env.CDP_PORT || 9340);
// 路径相对本脚本推导，整套目录搬走后仍可直接运行
// 测试入口带上 tour=0（不弹新手引导，免得遮住被测元素）
function withTestParams(u) {
  if (!u || /[?&]tour=0/.test(u)) return u;
  const parts = u.split('#');
  const base = parts[0];
  const hash = parts[1] ? '#' + parts[1] : '';
  return base + (base.indexOf('?') >= 0 ? '&' : '?') + 'tour=0' + hash;
}
const APP = withTestParams(process.env.APP_URL || fileURL(path.join(__dirname, '..', 'app', 'index.html')).href);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function getJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); }).on('error', reject);
  });
}

(async () => {
  const profile = path.join(os.tmpdir(), 'xyxt-audit-' + Date.now());
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--window-size=900,1400',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, '--no-first-run', APP + '#home'], { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 40; i++) {
    try { targets = await getJSON('http://127.0.0.1:' + PORT + '/json/list'); if (targets.length) break; } catch (e) {}
    await sleep(250);
  }
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
  await new Promise(r => { ws.onopen = r; });
  await send('Runtime.enable');
  await sleep(700);

  const evalIn = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };

  const audit = async (view, setup) => {
    if (setup) await evalIn(setup);
    await sleep(400);
    const r = await evalIn(`(() => {
      const bad = [];
      const pageW = document.documentElement.clientWidth;
      document.querySelectorAll('.view *').forEach(el => {
        const b = el.getBoundingClientRect();
        if (b.width === 0) return;
        if (b.right > pageW + 1.5 || b.left < -1.5) {
          bad.push({ tag: el.tagName, cls: (el.className || '').toString().slice(0, 24), left: Math.round(b.left), right: Math.round(b.right) });
        }
      });
      return { pageW, scrollW: document.documentElement.scrollWidth, overflow: bad.slice(0, 6), count: bad.length };
    })()`);
    console.log(view.padEnd(10), JSON.stringify(r));
    return r;
  };

  await audit('home', 'document.querySelector("[data-act=demo-student]").click()');
  await audit('map', 'document.querySelector(".tab[data-view=map]").click()');
  await audit('ask', 'document.querySelector(".tab[data-view=ask]").click()');
  await audit('task', 'document.querySelector(".tab[data-view=task]").click()');
  await audit('science', 'document.querySelector(".tab[data-view=science]").click()');
  await audit('test', 'document.querySelector(".tab[data-view=test]").click()');

  // 桌面宽度下的对比页
  await evalIn(`(() => { document.querySelector('.tab[data-view="map"]').click(); })()`);
  await sleep(300);
  await evalIn(`[...document.querySelectorAll('.career [data-cmp]')].slice(0,3).forEach(x=>x.click())`);
  await sleep(200);
  await evalIn(`document.querySelector('#cmpbar [data-act="go-compare"]').click()`);
  await audit('compare', null);

  // 手机宽度再体检一遍
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  for (const v of ['home', 'map', 'ask', 'compare']) {
    await evalIn(`document.querySelector('.tab[data-view="${v}"]').click()`);
    await audit('m:' + v, null);
  }

  chrome.kill();
  process.exit(0);
})();
