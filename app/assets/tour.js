/* 乡野星图 · 新手引导 v4
 * ─────────────────────────────────────────────────────────────
 * 做法：聚光灯（一个大矩形 + 9000px 外阴影）抠出目标，旁边浮一张说明卡。
 * 为什么不用第三方库：整套引导就 200 行，引一个库反而要多几百 KB 和一次网络请求。
 *
 * 特性：
 *   · 目标找不到 / 被隐藏时自动跳过该步，不会卡住
 *   · 支持滚动与窗口尺寸变化重定位
 *   · 键盘：← 上一步、→ 下一步、Esc 跳过
 *   · 读屏：卡片为 dialog，步骤变化通过 aria-live 播报
 */
(function () {
  'use strict';

  const STEPS = [
    {
      sel: '.brand',
      title: '这里是乡野星图',
      text: '面向县乡中学生的职业探索工作台。右上角是「我的设置」：改称呼、重看引导、导出备份、调小星星都在这儿。',
      place: 'bottom'
    },
    {
      sel: '#tabs',
      title: '七个入口，一条主线',
      text: '主线是：兴趣测评 → 看职业星图 → 对比方向 → 问问题 → 做任务。教师端是给老师用的独立页面（teacher.html），学生端不占位置。',
      place: 'bottom'
    },
    {
      sel: '[data-view="test"]',
      title: '兴趣测评：60 道题，约 8 分钟',
      text: '没有标准答案，凭第一感觉选。中途退出不要紧，下次进来会停在你上次那一题。做完会得到一个三码兴趣代码，比如 CSR。',
      place: 'bottom'
    },
    {
      sel: '[data-view="map"]',
      title: '职业星图：29 个真实职业',
      text: '每个职业都写了「真实的一天、怎么入行、学历门槛、本地有没有岗」。点卡片看详情，☆ 收藏，⊕ 加入对比。',
      place: 'bottom'
    },
    {
      sel: '[data-view="compare"]',
      title: '职业对比：别凭感觉选',
      text: '最多选 3 个并排看：一天怎么过、门槛多高、收入量级、本地机会、最坑的地方。看清代价再决定先试哪个。',
      place: 'bottom'
    },
    {
      sel: '[data-view="ask"]',
      title: '问问学长：职业问题问答',
      text: '打字或按住麦克风说话都行，带口音没关系，识别结果可以先改字再发。回答来自内置知识库，断网也能用。',
      place: 'bottom'
    },
    {
      sel: '[data-view="task"]',
      title: '探索任务：每周一件小事',
      text: '想不清楚的时候，先做一件具体的小事：问一位在行的人、查一次招生简章。打卡记录会一直留在本机。',
      place: 'bottom'
    },
    {
      sel: '#starFab',
      title: '小星星：随时喊它',
      text: '点右下角这颗星，问它「这个按钮是干什么的」「报告在哪导出」「小星星你是谁」，它会直接告诉你，还能帮你跳过去。',
      place: 'left'
    },
    {
      sel: '#btnUser',
      title: '你的记录，都在本机',
      text: '测评结果、收藏、对话、打卡都存在这台设备上，关掉再打开还在。换电脑时在这里导出备份，到新电脑导入就接上了。',
      place: 'bottom'
    }
  ];

  let layer = null;
  let idx = 0;
  let running = false;
  let steps = [];
  let onDone = null;
  let onSkip = null;

  function el(html) {
    const d = document.createElement('div');
    d.innerHTML = html;
    return d.firstElementChild;
  }

  function visible(node) {
    if (!node) return false;
    const r = node.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const st = getComputedStyle(node);
    return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.05;
  }

  function pickSteps() {
    return STEPS.filter(s => {
      const node = document.querySelector(s.sel);
      return visible(node);
    });
  }

  function ensureLayer() {
    if (layer && document.body.contains(layer)) return layer;
    layer = el(`
      <div class="tour" id="tourLayer" hidden>
        <div class="tour-dim" id="dimTop"></div>
        <div class="tour-dim" id="dimBottom"></div>
        <div class="tour-dim" id="dimLeft"></div>
        <div class="tour-dim" id="dimRight"></div>
        <div class="tour-hole" id="tourHole"></div>
        <div class="tour-card" id="tourCard" role="dialog" aria-modal="true" aria-labelledby="tourTitle">
          <div class="tour-k" id="tourK"></div>
          <h3 id="tourTitle"></h3>
          <p class="tour-text" id="tourText"></p>
          <div class="tour-acts">
            <button type="button" class="btn small" data-tour="skip">跳过引导</button>
            <span class="tour-spacer"></span>
            <button type="button" class="btn small" data-tour="prev">上一步</button>
            <button type="button" class="btn small primary" data-tour="next">下一步</button>
          </div>
          <div class="tour-dots" id="tourDots"></div>
        </div>
      </div>`);
    document.body.appendChild(layer);

    layer.addEventListener('click', e => {
      const b = e.target.closest('[data-tour]');
      if (!b) {
        // 点遮罩空白处 = 下一步（与多数引导一致，但不吞掉卡片内点击）
        if (e.target === layer) next();
        return;
      }
      const a = b.dataset.tour;
      if (a === 'next') next();
      else if (a === 'prev') prev();
      else if (a === 'skip') finish(true);
    });
    return layer;
  }

  /* 挖洞的遮罩：上/下/左/右四块拼起来。
     早先用的是一个 9000px spread 的 box-shadow，Chrome 会直接不画，所以改成实体块。 */
  function paintDim(g) {
    const boxes = {
      dimTop: [0, 0, g.vw, g.top],
      dimBottom: [0, g.top + g.h, g.vw, g.vh - (g.top + g.h)],
      dimLeft: [0, g.top, g.left, g.h],
      dimRight: [g.left + g.w, g.top, g.vw - (g.left + g.w), g.h]
    };
    Object.keys(boxes).forEach(k => {
      const d = document.getElementById(k);
      if (!d) return;
      const b = boxes[k];
      d.style.left = b[0] + 'px';
      d.style.top = b[1] + 'px';
      d.style.width = Math.max(0, b[2]) + 'px';
      d.style.height = Math.max(0, b[3]) + 'px';
    });
  }

  function place(step) {
    const target = document.querySelector(step.sel);
    if (!target) return false;
    const r = target.getBoundingClientRect();
    const hole = document.getElementById('tourHole');
    const card = document.getElementById('tourCard');
    const pad = 6;

    const top = Math.max(r.top - pad, 4);
    const left = Math.max(r.left - pad, 4);
    const w = Math.min(r.width + pad * 2, window.innerWidth - 8);
    const h = Math.min(r.height + pad * 2, window.innerHeight - 8);

    hole.style.top = top + 'px';
    hole.style.left = left + 'px';
    hole.style.width = w + 'px';
    hole.style.height = h + 'px';

    // 先让卡片进入布局才能量高度
    card.style.visibility = 'hidden';
    card.classList.toggle('on', true);
    const ch = card.offsetHeight;
    const cw = card.offsetWidth;
    const gap = 14;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    paintDim({ top, left, w, h, vw, vh });

    let cTop, cLeft;
    const spaceBelow = vh - (r.bottom + gap);
    const spaceAbove = r.top - gap;
    const want = step.place || 'bottom';

    if (want === 'left' && r.left - cw - gap > 8) {
      cTop = r.top + r.height / 2 - ch / 2;
      cLeft = r.left - cw - gap;
    } else if (spaceBelow >= ch + 8 || spaceBelow >= spaceAbove) {
      cTop = r.bottom + gap;
      cLeft = r.left + r.width / 2 - cw / 2;
    } else {
      cTop = r.top - ch - gap;
      cLeft = r.left + r.width / 2 - cw / 2;
    }

    cTop = Math.max(10, Math.min(cTop, vh - ch - 10));
    cLeft = Math.max(10, Math.min(cLeft, vw - cw - 10));
    card.style.top = cTop + 'px';
    card.style.left = cLeft + 'px';
    card.style.visibility = 'visible';
    card.classList.toggle('above', cTop < r.top);
    return true;
  }

  function paint() {
    const step = steps[idx];
    if (!step) { finish(false); return; }
    document.getElementById('tourK').textContent = '第 ' + (idx + 1) + ' / ' + steps.length + ' 步';
    document.getElementById('tourTitle').textContent = step.title;
    document.getElementById('tourText').textContent = step.text;
    document.getElementById('tourDots').innerHTML = steps
      .map((s, i) => `<i class="${i === idx ? 'on' : ''}"></i>`).join('');

    const card = document.getElementById('tourCard');
    card.setAttribute('aria-live', 'polite');

    const prevBtn = card.querySelector('[data-tour="prev"]');
    if (prevBtn) prevBtn.disabled = idx === 0;
    const nextBtn = card.querySelector('[data-tour="next"]');
    if (nextBtn) nextBtn.textContent = idx === steps.length - 1 ? '开始使用' : '下一步';

    // 目标可能在屏幕外：先滚进来再定位
    const target = document.querySelector(step.sel);
    if (target) {
      const r = target.getBoundingClientRect();
      const out = r.top < 60 || r.bottom > window.innerHeight - 60;
      if (out) {
        try { target.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { target.scrollIntoView(); }
        setTimeout(() => place(step), 320);
        place(step);
      } else {
        place(step);
      }
    }
    const btn = document.querySelector('#tourCard [data-tour="next"]');
    if (btn) btn.focus({ preventScroll: true });
  }

  function next() {
    if (idx >= steps.length - 1) { finish(false); return; }
    idx += 1;
    paint();
  }

  function prev() {
    if (idx <= 0) return;
    idx -= 1;
    paint();
  }

  function onResize() {
    if (!running) return;
    place(steps[idx]);
  }

  function onKey(e) {
    if (!running) return;
    if (e.key === 'Escape') { e.preventDefault(); finish(true); }
    else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
  }

  function start(opts) {
    const o = opts || {};
    if (running) return;
    steps = pickSteps();
    if (!steps.length) { if (o.onDone) o.onDone(); return; }

    onDone = o.onDone || null;
    onSkip = o.onSkip || null;
    idx = 0;
    running = true;

    const l = ensureLayer();
    l.hidden = false;
    document.body.classList.add('touring');
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onResize, true);
    document.addEventListener('keydown', onKey, true);
    paint();
  }

  function finish(skipped) {
    if (!running) return;
    running = false;
    window.removeEventListener('resize', onResize);
    window.removeEventListener('scroll', onResize, true);
    document.removeEventListener('keydown', onKey, true);
    document.body.classList.remove('touring');
    if (layer) layer.hidden = true;
    const cb = skipped ? onSkip : onDone;
    onDone = onSkip = null;
    if (cb) cb();
  }

  window.XYXT_TOUR = {
    start,
    stop: () => finish(true),
    isRunning: () => running,
    steps: () => STEPS.map(s => s.sel)
  };
})();
