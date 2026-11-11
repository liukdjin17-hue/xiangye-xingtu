/* v6.1 专项：60 题文案体检 → 答完停在提交卡（不再自动交卷）→ 补答后也要手动提交
   → 「重新测一次」两次确认 → 抽屉打开时数字键不误改答案 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { pathToFileURL: fileURL } = require('url');
const { spawn } = require('child_process');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.env.CDP_PORT || 9348);
const APP = process.env.APP_URL || (fileURL(path.join(__dirname, '..', 'app', 'index.html')).href + '?tour=0');
const SHOTS = path.join(__dirname, '..', '..', '测试截图');
fs.mkdirSync(SHOTS, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));

function getJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

(async () => {
  const profile = path.join(os.tmpdir(), 'xyxt-e2e-v7-' + Date.now());
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--window-size=900,1200',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check',
    APP
  ], { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 40; i++) {
    try { targets = await getJSON('http://127.0.0.1:' + PORT + '/json/list'); if (targets.length) break; } catch (e) {}
    await sleep(250);
  }
  if (!targets || !targets.length) { console.error('FAIL: 无法连接 Chrome'); process.exit(1); }
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);

  let id = 0;
  const pending = new Map();
  const consoleErrors = [];

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });

  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    } else if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception || {}).description);
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push(m.params.args.map(a => a.value || a.description).join(' '));
    }
  };

  await new Promise(r => { ws.onopen = r; });
  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(1500);

  const results = [];
  const evalIn = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception || {}));
    return r.result.value;
  };
  const shot = async name => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.data, 'base64'));
  };
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
  };

  try {
    /* ---------- 1. 60 题文案体检：改写后不许再有病句 ---------- */
    const copy = await evalIn(`(() => {
      const I = window.XYXT.ITEMS.map(x => x.t);
      const bad = [];
      I.forEach((t, i) => {
        if (/我愿意从事/.test(t)) bad.push((i + 1) + ' 我愿意从事…');
        if (/我能够.*能够/.test(t)) bad.push((i + 1) + ' 重复“能够”');
        if (/我能够(去|当|做|在)/.test(t)) bad.push((i + 1) + ' 我能够+动词');
        if (/从事(去|当|做|在)/.test(t)) bad.push((i + 1) + ' 从事+动词');
        if (!/。$/.test(t)) bad.push((i + 1) + ' 缺句号');
        if (t.length < 10 || t.length > 40) bad.push((i + 1) + ' 长度 ' + t.length);
      });
      const dup = I.length - new Set(I).size;
      const dims = window.XYXT.ITEMS.map(x => x.d).join('');
      return { n: I.length, bad, dup, dims, first: I[0], last: I[59] };
    })()`);
    check('60 条题目无病句、无重复、长度适中',
      copy.n === 60 && copy.bad.length === 0 && copy.dup === 0,
      JSON.stringify(copy.bad.slice(0, 6)) + ' n=' + copy.n + ' dup=' + copy.dup);
    check('维度与题号映射未变（R×10 I×10 A×10 S×10 E×10 C×10）',
      copy.dims === 'R'.repeat(10) + 'I'.repeat(10) + 'A'.repeat(10) + 'S'.repeat(10) + 'E'.repeat(10) + 'C'.repeat(10),
      copy.dims);

    /* ---------- 2. 全新开始（老数据清掉），答完 60 题停在提交卡 ---------- */
    const stop = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      document.querySelector('.tab[data-view="test"]').click();
      await s(300);
      const rt = document.querySelector('[data-act="retest"]');
      if (rt) { rt.click(); await s(160); const rt2 = document.querySelector('[data-act="retest"]'); if (rt2) rt2.click(); await s(320); }
      const st0 = document.querySelector('[data-act="start-test"]');
      if (st0) { st0.click(); await s(200); const st1 = document.querySelector('[data-act="start-test"]'); if (st1) st1.click(); await s(320); }
      for (let i = 0; i < 60; i++) {
        const btns = [...document.querySelectorAll('#scale button')];
        if (!btns.length) break;
        btns[i % 5].click();
        await s(230);
      }
      await s(500);
      const st = window.XYXT_APP.state();
      const card = document.getElementById('qsubmit');
      const sub = document.querySelector('[data-act="submit-test"]');
      const nextBtn = document.querySelector('[data-act="next-q"]');
      return {
        answered: Object.keys(st.answers).length,
        result: !!st.result,
        testing: st.testing,
        card: !!card,
        cardText: card ? card.innerText.replace(/\\n+/g, ' ').slice(0, 40) : '',
        submitLabel: sub ? sub.textContent.trim() : '',
        review: !!document.querySelector('[data-act="review-all"]'),
        nextLabel: nextBtn ? nextBtn.textContent.trim() : '',
        step: (document.body.innerText.match(/第 (\\d+) \\/ (\\d+) 题/) || []).slice(1).join('/'),
        gate: !!document.getElementById('qgate'),
        warn: !!document.querySelector('.warn-note')
      };
    })()`);
    check('答完 60 题：停在提交卡，没有自动出结果',
      stop.answered === 60 && !stop.result && stop.testing && stop.card && !stop.gate && !stop.warn && stop.step === '60/60',
      JSON.stringify(stop));
    check('提交卡有「提交」与「从头检查一遍」，最后一题按钮改叫「答完了，下一步」',
      /提交并生成我的星图/.test(stop.submitLabel) && stop.review && /答完了/.test(stop.nextLabel),
      JSON.stringify({ submit: stop.submitLabel, review: stop.review, next: stop.nextLabel }));
    await shot('v7-submit-card');

    /* ---------- 3. 「从头检查一遍」：回到第 1 题，答案不丢，提交卡还在 ---------- */
    const review = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      document.querySelector('[data-act="review-all"]').click();
      await s(450);
      const st = window.XYXT_APP.state();
      return {
        cursor: st.cursor,
        answered: Object.keys(st.answers).length,
        step: (document.body.innerText.match(/第 (\\d+) \\/ (\\d+) 题/) || []).slice(1).join('/'),
        card: !!document.getElementById('qsubmit'),
        result: !!st.result
      };
    })()`);
    check('点「从头检查一遍」回到第 1 题，答案与提交卡都在',
      review.cursor === 0 && review.step === '1/60' && review.answered === 60 && review.card && !review.result,
      JSON.stringify(review));

    /* ---------- 4. 按提交才出结果 ---------- */
    const submit = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      document.querySelector('[data-act="submit-test"]').click();
      await s(650);
      const st = window.XYXT_APP.state();
      return {
        result: !!st.result,
        answered: st.result ? st.result.answered : 0,
        code: st.result ? st.result.code : '',
        testing: st.testing,
        card: !!document.getElementById('qsubmit'),
        warn: !!document.querySelector('.warn-note')
      };
    })()`);
    check('按「提交并生成我的星图」后出结果，60 题全计分',
      submit.result && submit.answered === 60 && /^[RIASEC]{3}$/.test(submit.code) &&
      !submit.testing && !submit.card && !submit.warn,
      JSON.stringify(submit));
    await shot('v7-result');

    /* ---------- 5. 核心回归：补答完不再自动提交 ---------- */
    const regress = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      /* 重测：点两次才清空 */
      const r1 = document.querySelector('[data-act="retest"]');
      if (r1) { r1.click(); await s(180); }
      const r2 = document.querySelector('[data-act="retest"]');
      if (r2) r2.click();
      await s(360);
      /* 跳第 1 题、第 59 题，其余答完 */
      document.querySelector('[data-act="skip-q"]').click();
      await s(240);
      for (let i = 1; i < 58; i++) {
        const b = document.querySelectorAll('#scale button');
        if (!b.length) break;
        b[1].click();
        await s(230);
      }
      document.querySelector('[data-act="skip-q"]').click();
      await s(240);
      document.querySelectorAll('#scale button')[1].click();
      await s(600);
      const gate = !!document.getElementById('qgate');
      const resultAtGate = !!window.XYXT_APP.state().result;
      document.querySelector('[data-act="gate-fill"]').click();
      await s(420);
      const atFirst = (document.body.innerText.match(/第 (\\d+) \\/ (\\d+) 题/) || []).slice(1).join('/');
      document.querySelectorAll('#scale button')[2].click();
      await s(330);
      document.querySelector('[data-jump="58"]').click();
      await s(360);
      document.querySelectorAll('#scale button')[2].click();
      await s(360);
      /* 回到第 60 题再答一次 → 应该出现提交卡，而不是结果 */
      const b60 = document.querySelectorAll('#scale button');
      b60[2].click();
      await s(650);
      const st = window.XYXT_APP.state();
      const card = document.getElementById('qsubmit');
      return {
        gate, resultAtGate, atFirst,
        answered: Object.keys(st.answers).length,
        resultBeforeSubmit: !!st.result,
        card: !!card,
        gateAfter: !!document.getElementById('qgate'),
        step: (document.body.innerText.match(/第 (\\d+) \\/ (\\d+) 题/) || []).slice(1).join('/')
      };
    })()`);
    check('跳过 2 题 → 答完最后一题先弹闸门（不交卷）',
      regress.gate && !regress.resultAtGate, JSON.stringify(regress));
    check('补答完这两题后停在提交卡，没有被自动交卷',
      regress.answered === 60 && !regress.resultBeforeSubmit && regress.card && !regress.gateAfter,
      JSON.stringify(regress));

    const regressSubmit = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      document.querySelector('[data-act="submit-test"]').click();
      await s(700);
      const st = window.XYXT_APP.state();
      return {
        result: !!st.result,
        answered: st.result ? st.result.answered : 0,
        warn: !!document.querySelector('.warn-note')
      };
    })()`);
    check('补答后手动提交：结果是完整的 60 题，没有「未作答」提示',
      regressSubmit.result && regressSubmit.answered === 60 && !regressSubmit.warn,
      JSON.stringify(regressSubmit));

    /* ---------- 6. 「重新测一次」两次确认 ---------- */
    const arm = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      const before = Object.keys(window.XYXT_APP.state().answers).length;
      const b = document.querySelector('[data-act="retest"]');
      b.click();
      await s(320);
      return {
        before,
        afterFirstClick: Object.keys(window.XYXT_APP.state().answers).length,
        stillResult: !!window.XYXT_APP.state().result,
        label: document.querySelector('[data-act="retest"]').textContent.trim(),
        cancel: !!document.querySelector('[data-act="retest-cancel"]')
      };
    })()`);
    check('「重新测一次」点第一次不会清空，只要求确认',
      arm.before === 60 && arm.afterFirstClick === 60 && arm.stillResult &&
      /确认/.test(arm.label) && arm.cancel,
      JSON.stringify(arm));
    await shot('v7-retest-arm');

    const disarm = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      document.querySelector('[data-act="retest-cancel"]').click();
      await s(320);
      return {
        answers: Object.keys(window.XYXT_APP.state().answers).length,
        label: document.querySelector('[data-act="retest"]').textContent.trim(),
        cancel: !!document.querySelector('[data-act="retest-cancel"]')
      };
    })()`);
    check('点「算了」撤销，答案原样保留',
      disarm.answers === 60 && /重新测一次/.test(disarm.label) && !disarm.cancel, JSON.stringify(disarm));

    const reallyReset = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      const a = document.querySelector('[data-act="retest"]');
      a.click(); await s(200);
      const b = document.querySelector('[data-act="retest"]');
      if (b) b.click();
      await s(450);
      const st = window.XYXT_APP.state();
      return {
        answers: Object.keys(st.answers).length,
        result: !!st.result,
        testing: st.testing,
        scale: !!document.querySelector('#scale button'),
        step: (document.body.innerText.match(/第 (\\d+) \\/ (\\d+) 题/) || []).slice(1).join('/')
      };
    })()`);
    check('连点两次才真正清空，回到第 1 题',
      reallyReset.answers === 0 && !reallyReset.result && reallyReset.testing &&
      reallyReset.scale && reallyReset.step === '1/60',
      JSON.stringify(reallyReset));

    /* ---------- 7. 抽屉打开时数字键不该改答案 ---------- */
    const kbd = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      /* 先在第 1 题答一个值，作为对照 */
      document.querySelectorAll('#scale button')[1].click();
      await s(330);
      const cursor0 = window.XYXT_APP.state().cursor;
      const before = JSON.stringify(window.XYXT_APP.state().answers);
      window.XYXT_APP.openSettings();
      await s(450);
      const sheeted = document.body.classList.contains('sheeting');
      for (let k = 1; k <= 5; k++) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: String(k), bubbles: true }));
      }
      await s(250);
      const after = JSON.stringify(window.XYXT_APP.state().answers);
      const cursor1 = window.XYXT_APP.state().cursor;
      document.querySelector('[data-act="close-sheet"]') && document.querySelector('[data-act="close-sheet"]').click();
      await s(350);
      return { sheeted, before, after, cursor0, cursor1, same: before === after };
    })()`);
    check('设置抽屉打开时按 1—5 不会偷偷改答案',
      kbd.sheeted && kbd.same && kbd.cursor0 === kbd.cursor1, JSON.stringify(kbd));

    const kbd2 = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      window.XYXT_APP.go('test');
      await s(350);
      const cursor = window.XYXT_APP.state().cursor;
      const id = window.XYXT.ITEMS[cursor].id;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '5', bubbles: true }));
      await s(330);
      return { value: window.XYXT_APP.state().answers[id], cursor };
    })()`);
    check('没有抽屉时键盘 1—5 仍能正常打分',
      kbd2.value === 5, JSON.stringify(kbd2));

    /* ---------- 8. 答完刷新：首页说「还差最后一步」，不是「没做完」 ---------- */
    const finishAll = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      window.XYXT_APP.go('test');
      await s(250);
      const t = document.querySelector('[data-act="start-test"]');
      if (t) { t.click(); await s(220); const t2 = document.querySelector('[data-act="start-test"]'); if (t2) t2.click(); await s(350); }
      for (let i = 0; i < 60; i++) {
        const b = document.querySelectorAll('#scale button');
        if (!b.length) break;
        b[3].click();
        await s(230);
      }
      await s(500);
      return { card: !!document.getElementById('qsubmit'), answered: Object.keys(window.XYXT_APP.state().answers).length };
    })()`);
    await send('Page.reload', { ignoreCache: false });
    await sleep(2000);
    const afterReload = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      document.querySelector('.tab[data-view="home"]').click();
      await s(400);
      const box = document.querySelector('.resume-card');
      const btn = box ? box.querySelector('[data-act="resume-test"]') : null;
      const label = btn ? btn.textContent.trim() : '';
      if (btn) { btn.click(); await s(500); }
      return {
        head: box ? box.querySelector('h4').textContent.trim() : '',
        label,
        text: box ? box.innerText.replace(/\\n+/g, ' ') : '',
        card: !!document.getElementById('qsubmit'),
        step: (document.body.innerText.match(/第 (\\d+) \\/ (\\d+) 题/) || []).slice(1).join('/')
      };
    })()`);
    check('答完 60 题刷新后，首页写「都答完了，还差最后一步」而不是「没做完」',
      finishAll.card && finishAll.answered === 60 && /都答完了/.test(afterReload.head) && !/没做完/.test(afterReload.text),
      JSON.stringify({ finishAll, afterReload }));
    check('首页「去提交」直接落到提交卡那一题',
      /去提交/.test(afterReload.label) && afterReload.card && afterReload.step === '60/60',
      JSON.stringify(afterReload));

    /* ---------- 9. 390px 下提交卡不横向溢出 ---------- */
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(700);
    const mobile = await evalIn(`(() => {
      const g = document.getElementById('qsubmit');
      const box = g ? g.getBoundingClientRect() : null;
      return {
        scrollW: document.documentElement.scrollWidth,
        vw: window.innerWidth,
        card: !!g,
        right: box ? Math.round(box.right) : 0,
        inner: g ? g.scrollWidth <= g.clientWidth + 1 : false
      };
    })()`);
    await shot('v7-mobile-submit');
    check('390px：提交卡不横向溢出',
      mobile.card && mobile.scrollW <= mobile.vw + 1 && mobile.right <= mobile.vw + 1 && mobile.inner,
      JSON.stringify(mobile));
    await send('Emulation.clearDeviceMetricsOverride');

    /* ---------- 10. 界面体检：7 个视图都不白屏、无重复 id、无空按钮、主按钮点击区够大 ---------- */
    const health = await evalIn(`(async () => {
      const s = ms => new Promise(r => setTimeout(r, ms));
      const views = ['home', 'test', 'map', 'compare', 'ask', 'task', 'science'];
      const blank = [], dups = [], emptyBtn = [], smallTap = [], noLabel = [];
      for (const v of views) {
        window.XYXT_APP.go(v);
        await s(300);
        const cards = document.querySelectorAll('#view .card').length;
        if (!cards) blank.push(v);
        const seen = new Map();
        document.querySelectorAll('[id]').forEach(el => seen.set(el.id, (seen.get(el.id) || 0) + 1));
        [...seen.entries()].filter(([, n]) => n > 1).forEach(([i, n]) => dups.push(v + '#' + i + '×' + n));
        document.querySelectorAll('button, a.btn').forEach(b => {
          const t = (b.textContent || '').trim();
          const al = b.getAttribute('aria-label') || b.getAttribute('title') || '';
          if (!t && !al) emptyBtn.push(v + ':' + (b.dataset.act || b.className || b.tagName));
          if (b.classList.contains('btn')) {
            const r = b.getBoundingClientRect();
            if (r.width > 0 && (r.width < 28 || r.height < 24)) smallTap.push(v + ':' + t.slice(0, 6) + '(' + Math.round(r.width) + 'x' + Math.round(r.height) + ')');
          }
        });
        document.querySelectorAll('input:not([type=checkbox]):not([type=radio]), textarea, select').forEach(el => {
          const hasLabel = el.id && document.querySelector('label[for="' + el.id + '"]');
          const aria = el.getAttribute('aria-label') || el.getAttribute('placeholder');
          if (!hasLabel && !el.closest('label') && !aria) noLabel.push(v + ':' + (el.id || el.tagName));
        });
      }
      window.XYXT_APP.go('home');
      await s(200);
      return { blank, dups, emptyBtn, smallTap, noLabel };
    })()`);
    check('7 个视图都有内容、无重复 id、无空按钮、主按钮点击区达标',
      health.blank.length === 0 && health.dups.length === 0 &&
      health.emptyBtn.length === 0 && health.smallTap.length === 0,
      JSON.stringify(health));

    /* ---------- 11. 版本与缓存名 ---------- */
    const ver = await evalIn(`(() => ({
      version: window.XYXT_APP.version,
      fromHtml: [...document.querySelectorAll('script[src],link[rel=stylesheet]')].map(e => e.src || e.href).filter(u => !/\\?v=8/.test(u))
    }))()`);
    check('版本 6.2.0，页面资源都带 ?v=8',
      /^6\.2\.0$/.test(ver.version) && ver.fromHtml.length === 0, JSON.stringify(ver));

    const swText = fs.readFileSync(path.join(__dirname, '..', 'app', 'sw.js'), 'utf8');
    check('Service Worker 缓存名升到 xyxt-v8（否则老用户拿不到新代码）',
      /xyxt-v8/.test(swText) && !/xyxt-v7/.test(swText), swText.match(/CACHE = '[^']+'/)[0]);

    /* ---------- 12. 无未捕获脚本错误 ---------- */
    check('无未捕获脚本错误', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 300));

  } catch (e) {
    check('执行过程无异常', false, e.message);
  }

  const passed = results.filter(r => r.ok).length;
  console.log('\n' + passed + '/' + results.length + ' passed');
  fs.writeFileSync(path.join(SHOTS, 'e2e-v7-report.json'), JSON.stringify(results, null, 2));

  ws.close();
  chrome.kill();
  process.exit(passed === results.length ? 0 : 1);
})();
