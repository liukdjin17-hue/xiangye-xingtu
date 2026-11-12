/* 乡野星图 · 应用逻辑 v6
 * 纯前端、可离线：状态存 localStorage，不发任何网络请求。
 * 主线：建档 → 霍兰德测评 → 个性化推荐 → 职业画像/对比 → 语音问答 → 行动任务。
 * v6 相对 v5：年级扩到 11 个并按学段给建议；探索任务改成三阶 14 件；测评加「补答闸门」；
 *            教师端拆成独立页面 teacher.html（学生端不再有这个标签）；小星星接入 DeepSeek 显性化。
 */
(function () {
  'use strict';

  const { DIMS, ITEMS, KINDS, HEX, CAREERS, TASKS, TASK_LEVELS, FAQ, SDS } = window.XYXT;

  const DIM_MAP = {};
  DIMS.forEach(d => { DIM_MAP[d.key] = d; });
  const CAREER_MAP = {};
  CAREERS.forEach(c => { CAREER_MAP[c.id] = c; });

  const SCALE = [
    { v: 1, l: '很不符合' },
    { v: 2, l: '不太符合' },
    { v: 3, l: '说不清' },
    { v: 4, l: '比较符合' },
    { v: 5, l: '非常符合' }
  ];

  const SUBJECTS = ['语文', '数学', '英语', '物理', '化学', '生物', '政治', '历史', '地理', '信息技术', '音乐', '美术', '体育'];
  /* 11 个年级：小学 2 + 初中 3 + 高中 3 + 中职 3，覆盖县乡学校真实存在的学制 */
  const GRADES = ['小学五年级', '小学六年级', '初一', '初二', '初三', '高一', '高二', '高三', '中职一年级', '中职二年级', '中职三年级'];
  /* 学段：p 小学 / j 初中 / s 高中 / v 中职。任务的适用学段、首页文案都按它分岔 */
  const STAGE_OF = g => /小学/.test(g) ? 'p' : /^初/.test(g) ? 'j' : /中职/.test(g) ? 'v' : 's';
  const STAGE_NAME = { p: '小学', j: '初中', s: '高中', v: '中职' };

  /* 不要登录：一台设备一份记录，直接存在本机。
     换设备时用「设置 → 导出备份 / 导入备份」搬走，不依赖任何服务器。 */
  const KEY = 'xyxt.v3';
  const OLD_KEY = 'xyxt.v2';
  const MAX_COMPARE = 3;
  const APP_VERSION = '6.2.0';

  /* 测评的「补答闸门」：最后一题答完但前面还有跳过的题时，先不交卷。
     只存在内存里，不写 localStorage —— 刷新后重新从题目流开始判断即可。 */
  let gateOpen = false;
  let answerToken = 0;
  /* 「重新做一遍」这类会清空答案的动作，第一次点击只上膛、第二次才真的清。
     以前点一下就清空 60 题，手滑就没了。 */
  let resetArm = false;


  /* ---------------- 状态 ---------------- */
  function blank() {
    return {
      v: 4,
      profile: { nick: '', grade: '初一', county: '', subjects: [] },
      answers: {},
      cursor: 0,
      testing: false,
      result: null,
      history: [],
      tasksDone: [],
      chat: [],
      starChat: [],
      lastCareer: null,
      autoRead: false,
      fav: [],
      compare: [],
      filter: { local: 'all', edu: 'all', q: '', favOnly: false },
      hideVoiceNotice: false,
      tourDone: false,
      createdAt: Date.now()
    };
  }

  const DEFAULTS = blank();

  /* 兼容 v4：登录没了，但旧账号下的记录不能当作不存在——
     本机还没有数据时，接管最近一次使用的那份。 */
  function adoptAccountData() {
    try {
      if (localStorage.getItem(KEY)) return;
      let best = null;
      let bestAt = 0;
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || k.indexOf(KEY + '.u.') !== 0) continue;
        let at = 0;
        try { at = (JSON.parse(localStorage.getItem(k)) || {}).createdAt || 0; } catch (e) { at = 0; }
        if (at >= bestAt) { bestAt = at; best = k; }
      }
      if (best) localStorage.setItem(KEY, localStorage.getItem(best));
    } catch (e) { /* 隐私模式：忽略 */ }
  }
  adoptAccountData();

  function load() {
    let raw = null;
    try {
      raw = localStorage.getItem(KEY);
      // v2 的老数据只接在匿名键上，不能串到某个账号里
      if (!raw) raw = localStorage.getItem(OLD_KEY);
    } catch (e) { return blank(); }
    if (!raw) return blank();
    try {
      const o = JSON.parse(raw) || {};
      const s = Object.assign({}, DEFAULTS, o);
      s.profile = Object.assign({}, DEFAULTS.profile, o.profile || {});
      s.filter = Object.assign({}, DEFAULTS.filter, o.filter || {});
      if (!Array.isArray(s.fav)) s.fav = [];
      if (!Array.isArray(s.compare)) s.compare = [];
      if (!Array.isArray(s.history)) s.history = [];
      if (!Array.isArray(s.starChat)) s.starChat = [];
      s.testing = !!o.testing;
      s.v = 4;
      return s;
    } catch (e) {
      return blank();
    }
  }

  let S = load();

  let saveOk = true;
  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(S));
      saveOk = true;
    } catch (e) { saveOk = false; }
  }

  /* ---------------- 工具 ---------------- */
  const $ = sel => document.querySelector(sel);

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('on'), 2800);
  }

  function b64enc(obj) {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    let bin = '';
    bytes.forEach(b => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/=+$/, '');
  }

  function download(name, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise((resolve, reject) => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); resolve(); } catch (e) { reject(e); }
      document.body.removeChild(ta);
    });
  }

  const dateStr = ts => new Date(ts).toLocaleString('zh-CN', { hour12: false });

  /* ---------------- 语音：朗读 ---------------- */
  let voices = [];
  function loadVoices() {
    if (!('speechSynthesis' in window)) return;
    voices = window.speechSynthesis.getVoices() || [];
  }
  if ('speechSynthesis' in window) {
    loadVoices();
    window.speechSynthesis.addEventListener('voiceschanged', loadVoices);
  }

  /* 朗读统一用温柔女声：按「更柔和、更自然」的顺序挑，并明确避开男声。
     设备上没装中文女声时退回最接近的中文音色，用音调补偿，尽量不显男声。 */
  const VOICE_WARM = [
    /xiaoxiao|晓晓/i, /xiaoyi|晓伊/i, /xiaomeng|晓梦/i, /xiaohan|晓涵/i, /xiaomo|晓墨/i,
    /huihui|慧慧/i, /yaoyao|瑶瑶/i, /tingting|婷婷/i, /meijia|美佳|mei-?jia/i,
    /google.*(普通话|中文|chinese)/i, /female|woman|女声|女/i
  ];
  const VOICE_MALE = /yunxi|云希|yunjian|云健|yunyang|云扬|yunhao|云皓|yunye|云野|yunjie|云阶|kangkang|康康|male|男/i;

  /* list 可传候选数组（测试注入假 voice 列表），不传就用全局 voices。
     空列表、全英文 voice、只有男声这三种情况都返回 null 或原对象，不抛异常。 */
  function pickVoice(list) {
    const src = (list && list.length) ? list : voices;
    if (!src.length) { loadVoices(); }
    const pool = (list && list.length) ? list : voices;
    const zh = pool.filter(v => /^zh([-_]|$)/i.test(v.lang || '') || /chinese|中文|普通话|國語|国语/i.test(v.name || ''));
    if (!zh.length) return null;
    const female = zh.filter(v => !VOICE_MALE.test(v.name || ''));
    for (var i = 0; i < VOICE_WARM.length; i++) {
      const hit = female.find(v => VOICE_WARM[i].test(v.name || ''));
      if (hit) return hit;
    }
    return female[0] || zh[0] || null;
  }

  function voiceIsWarm(v) { return !!v && !VOICE_MALE.test(v.name || ''); }

  const TTS_OK = typeof window !== 'undefined' && 'speechSynthesis' in window;

  function speak(text, opts) {
    if (!TTS_OK) { toast('这台设备不支持朗读，可以直接看文字'); return; }
    const o = opts || {};
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(String(text).replace(/[*#>_`]/g, '').slice(0, 800));
    u.lang = 'zh-CN';
    u.rate = o.rate || 0.92;                                  // 比原来慢一点，像在跟人说话
    const v = o.voice || pickVoice();
    if (v) u.voice = v;
    u.pitch = o.pitch || (voiceIsWarm(v) ? 1.06 : 1.14);      // 女声略提亮；只剩男声时用音调补偿
    u.onerror = () => {};
    window.speechSynthesis.speak(u);
  }

  function stopSpeak() {
    if (TTS_OK) window.speechSynthesis.cancel();
  }

  /* ---------------- 语音：识别 ---------------- */
  let rec = null;
  let recing = false;

  function srSupported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  function startRec(onText, onState) {
    if (!srSupported()) {
      toast('这个浏览器不支持语音识别，请用 Edge / Chrome 打开，或直接打字');
      onState && onState('unsupported');
      return;
    }
    if (recing) { stopRec(); return; }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    rec = new SR();
    rec.lang = 'zh-CN';
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 4;

    rec.onstart = () => { recing = true; onState && onState('listening'); };
    rec.onaudiostart = () => { onState && onState('listening'); };
    rec.onspeechend = () => { onState && onState('thinking'); };
    rec.onend = () => { recing = false; onState && onState('idle'); };
    rec.onnomatch = () => { onState && onState('nomatch'); };
    rec.onerror = e => {
      recing = false;
      const map = {
        'not-allowed': '麦克风被拒绝了。用「本地文件」方式打开时浏览器不允许录音，请改用 打开.bat 启动，或直接打字',
        'service-not-allowed': '当前环境不允许调用语音，请用 Edge 打开本地服务模式，或直接打字',
        'no-speech': '没听到声音，再靠近一点麦克风说一次',
        'audio-capture': '没找到麦克风，检查一下设备',
        'network': '语音识别需要联网，断网时可以直接打字',
        'aborted': ''
      };
      const msg = map[e.error];
      if (msg) toast(msg);
      onState && onState('idle');
    };
    rec.onresult = ev => {
      let text = '';
      let alts = [];
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        text += r[0].transcript;
        if (r.isFinal) {
          alts = [];
          for (let k = 0; k < r.length; k++) alts.push(r[k].transcript.trim());
        }
      }
      onText(text.trim(), ev.results[ev.results.length - 1].isFinal, alts);
    };
    try { rec.start(); } catch (e) { recing = false; toast('语音启动失败，请直接打字'); }
  }

  function stopRec() {
    if (rec) { try { rec.stop(); } catch (e) { /* 已结束 */ } }
    recing = false;
  }

  /* ---------------- 计分 ---------------- */
  function hexDistance(a, b) {
    const i = HEX.indexOf(a), j = HEX.indexOf(b);
    const d = Math.abs(i - j);
    return Math.min(d, 6 - d);
  }

  function consistencyLabel(d) {
    if (d === 1) return { level: '高', note: '前两码在六边形上相邻，兴趣指向集中' };
    if (d === 2) return { level: '中', note: '前两码隔一位，兴趣有两个方向，可以都看看' };
    return { level: '低', note: '前两码相对，兴趣跨度大——不是缺点，说明你可以适应两类工作' };
  }

  function computeResult() {
    const sums = {}, cnts = {};
    DIMS.forEach(d => { sums[d.key] = 0; cnts[d.key] = 0; });
    let answered = 0;
    ITEMS.forEach(it => {
      const v = S.answers[it.id];
      if (typeof v === 'number' && v >= 1 && v <= 5) {
        sums[it.d] += v; cnts[it.d] += 1; answered += 1;
      }
    });
    const pct = {}, raw = {};
    DIMS.forEach(d => {
      const c = cnts[d.key];
      raw[d.key] = sums[d.key];
      pct[d.key] = c ? Math.round(((sums[d.key] - c) / (4 * c)) * 100) : 0;
    });
    const order = DIMS.map(d => d.key).sort((a, b) => (pct[b] - pct[a]) || (HEX.indexOf(a) - HEX.indexOf(b)));
    const code = order.slice(0, 3).join('');
    const diff = pct[order[0]] - pct[order[5]];
    const cons = consistencyLabel(hexDistance(order[0], order[1]));
    return { pct, raw, code, order, diff, cons, answered, total: ITEMS.length, at: Date.now() };
  }

  const W = [1, 0.72, 0.48];

  function matchCareer(career, res) {
    if (!res) return 0;
    const letters = career.code.split('');
    let sum = 0, wsum = 0;
    letters.forEach((L, i) => {
      const w = W[i] || 0.4;
      sum += (res.pct[L] || 0) * w;
      wsum += w;
    });
    let score = sum / wsum;
    const subs = S.profile.subjects || [];
    const hit = (career.subjects || []).filter(s => subs.indexOf(s) >= 0);
    if (hit.length) score += Math.min(8, hit.length * 4);
    return Math.max(5, Math.min(99, Math.round(score)));
  }

  function matchAll() {
    return CAREERS.map(c => ({ c, score: matchCareer(c, S.result), why: whyText(c, S.result) }))
      .sort((a, b) => b.score - a.score);
  }

  function whyText(c, res) {
    if (!res) return '完成兴趣测评后，这里会告诉你“为什么适合”';
    const letters = c.code.split('');
    let best = letters[0];
    let bestRank = 99;
    letters.forEach(L => {
      const r = res.order.indexOf(L);
      if (r >= 0 && r < bestRank) { bestRank = r; best = L; }
    });
    const dim = DIM_MAP[best].name;
    const focus = (c.bright && c.bright[0]) ? '这份工作最吃的是「' + c.bright[0] + '」' : '这条路和你现在的状态对得上';
    if (bestRank === 0) return '你的「' + dim + '」最突出，' + focus + '。';
    if (bestRank === 1) return '你的第二兴趣「' + dim + '」在这里天天用得上，' + focus + '。';
    if (bestRank === 2) return '你的「' + dim + '」也在它的三码里，能补上它最缺的一面。';
    const subs = S.profile.subjects || [];
    const hit = (c.subjects || []).filter(s => subs.indexOf(s) >= 0);
    if (hit.length) return '你选的' + hit.slice(0, 2).join('、') + '，正是入行要用的学科。';
    return '它能补上你目前较少接触的一面，值得作为一个“反向选项”看看。';
  }

  function fitTags(c) {
    const out = [];
    const subs = S.profile.subjects || [];
    const hit = (c.subjects || []).filter(s => subs.indexOf(s) >= 0);
    if (hit.length) out.push('学科对口 · ' + hit.slice(0, 2).join('、'));
    if (/中职|大专/.test(c.edu)) out.push('学历门槛不高');
    if (c.local === '可远程') out.push('可远程就业');
    else if (/县城|县乡|乡镇|县域/.test(c.local)) out.push('家门口有岗');
    return out;
  }

  /* 首页推荐：匹配度 + 本地可行性 + 学历门槛，避免只推“最难够到的” */
  function recommend(n) {
    const res = S.result;
    if (!res) return [];
    return CAREERS.map(c => {
      const base = matchCareer(c, res);
      let rank = base;
      if (/中职|大专/.test(c.edu)) rank += 2;
      if (c.local === '可远程') rank += 1;
      return { c, score: base, rank, why: whyText(c, res), tags: fitTags(c) };
    }).sort((a, b) => (b.score - a.score) || (b.rank - a.rank)).slice(0, n || 5);
  }

  /* ---------------- 雷达图（SVG，可打印） ---------------- */
  function radarSVG(pct, size) {
    const s0 = size || 260;
    const cx = s0 / 2, cy = s0 / 2, R = s0 * 0.33;
    const n = DIMS.length;
    const ang = i => -Math.PI / 2 + (i * 2 * Math.PI) / n;
    const pt = (i, k) => [cx + Math.cos(ang(i)) * R * k, cy + Math.sin(ang(i)) * R * k];

    let s = `<svg class="radar-svg" viewBox="0 0 ${s0} ${s0}" width="${s0}" height="${s0}" role="img" aria-label="六维兴趣雷达图">`;
    [0.25, 0.5, 0.75, 1].forEach(k => {
      const pts = DIMS.map((d, i) => pt(i, k).join(',')).join(' ');
      s += `<polygon points="${pts}" fill="none" stroke="${k === 1 ? '#ded3c0' : '#f0e9dc'}" stroke-width="1"/>`;
    });
    DIMS.forEach((d, i) => {
      const p = pt(i, 1);
      s += `<line x1="${cx}" y1="${cy}" x2="${p[0]}" y2="${p[1]}" stroke="#f0e9dc"/>`;
    });
    const area = DIMS.map((d, i) => pt(i, Math.max(0.02, (pct[d.key] || 0) / 100)).join(',')).join(' ');
    s += `<polygon points="${area}" fill="rgba(194,103,15,.22)" stroke="#c2670f" stroke-width="1.8"/>`;
    DIMS.forEach((d, i) => {
      const p = pt(i, Math.max(0.02, (pct[d.key] || 0) / 100));
      s += `<circle cx="${p[0]}" cy="${p[1]}" r="2.8" fill="#10312f"/>`;
    });
    DIMS.forEach((d, i) => {
      const p = pt(i, 1.2);
      s += `<text x="${p[0]}" y="${p[1]}" text-anchor="middle" dominant-baseline="middle" font-size="11.5" fill="#4d5a68">${esc(d.short)}</text>`;
    });
    return s + '</svg>';
  }

  /* ---------------- 视图：首页 ---------------- */
  function viewHome() {
    const p = S.profile;
    const res = S.result;
    const name = p.nick ? esc(p.nick) : '同学';
    const doneTasks = S.tasksDone.length;

    const steps = [
      { k: 'STEP 01', t: '建档', d: '年级与学科偏好', done: !!p.nick },
      { k: 'STEP 02', t: '测评', d: ITEMS.length + ' 题，约 8 分钟', done: !!res },
      { k: 'STEP 03', t: '看星图', d: CAREERS.length + ' 个职业画像', done: !!res },
      { k: 'STEP 04', t: '说出来', d: '语音或打字提问', done: S.chat.length > 0 },
      { k: 'STEP 05', t: '做任务', d: '每周一件小事', done: doneTasks > 0 }
    ].map(s => `<div class="step ${s.done ? 'done' : ''}"><div class="k">${s.k}</div><div class="t">${s.t}</div><div class="d">${s.d}</div></div>`).join('');

    let body = '';

    if (!res) {
      body = `
        <div class="card">
          <div class="eyebrow">从这里开始</div>
          <h2>先花 8 分钟，做一次霍兰德兴趣测评</h2>
          <p class="lead">${ITEMS.length} 道题，题目来自真实的生活场景，没有标准答案。做完会得到一张六边形兴趣星图、一个三码兴趣代码，以及 ${CAREERS.length} 个职业里最值得先看的几个。</p>
          ${p.nick ? gradeOnly() : profileForm()}
          <div class="btn-row">
            <button class="btn primary" data-act="go-test">开始测评</button>
            <button class="btn" data-act="go-map">先随便逛逛职业</button>
          </div>
          ${stageHint()}
        </div>
        <div class="card tight">
          <h4>不方便打字？直接说</h4>
          <p class="muted">测评题目可以按 🔊 朗读；“问问学长”支持直接说话提问，带口音也没关系，识别结果可以先改字再发送。</p>
        </div>`;
    } else {
      const list = recommend(5);
      body = `
        <div class="card ink">
          <div class="starline">你的霍兰德兴趣代码</div>
          <h1>${name}，你的兴趣代码是 <span class="code-hl">${res.code}</span></h1>
          <p class="lead">${res.order.slice(0, 2).map(k => DIM_MAP[k].name).join(' + ')}——你在${DIM_MAP[res.order[0]].short}和${DIM_MAP[res.order[1]].short}的事情上更容易投入，也更容易做好。</p>
          <div class="hero-stats">
            <div class="s"><div class="n">${res.pct[res.order[0]]}</div><div class="l">最强维度标准分</div></div>
            <div class="s"><div class="n">${res.diff}</div><div class="l">分化度（越高越清晰）</div></div>
            <div class="s"><div class="n">${res.cons.level}</div><div class="l">一致性</div></div>
          </div>
        </div>

        <div class="card">
          <div class="eyebrow">按你的情况排的</div>
          <h2>先看这 5 条路</h2>
          <p class="muted">不只看“兴趣像不像”，也算了学历门槛和你家门口有没有岗位——县乡学生真正能用上的排序。</p>
          <div class="career-list" style="margin-top:12px">
            ${list.map(x => careerCard(x)).join('')}
          </div>
          <div class="btn-row">
            <button class="btn primary" data-act="go-map">看完整星图（${CAREERS.length}）</button>
            <button class="btn" data-act="go-ask">问问学长</button>
          </div>
        </div>

        <div class="card tight">
          <h4>把这张星图带走</h4>
          <p class="muted">可以打印成一张 A4 报告，带去和班主任、家长聊；也可以复制“结果码”交给老师，做班级整体分析。</p>
          <div class="btn-row no-print">
            <button class="btn" data-act="toggle-report">预览报告</button>
            <button class="btn" data-act="print">打印 / 存为 PDF</button>
            <button class="btn" data-act="export-report">导出报告文件</button>
            <button class="btn" data-act="copy-code">复制结果码</button>
          </div>
        </div>`;
    }

    return `
      ${res ? body : hero() + body}
      ${S.testing ? resumeCard() : ''}
      <div class="card tight">
        <h4>五步，走完一次探索</h4>
        <div class="steps">${steps}</div>
      </div>
      <div class="card tight demo-card no-print">
        <h4>给评委／老师的 60 秒</h4>
        <p class="muted">不用做 ${ITEMS.length} 道题，也能看到完整效果：载入一份样例学生数据，直接看推荐、报告和班级看板。</p>
        <div class="btn-row">
          <button class="btn accent" data-act="demo-student">载入样例学生</button>
          <button class="btn" data-act="open-teacher">打开教师端（新页面）</button>
          <button class="btn" data-act="export-backup">备份本机数据</button>
        </div>
        <p class="small muted">教师端是独立页面，学生端不留入口。</p>
      </div>
      ${res ? reportBlock() : ''}
    `;
  }

  function resumeCard() {
    const done = ITEMS.length - missingIdx().length;
    /* 全部答完但还没提交：这时候说“没做完”会让人以为还漏题 */
    if (done >= ITEMS.length) {
      return `
      <div class="card tight resume-card no-print">
        <h4>${ITEMS.length} 道题都答完了，还差最后一步</h4>
        <p class="muted">答案都存着了。回去检查一遍，或者直接提交，就能看到六边形星图。</p>
        <div class="btn-row">
          <button class="btn primary" data-act="resume-test">去提交</button>
        </div>
      </div>`;
    }
    return `
      <div class="card tight resume-card no-print">
        <h4>你还有一次没做完的测评</h4>
        <p class="muted">已答 ${done} / ${ITEMS.length} 题，下一次回来还能接着答，不用从头开始。</p>
        <div class="btn-row">
          <button class="btn primary" data-act="resume-test">继续第 ${Math.min(S.cursor + 1, ITEMS.length)} 题</button>
        </div>
      </div>`;
  }

  function hero() {
    return `
      <div class="card ink">
        <div class="starline">乡野星图 · XYXT</div>
        <h1>把一座城市的职业现场，<br>装进县乡学生的一次对话里</h1>
        <p class="lead">职业认知不该由出生地决定。这里没有“你应该成为谁”，只有 ${CAREERS.length} 个职业的真实一天、入行路径，和一条条从你现在的位置出发的路。不方便打字，直接说就行。</p>
      </div>`;
  }

  /* 年级下拉只有这一份实现：首页建档卡片、已填过称呼时的精简版、设置里的「修改年级」都用它 */
  function gradeField() {
    return `
          <label for="pf-grade">年级</label>
          <select id="pf-grade" data-pf="grade">
            ${GRADES.map(g => `<option ${S.profile.grade === g ? 'selected' : ''}>${g}</option>`).join('')}
          </select>`;
  }

  /* 学科多选 chips 只有这一份实现：首页建档卡片与设置里的「修改学科偏好」都用它。
     两处手感、样式、aria-pressed 状态保持一致，改一处就同时改两处。 */
  function subjectChips(boxId, labelId) {
    return `
        <div class="chips" id="${boxId}" role="group" aria-labelledby="${labelId}">
          ${SUBJECTS.map(s => `<button type="button" class="chip ${S.profile.subjects.indexOf(s) >= 0 ? 'teal' : 'plain'}" data-sub="${s}" aria-pressed="${S.profile.subjects.indexOf(s) >= 0}">${s}</button>`).join('')}
        </div>`;
  }

  /* 设置首页「个人」组里那一行的右侧值：太长会挤破 390px 的行，只给前两门 + 总数 */
  function subSummary() {
    const list = S.profile.subjects || [];
    if (!list.length) return '还没选';
    if (list.length <= 3) return list.join('、');
    return list.slice(0, 2).join('、') + ' 等 ' + list.length + ' 门';
  }

  /* 设置面板里「已选 …」那行的文案：这里给全，学生要能一眼核对 */
  function subNowText() {
    const list = S.profile.subjects || [];
    return list.length ? '已选：' + list.join('、') : '还没选，不选也不影响使用';
  }

  /* 点 chip 时不重绘面板，只把这一行改掉 */
  function paintSubNow() {
    const box = document.getElementById('setSubNow');
    if (box) box.textContent = subNowText();
  }

  function profileForm() {
    return `
      <div class="grid2" style="margin-top:14px">
        <div class="field">
          <label for="pf-nick">怎么称呼你</label>
          <input id="pf-nick" data-pf="nick" placeholder="昵称即可，不用真名" value="${esc(S.profile.nick)}" maxlength="12">
        </div>
        <div class="field">${gradeField()}
        </div>
      </div>
      <div class="field">
        <label id="pf-sub-label">你比较拿手的学科（可多选，帮助匹配更准）</label>${subjectChips('pf-subjects', 'pf-sub-label')}
      </div>`;
  }

  /* 已经有称呼时建档卡片会收起，但年级必须还能改——
     v6 的 11 个年级、四个学段的建议、任务里的「适用」提示全靠这个值。
     否则填过称呼（或载入过样例学生）的同学再也改不了年级。 */
  function gradeOnly() {
    return `
      <div class="field" style="margin-top:14px">${gradeField()}
        <p class="small muted" style="margin:6px 0 0">换年级会换上面这行建议，也会换探索任务里的「适用」提示。改称呼用右上角「我的设置」。</p>
      </div>`;
  }

  /* 建档卡片下方的一行学段提示：不同学段的重点不一样，别让小学生照高中生的路径走 */
  const STAGE_TIP = {
    p: '小学阶段的重点不是选职业，是多见几种工作。先做探索任务里带「轻松」标记的那几件，测评可以等六年级再做。',
    j: '初中阶段先把「见过什么工作」补上，选科相关的任务等上高中再看不迟。',
    s: '高中阶段最该弄清的是选科与专业门槛，任务里的「选科」「招聘简章」两类优先做。',
    v: '中职阶段优先做「招聘简章」「职业体验」，技能证书比兴趣标签更值钱。'
  };
  const STAGE_EXTRA_P = '60 道题对小学生偏长，可以分两次做完，跳到最后一题时会提醒你补答';

  function stageHint() {
    const st = STAGE_OF(S.profile.grade);
    const extra = (st === 'p' && !S.result) ? `<p class="small muted stage-extra">${STAGE_EXTRA_P}</p>` : '';
    return `<p class="small muted stage-hint" data-stage="${st}">${esc(STAGE_TIP[st] || '')}</p>${extra}`;
  }

  /* 改年级时只换这一行，不重绘整页——输入法焦点不会被打断 */
  function paintStageHint() {
    const st = STAGE_OF(S.profile.grade);
    /* 设置里的「修改年级」面板也要跟着变，否则选完学段说明还是旧的 */
    const inSheet = document.getElementById('setGradeStage');
    if (inSheet) inSheet.textContent = '当前学段：' + STAGE_NAME[st] + '。选完立刻生效，不用再点保存。';
    const box = document.querySelector('.stage-hint');
    if (!box) return;
    box.dataset.stage = st;
    box.textContent = STAGE_TIP[st] || '';
    const old = document.querySelector('.stage-extra');
    if (old) old.remove();
    if (st === 'p' && !S.result) {
      const p = document.createElement('p');
      p.className = 'small muted stage-extra';
      p.textContent = STAGE_EXTRA_P;
      box.insertAdjacentElement('afterend', p);
    }
  }

  function bar(d, v) {
    const w = Math.max(0, Math.min(100, v));
    return `<div class="bar"><span class="t">${d.name}</span><span class="track"><i style="width:${w}%;background:${d.color}"></i></span><span class="v">${v}</span></div>`;
  }

  function careerCard(x) {
    const c = x.c;
    const fav = S.fav.indexOf(c.id) >= 0;
    const inCmp = S.compare.indexOf(c.id) >= 0;
    return `
      <div class="career" data-career="${c.id}">
        <div class="top">
          <div>
            <div class="name">${esc(c.name)}</div>
            <div class="why">${esc(x.why)}</div>
          </div>
          <div class="card-tools">
            <span class="match">匹配 ${x.score}</span>
            <button class="icon-btn ${fav ? 'on' : ''}" data-fav="${c.id}" title="${fav ? '取消收藏' : '收藏'}" aria-label="${fav ? '取消收藏' : '收藏'}${esc(c.name)}" aria-pressed="${fav}">${fav ? '★' : '☆'}</button>
            <button class="icon-btn ${inCmp ? 'on' : ''}" data-cmp="${c.id}" title="${inCmp ? '移出对比' : '加入对比'}" aria-label="${inCmp ? '移出对比' : '加入对比'}${esc(c.name)}" aria-pressed="${inCmp}">⇄</button>
          </div>
        </div>
        <div class="chips metas">
          <span class="chip">${esc(c.edu)}</span>
          <span class="chip teal">${esc(c.local)}</span>
          ${(x.tags || []).slice(0, 1).map(t => `<span class="chip amber">${esc(t)}</span>`).join('')}
          ${c.bright.slice(0, 2).map(b => `<span class="chip plain">${esc(b)}</span>`).join('')}
        </div>
      </div>`;
  }

  /* 报告里的「接下来 30 天」按当前学段取任务：
     先挑本学段能做的（这些才是真的能立刻动手的），不够再用其余任务补满。
     n 省略或非正数表示不截断（导出报告要全列）。 */
  function reportTasks(n) {
    const lim = (typeof n === 'number' && n > 0) ? n : TASKS.length;
    const st = STAGE_OF(S.profile.grade);
    const fit = TASKS.filter(t => (t.st || []).indexOf(st) >= 0);
    const rest = TASKS.filter(t => (t.st || []).indexOf(st) < 0);
    return fit.concat(rest).slice(0, lim);
  }

  function reportBlock() {
    const res = S.result;
    const top = matchAll().slice(0, 6);
    return `
      <div class="card report-card" id="report">
        <div class="report-head">
          <div>
            <div class="eyebrow">职业探索报告 · 乡野星图</div>
            <h2>${esc(S.profile.nick || '同学')}的星图报告</h2>
            <p class="muted">生成时间：${dateStr(res.at)}　·　兴趣代码：${res.code}　·　年级：${esc(S.profile.grade)}</p>
          </div>
          <div class="report-code">${res.code}</div>
        </div>
        <div class="report-top">
          <div class="report-radar">${radarSVG(res.pct, 250)}</div>
          <div>
            <div class="bars">${DIMS.map(d => bar(d, res.pct[d.key])).join('')}</div>
            <p class="small" style="margin-top:12px">分化度 <b>${res.diff}</b>　·　一致性 <b>${res.cons.level}</b>（${esc(res.cons.note)}）</p>
          </div>
        </div>
        <h4 style="margin-top:18px">建议优先了解的 6 个方向</h4>
        <table class="simple">
          <thead><tr><th>职业</th><th>匹配度</th><th>学历门槛</th><th>本地机会</th></tr></thead>
          <tbody>
            ${top.map(x => `<tr><td>${esc(x.c.name)}</td><td>${x.score}</td><td>${esc(x.c.edu)}</td><td>${esc(x.c.local)}</td></tr>`).join('')}
          </tbody>
        </table>
        <h4 style="margin-top:16px">接下来 30 天可以做的小事</h4>
        <ol class="small list-num">
          ${reportTasks(4).map(t => `<li>${esc(t.title)}——${esc(t.desc.split('，')[0])}</li>`).join('')}
        </ol>
        <p class="muted" style="margin-top:14px">本报告依据霍兰德职业兴趣测评（课堂改编版）生成，仅作生涯探索参考，不作为升学或职业选择的唯一依据。</p>
        <p class="muted">乡野星图 · 2026“联通杯”AI 应用创新大赛参赛作品 · 队伍：拾光职引</p>
      </div>`;
  }

  /* ---------------- 视图：测评 ---------------- */
  function viewTest() {
    if (S.testing) return testQuestion();

    if (S.result) {
      const res = S.result;
      return `
        <div class="card">
          <div class="eyebrow">霍兰德兴趣星图</div>
          <h2>你的兴趣代码：<span class="code-badge">${res.code}</span></h2>
          <div class="result-top" style="margin-top:16px">
            <div class="radar-wrap" id="radar">${radarSVG(res.pct, 250)}</div>
            <div>
              <div class="bars">${DIMS.map(d => bar(d, res.pct[d.key])).join('')}</div>
              <p class="small" style="margin-top:12px">分化度 <b>${res.diff}</b>　·　一致性 <b>${res.cons.level}</b></p>
              <p class="muted">${esc(res.cons.note)}</p>
            </div>
          </div>
          ${res.answered < res.total ? `<div class="warn-note">这次有 ${res.total - res.answered} 道题没有作答，未答的题不参与计分，结果仅供参考。建议补做一次完整的测评。 <button class="btn small" data-act="fix-blank">去补答</button></div>` : ''}
          <div class="btn-row">
            <button class="btn primary" data-act="go-home">回我的星图</button>
            <button class="btn" data-act="read-result">朗读结果</button>
            <button class="btn${resetArm ? ' danger' : ''}" data-act="retest">${resetArm ? `确认重测（清空这 ${ITEMS.length} 题答案）` : '重新测一次'}</button>
            ${resetArm ? '<button class="btn" data-act="retest-cancel">算了</button>' : ''}
            <button class="btn" data-act="go-science">看看这个量表怎么算的</button>
          </div>
        </div>
        <div class="card tight">
          <h4>六个维度分别指什么</h4>
          ${DIMS.map(d => `<p class="small"><b style="color:${d.color}">${d.name}（${d.short} · ${d.en}）</b>　${esc(d.desc)}</p>`).join('')}
        </div>`;
    }

    const answered = ITEMS.length - missingIdx().length;
    return `
      <div class="card">
        <div class="eyebrow">霍兰德职业兴趣测评 · 课堂改编版</div>
        <h2>${ITEMS.length} 道题，凭第一反应选</h2>
        <p class="lead">题目分三类：你喜欢做什么（活动）、你觉得自己能做多好（能力）、你愿不愿意做（职业）。不是考试，没有对错，也无需选“更正确的答案”。</p>
        <ul class="small list-disc">
          <li>约 8 分钟，6 个维度各 10 题，中途可以返回上一题；</li>
          <li>看不清或识字不便，可以点题目旁的 🔊 听题；</li>
          <li>题目里遇到不认识的词（比如「飞防手」「外业员」），点右下角的小星星问一句，它会用人话解释；</li>
          <li>答完可以再检查一遍，按「提交」才生成六边形星图与三码代码，不联网、不上传。</li>
        </ul>
        <div class="btn-row">
          ${answered ? `<button class="btn primary" data-act="resume-test">继续上次（第 ${Math.min(S.cursor + 1, ITEMS.length)} 题）</button>
          <button class="btn${resetArm ? ' danger' : ''}" data-act="start-test">${resetArm ? `确认重做（清空这 ${answered} 题答案）` : '重新开始'}</button>
          ${resetArm ? '<button class="btn" data-act="retest-cancel">算了</button>' : ''}` : `<button class="btn primary" data-act="start-test">开始（第 1 题）</button>`}
        </div>
      </div>
      <div class="card tight">
        <h4>为什么用它</h4>
        <p class="muted">霍兰德（John Holland）的 RIASEC 理论是生涯辅导里用得最广的兴趣框架：人可以被分成六类兴趣倾向，工作环境也能分成六类，兴趣与环境越匹配，学习和工作的稳定性越高。这个量表就是把这个理论做成县乡学生能做的 ${ITEMS.length} 道题。详见“科学性”页。</p>
      </div>`;
  }

  /* 未答题的索引（0 基），用于闸门与「去补答」 */
  function missingIdx() {
    return ITEMS.map((it, i) => [it, i])
      .filter(([it]) => typeof S.answers[it.id] !== 'number')
      .map(([, i]) => i);
  }

  function scrollToGate() {
    setTimeout(() => {
      const g = $('#qgate');
      if (g) g.scrollIntoView({ block: 'center' });
    }, 0);
  }

  function scrollToSubmit() {
    setTimeout(() => {
      const g = $('#qsubmit');
      if (g) g.scrollIntoView({ block: 'center' });
    }, 0);
  }

  /* 全部答完后出现的「提交」卡片。
     以前是答完最后一题直接出结果，补答完连回头的机会都没有；
     现在停在这里，人可以翻回去改，改完再自己按下提交。 */
  function submitCard() {
    if (gateOpen || missingIdx().length) return '';
    const n = ITEMS.length;
    return `
      <div class="card done" id="qsubmit">
        <h3>${n} 道题都答完了</h3>
        <p class="muted">不急，最后再翻一遍也来得及。上面「查看答题进度」里点任意题号就能回去改；改完回到这里按提交，立刻算出六个维度。</p>
        <div class="btn-row">
          <button class="btn primary" data-act="submit-test">提交并生成我的星图</button>
          <button class="btn" data-act="review-all">从头检查一遍</button>
        </div>
      </div>`;
  }

  /* 闸门卡片：答完最后一题但前面有跳过题时，先把未答题摆出来，再决定补答还是直接出结果 */
  function gateCard() {
    const miss = missingIdx();
    if (!miss.length) return '';
    const shown = miss.slice(0, 12);
    const chips = shown.map(i => `<button type="button" class="chip plain" data-jump="${i}">第 ${i + 1} 题</button>`).join('');
    const more = miss.length > shown.length ? `<span class="small muted">等共 ${miss.length} 题</span>` : '';
    return `
      <div class="card gate" id="qgate">
        <h3>还有 ${miss.length} 道题没答</h3>
        <p class="muted">未答的题不参与计分，结果页会标注「有 ${miss.length} 题未作答」，判断会打折扣。现在补上只要一两分钟。</p>
        <div class="chips gate-jump">${chips}${more}</div>
        <div class="btn-row">
          <button class="btn primary" data-act="gate-fill">补答这 ${miss.length} 题</button>
          <button class="btn" data-act="gate-submit">就这样生成结果</button>
          <button class="btn" data-act="gate-cancel">回到第 ${ITEMS.length} 题</button>
        </div>
      </div>`;
  }

  function testQuestion() {
    const i = Math.min(S.cursor, ITEMS.length - 1);
    const q = ITEMS[i];
    const sel = S.answers[q.id];
    const kind = KINDS[q.k];
    const answered = ITEMS.length - missingIdx().length;
    const last = i === ITEMS.length - 1;
    const dots = ITEMS.map((it, k) => {
      const on = typeof S.answers[it.id] === 'number';
      return `<button class="dot ${on ? 'on' : ''} ${k === i ? 'cur' : ''}" data-jump="${k}" title="第 ${k + 1} 题${on ? '（已答）' : ''}" aria-label="跳到第 ${k + 1} 题${on ? '，已答' : '，未答'}"></button>`;
    }).join('');

    return `
      ${gateOpen ? gateCard() : ''}
      <div class="card">
        <div class="quiz-head">
          <span class="small muted">第 ${i + 1} / ${ITEMS.length} 题</span>
          <span class="small muted">${kind} · ${DIM_MAP[q.d].name}</span>
        </div>
        <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${ITEMS.length}" aria-valuenow="${answered}"><i style="width:${(answered / ITEMS.length) * 100}%"></i></div>
        <div class="qtext">${esc(q.t)}</div>
        <div class="qhint">这句话有多符合你？<span class="kb-hint">也可按键盘 1—5</span></div>
        <div class="btn-row" style="margin-top:-4px">
          <button class="btn small" data-act="read-q">🔊 听题</button>
          <label class="switch"><input type="checkbox" id="autoRead" ${S.autoRead ? 'checked' : ''}> 自动朗读每题</label>
        </div>
        <div class="scale" id="scale">
          ${SCALE.map(s => `<button type="button" class="${sel === s.v ? 'sel' : ''}" data-v="${s.v}" aria-pressed="${sel === s.v}"><span class="n">${s.v}</span><span class="l">${s.l}</span></button>`).join('')}
        </div>
        <div class="btn-row">
          <button class="btn" data-act="prev-q" ${i === 0 ? 'disabled' : ''}>上一题</button>
          <button class="btn" data-act="skip-q">先跳过</button>
          <button class="btn" data-act="next-q" ${typeof sel === 'number' ? '' : 'disabled'}>${last ? '答完了，下一步' : '下一题'}</button>
        </div>
        <details class="dots-wrap">
          <summary class="small muted">查看答题进度（已答 ${answered} / ${ITEMS.length}）</summary>
          <div class="dots" role="group" aria-label="题目跳转">${dots}</div>
        </details>
      </div>
      ${submitCard()}`;
  }

  /* ---------------- 视图：职业星图 ---------------- */
  function filtered() {
    const f = S.filter;
    let list = matchAll();
    if (f.favOnly) list = list.filter(x => S.fav.indexOf(x.c.id) >= 0);
    if (f.local !== 'all') list = list.filter(x => x.c.local.indexOf(f.local) >= 0);
    if (f.edu !== 'all') {
      list = list.filter(x => {
        const e = x.c.edu;
        if (f.edu === 'low') return /大专|中职|能力导向/.test(e);
        if (f.edu === 'bachelor') return /本科/.test(e) && !/大专/.test(e);
        return true;
      });
    }
    const q = (f.q || '').trim();
    if (q) {
      list = list.filter(x => {
        const c = x.c;
        const hay = c.name + c.day + c.enter + c.grow + c.hint + c.bright.join('') + c.majors.join('') + c.code;
        return hay.indexOf(q) >= 0;
      });
    }
    return list;
  }

  function viewMap() {
    const f = S.filter;
    const list = filtered();

    return `
      <div class="card tight">
        <div class="field" style="margin-bottom:10px">
          <label class="sr-only" for="map-q">搜索职业</label>
          <input id="map-q" placeholder="搜索职业、专业或关键词，如“规划”“无人机”“护理”" value="${esc(f.q)}" autocomplete="off">
        </div>
        <div class="chips">
          ${[['all', '全部'], ['县城', '县城有岗'], ['乡镇', '乡镇有岗'], ['可远程', '可远程']].map(([k, l]) =>
            `<button class="chip ${f.local === k ? 'teal' : 'plain'}" data-fl="${k}" aria-pressed="${f.local === k}">${l}</button>`).join('')}
          <span class="chip-sep"></span>
          ${[['all', '全部学历'], ['low', '大专/中职可入'], ['bachelor', '本科起']].map(([k, l]) =>
            `<button class="chip ${f.edu === k ? 'amber' : 'plain'}" data-fe="${k}" aria-pressed="${f.edu === k}">${l}</button>`).join('')}
          <span class="chip-sep"></span>
          <button class="chip ${f.favOnly ? 'teal' : 'plain'}" data-ffav="1" aria-pressed="${f.favOnly}">★ 我的收藏 ${S.fav.length}</button>
        </div>
      </div>
      <p class="muted" style="margin:0 0 10px" id="mapCount">${mapCountText(list.length)}</p>
      <div class="career-list" id="mapList">
        ${list.length ? list.map(x => careerCard(x)).join('') : '<div class="empty"><div class="big">◎</div>没有符合条件的职业，换个关键词试试</div>'}
      </div>`;
  }

  function mapCountText(n) {
    return `共 ${CAREERS.length} 个职业画像，当前显示 ${n} 个。点开看“真实的一天”，按 ⇄ 可以并排对比。`;
  }

  function refreshMapList() {
    const list = filtered();
    const box = $('#mapList');
    if (box) box.innerHTML = list.length ? list.map(x => careerCard(x)).join('') : '<div class="empty"><div class="big">◎</div>没有符合条件的职业，换个关键词试试</div>';
    const cnt = $('#mapCount');
    if (cnt) cnt.textContent = mapCountText(list.length);
    const favChip = document.querySelector('[data-ffav]');
    if (favChip) favChip.textContent = '★ 我的收藏 ' + S.fav.length;
    syncCompareBar();
  }

  /* ---------------- 视图：对比 ---------------- */
  const CMP_ROWS = [
    ['兴趣代码', c => `<span class="code-inline">${c.code}</span>`],
    ['匹配度', c => (S.result ? `<b>${matchCareer(c, S.result)}</b>` : '—')],
    ['本地机会', c => esc(c.local)],
    ['学历门槛', c => esc(c.edu)],
    ['收入参考', c => esc(c.income)],
    ['真实的一天', c => esc(c.day)],
    ['怎么入行', c => esc(c.enter)],
    ['成长路径', c => esc(c.grow)],
    ['要提前知道', c => esc(c.hint)]
  ];

  function viewCompare() {
    const ids = S.compare;
    if (!ids.length) {
      return `<div class="card"><div class="eyebrow">对比</div><h2>还没有选中职业</h2>
        <p class="muted">回到“职业星图”，点卡片右上角的 ⇄ 选 2—3 个职业，这里会并排列出它们的真实差别。</p>
        <div class="btn-row"><button class="btn primary" data-act="go-map">去挑几个职业</button></div></div>`;
    }
    const cs = ids.map(id => CAREER_MAP[id]).filter(Boolean);
    return `
      <div class="card">
        <div class="eyebrow">并排对比</div>
        <h2>${cs.map(c => esc(c.name.split('（')[0])).join(' vs ')}</h2>
        <p class="muted">对比的重点不是“谁更好”，而是看清三条路的代价和门槛，再决定先从哪条开始试。</p>
        <p class="small muted swipe-hint">表格可以左右滑动查看全部内容 →</p>
        <div class="table-scroll">
          <table class="simple compare">
            <thead>
              <tr><th class="rowhead">对比项</th>${cs.map(c => `<th>${esc(c.name.split('（')[0])}</th>`).join('')}</tr>
            </thead>
            <tbody>
              ${CMP_ROWS.map(([label, fn]) => `<tr><th class="rowhead">${label}</th>${cs.map(c => `<td>${fn(c)}</td>`).join('')}</tr>`).join('')}
            </tbody>
          </table>
        </div>
        <div class="btn-row">
          <button class="btn" data-act="clear-compare">清空对比</button>
          <button class="btn" data-act="go-map">再加一个</button>
        </div>
      </div>`;
  }

  /* ---------------- 抽屉 ---------------- */
  function openSheet(html) {
    const sheet = $('#sheet');
    if (!sheet) return;
    sheet.innerHTML = html;
    sheet.classList.add('on');
    const bd = $('#sheetBackdrop');
    if (bd) bd.classList.add('on');
    sheet.scrollTop = 0;
    sheet.setAttribute('aria-hidden', 'false');
    document.body.classList.add('sheeting');
    const closeBtn = sheet.querySelector('[data-act="close-sheet"]');
    if (closeBtn) closeBtn.focus({ preventScroll: true });
  }

  /* ---------------- 职业详情 ---------------- */
  function openCareer(id) {
    const c = CAREER_MAP[id];
    if (!c) return;
    const score = matchCareer(c, S.result);
    const fav = S.fav.indexOf(c.id) >= 0;
    const inCmp = S.compare.indexOf(c.id) >= 0;
    const html = `
      <button class="btn close" data-act="close-sheet">关闭</button>
      <div class="eyebrow">职业画像 · ${esc(c.local)}</div>
      <h2>${esc(c.name)}</h2>
      <div class="chips" style="margin-bottom:14px">
        <span class="chip amber">霍兰德 ${c.code}</span>
        <span class="chip">${esc(c.edu)}</span>
        ${S.result ? `<span class="chip teal">匹配 ${score}</span>` : ''}
        ${c.bright.map(b => `<span class="chip plain">${esc(b)}</span>`).join('')}
      </div>
      <div class="dl">
        <div class="item"><div class="k">真实的一天</div><div class="v">${esc(c.day)}</div></div>
        <div class="item"><div class="k">怎么入行</div><div class="v">${esc(c.enter)}</div></div>
        <div class="item"><div class="k">对应专业</div><div class="v">${c.majors.map(esc).join('、')}</div></div>
        <div class="item"><div class="k">建议选科</div><div class="v">${c.subjects.map(esc).join('、')}</div></div>
        <div class="item"><div class="k">成长路径</div><div class="v">${esc(c.grow)}</div></div>
        <div class="item"><div class="k">收入参考</div><div class="v">${esc(c.income)}</div></div>
        <div class="item"><div class="k">要提前知道的事</div><div class="v">${esc(c.hint)}</div></div>
      </div>
      <div class="btn-row">
        <button class="btn primary" data-act="ask-about" data-name="${esc(c.name)}">就这个职业问学长</button>
        <button class="btn" data-act="read-career" data-id="${c.id}">🔊 朗读</button>
        <button class="btn" data-cmp="${c.id}">${inCmp ? '移出对比' : '加入对比'}</button>
        <button class="btn" data-fav="${c.id}">${fav ? '★ 已收藏' : '☆ 收藏'}</button>
        <button class="btn" data-act="close-sheet">继续逛</button>
      </div>
      <p class="muted" style="margin-top:14px">收入与招聘要求随地区、年限差异较大，此处的数字只作量级参考，正式报考请以当年招生简章与招聘公告为准。</p>
    `;
    openSheet(html);
  }

  function closeSheet() {
    const sheet = $('#sheet');
    if (!sheet) return;
    sheet.classList.remove('on');
    const bd = $('#sheetBackdrop');
    if (bd) bd.classList.remove('on');
    sheet.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('sheeting');
  }

  /* ---------------- 设置 ---------------- */
  function meName() {
    return S.profile.nick || '同学';
  }

  /* 顶栏头像：让「记录属于谁」一直看得见 */
  function paintUserChip() {
    const ava = $('#userAva');
    const nm = $('#userName');
    const n = meName();
    if (ava) ava.textContent = n.slice(0, 1);
    if (nm) nm.textContent = n;
  }

  function openSettings(sub) {
    const name = sub || 'main';
    let html = '';
    if (name === 'nick') html = viewSetNick();
    else if (name === 'grade') html = viewSetGrade();
    else if (name === 'subjects') html = viewSetSubjects();
    else if (name === 'star') html = viewSetStar();
    else if (name === 'about') html = viewSetAbout();
    else if (name === 'privacy' || name === 'user') html = viewProtocol(name);
    else html = viewSetMain();
    openSheet(html);
    const inp = document.querySelector('#sheet .set-input');
    if (inp) setTimeout(() => inp.focus({ preventScroll: true }), 90);
  }

  function countRecords() {
    return {
      answers: Object.keys(S.answers || {}).length,
      fav: (S.fav || []).length,
      tasks: (S.tasksDone || []).length,
      chats: (S.chat || []).length + (S.starChat || []).length,
      tests: (S.history || []).length
    };
  }

  function viewSetMain() {
    const nick = meName();
    const starCfg = window.XYXT_STAR ? window.XYXT_STAR.config() : { baseUrl: '', model: '' };
    const c = countRecords();
    return `
      <button class="btn close" data-act="close-sheet">关闭</button>
      <div class="eyebrow">我的设置</div>
      <div class="set-me">
        <span class="set-ava" aria-hidden="true">${esc(nick.slice(0, 1))}</span>
        <span class="set-me-txt">
          <b>${esc(nick)}</b>
          <small>本机使用 · 不用登录 · 记录留在这台设备上</small>
        </span>
      </div>

      <div class="set-stats">
        <div><b>${c.tests}</b><span>测评</span></div>
        <div><b>${c.fav}</b><span>收藏</span></div>
        <div><b>${c.tasks}</b><span>打卡</span></div>
        <div><b>${c.chats}</b><span>对话</span></div>
      </div>
      <p class="set-note">以上记录全部存在本机，关掉程序再打开还在。换电脑时用下面「导出备份」，到新电脑「导入备份」就接上了。</p>

      <div class="set-sec">
        <div class="set-h">个人</div>
        <button class="set-row" data-act="set-nav" data-set="nick"><span>修改称呼</span><span class="set-val">${esc(nick)} ›</span></button>
        <button class="set-row" data-act="set-nav" data-set="grade"><span>修改年级</span><span class="set-val">${esc(S.profile.grade)} ›</span></button>
        <button class="set-row" data-act="set-nav" data-set="subjects"><span>修改学科偏好</span><span class="set-val">${esc(subSummary())} ›</span></button>
      </div>

      <div class="set-sec">
        <div class="set-h">使用</div>
        <button class="set-row" data-act="set-tour"><span>重看新手引导</span><span class="set-val">${S.tourDone ? '已完成' : '还没看'} ›</span></button>
        <button class="set-row" data-act="set-nav" data-set="star"><span>小星星 · AI 设置</span><span class="set-val">${starCfg.baseUrl && starCfg.model ? '已接入大模型' : '内置知识库'} ›</span></button>
        <button class="set-row" data-act="voice-test"><span>试听朗读声音</span><span class="set-val">温柔女声 ›</span></button>
        <p class="set-note">朗读统一用系统里的中文女声（晓晓、慧慧、婷婷这类），语速偏慢、音调略柔和。设备上没装中文女声时，会自动用最接近的音色代替；想更好听，可以在系统「设置 → 时间和语言 → 语音」里加装中文语音包。</p>
      </div>

      <div class="set-sec">
        <div class="set-h">数据</div>
        <div class="set-btnrow">
          <button class="btn small" data-act="export-backup">导出备份</button>
          <button class="btn small" data-act="import-backup">导入备份</button>
          <button class="btn small danger" data-act="set-clear">清空本机数据</button>
        </div>
        <p class="set-note">备份是一个 JSON 文件，含测评作答、结果、收藏、打卡与小星星对话，可拷到 U 盘带走。程序不上传任何数据。</p>
      </div>

      <div class="set-sec">
        <div class="set-h">关于</div>
        <button class="set-row" data-act="set-nav" data-set="about"><span>关于乡野星图</span><span class="set-val">v${APP_VERSION} ›</span></button>
        <button class="set-row" data-act="set-nav" data-set="privacy"><span>隐私说明</span><span class="set-val">数据不出本机 ›</span></button>
        <button class="set-row" data-act="set-nav" data-set="user"><span>使用条款</span><span class="set-val">›</span></button>
      </div>
    `;
  }

  function viewSetNick() {
    const cur = meName();
    return `
      <button class="btn close" data-act="close-sheet">关闭</button>
      <div class="eyebrow">个人</div>
      <h2>你想怎么被称呼</h2>
      <p class="muted">会出现在结果页、导出报告和教师端汇总里。写真名或小名都行。</p>
      <label class="sr-only" for="setNickIn">称呼</label>
      <input class="set-input" id="setNickIn" maxlength="12" value="${esc(cur === '同学' ? '' : cur)}" placeholder="例如：小满">
      <div class="btn-row">
        <button class="btn primary" data-act="set-nick-save">保存</button>
        <button class="btn" data-act="set-nav" data-set="main">返回</button>
      </div>`;
  }

  function viewSetGrade() {
    const st = STAGE_OF(S.profile.grade);
    return `
      <button class="btn close" data-act="close-sheet">关闭</button>
      <div class="eyebrow">个人</div>
      <h2>你现在读几年级</h2>
      <p class="muted">年级决定首页给的建议，也决定探索任务里哪些项标「适用：XX」。小学五、六年级到中职三年级都在里面。</p>
      <div class="field">
        <label for="setGrade">年级</label>
        <select id="setGrade" data-pf="grade">
          ${GRADES.map(g => `<option ${S.profile.grade === g ? 'selected' : ''}>${g}</option>`).join('')}
        </select>
        <p class="small muted" id="setGradeStage" style="margin:8px 0 0">当前学段：${STAGE_NAME[st]}。选完立刻生效，不用再点保存。</p>
      </div>
      <div class="btn-row">
        <button class="btn" data-act="set-nav" data-set="main">返回</button>
        <button class="btn" data-act="close-sheet">关闭</button>
      </div>`;
  }

  /* 修改学科偏好：recommend() 用 S.profile.subjects 参与匹配打分，
     以前只有首页「建档」卡片能选，填过称呼（或载入过样例学生）的同学就再也改不了。
     这里给一个与「修改年级」同构的入口；点 chip 不重绘面板，只看得到那一行文案在变。 */
  function viewSetSubjects() {
    return `
      <button class="btn close" data-act="close-sheet">关闭</button>
      <div class="eyebrow">个人</div>
      <h2>你比较拿手的学科</h2>
      <p class="muted">可多选，也可以一门都不选。选了的学科会让相关方向的职业匹配度更高，选完立刻生效，不用点保存。</p>
      <div class="field">
        <label id="set-sub-label">选几门拿手的（可多选）</label>${subjectChips('set-subjects', 'set-sub-label')}
      </div>
      <p class="small muted" id="setSubNow" style="margin:12px 0 0">${esc(subNowText())}</p>
      <div class="btn-row">
        <button class="btn" data-act="set-nav" data-set="main">返回</button>
        <button class="btn" data-act="close-sheet">关闭</button>
      </div>`;
  }

  function viewProtocol(kind) {
    if (kind === 'user') {
      return `
        <button class="btn close" data-act="close-sheet">关闭</button>
        <div class="eyebrow">使用条款</div>
        <h2>这是一件什么工具</h2>
        <p class="muted">乡野星图是职业探索的辅助工具，不是测评诊断，也不替你做升学决定。</p>
        <div class="dl">
          <div class="item"><div class="k">结果怎么用</div><div class="v">兴趣代码和推荐只用来缩小探索范围。真正的决定要结合成绩、家庭条件和本地机会，和老师、家长一起判断。</div></div>
          <div class="item"><div class="k">数据怎么算</div><div class="v">收入、学历门槛、本地岗位来自公开资料整理，会随地区与年份变化。正式报考请以当年招生简章和招聘公告为准。</div></div>
          <div class="item"><div class="k">谁可以用</div><div class="v">面向中学生及教师免费使用。未满 14 周岁的同学请在老师或家长陪同下使用。</div></div>
          <div class="item"><div class="k">内容边界</div><div class="v">职业描述力求真实，包括辛苦和不体面的部分；如发现与实际不符，欢迎反馈，我们会改。</div></div>
        </div>`;
    }
    return `
      <button class="btn close" data-act="close-sheet">关闭</button>
      <div class="eyebrow">隐私说明</div>
      <h2>你的数据不出这台设备</h2>
      <p class="muted">程序没有服务器，也不发网络请求（除非你自己在「小星星 · AI 设置」里填了大模型接口）。</p>
      <div class="dl">
        <div class="item"><div class="k">存了什么</div><div class="v">称呼、年级、所在县、选科、60 题作答、兴趣代码、收藏、对比、打卡、与小星星/学长的对话、引导完成状态。</div></div>
        <div class="item"><div class="k">存在哪</div><div class="v">只存在这台设备的浏览器本地存储里。关掉程序不丢，换设备不会自动同步。</div></div>
        <div class="item"><div class="k">谁会看到</div><div class="v">只有用这台设备的人。教师端汇总需要你手动粘贴或导入兴趣代码才会生成，不会自动上传。</div></div>
        <div class="item"><div class="k">怎么删</div><div class="v">「我的设置 → 清空本机数据」一次性删干净；也可以直接删掉程序所在文件夹。</div></div>
        <div class="item"><div class="k">接了大模型呢</div><div class="v">若你填了接口地址与 Key，小星星在本地知识库答不上来时会把你这一句提问发过去。不吃这道菜就别填。</div></div>
      </div>`;
  }

  function viewSetStar() {
    const c = window.XYXT_STAR ? window.XYXT_STAR.config() : { baseUrl: '', apiKey: '', model: '' };
    return `
      <button class="btn close" data-act="close-sheet">关闭</button>
      <div class="eyebrow">小星星 · AI 设置</div>
      <h2>要不要给星星接个大脑</h2>
      <p class="muted">不填也能用：小星星内置了 58 条程序使用知识 + 本地职业知识库，断网也能答。</p>
      <p class="muted">填了之后，内置知识库答不了的问题会转给大模型；接口失败会自动退回本地回答，不会把对话卡住。</p>
      <label class="set-label" for="starBase">接口地址（OpenAI 兼容）</label>
      <input class="set-input" id="starBase" value="${esc(c.baseUrl)}" placeholder="https://api.example.com/v1">
      <label class="set-label" for="starKey">API Key</label>
      <input class="set-input" id="starKey" type="password" value="${esc(c.apiKey || '')}" placeholder="留空表示不需要">
      <label class="set-label" for="starModel">模型名</label>
      <input class="set-input" id="starModel" value="${esc(c.model)}" placeholder="例如 deepseek-chat">
      <div class="btn-row">
        <button class="btn small" data-act="set-star-deepseek">一键填入 DeepSeek</button>
      </div>
      <p class="small muted">DeepSeek：接口地址填 <code>https://api.deepseek.com/v1</code>，模型填 <code>deepseek-chat</code>（对话）或 <code>deepseek-reasoner</code>（深度思考）。Key 在 platform.deepseek.com 申请。</p>
      <p class="small muted">也可以填任意 OpenAI 兼容服务（通义千问、Kimi、智谱等），格式都是 <code>/chat/completions</code>。</p>
      <p class="small muted">Key 只存在这台设备，但前端填 Key 仅适合自用与演示；要公开部署请改成自己的服务端代理。</p>
      <p class="set-note">Key 只存在这台设备的本地存储里，不会随备份以外的方式外传。演示机请不要填真实 Key。</p>
      <div class="btn-row">
        <button class="btn primary" data-act="set-star-save">保存</button>
        <button class="btn" data-act="set-star-clear">改回本地知识库</button>
        <button class="btn" data-act="set-nav" data-set="main">返回</button>
      </div>`;
  }

  function viewSetAbout() {
    return `
      <button class="btn close" data-act="close-sheet">关闭</button>
      <div class="eyebrow">关于</div>
      <h2>乡野星图 v${APP_VERSION}</h2>
      <p class="muted">县乡青少年职业探索工作台。做它的原因很朴素：县乡孩子缺的不是努力，是“看见”——看见有哪些职业、看见路怎么走。</p>
      <div class="dl">
        <div class="item"><div class="k">主线</div><div class="v">建档 → 霍兰德测评（${ITEMS.length} 题）→ 个性化推荐 → 职业画像与对比 → 问答 → 每周任务 → 班级看板</div></div>
        <div class="item"><div class="k">职业库</div><div class="v">${CAREERS.length} 个县域可触达的职业，每个都写了真实的一天、入行路径、学历门槛和本地机会</div></div>
        <div class="item"><div class="k">任务</div><div class="v">${TASKS.length} 件分三阶的小事：轻松上手 / 需要开口 / 要花点功夫，按年级标出适用学段</div></div>
        <div class="item"><div class="k">教师端</div><div class="v">独立页面 teacher.html：粘贴学生结果码生成班级看板，与学生端数据完全分开</div></div>
        <div class="item"><div class="k">数据</div><div class="v">不用登录、不联网，全部存在本机；可用 JSON 备份带走或恢复</div></div>
        <div class="item"><div class="k">助手</div><div class="v">小星星：内置程序使用知识与职业问答，完全离线；也可自行接入大模型</div></div>
        <div class="item"><div class="k">出品</div><div class="v">「拾光职引」队伍 · 2026“联通杯”广东第二师范学院 AI 应用创新大赛 · 县乡教育赋能赛道</div></div>
      </div>
      <div class="set-sec">
        <div class="set-h">教师端</div>
        <button class="set-row" data-act="open-teacher"><span>教师端入口（独立页面）</span><span class="set-val">teacher.html ›</span></button>
        <p class="set-note">教师端是给学生之外的人用的独立页面，学生端不占位置，也不会读取这边的任何记录。</p>
      </div>
      <p class="set-note">测评结果用于缩小探索范围，不构成升学或职业选择的唯一依据；收入与门槛随地区年份变化，正式报考请以当年招生简章为准。</p>
    `;
  }

  function saveNick() {
    const inp = $('#setNickIn');
    const v = (inp ? inp.value : '').trim();
    if (!v) { toast('写个称呼再保存'); return; }
    S.profile.nick = v;
    save();
    paintUserChip();
    closeSheet();
    render({ keepScroll: true });
    toast('称呼已改为「' + v + '」');
  }

  function saveStarCfg() {
    const g = id => (($('#' + id) || {}).value || '').trim();
    const c = { baseUrl: g('starBase'), apiKey: g('starKey'), model: g('starModel') };
    if (c.baseUrl && !/^https?:\/\//.test(c.baseUrl)) {
      toast('接口地址要以 http:// 或 https:// 开头');
      return;
    }
    if (window.XYXT_STAR) window.XYXT_STAR.saveConfig(c);
    closeSheet();
    toast(c.baseUrl && c.model ? '已接入大模型，小星星会先查知识库再问模型' : '已改回本地知识库');
  }

  function startTour() {
    if (!window.XYXT_TOUR) return;
    window.XYXT_TOUR.start({
      onDone: () => { S.tourDone = true; save(); },
      onSkip: () => { S.tourDone = true; save(); }
    });
  }

  /* ---------------- 问答引擎 ---------------- */
  const ALIAS = {
    '护士': 'nurse', '护理': 'nurse', '医生': 'doctor', '临床': 'doctor', '老师': 'teacher', '教师': 'teacher',
    '幼师': 'preschool', '幼儿园': 'preschool', '电网': 'electric', '电气': 'electric', '数控': 'mech', '机械': 'mech',
    '汽修': 'nev', '修车': 'nev', '汽车': 'nev', '建筑': 'civil', '造价': 'civil', '工地': 'civil',
    '会计': 'account', '财务': 'account', '公务员': 'gov', '考公': 'gov', '体制': 'gov', '社工': 'social',
    '心理': 'psych', '农业': 'agri', '种地': 'agri', '兽医': 'vet', '宠物': 'vet', '电商': 'ecom', '直播': 'ecom',
    '无人机': 'uav', '飞手': 'uav', '程序员': 'dev', '码农': 'dev', '计算机': 'dev', '软件': 'dev',
    '数据': 'data', '设计': 'design', '铁路': 'rail', '地铁': 'rail', '食品': 'food', '检验': 'food',
    '民宿': 'homestay', '旅游': 'homestay', 'AI': 'aiops', '人工智能': 'aiops', '养老': 'elder', '跨境': 'cross',
    '规划': 'planner', '城乡规划': 'planner', '国土': 'planner', '村庄': 'ruralplanner', '乡村规划': 'ruralplanner',
    '测绘': 'gis', 'GIS': 'gis', '地理信息': 'gis', '药师': 'pharmacy', '药学': 'pharmacy'
  };

  const INTENTS = [
    { k: 'local', re: /县城|本地|回家|家乡|乡镇|留在|外地|村里|家门口/ },
    { k: 'money', re: /工资|收入|赚|薪|多少钱|待遇/ },
    { k: 'edu', re: /学历|分数|考多少|本科|大专|门槛|成绩|考得上|中考|高考/ },
    { k: 'subject', re: /选科|学什么|专业|报什么|文科|理科|学哪个/ },
    { k: 'hard', re: /累|辛苦|压力|难|加班|劝退|后悔|夜班/ },
    { k: 'start', re: /怎么开始|准备|现在|高[一二三]|初中|起步|第一步|来得及/ },
    { k: 'future', re: /前景|未来|AI|取代|趋势|发展|吃香/ },
    { k: 'family', re: /家里|爸妈|父母|条件|没钱|负担|学费|花钱/ }
  ];

  function findCareers(text, limit) {
    const hit = [];
    CAREERS.forEach(c => {
      if (text.indexOf(c.name.split('（')[0]) >= 0 && hit.indexOf(c) < 0) hit.push(c);
    });
    const keys = Object.keys(ALIAS).sort((a, b) => b.length - a.length);
    keys.forEach(k => {
      if (text.indexOf(k) >= 0) {
        const c = CAREER_MAP[ALIAS[k]];
        if (c && hit.indexOf(c) < 0) hit.push(c);
      }
    });
    return hit.slice(0, limit || 3);
  }

  function localLine(c) {
    const m = {
      '县城有岗': '这个职业在县城是有岗位的。县域医院、学校、供电所、规划与测绘单位、加工企业每年都在招人，缺点是名额少、常要考试，优点是生活成本和离家距离都低。',
      '乡镇有岗': '这类岗位多在乡镇，比如农技站、社工站、基层政府、养老机构、乡村规划师。竞争相对小，但要习惯跑村和“一人多岗”。',
      '县域工业园有岗': '县里的工业园是主要去处。这类岗位看重实操和证书，学历门槛没那么死，但行业周期会影响收入。',
      '可远程': '这类工作不绑地域，只要有网络和一台电脑就能接活，是“留在家乡、赚外面的钱”的现实路径。但前提是作品和能力过硬，前两年通常要靠自学补课。',
      '县域有岗': '县里相关单位和企业有岗位，但数量有限，通常要考试或靠项目进入。',
      '县乡有岗': '县城和乡镇都有岗位，多数走考试或在编招聘，基层岗位竞争相对小。'
    };
    return m[c.local] || ('这个职业的本地机会属于“' + c.local + '”，具体岗位要看当年当地的招聘公告。');
  }

  function startLine(c) {
    const first = (c.enter || '').split('；')[0];
    return first + '。这个学期可以先做两件事：一是把' + (c.subjects[0] || '相关学科') + '的成绩稳住，二是找一位在这个行业里的人聊 20 分钟。';
  }

  function futureLine(c) {
    return '这个职业正在被技术改变，但被替代的通常是重复的部分，不是判断和沟通的部分。' + c.grow + '判断一个方向值不值得走，看它有没有“越做越值钱”的台阶。';
  }

  const INTENT_ANSWER = {
    local: c => '关于留在本地：' + localLine(c),
    money: c => '关于收入：' + c.income + '。这只是量级参考，刚入行通常从低位开始。',
    edu: c => '关于门槛：这个方向一般要求' + c.edu + '。' + c.enter,
    subject: c => '关于选科和专业：建议关注 ' + c.subjects.join('、') + '；对口专业有 ' + c.majors.join('、') + '。',
    hard: c => '关于辛苦这件事：' + c.hint,
    start: c => '现在就动手的话，我会建议：' + startLine(c),
    future: c => '关于前景：' + futureLine(c),
    family: c => '关于家里条件：这个方向前期投入不算高，' + c.edu + '就能起步；' + (c.local === '可远程' ? '而且可以远程接活，不用一开始就搬去大城市。' : '本地也有岗位，不用非得离家很远。')
  };

  function compareCareers(cs) {
    const lines = ['这两个不用急着分高下，先把差别摆出来。'];
    cs.forEach(c => {
      lines.push('【' + c.name.split('（')[0] + '】\n· 门槛：' + c.edu + '\n· 本地机会：' + c.local + '\n· 收入量级：' + c.income + '\n· 最难的地方：' + c.hint);
    });
    const a = cs[0], b = cs[1];
    lines.push('如果只能先选一个来试：看你更怕哪种辛苦——' + a.name.split('（')[0] + '怕的是“' + a.hint.split('；')[0] + '”，' + b.name.split('（')[0] + '怕的是“' + b.hint.split('；')[0] + '”。选那个你能忍的。');
    return lines.join('\n\n');
  }

  function personalAnswer() {
    if (!S.result) {
      return '我还不知道你的兴趣长什么样。先做一次测评（60 道题，8 分钟），我再按你的结果说话，比空谈靠谱。';
    }
    const list = recommend(3);
    const lines = ['按你的「' + S.result.code + '」来看，我会先带你看这三个方向：'];
    list.forEach((x, i) => {
      lines.push((i + 1) + '. ' + x.c.name + '（匹配 ' + x.score + '）\n   ' + x.why + '\n   门槛：' + x.c.edu + '；本地机会：' + x.c.local);
    });
    lines.push('三个都不必现在就定，挑一个做一次“每周任务”，试过再判断。想细问哪个，直接说名字。');
    return lines.join('\n\n');
  }

  function answer(text) {
    const t = String(text || '');
    const cs = findCareers(t);

    if (cs.length >= 2 && /(哪个|对比|区别|还是|和|跟|vs|VS)/.test(t)) {
      return { text: compareCareers(cs.slice(0, 2)), careerId: null };
    }

    if (/(我适合|适合我|推荐|选什么|报什么好|不知道选|给点建议)/.test(t) && !cs.length) {
      return { text: personalAnswer(), careerId: null };
    }

    const intents = INTENTS.filter(i => i.re.test(t)).map(i => i.k);
    let c = cs[0] || null;

    if (!c && S.lastCareer && t.length <= 12 && intents.length) c = CAREER_MAP[S.lastCareer];

    if (c) {
      const parts = ['我是走过这条路的学长，说点实在的。'];
      if (!intents.length) {
        parts.push(c.name + '的一天大概是这样的：' + c.day);
        parts.push('入行的路径是：' + c.enter);
        parts.push('它的成长路径是：' + c.grow);
        parts.push('想细问哪一块？可以问我“在县城有工作吗”“工资多少”“要学什么专业”“累不累”。');
      } else {
        intents.slice(0, 2).forEach(k => {
          const fn = INTENT_ANSWER[k];
          if (fn) parts.push(fn(c));
        });
        if (intents.indexOf('local') < 0 && intents.indexOf('money') < 0) {
          parts.push('顺带说一句本地机会：' + c.local + '。');
        }
      }
      return { text: parts.join('\n\n'), careerId: c.id };
    }

    if (intents.indexOf('local') >= 0) {
      return {
        text: '很多人以为“留在家乡”和“有出息”是对立的，其实不是。\n\n星图里每个职业都标了本地机会，大致分四类：\n· 县城有岗：教师、护理、医生、会计、电网、质检、规划、测绘等，靠考编或本地招聘进入；\n· 乡镇有岗：农技、社工、养老、乡村规划师、基层公务员，常年缺人；\n· 可远程：设计、开发、数据分析、AI 相关，只要有网络就能接单；\n· 要走出去：跨境电商、三甲医院专科、部分研发岗。\n\n你可以先想清楚一件事：三年后你更想“离家近”，还是“机会多”。没有对错，但答案会决定你现在的重点。',
        careerId: null
      };
    }
    if (intents.indexOf('edu') >= 0) {
      return {
        text: '成绩不是唯一的分岔口，但确实是目前最宽的那条路。\n\n几个真实的通道：\n· 本科线以上：普通本科 → 考研/考编/校招；\n· 本科线附近：公办专科的好专业，往往比民办本科的冷门专业更好就业；\n· 中职/职高：技能大赛、订单班、职教高考、专升本，都能继续往上走。\n\n护理、数控、新能源维修、无人机、养老照护这些方向，看的是证书和手上功夫。你想先看哪一条？',
        careerId: null
      };
    }
    if (intents.indexOf('family') >= 0) {
      return {
        text: '家里条件不支持读很多年书，是很现实的限制，不用回避。\n\n可以优先看三类：一是学制短、能考编的（护理、幼师、乡村医生定向）；二是订单班、企业冠名班，进去就有岗；三是本地上班、住家里，省下住宿和生活费。\n\n这些在星图里都能筛出来：把“学历门槛”切到“大专/中职可入”，再按“县城有岗”过滤。',
        careerId: null
      };
    }
    if (intents.indexOf('hard') >= 0) {
      return { text: FAQ[1].a, careerId: null };
    }

    const picks = recommend(3);
    const names = picks.length ? picks.map(x => x.c.name.split('（')[0]) : CAREERS.slice(0, 3).map(c => c.name.split('（')[0]);
    return {
      text: '这个问题我还答不好，但我可以帮你把它变具体一点。\n\n试着这样问：\n· “护理在县城医院好找工作吗？”\n· “无人机飞手要考什么证？”\n· “我想学规划，但成绩一般怎么办？”\n· “我适合什么？”\n\n或者先看看这几个职业：' + names.join('、') + '。',
      careerId: null
    };
  }

  /* ---------------- 视图：问问学长 ---------------- */
  const GREET = '你好，我是“问问学长”——一个专门回答县乡学生职业问题的助手。\n\n你可以打字，也可以按住麦克风说话，带口音没关系，识别出来先看一眼、改一改再发。\n\n试试问：“护理在县城好找工作吗”“无人机飞手要考什么证”“我适合什么”。';

  function viewAsk() {
    const msgs = S.chat;
    const lastAi = [...msgs].reverse().find(m => m.role !== 'me');
    const quick = lastAi && lastAi.careerId
      ? ['在县城有岗吗', '工资多少', '要学什么专业', '累不累']
      : ['我适合什么', '护理在县城好找工作吗', '无人机飞手要考什么证', '家里条件一般读什么好'];

    return `
      <div class="card">
        <div class="eyebrow">领域专家 · 本地知识库 · 语音提问</div>
        <h2>问问学长</h2>
        <p class="muted">回答来自内置的职业知识库，不联网也能用。语音识别需要联网；涉及具体招聘与分数，请以当年公告为准。</p>
        <div class="chat-box" id="chatBox" role="log" aria-live="polite">
          ${msgs.length ? msgs.map(m => `<div class="msg ${m.role === 'me' ? 'me' : 'ai'}">${esc(m.text)}</div>`).join('') : `<div class="msg ai">${esc(GREET)}</div>`}
        </div>
        <div class="suggest no-print" id="quickAsk">
          ${quick.map(q => `<button data-ask="${esc(q)}">${esc(q)}</button>`).join('')}
          ${msgs.length ? `<button data-act="clear-chat" class="ghost">清空对话</button>` : ''}
        </div>
        <div class="chat-input">
          <button class="btn mic" id="micBtn" data-act="voice" title="说话提问" aria-label="语音输入">🎤</button>
          <label class="sr-only" for="chatIn">你的问题</label>
          <input id="chatIn" placeholder="说一句你现在最纠结的事，也可以直接打字…" maxlength="120">
          <button class="btn primary" data-act="send">发送</button>
        </div>
        <p class="small muted" id="micHint" style="margin-top:8px"></p>
      </div>
      <div class="card tight">
        <h4>几个常被问到的问题</h4>
        ${FAQ.map(f => `<p class="small faq-item"><b class="faq-q">${esc(f.q)}</b><br><span class="muted">${esc(f.a)}</span></p>`).join('')}
      </div>`;
  }

  /* ---------------- 视图：探索任务（三阶，由易到难） ---------------- */
  function viewTask() {
    const done = S.tasksDone;
    const stage = STAGE_OF(S.profile.grade);
    const pct = Math.round((done.length / TASKS.length) * 100);

    const groups = TASK_LEVELS.map(L => {
      const items = TASKS.map((t, i) => ({ t, i })).filter(x => x.t.lv === L.lv);
      const finished = items.filter(x => done.indexOf(x.t.id) >= 0).length;
      const list = items.map(({ t, i }) => {
        const fit = t.st.indexOf(stage) >= 0;
        const on = done.indexOf(t.id) >= 0;
        const stageTag = fit ? '' : `<span class="stag">适用：${t.st.map(k => STAGE_NAME[k]).join('/')}</span>`;
        return `
          <label class="task ${on ? 'done' : ''} ${fit ? '' : 'dim'}">
            <input type="checkbox" data-task="${t.id}" ${on ? 'checked' : ''}>
            <span class="idx" aria-hidden="true">${String(i + 1).padStart(2, '0')}</span>
            <span>
              <span class="t">${esc(t.title)}</span>
              <span class="d">${esc(t.desc)}</span>
            </span>
            <span class="min">${stageTag}${t.tag} · ${t.min}′</span>
          </label>`;
      }).join('');
      return `
        <div class="card">
          <div class="lv-head">
            <div class="lv-t">
              <b>第 ${L.lv} 阶 · ${L.name}</b>
              <small>${L.sub}</small>
            </div>
            <span class="lv-n">${finished}/${items.length}</span>
          </div>
          ${list}
        </div>`;
    }).join('');

    return `
      <div class="card">
        <div class="eyebrow">每周一件小事</div>
        <h2>探索任务 · ${TASKS.length} 件由易到难的小事</h2>
        <p class="muted">想不清楚的时候，先做一件小事。完成 ${done.length} / ${TASKS.length} 项。</p>
        <div class="progress" style="margin:10px 0 4px" role="progressbar" aria-valuemin="0" aria-valuemax="${TASKS.length}" aria-valuenow="${done.length}"><i style="width:${pct}%"></i></div>
        <p class="small muted">${pct}% 完成　·　当前学段：${STAGE_NAME[stage]}</p>
        <p class="small muted">不用按顺序打勾，但按难度往下走最容易坚持。标了「适用：」的任务是别的学段更要紧的，先放着。</p>
      </div>
      ${groups}
      <div class="card tight">
        <h4>为什么要做任务，而不是只看测评</h4>
        <p class="muted">测评告诉你“可能喜欢什么”，任务告诉你“是不是真的喜欢”。县乡学生最缺的不是信息，是接触真实工作场景的机会——这 ${TASKS.length} 件小事，就是最小成本的接触方式。</p>
      </div>`;
  }

  /* ---------------- 视图：科学性 ---------------- */
  function viewScience() {
    const res = S.result;
    return `
      <div class="card">
        <div class="eyebrow">量表说明 · 可核查</div>
        <h2>${esc(SDS.name)}</h2>
        <p class="lead">${esc(SDS.origin)}</p>
        ${res ? `<div class="card tight note-box">
          <h4 style="margin-bottom:6px">你的这次结果</h4>
          <p class="small" style="margin:0">兴趣代码 <b>${res.code}</b>　·　分化度 <b>${res.diff}</b>　·　一致性 <b>${res.cons.level}</b>（${esc(res.cons.note)}）　·　已答 <b>${res.answered}/${res.total}</b></p>
        </div>` : ''}
      </div>

      <div class="card">
        <h3>一、题目结构</h3>
        <p class="muted">六维度各 10 题，共 ${ITEMS.length} 题；每维包含活动偏好、能力自评、职业意愿三类题项，对应 SDS 的题项设计思路。</p>
        <table class="simple">
          <thead><tr><th>题项类型</th><th>题数</th><th>在测什么</th></tr></thead>
          <tbody>${SDS.structure.map(s => `<tr><td>${esc(s.k)}</td><td>${s.n}</td><td>${esc(s.d)}</td></tr>`).join('')}</tbody>
        </table>
      </div>

      <div class="card">
        <h3>二、怎么计分</h3>
        <ol class="small list-num">
          ${SDS.scoring.map(s => `<li>${esc(s)}</li>`).join('')}
        </ol>
      </div>

      <div class="card">
        <h3>三、信度与效度</h3>
        ${SDS.reliability.map(s => `<p class="small">· ${esc(s)}</p>`).join('')}
        <h4 style="margin-top:12px">效度证据</h4>
        ${SDS.validity.map(s => `<p class="small">· ${esc(s)}</p>`).join('')}
      </div>

      <div class="card">
        <h3>四、局限与伦理</h3>
        ${SDS.limits.map(s => `<p class="small">· ${esc(s)}</p>`).join('')}
        <p class="muted" style="margin-top:10px">我们不做“你适合什么”的断言，只提供三个可以继续验证的方向，并给出下一步可做的小事。</p>
      </div>

      <div class="card tight">
        <h4>参考文献</h4>
        ${SDS.refs.map((r, i) => `<p class="small muted ref">[${i + 1}] ${esc(r)}</p>`).join('')}
      </div>`;
  }

  /* ---------------- 路由 ---------------- */
  let route = 'home';

  const TITLES = {
    home: '我的星图', test: '兴趣测评', map: '职业星图', ask: '问问学长',
    task: '探索任务', science: '科学性', compare: '职业对比'
  };

  function render(opts) {
    const scroll = opts && opts.keepScroll ? window.scrollY : 0;
    const view = $('#view');
    let html = '';
    if (route === 'home') html = viewHome();
    else if (route === 'test') html = viewTest();
    else if (route === 'map') html = viewMap();
    else if (route === 'ask') html = viewAsk();
    else if (route === 'task') html = viewTask();
    else if (route === 'science') html = viewScience();
    else if (route === 'compare') html = viewCompare();
    view.innerHTML = html;

    document.querySelectorAll('.tab').forEach(t => {
      const on = t.dataset.view === route;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.setAttribute('tabindex', on ? '0' : '-1');
    });

    if (route === 'ask') {
      const box = $('#chatBox');
      if (box) box.scrollTop = box.scrollHeight;
      const hint = $('#micHint');
      if (hint) hint.textContent = micHintText();
    }
    if (route === 'test' && S.testing && S.autoRead) {
      const q = ITEMS[S.cursor];
      if (q && spokenFor !== q.id) { spokenFor = q.id; speak(q.t); }
    }
    syncCompareBar();
    paintUserChip();
    if (scroll) window.scrollTo(0, scroll);
  }

  function micHintText() {
    if (!srSupported()) return '当前浏览器不支持语音识别，请用 Edge / Chrome 打开，或直接打字。';
    if (location.protocol === 'file:') return '点 🎤 说话。注意：用「本地文件」方式打开时浏览器不允许录音，请改用 打开.bat 启动。';
    return '点 🎤 说话，识别结果会先填进输入框，可以直接改字再发送。';
  }

  function go(v) {
    if (!TITLES[v]) v = 'home';
    route = v;
    resetArm = false;   /* 换页就让「确认清空」失效，免得下次回来手一滑就清了 */
    if (location.hash !== '#' + v) {
      try { history.replaceState(null, '', '#' + v); } catch (e) { /* file:// 下忽略 */ }
    }
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    const view = $('#view');
    if (view) { view.setAttribute('tabindex', '-1'); view.focus({ preventScroll: true }); }
  }

  /* ---------------- 对比条 ---------------- */
  function syncCompareBar() {
    let bar = $('#cmpbar');
    if (!S.compare.length) {
      if (bar) bar.remove();
      return;
    }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'cmpbar';
      bar.className = 'cmpbar';
      document.body.appendChild(bar);
    }
    bar.innerHTML = `
      <div class="cmpbar-in">
        <span class="small">已选 ${S.compare.length} 个：${S.compare.map(id => esc(((CAREER_MAP[id] || {}).name || '').split('（')[0])).join(' · ')}</span>
        <span class="cmpbar-btns">
          <button class="btn small primary" data-act="go-compare" ${S.compare.length < 2 ? 'disabled' : ''}>开始对比</button>
          <button class="btn small" data-act="clear-compare">清空</button>
        </span>
      </div>`;
  }

  /* ---------------- 事件 ---------------- */
  function toggleFav(id) {
    const i = S.fav.indexOf(id);
    if (i >= 0) { S.fav.splice(i, 1); toast('已取消收藏'); }
    else { S.fav.push(id); toast('已收藏，可在“职业星图”里筛出来'); }
    save();
    return i < 0;
  }

  function toggleCompare(id) {
    const i = S.compare.indexOf(id);
    if (i >= 0) { S.compare.splice(i, 1); }
    else {
      if (S.compare.length >= MAX_COMPARE) {
        toast('最多对比 ' + MAX_COMPARE + ' 个，先移出一个');
        return null;
      }
      S.compare.push(id);
    }
    save();
    return i < 0;
  }

  document.addEventListener('click', e => {
    const tab = e.target.closest('.tab');
    if (tab) { stopSpeak(); stopRec(); go(tab.dataset.view); return; }

    const subBtn = e.target.closest('[data-sub]');
    if (subBtn) {
      const s = subBtn.dataset.sub;
      const i = S.profile.subjects.indexOf(s);
      if (i >= 0) S.profile.subjects.splice(i, 1); else S.profile.subjects.push(s);
      subBtn.classList.toggle('teal');
      subBtn.classList.toggle('plain');
      subBtn.setAttribute('aria-pressed', S.profile.subjects.indexOf(s) >= 0 ? 'true' : 'false');
      save();
      /* 设置面板里那一行「已选 …」跟着变；首页没有这行，paintSubNow 自己会跳过 */
      paintSubNow();
      return;
    }

    const favBtn = e.target.closest('[data-fav]');
    if (favBtn) {
      e.stopPropagation();
      const id = favBtn.dataset.fav;
      const added = toggleFav(id);
      if (favBtn.classList.contains('icon-btn')) {
        favBtn.classList.toggle('on', added);
        favBtn.textContent = added ? '★' : '☆';
        favBtn.setAttribute('aria-pressed', added ? 'true' : 'false');
        if (route === 'map' && S.filter.favOnly) refreshMapList();
      } else {
        openCareer(id);
      }
      return;
    }

    const cmpBtn = e.target.closest('[data-cmp]');
    if (cmpBtn) {
      e.stopPropagation();
      const id = cmpBtn.dataset.cmp;
      const added = toggleCompare(id);
      if (added === null) return;
      if (route === 'compare') { render(); return; }
      if (cmpBtn.classList.contains('icon-btn')) {
        cmpBtn.classList.toggle('on', added);
        cmpBtn.setAttribute('aria-pressed', added ? 'true' : 'false');
      } else {
        openCareer(id);
      }
      syncCompareBar();
      return;
    }

    const fl = e.target.closest('[data-fl]');
    if (fl) { S.filter.local = fl.dataset.fl; save(); render({ keepScroll: true }); return; }

    const fe = e.target.closest('[data-fe]');
    if (fe) { S.filter.edu = fe.dataset.fe; save(); render({ keepScroll: true }); return; }

    const ff = e.target.closest('[data-ffav]');
    if (ff) { S.filter.favOnly = !S.filter.favOnly; save(); render({ keepScroll: true }); return; }

    const jump = e.target.closest('[data-jump]');
    if (jump) { gateOpen = false; S.cursor = Number(jump.dataset.jump); save(); render(); return; }

    if (e.target.closest('[data-task]')) return; // 交给 change

    const askBtn = e.target.closest('[data-ask]');
    if (askBtn) { sendChat(askBtn.dataset.ask); return; }

    const scaleBtn = e.target.closest('#scale button');
    if (scaleBtn) { answerItem(Number(scaleBtn.dataset.v), scaleBtn); return; }

    const act = e.target.closest('[data-act]');
    const careerEl = e.target.closest('[data-career]');
    if (careerEl && !act) { openCareer(careerEl.dataset.career); return; }
    if (!act) return;

    const a = act.dataset.act;
    switch (a) {
      case 'go-test': go('test'); break;
      case 'go-map': go('map'); break;
      case 'go-ask': go('ask'); break;
      case 'go-home': go('home'); break;
      case 'go-science': go('science'); break;
      case 'open-teacher':
        /* 教师端是独立页面：新窗口打开；被拦截时退回当前窗口跳转 */
        if (!window.open('teacher.html', '_blank')) { location.href = 'teacher.html'; }
        break;
      case 'go-compare': go('compare'); break;
      case 'clear-compare':
        S.compare = [];
        save();
        if (route === 'compare') render(); else syncCompareBar();
        toast('已清空对比');
        break;
      /* 会清空答案的两个入口：第一次点击只上膛，第二次才真的清。
         以前点一下就没了 60 题，误触没法回头。 */
      case 'start-test': {
        const done = ITEMS.length - missingIdx().length;
        if (done > 0 && !resetArm) {
          resetArm = true;
          render({ keepScroll: true });
          toast('再点一次就清空这 ' + done + ' 题答案');
          break;
        }
        resetArm = false;
        gateOpen = false;
        S.testing = true;
        S.cursor = 0;
        S.answers = {};
        save();
        render();
        break;
      }
      /* 首页那张「继续上次的测评」卡片上也有这个按钮：必须真的切到测评页，
         否则点一下只是原地重绘首页，看起来像没反应。 */
      case 'resume-test': gateOpen = false; resetArm = false; S.testing = true; save(); go('test'); break;
      case 'retest': {
        const done = ITEMS.length - missingIdx().length;
        if (done > 0 && !resetArm) {
          resetArm = true;
          render({ keepScroll: true });
          toast('再点一次就清空这 ' + done + ' 题答案');
          break;
        }
        resetArm = false;
        gateOpen = false;
        S.testing = true;
        S.cursor = 0;
        S.answers = {};
        S.result = null;
        save();
        render();
        break;
      }
      case 'retest-cancel': resetArm = false; render({ keepScroll: true }); break;
      case 'prev-q': gateOpen = false; if (S.cursor > 0) { stopSpeak(); S.cursor -= 1; save(); render(); } break;
      case 'skip-q':
        stopSpeak();
        advanceQuestion();
        break;
      case 'next-q':
        stopSpeak();
        advanceQuestion();
        break;
      case 'gate-fill': {
        const miss = missingIdx();
        S.cursor = miss.length ? miss[0] : 0;
        gateOpen = false;
        save();
        render();
        break;
      }
      case 'gate-submit': gateOpen = false; finishTest(); break;
      case 'gate-cancel': gateOpen = false; render(); break;
      /* 全部答完后由人按下的提交（不再自动交卷） */
      case 'submit-test': gateOpen = false; finishTest(); break;
      case 'review-all': gateOpen = false; S.cursor = 0; save(); render(); toast('从头看一遍，改完点最下面的「提交」'); break;
      case 'fix-blank': {
        const miss = missingIdx();
        S.testing = true;
        S.cursor = miss.length ? miss[0] : 0;
        gateOpen = false;
        save();
        render();
        break;
      }
      case 'read-q': { const q = ITEMS[S.cursor]; speak(q.t); break; }
      case 'read-result': {
        const r = S.result;
        if (!r) break;
        speak('你的兴趣代码是' + r.code.split('').join('、') + '。最强的是' + DIM_MAP[r.order[0]].name + '，其次是' + DIM_MAP[r.order[1]].name + '。分化度' + r.diff + '，一致性' + r.cons.level + '。');
        break;
      }
      case 'read-career': {
        const c = CAREER_MAP[act.dataset.id];
        if (c) speak(c.name + '。' + c.day + '。怎么入行：' + c.enter);
        break;
      }
      case 'read-last': {
        const ai = [...S.chat].reverse().find(m => m.role !== 'me');
        if (ai) speak(ai.text); else toast('还没有可以朗读的回答');
        break;
      }
      case 'clear-chat':
        if (S.chat.length && confirm('清空这段对话记录？')) { S.chat = []; S.lastCareer = null; save(); render(); }
        break;
      case 'close-sheet': closeSheet(); break;
      case 'set-nav': openSettings(act.dataset.set); break;
      case 'set-tour': closeSheet(); setTimeout(startTour, 200); break;
      case 'voice-test': {
        /* 只出声、不重绘：一 render() 就把 toast 一起刷新掉了 */
        const v = pickVoice();
        speak('我是小星星。这段路不用一次走完，我们慢慢来。');
        if (!v) toast('这台设备没装中文语音包，朗读可能偏机械');
        else if (!voiceIsWarm(v)) toast('这台设备只有「' + String(v.name).replace(/\s*\(.*?\)\s*/g, '') + '」，音调已经调柔和了');
        else toast('朗读声音：' + String(v.name).replace(/\s*\(.*?\)\s*/g, ''));
        break;
      }
      case 'set-nick-save': saveNick(); break;
      case 'set-star-save': saveStarCfg(); break;
      case 'set-star-clear':
        if (window.XYXT_STAR) window.XYXT_STAR.saveConfig({ baseUrl: '', apiKey: '', model: '' });
        closeSheet();
        toast('已改回本地知识库');
        break;
      case 'set-star-deepseek': {
        /* 只填地址与模型，Key 保留用户已经填过的那个（绝不预置或伪造 Key） */
        const cur = window.XYXT_STAR ? window.XYXT_STAR.config() : { apiKey: '' };
        const baseUrl = 'https://api.deepseek.com/v1';
        const model = 'deepseek-chat';
        if (window.XYXT_STAR) window.XYXT_STAR.saveConfig({ baseUrl, model, apiKey: cur.apiKey || '' });
        const bi = $('#starBase'); if (bi) bi.value = baseUrl;
        const mi = $('#starModel'); if (mi) mi.value = model;
        render();
        toast('已填入 DeepSeek，记得补上你自己的 API Key');
        break;
      }
      case 'set-clear': {
        if (!confirm('会清空本机保存的测评作答、结果、收藏、打卡与小星星对话，无法恢复。确定吗？')) break;
        if (!confirm('再确认一次：清空后连称呼也回到「同学」。真的要清空吗？')) break;
        try { localStorage.removeItem(KEY); localStorage.removeItem(OLD_KEY); } catch (e) { /* 忽略 */ }
        S = blank();
        save();
        closeSheet();
        route = 'home';
        paintUserChip();
        render();
        toast('已清空本机记录');
        break;
      }
      case 'ask-about':
        closeSheet();
        go('ask');
        setTimeout(() => sendChat('我想了解' + act.dataset.name + '，说说真实情况'), 120);
        break;
      case 'voice': {
        const input = $('#chatIn');
        if (!input) break;
        if (recing) { stopRec(); break; }
        const btn = $('#micBtn');
        startRec(
          (text, isFinal, alts) => {
            input.value = text;
            if (isFinal && alts && alts.length > 1) showAlts(alts, input);
            if (isFinal && btn) btn.classList.remove('on');
          },
          state => {
            if (btn) btn.classList.toggle('on', state === 'listening');
            const hint = $('#micHint');
            if (hint) hint.textContent =
              state === 'listening' ? '正在听……说完会自动停下' :
                state === 'thinking' ? '正在识别……' :
                  state === 'unsupported' ? '这个环境不支持语音输入，直接打字也可以' : micHintText();
          }
        );
        break;
      }
      case 'use-alt': {
        const input = $('#chatIn');
        if (input) input.value = act.dataset.text;
        const box = $('#altBox');
        if (box) box.remove();
        break;
      }
      case 'send': {
        const inp = $('#chatIn');
        if (inp && inp.value.trim()) { const v = inp.value.trim(); inp.value = ''; sendChat(v); }
        break;
      }
      case 'print': window.print(); break;
      case 'toggle-report': {
        const r = $('#report');
        if (!r) break;
        r.classList.toggle('open');
        if (r.classList.contains('open')) r.scrollIntoView({ behavior: 'smooth', block: 'start' });
        break;
      }
      case 'export-report': {
        if (!S.result) { toast('先完成测评才能生成报告'); break; }
        download('乡野星图-职业探索报告-' + (S.profile.nick || '学生') + '.html', reportHTML(), 'text/html;charset=utf-8');
        toast('报告已导出，可用浏览器打开后“打印为 PDF”');
        break;
      }
      case 'copy-code': {
        if (!S.result) { toast('先完成测评才能生成结果码'); break; }
        const code = makeCode();
        copyText(code).then(() => toast('结果码已复制，粘贴发给老师即可')).catch(() => {
          window.prompt('复制这段结果码发给老师：', code);
        });
        break;
      }
      case 'import-backup': {
        const inp = $('#backupFile');
        if (inp) inp.click();
        break;
      }
      case 'export-backup': {
        download('乡野星图-数据备份-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify(S, null, 2), 'application/json');
        toast('已导出本机数据备份');
        break;
      }
      case 'demo-student': {
        seedDemo();
        route = 'home';
        render();
        toast('已载入样例学生“小满”的完整数据');
        break;
      }
      default: break;
    }
  });

  /* 往下走一题；已经在最后一题时先看有没有跳过的题：
     有 → 打开补答闸门；没有 → 停下等人按提交（不再自动交卷）。 */
  function advanceQuestion() {
    const miss = missingIdx();
    if (S.cursor < ITEMS.length - 1) {
      S.cursor += 1;
      save();
      render();
    } else if (miss.length) {
      gateOpen = true;
      save();
      render();
      scrollToGate();
    } else {
      /* 全部答完：停在最后一题，把提交卡片滚到眼前。
         这一步以前是 finishTest()，导致补答完直接被交卷。 */
      gateOpen = false;
      save();
      render({ keepScroll: true });
      scrollToSubmit();
    }
  }

  function answerItem(v, btn) {
    const q = ITEMS[S.cursor];
    if (!q) return;
    S.answers[q.id] = v;
    save();
    document.querySelectorAll('#scale button').forEach(b => {
      const on = b === btn;
      b.classList.toggle('sel', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    const bar = document.querySelector('.progress > i');
    const answered = Object.keys(S.answers).length;
    if (bar) bar.style.width = (answered / ITEMS.length) * 100 + '%';
    /* 连点同一分值（或键盘+鼠标同时触发）时只推进一题：
       旧定时器带的是旧 token，过期就作废，避免一下子跳过两题。 */
    const token = ++answerToken;
    setTimeout(() => {
      if (token !== answerToken) return;
      advanceQuestion();
    }, 170);
  }

  function showAlts(alts, input) {
    const old = $('#altBox');
    if (old) old.remove();
    if (!alts || alts.length < 2) return;
    const box = document.createElement('div');
    box.id = 'altBox';
    box.className = 'suggest';
    box.style.marginTop = '8px';
    box.innerHTML = '<span class="small muted alt-label">听成这样了？点一下换：</span>' +
      alts.slice(0, 3).map(t => `<button data-act="use-alt" data-text="${esc(t)}">${esc(t)}</button>`).join('');
    input.parentElement.parentElement.appendChild(box);
  }

  document.addEventListener('change', e => {
    const cb = e.target.closest('[data-task]');
    if (cb) {
      const id = cb.dataset.task;
      const i = S.tasksDone.indexOf(id);
      if (cb.checked && i < 0) S.tasksDone.push(id);
      if (!cb.checked && i >= 0) S.tasksDone.splice(i, 1);
      save();
      render({ keepScroll: true });
      if (cb.checked) toast('完成一件小事，比想清楚更重要');
      return;
    }
    if (e.target.id === 'autoRead') {
      S.autoRead = e.target.checked;
      save();
      spokenFor = 0;
      if (S.autoRead) { const q = ITEMS[S.cursor]; if (q) speak(q.t); }
      else stopSpeak();
      return;
    }
    if (e.target.id === 'backupFile') {
      readTextFile(e.target.files[0], text => {
        try {
          const o = JSON.parse(text);
          if (!o || typeof o !== 'object') throw new Error('bad');
          S = Object.assign(blank(), o);
          S.profile = Object.assign({}, DEFAULTS.profile, o.profile || {});
          S.filter = Object.assign({}, DEFAULTS.filter, o.filter || {});
          save();
          route = 'home';
          render();
          toast('数据已恢复');
        } catch (err) {
          toast('这个文件读不出来，请选择从本应用导出的备份文件');
        }
      });
      e.target.value = '';
      return;
    }
    const pf = e.target.closest('[data-pf]');
    if (pf) {
      S.profile[pf.dataset.pf] = pf.value;
      save();
      if (pf.dataset.pf === 'grade') paintStageHint();
    }
  });

  function readTextFile(file, cb) {
    if (!file) return;
    const fr = new FileReader();
    fr.onload = () => cb(String(fr.result || ''));
    fr.onerror = () => toast('文件读取失败');
    fr.readAsText(file, 'utf-8');
  }

  /* 搜索：只刷新列表，不重绘整页，避免打断中文输入法 */
  document.addEventListener('input', e => {
    if (e.target.id !== 'map-q') return;
    S.filter.q = e.target.value;
    refreshMapList();
  });

  document.addEventListener('keydown', e => {
    const el = e.target instanceof Element ? e.target : null;
    if (el && el.id === 'chatIn' && e.key === 'Enter') {
      const v = el.value.trim();
      if (v) { el.value = ''; sendChat(v); }
      return;
    }
    if (el && el.closest('.tabs') && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      const tabs = [...document.querySelectorAll('.tab')];
      const cur = tabs.findIndex(t => t.classList.contains('active'));
      const next = (cur + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
      tabs[next].focus();
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape') { closeSheet(); return; }
    /* 只在真正“正在看题”时响应 1—5：抽屉、引导层盖在上面时按数字不该改答案 */
    const covered = document.body.classList.contains('sheeting') || document.body.classList.contains('touring');
    if (route === 'test' && S.testing && !covered && /^[1-5]$/.test(e.key) && !(el && /^(input|textarea|select)$/i.test(el.tagName))) {
      const btn = document.querySelector('#scale button[data-v="' + e.key + '"]');
      if (btn) { btn.click(); e.preventDefault(); }
    }
  });

  /* ---------------- 测评结束 ---------------- */
  function finishTest() {
    S.result = computeResult();
    S.testing = false;
    S.cursor = 0;
    S.history.push({ code: S.result.code, at: S.result.at, answered: S.result.answered });
    save();
    render();
    const res = S.result;
    setTimeout(() => toast('星图已生成：' + res.code + (res.answered < res.total ? '（有未答题）' : '')), 200);
  }

  /* ---------------- 问答流程 ---------------- */
  function sendChat(text) {
    stopSpeak();
    /* 教师端已经独立成 teacher.html，学生端不再有这一页：这里只提示，不跳转 */
    if (/(教师端|老师端|班级看板)/.test(String(text))) {
      S.chat.push({ role: 'me', text });
      S.chat.push({
        role: 'ai',
        text: '教师端现在是独立页面了（teacher.html），学生端顶部不再有这个标签。\n\n打开方式：首页「给评委／老师的 60 秒」里点「打开教师端（新页面）」，或「我的设置 → 关于 → 教师端入口」。它不会读这边的数据，只认学生发给你的结果码。'
      });
      if (S.chat.length > 60) S.chat = S.chat.slice(-60);
      save();
      if (route !== 'ask') route = 'ask';
      render();
      toast('教师端：teacher.html（独立页面）');
      return;
    }
    const cmd = navCommand(text);
    if (cmd) { go(cmd); toast('已切换到「' + TITLES[cmd] + '」'); return; }
    S.chat.push({ role: 'me', text });
    const r = answer(text);
    S.chat.push({ role: 'ai', text: r.text, careerId: r.careerId });
    if (r.careerId) S.lastCareer = r.careerId;
    if (S.chat.length > 60) S.chat = S.chat.slice(-60);
    save();
    if (route !== 'ask') route = 'ask';
    render();
    const hint = $('#micHint');
    if (hint) hint.textContent = micHintText();
  }

  function navCommand(text) {
    const t = String(text).trim();
    if (t.length > 8) return null;
    if (/(测评|做题|开始测|考试)/.test(t)) return 'test';
    if (/(职业|星图|看看职业)/.test(t)) return 'map';
    if (/(任务|打卡)/.test(t)) return 'task';
    if (/(首页|我的星图)/.test(t)) return 'home';
    return null;
  }

  /* ---------------- 结果码 / 汇总 / 导出 ---------------- */
  function makeCode() {
    const res = S.result;
    const top = matchAll().slice(0, 3).map(x => x.c.id);
    const p = DIMS.map(d => String(res.pct[d.key] || 0).padStart(2, '0')).join('');
    return 'XYXT1-' + b64enc({
      n: (S.profile.nick || '同学').slice(0, 8),
      g: S.profile.grade,
      c: res.code,
      p: p,
      t: top,
      d: (S.tasksDone || []).length
    });
  }

  /* ---------------- 报告导出（独立 HTML） ---------------- */
  function reportHTML() {
    const res = S.result;
    const top = matchAll().slice(0, 8);
    const rows = DIMS.map(d => `<tr><td>${esc(d.name)}（${d.short}）</td><td>${res.pct[d.key]}</td><td>${esc(d.desc)}</td></tr>`).join('');
    const list = top.map(x => `<tr><td>${esc(x.c.name)}</td><td>${x.score}</td><td>${esc(x.c.edu)}</td><td>${esc(x.c.local)}</td><td>${esc(x.c.enter)}</td></tr>`).join('');
    const tasks = reportTasks(TASKS.length).map(t => `<li><b>${esc(t.title)}</b>（${esc(t.tag)} · ${t.min} 分钟）<br><span class="g">${esc(t.desc)}</span></li>`).join('');

    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>乡野星图 · ${esc(S.profile.nick || '同学')}的职业探索报告</title>
<style>
  @page { size: A4; margin: 16mm 14mm; }
  body{font-family:"PingFang SC","Microsoft YaHei",sans-serif;color:#1b2530;line-height:1.7;margin:0 auto;max-width:760px;padding:28px 20px;font-size:14px;background:#fff}
  h1{font-size:24px;color:#10312f;margin:0 0 4px} h2{font-size:17px;color:#10312f;margin:22px 0 8px;border-left:3px solid #c2670f;padding-left:9px}
  .sub{color:#7b8794;font-size:12.5px;margin:0 0 18px}
  .code{font-size:34px;color:#c2670f;font-weight:700;letter-spacing:.1em}
  .head{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid #10312f;padding-bottom:10px}
  table{width:100%;border-collapse:collapse;font-size:12.5px;margin:8px 0}
  th,td{border-bottom:1px solid #e8dfd0;padding:7px 6px;text-align:left;vertical-align:top}
  th{color:#7b8794;font-weight:500;font-size:12px;background:#fbf7ef}
  .bars{margin:10px 0}
  .bar{display:grid;grid-template-columns:70px 1fr 34px;gap:10px;align-items:center;font-size:12.5px;margin:5px 0}
  .track{height:7px;background:#f0e9dc;border-radius:99px;overflow:hidden}
  .track>i{display:block;height:100%}
  .g{color:#7b8794;font-size:12px}
  ol,ul{padding-left:20px;margin:8px 0} li{margin:5px 0}
  .foot{margin-top:26px;border-top:1px solid #e8dfd0;padding-top:10px;color:#7b8794;font-size:11.5px}
  svg{float:right;margin-left:12px}
</style></head><body>
<div class="head">
  <div><h1>${esc(S.profile.nick || '同学')}的职业探索报告</h1>
  <p class="sub">乡野星图 · 霍兰德兴趣测评（课堂改编版） · 生成时间：${dateStr(res.at)} · 年级：${esc(S.profile.grade)}</p></div>
  <div class="code">${res.code}</div>
</div>
<div>${radarSVG(res.pct, 230)}</div>
<h2>一、兴趣结构</h2>
<div class="bars">${DIMS.map(d => `<div class="bar"><span>${d.name}</span><span class="track"><i style="width:${res.pct[d.key]}%;background:${d.color}"></i></span><span>${res.pct[d.key]}</span></div>`).join('')}</div>
<p class="sub">分化度 ${res.diff}（最高分与最低分之差，越大越清晰） · 一致性 ${res.cons.level}：${esc(res.cons.note)}</p>
<table><thead><tr><th>维度</th><th>标准分</th><th>含义</th></tr></thead><tbody>${rows}</tbody></table>
<h2>二、建议优先了解的方向</h2>
<table><thead><tr><th>职业</th><th>匹配度</th><th>学历门槛</th><th>本地机会</th><th>怎么入行</th></tr></thead><tbody>${list}</tbody></table>
<h2>三、接下来 30 天可以做的事</h2>
<ol>${tasks}</ol>
<h2>四、说明</h2>
<ul class="g">
  <li>本报告依据霍兰德 RIASEC 理论编制的课堂改编量表生成，用于缩小探索范围，不作为升学或职业选择的唯一依据。</li>
  <li>收入与招聘要求随地区、年限差异较大，正式报考请以当年招生简章与招聘公告为准。</li>
  <li>报告数据仅保存在本机，未上传任何服务器。</li>
</ul>
<p class="foot">乡野星图 · 2026“联通杯”广东第二师范学院 AI 应用创新大赛参赛作品 · 队伍：拾光职引</p>
</body></html>`;
  }

  /* ---------------- 演示数据 ---------------- */
  function seedDemo() {
    S.profile = { nick: '小满', grade: '高一', county: '', subjects: ['生物', '语文'] };
    S.answers = {};
    ITEMS.forEach(it => {
      const base = { R: 3, I: 5, A: 4, S: 3, E: 2, C: 3 }[it.d];
      S.answers[it.id] = Math.max(1, Math.min(5, base + (it.k === 'occ' ? -1 : 0)));
    });
    S.result = computeResult();
    S.tasksDone = ['t1', 't2'];
    S.chat = [];
    S.testing = false;
    S.cursor = 0;
    S.history.push({ code: S.result.code, at: S.result.at, answered: S.result.answered });
    save();
  }

  /* ---------------- 启动 ---------------- */
  let booted = false;
  let spokenFor = 0;

  function isDemoRun() {
    return /[?&]demo=1/.test(location.search) || location.hash.indexOf('demo') >= 0;
  }

  function mountStar() {
    if (window.XYXT_STAR && window.XYXT_STAR.mount) window.XYXT_STAR.mount();
  }

  /* 打开即用的统一入口：渲染、挂小星星、按需放引导 */
  function startSession(demo) {
    const h = (location.hash || '').replace('#', '');
    if (TITLES[h]) route = h;
    if (demo && !S.result) seedDemo();
    if (!saveOk) toast('这台电脑禁用了本地存储，数据关闭后会丢失，建议先导出备份');
    paintUserChip();
    render();
    mountStar();
    registerSW();
    showVoiceNotice();

    // 第一次进来就带一遍路；做完就不再自动弹
    const noTour = /[?&]tour=0/.test(location.search);
    const wantTour = /[?&]tour=1/.test(location.search);
    if (!noTour && (!S.tourDone || wantTour)) setTimeout(startTour, 620);
  }

  function boot() {
    if (booted) return;
    booted = true;

    const bd = document.createElement('div');
    bd.className = 'sheet-backdrop';
    bd.id = 'sheetBackdrop';
    bd.addEventListener('click', closeSheet);
    document.body.appendChild(bd);

    const sheet = document.createElement('div');
    sheet.className = 'sheet';
    sheet.id = 'sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-hidden', 'true');
    document.body.appendChild(sheet);

    const backup = document.createElement('input');
    backup.type = 'file';
    backup.id = 'backupFile';
    backup.accept = '.json,application/json';
    backup.setAttribute('aria-label', '选择要导入的备份文件');
    backup.hidden = true;
    document.body.appendChild(backup);

    const userBtn = $('#btnUser');
    if (userBtn) userBtn.addEventListener('click', () => openSettings());

    // 不设登录：打开就能用，记录直接落在本机
    startSession(isDemoRun());
  }

  function showVoiceNotice() {
    if (location.protocol !== 'file:' || S.hideVoiceNotice) return;
    const box = $('#notice');
    if (!box) return;
    box.hidden = false;
    box.innerHTML = `
      <span>当前是「本地文件」模式：朗读、测评、报告都正常，但浏览器不允许录音；而且这个模式与「打开.bat」模式的记录是分开存的。要语音、要两边数据统一，请用 打开.bat 启动。</span>
      <span class="notice-acts">
        <button class="btn small" data-act="close-notice">知道了</button>
      </span>`;
    box.querySelector('[data-act="close-notice"]').addEventListener('click', () => {
      box.hidden = true;
      S.hideVoiceNotice = true;
      save();
    });
  }

  /* ---------------- Service Worker ---------------- */
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  window.addEventListener('hashchange', () => {
    const h = (location.hash || '').replace('#', '');
    if (!h) return;
    if (TITLES[h]) {
      if (h !== route) { route = h; render(); }
      return;
    }
    /* 失效路由（例如 v5 遗留的 #teacher）：回首页，不要白屏 */
    if (h !== route) { route = 'home'; render(); }
  });

  document.addEventListener('DOMContentLoaded', boot);

  /* 供测试与调试使用 */
  window.XYXT_APP = {
    version: APP_VERSION,
    state: () => S,
    save,
    answer,
    computeResult,
    recommend,
    makeCode,
    go,
    openCareer,
    openSettings,
    startTour,
    meName,
    findCareers,
    pickVoice,
    speak,
    voiceIsWarm,
    dataKey: () => KEY
  };

  // 立即启动；DOM 已就绪时 boot 会同步执行
  if (document.readyState !== 'loading') boot();
})();
