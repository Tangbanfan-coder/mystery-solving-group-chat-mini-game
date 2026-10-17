/* 日出小队 —— 前端：渲染 + 向 GM 服务要下一屏 */
(function () {
  'use strict';

  const S = window.STORY;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const state = {
    sid: sessionStorage.getItem('richu.sid') || (Math.random().toString(36).slice(2) + Date.now().toString(36)),
    clock: S.meta.startClock,
    members: S.meta.members.slice(),
    groupName: S.meta.groupName,
    notice: { from: S.meta.noticeFrom, text: S.meta.notice, meta: S.meta.noticeMeta },
    noticeLog: [],
    flags: {},
    focus: 'group',
    stack: [],
    ended: null,
    busy: true
  };
  sessionStorage.setItem('richu.sid', state.sid);

  const threads = {};

  /* ---------- 基础 ---------- */
  function el(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }
  function memberOf(id) {
    const m = state.members.find((x) => x.id === id);
    if (m) return m;
    const name = String(id || '').split(':').pop() || '?';
    return { id, name, a: name.slice(-1), c1: '#7b8a84', c2: '#3f4a46' };
  }
  function avatarEl(id) {
    const m = memberOf(id);
    const a = el('div', 'avatar', m.a);
    a.style.setProperty('--c1', m.c1 || '#8a8a8a');
    a.style.setProperty('--c2', m.c2 || '#5f5f5f');
    return a;
  }

  function makeThread(key, innerSel, chatSel) {
    const chat = $(chatSel);
    const th = { key, inner: $(innerSel), chat, stick: true, log: [] };
    chat.addEventListener('scroll', () => {
      th.stick = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 140;
    });
    threads[key] = th;
    return th;
  }
  function scrollBottom(th, force) {
    if (!th.stick && !force) return;
    requestAnimationFrame(() => { th.chat.scrollTop = th.chat.scrollHeight; });
  }
  function push(th, m) {
    th.log.push(m);
    render(th, m);
    scrollBottom(th);
    if (th.key === 'group') persist();
  }

  function persist() {
    try {
      const logs = {};
      Object.keys(threads).forEach((k) => { if (threads[k].log.length) logs[k] = threads[k].log; });
      sessionStorage.setItem('richu.state.' + state.sid, JSON.stringify({
        clock: state.clock,
        members: state.members,
        groupName: state.groupName,
        notice: state.notice,
        noticeLog: state.noticeLog,
        flags: state.flags,
        ended: state.ended,
        logs
      }));
    } catch (e) {}
  }

  function restore() {
    let raw;
    try { raw = sessionStorage.getItem('richu.state.' + state.sid); } catch (e) { return false; }
    if (!raw) return false;
    let s;
    try { s = JSON.parse(raw); } catch (e) { return false; }
    if (!s || !s.logs) return false;
    state.clock = s.clock || state.clock;
    state.members = s.members || state.members;
    state.groupName = s.groupName || state.groupName;
    state.notice = s.notice || state.notice;
    state.noticeLog = s.noticeLog || [];
    state.flags = s.flags || {};
    state.ended = s.ended || null;
    Object.keys(s.logs).forEach((k) => {
      if (k === 'group') {
        (s.logs[k] || []).forEach((m) => { threads.group.log.push(m); render(threads.group, m); });
      } else {
        const th = makeThread(k, '#privInner', '#privChat');
        th.log = s.logs[k] || [];
      }
    });
    return (s.logs.group || []).length > 0;
  }

  function photoSvg(kind) {
    if (kind !== 'xiaoman') return '';
    return `<svg viewBox="0 0 392 248" width="100%">
      <defs><linearGradient id="night" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#0d1218"/><stop offset=".55" stop-color="#1a222b"/><stop offset="1" stop-color="#0a0e13"/></linearGradient></defs>
      <rect width="392" height="248" fill="url(#night)"/>
      <rect x="0" y="196" width="392" height="52" fill="#14181d"/>
      <rect x="34" y="88" width="196" height="66" rx="4" fill="#0b6b3a"/>
      <rect x="34" y="88" width="196" height="66" rx="4" fill="none" stroke="#e8f0e9" stroke-width="2" opacity=".85"/>
      <text x="48" y="118" font-size="21" font-family="PingFang SC,Microsoft YaHei,sans-serif" fill="#f2f7f2">松岭服务区</text>
      <text x="48" y="140" font-size="12" font-family="PingFang SC,Microsoft YaHei,sans-serif" fill="#cfe3d4">SONGLING · 2km</text>
      <rect x="238" y="112" width="6" height="120" fill="#3b444d"/>
      <circle cx="241" cy="108" r="9" fill="#5a4a34" opacity=".9"/>
      <rect x="0" y="210" width="392" height="3" fill="#2b333b" opacity=".8"/>
      <text x="250" y="232" font-size="12" font-family="Consolas,monospace" fill="#c8d2cb" opacity=".85">2025-11-17 03:14</text>
      <text x="16" y="232" font-size="10" font-family="Consolas,monospace" fill="#8e9a93" opacity=".7">IMG_0314.JPG</text>
      <rect width="392" height="248" fill="#05070a" opacity=".12"/>
    </svg>`;
  }

  function render(th, m) {
    const box = th.inner;
    if (m.type === 'time') { box.appendChild(el('div', 'time-div', m.v)); return; }
    if (m.type === 'sys') {
      const d = el('div', 'sys' + (m.tone ? ' ' + m.tone : ''));
      d.appendChild(el('span', null, m.text));
      box.appendChild(d);
      return;
    }
    if (m.type === 'recall') {
      const d = el('div', 'recall');
      d.appendChild(el('span', null, m.text || (memberOf(m.from).name + ' 撤回了一条消息')));
      box.appendChild(d);
      return;
    }
    if (m.type === 'notice-card') {
      const d = el('div', 'sys warn');
      d.appendChild(el('span', null, m.text));
      box.appendChild(d);
      return;
    }

    const self = m.from === 'me';
    const row = el('div', 'row' + (self ? ' self' : ''));
    row.appendChild(avatarEl(m.from));
    const col = el('div', 'col');
    if (!self) {
      const nm = el('div', 'name');
      nm.appendChild(el('span', null, memberOf(m.from).name));
      col.appendChild(nm);
    }

    if (m.type === 'voice') {
      const b = el('div', 'bubble');
      const v = el('div', 'voice');
      const bars = el('div', 'bars');
      const n = Math.max(4, Math.min(11, Math.round((m.dur || 3) / 2) + 3));
      for (let i = 0; i < n; i++) {
        const bar = el('i');
        bar.style.height = (4 + ((i * 7) % 12)) + 'px';
        bars.appendChild(bar);
      }
      v.appendChild(bars);
      v.appendChild(el('span', 'dur', (m.dur || 3) + '″'));
      if (m.asr) v.appendChild(el('div', 'asr', '转文字：' + m.asr));
      b.appendChild(v);
      b.addEventListener('click', () => { v.classList.add('open'); scrollBottom(th); });
      col.appendChild(b);
    } else if (m.type === 'loc') {
      const card = el('div', 'loc-card odd');
      const thumb = el('div', 'map-thumb');
      thumb.appendChild(el('div', 'pin'));
      card.appendChild(thumb);
      const body = el('div', 'loc-body');
      body.appendChild(el('div', 'loc-name', m.name));
      body.appendChild(el('div', 'loc-addr', m.addr || ''));
      body.appendChild(el('div', 'loc-flag', m.flag || '定位时间异常'));
      card.appendChild(body);
      card.addEventListener('click', () => openMap(m));
      col.appendChild(card);
    } else if (m.type === 'img') {
      const card = el('div', 'img-card');
      card.innerHTML = photoSvg(m.kind);
      if (m.cap) card.appendChild(el('div', 'cap', m.cap));
      card.addEventListener('click', () => openPhoto(m));
      col.appendChild(card);
    } else {
      const b = el('div', 'bubble');
      b.textContent = m.text || '';
      col.appendChild(b);
    }

    row.appendChild(col);
    box.appendChild(row);
  }

  /* ---------- 视图 ---------- */
  function openView(id) {
    const v = document.getElementById(id);
    if (!v || state.stack.includes(id)) return;
    state.stack.push(id);
    v.classList.add('on');
    if (id === 'viewSearch') renderSearchHome();
  }
  function closeView(id) {
    const v = document.getElementById(id);
    if (v) v.classList.remove('on');
    state.stack = state.stack.filter((x) => x !== id);
  }
  function closeAllViews() {
    state.stack.forEach((id) => document.getElementById(id).classList.remove('on'));
    state.stack = [];
  }

  function openMap(m) {
    $('#mapTitle').textContent = m.name || '位置';
    $('#mapName').textContent = m.name || '';
    $('#mapAddr').textContent = m.addr || '';
    $('#mapMeta').textContent = [m.when, m.flag].filter(Boolean).join(' · ');
    $('#mapModal').classList.add('on');
  }

  function openPhoto(m) {
    $('#mapTitle').textContent = '图片';
    $('#mapName').textContent = 'IMG_0314.JPG';
    $('#mapAddr').textContent = '松岭服务区 · G65 包茂高速';
    $('#mapMeta').textContent = '拍摄于 2025-11-17 03:14 · 距南门 203 公里';
    const canvas = $('#mapCanvas');
    canvas.innerHTML = `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:16px">
      <div style="width:100%;max-width:360px;border-radius:6px;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,.35)">${photoSvg('xiaoman')}</div></div>`;
    $('#mapModal').classList.add('on');
    markSeen('photo');
  }

  function toast(text, ms) {
    const t = $('#toast');
    t.textContent = text;
    t.classList.add('on');
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove('on'), ms || 2400);
  }

  /* ---------- 群信息 ---------- */
  function updateMembers() {
    $('#navCount').textContent = '(' + state.members.length + ')';
    const list = $('#memberList');
    if (!list) return;
    list.innerHTML = '';
    state.members.forEach((m) => {
      const d = el('div', 'member');
      const a = el('div', 'avatar', m.a);
      a.style.setProperty('--c1', m.c1 || '#8a8a8a');
      a.style.setProperty('--c2', m.c2 || '#5f5f5f');
      d.appendChild(a);
      d.appendChild(el('span', null, m.id === 'me' ? '你' : m.name));
      d.addEventListener('click', () => { if (m.id !== 'me') openPrivate(m.id); });
      list.appendChild(d);
    });
  }

  function renderNotice() {
    $('#noticeFrom').textContent = state.notice.from;
    $('#noticeText').textContent = state.notice.text;
    $('#noticeMeta').textContent = state.notice.meta;
    const log = $('#noticeLog');
    log.innerHTML = '';
    state.noticeLog.forEach((n) => {
      const d = el('div', 'log-item');
      d.innerHTML = '<b>' + n.by + '</b> 修改了群公告<br>' + String(n.text).replace(/\n/g, '<br>');
      log.appendChild(d);
    });
  }

  /* ---------- 消息处理 ---------- */
  function applyClock(v) {
    if (!v) return;
    state.clock = v;
    $('#clock').textContent = v;
  }

  async function playEvents(th, events) {
    for (const e of events) {
      if (e.t === 'msg') {
        await typing(th, e.from);
        push(th, { type: 'text', from: e.from, text: e.text });
        await sleep(560 + Math.min(500, (e.text || '').length * 12));
      } else if (e.t === 'voice') {
        await typing(th, e.from);
        push(th, { type: 'voice', from: e.from, dur: e.dur, asr: e.asr });
        await sleep(800);
      } else if (e.t === 'sys') {
        await sleep(420);
        push(th, { type: 'sys', text: e.text, tone: e.tone });
      } else if (e.t === 'recall') {
        await sleep(380);
        push(th, { type: 'recall', from: e.from, text: e.text });
      } else if (e.t === 'loc') {
        await typing(th, e.from);
        push(th, { type: 'loc', from: e.from, name: e.name, addr: e.addr, when: e.when, flag: e.flag });
        await sleep(600);
      } else if (e.t === 'img') {
        await sleep(500);
        push(th, { type: 'img', from: e.from, kind: e.kind || 'xiaoman', cap: e.cap });
        state.flags.photo = true;
        markSeen('photo');
      } else if (e.t === 'rename') {
        state.groupName = e.name;
        $('#navName').textContent = e.name;
        $('#cellGroupName').textContent = e.name;
        document.title = e.name;
        push(th, { type: 'sys', text: '群名已修改为「' + e.name + '」', tone: 'warn' });
      } else if (e.t === 'notice') {
        state.notice = { from: e.by || '默', text: e.text, meta: '刚刚' };
        state.noticeLog.unshift({ by: e.by || '默', text: e.text });
        renderNotice();
        push(th, { type: 'sys', text: '「' + (e.by || '默') + '」修改了群公告', tone: 'warn' });
      } else if (e.t === 'join' || e.t === 'leave') {
        if (e.t === 'join') {
          if (!state.members.find((m) => m.name === e.name)) {
            state.members.push({ id: 'u:' + e.name, name: e.name, a: e.name.slice(-1), c1: '#7b8a84', c2: '#3f4a46' });
          }
        } else {
          state.members = state.members.filter((m) => m.name !== e.name);
        }
        updateMembers();
        push(th, { type: 'sys', text: e.text || ('「' + e.name + '」' + (e.t === 'join' ? '加入了群聊' : '退出了群聊')), tone: e.t === 'join' ? 'ghost' : 'warn' });
      }
    }
  }

  async function typing(th, who) {
    if (th.key !== state.focus) return;
    $('#typingWho').textContent = memberOf(who).name + '正在输入';
    $('#typing').classList.add('on');
    await sleep(520);
    $('#typing').classList.remove('on');
    await sleep(120);
  }

  function markSeen(kind) {
    fetch('/api/seen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sid: state.sid, kind })
    }).catch(() => {});
    state.flags[kind] = true;
    persist();
  }

  /* ---------- 回合 ---------- */
  async function turn(channel, text) {
    if (state.busy || state.ended) return;
    state.busy = true;
    document.body.classList.add('busy');
    const th = channel === 'group' ? threads.group : threads[channel];

    if (channel === 'group') { push(th, { type: 'text', from: 'me', text }); }
    else { push(th, { type: 'text', from: 'me', text }); }

    $('#typingWho').textContent = '对方正在输入';
    $('#typing').classList.add('on');

    let data = null;
    try {
      const r = await fetch('/api/turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid: state.sid, channel, text })
      });
      data = await r.json();
      if (data.error) toast(data.error, 4000);
    } catch (e) {
      toast('网络断了：' + e.message, 4000);
    }
    $('#typing').classList.remove('on');

    if (data && data.events) {
      await playEvents(th, data.events);
      applyClock(data.clock);
      if (data.unlock && data.unlock.includes('archive') && !state.flags.archive) {
        state.flags.archive = true;
        persist();
        toast('聊天记录里好像多出了几条', 3200);
      }
      if (data.ending) {
        state.ended = data.ending;
        persist();
        await sleep(1400);
        showEnding(data.ending);
      }
    }
    state.busy = false;
    document.body.classList.remove('busy');
    scrollBottom(th, true);
  }

  function showEnding(key) {
    const e = S.endings[key] || S.endings.good;
    const box = el('div', 'ending');
    box.innerHTML =
      '<div class="ending-in">' +
      '<div class="ending-kicker">结 局</div>' +
      '<div class="ending-title">' + e.title + '</div>' +
      '<div class="ending-text">' + e.text + '</div>' +
      '<button class="ending-btn">再来一次</button>' +
      '</div>';
    box.querySelector('.ending-btn').addEventListener('click', async () => {
      try { await fetch('/api/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sid: state.sid }) }); } catch (e2) {}
      sessionStorage.removeItem('richu.sid');
      location.reload();
    });
    $('#phone').appendChild(box);
  }

  /* ---------- 输入 ---------- */
  const INPUT_MAX_H = 102; // 输入框最高 4 行（22px 行高 + 上下内边距），超出后内部滚动

  // 单行起步，随内容自动增高；删除文字后自动缩回
  function autoGrow(ta) {
    if (!ta) return;
    ta.style.height = 'auto';
    const full = ta.scrollHeight;
    const h = Math.min(Math.max(full, 36), INPUT_MAX_H);
    ta.style.height = h + 'px';
    ta.style.overflowY = full > INPUT_MAX_H ? 'auto' : 'hidden';
  }

  function bindComposer(sel, submit) {
    const ta = $(sel);
    if (!ta) return;
    ta.addEventListener('input', () => { syncSend(); autoGrow(ta); });
    ta.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
      if (e.shiftKey) return; // Shift+Enter：换行
      e.preventDefault();
      submit();
    });
  }

  function submitGroup() {
    const input = $('#input');
    const v = input.value.trim();
    if (!v) return;
    if (state.busy) { toast('等一下，群里还在说话', 1600); return; }
    input.value = '';
    syncSend();
    autoGrow(input);
    turn('group', v);
  }
  function submitPrivate() {
    const input = $('#privInput');
    const v = input.value.trim();
    if (!v) return;
    if (state.busy) { toast('等一下', 1600); return; }
    const th = threads[state.focus];
    if (!th) return;
    input.value = '';
    syncSend();
    autoGrow(input);
    turn(state.focus, v);
  }
  function syncSend() {
    $('#sendBtn').classList.toggle('on', $('#input').value.trim().length > 0);
    $('#privSend').classList.toggle('on', $('#privInput').value.trim().length > 0);
  }

  /* ---------- 私聊 ---------- */
  function showPriv(th) {
    if (state.currentPriv === th.key) return;
    const inner = $('#privInner');
    inner.innerHTML = '';
    th.log.forEach((m) => render(th, m));
    state.currentPriv = th.key;
  }

  function openPrivate(id) {
    const m = memberOf(id);
    const key = 'p:' + id;
    let th = threads[key];
    if (!th) {
      th = makeThread(key, '#privInner', '#privChat');
      push(th, { type: 'sys', text: '你和「' + m.name + '」还不是好友。' });
      if (id === 'mo') push(th, { type: 'sys', text: '你发不出去。' });
    }
    showPriv(th);
    $('#privTitle').textContent = m.name;
    state.focus = key;
    openView('viewPrivate');
    scrollBottom(th, true);
  }

  function backToGroup() {
    state.focus = 'group';
    closeAllViews();
    scrollBottom(threads.group, true);
  }

  /* ---------- 搜索 / 历史 ---------- */
  function renderSearchHome() {
    const box = $('#searchResults');
    box.innerHTML = '';
    box.appendChild(el('div', 'sr-label', '按日期查找'));
    const d = el('div', 'sr-date');
    d.appendChild(el('span', null, S.archive.date));
    d.appendChild(el('span', 'cell-arrow', '›'));
    d.addEventListener('click', renderArchive);
    box.appendChild(d);
    const hits = threads.group.log.filter((m) => m.type === 'text' && m.text);
    if (hits.length) {
      box.appendChild(el('div', 'sr-label', '今天的聊天'));
      hits.slice(-8).reverse().forEach((m) => {
        const it = el('div', 'sr-item');
        it.innerHTML = '<b>' + memberOf(m.from).name + '</b>：' + m.text;
        box.appendChild(it);
      });
    }
  }

  function renderArchive() {
    const box = $('#searchResults');
    box.innerHTML = '';
    const back = el('div', 'sr-back', '‹ 返回日期');
    back.addEventListener('click', renderSearchHome);
    box.appendChild(back);
    box.appendChild(el('div', 'sr-label', S.archive.date));
    S.archive.items
      .filter((it) => !it.gate || state.flags[it.gate])
      .forEach((it) => {
        const d = el('div', 'sr-msg');
        d.appendChild(el('div', 'sr-who', it.name + ' · ' + it.time));
        d.appendChild(el('div', 'sr-txt', it.text));
        box.appendChild(d);
      });
    box.appendChild(el('div', 'sr-foot', S.archive.foot));
    markSeen('archive');
  }

  /* ---------- 导出 ---------- */
  function exportLog() {
    const lines = [];
    lines.push('# 日出小队 · 对话记录');
    lines.push('');
    lines.push('- 导出时间：' + new Date().toLocaleString('zh-CN'));
    lines.push('- 群名：' + state.groupName + '（' + state.members.length + ' 人）');
    lines.push('- 结局：' + (state.ended || '未结束'));
    lines.push('');
    const order = ['group'].concat(Object.keys(threads).filter((k) => k !== 'group'));
    order.forEach((k) => {
      const th = threads[k];
      if (!th || !th.log.length) return;
      lines.push('## ' + (k === 'group' ? '群聊' : '私聊 · ' + memberOf(k.slice(2)).name));
      lines.push('');
      th.log.forEach((m) => {
        if (m.type === 'time') { lines.push(''); lines.push('`' + m.v + '`'); lines.push(''); return; }
        if (m.type === 'sys') { lines.push('· ' + m.text); return; }
        if (m.type === 'recall') { lines.push('· ' + (m.from && m.from !== 'me' ? memberOf(m.from).name : '有人') + '撤回了一条消息'); return; }
        if (m.type === 'loc') { lines.push('· [位置] ' + m.name + ' ' + (m.when || '') + ' ' + (m.flag || '')); return; }
        if (m.type === 'voice') { lines.push('· [语音 ' + m.dur + '″] ' + (m.asr || '')); return; }
        if (m.type === 'img') { lines.push('· [图片] ' + (m.cap || '')); return; }
        const who = m.from === 'me' ? '我' : memberOf(m.from).name;
        lines.push(who + '：' + (m.text || ''));
      });
      lines.push('');
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '日出小队_对话.md';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast('已导出到下载文件夹', 2600);
  }

  /* ---------- 启动 ---------- */
  async function boot() {
    const g = makeThread('group', '#chatInner', '#chat');
    $('#navName').textContent = state.groupName;
    $('#cellGroupName').textContent = state.groupName;
    $('#clock').textContent = state.clock;
    document.title = state.groupName;
    updateMembers();
    renderNotice();

    $('#sendBtn').addEventListener('click', submitGroup);
    $('#privSend').addEventListener('click', submitPrivate);
    bindComposer('#input', submitGroup);
    bindComposer('#privInput', submitPrivate);

    $('#navTitle').addEventListener('click', () => openView('viewInfo'));
    $('#navMore').addEventListener('click', () => openView('viewInfo'));
    $('#cellNotice').addEventListener('click', () => openView('viewNotice'));
    $('#cellSearch').addEventListener('click', () => openView('viewSearch'));
    $('#cellQuit').addEventListener('click', () => toast('退不出去。群里的人还在等你。', 3000));

    $('#navBack').addEventListener('click', backToGroup);
    $$('[data-close]').forEach((b) => b.addEventListener('click', () => {
      const id = b.dataset.close;
      if (id === 'mapModal') { $('#mapModal').classList.remove('on'); return; }
      if (id === 'viewPrivate') { backToGroup(); return; }
      closeView(id);
    }));

    $('#plusBtn').addEventListener('click', () => $('#panel').classList.toggle('on'));
    $$('.panel-item').forEach((b) => b.addEventListener('click', () => {
      $('#panel').classList.remove('on');
      const act = b.dataset.act;
      if (act === 'note') return openView('viewNotice');
      if (act === 'location') return toast('位置发送失败：当前无法获取定位', 2600);
      if (act === 'photo') return toast('相册里没有可以发的照片', 2400);
      if (act === 'call') return toast('对方无应答', 2400);
      if (act === 'recall') return toast('撤不回来了。', 2400);
    }));

    $('#searchInput').addEventListener('input', (e) => {
      const q = e.target.value.trim();
      const box = $('#searchResults');
      if (!q) return renderSearchHome();
      box.innerHTML = '';
      const hits = threads.group.log.filter((m) => m.type === 'text' && (m.text || '').includes(q));
      if (!hits.length) { box.appendChild(el('div', 'sr-empty', '没有找到相关聊天记录')); return; }
      hits.forEach((m) => {
        const it = el('div', 'sr-item');
        it.innerHTML = '<b>' + memberOf(m.from).name + '</b>：' + m.text.split(q).join('<b>' + q + '</b>');
        box.appendChild(it);
      });
    });

    $('#reset').addEventListener('click', async () => {
      if (!confirm('重新开始？当前进度会消失。')) return;
      try { await fetch('/api/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sid: state.sid }) }); } catch (e) {}
      sessionStorage.removeItem('richu.sid');
      sessionStorage.removeItem('richu.state.' + state.sid);
      location.reload();
    });

    $('#export').addEventListener('click', exportLog);

    // 开场 / 恢复进度
    const restored = restore();
    if (restored) {
      state.busy = false;
      document.body.classList.remove('busy');
      applyClock(state.clock);
      $('#navName').textContent = state.groupName;
      $('#cellGroupName').textContent = state.groupName;
      document.title = state.groupName;
      updateMembers();
      renderNotice();
      scrollBottom(g, true);
      if (state.ended) showEnding(state.ended);
      $('#input').placeholder = '说点什么';
      return;
    }

    state.busy = true;
    for (const m of S.intro) {
      if (m.t === 'time') { push(g, { type: 'time', v: m.v }); await sleep(260); }
      else if (m.t === 'sys') { push(g, { type: 'sys', text: m.text, tone: m.tone }); await sleep(300); }
      else if (m.t === 'loc') { push(g, { type: 'loc', from: m.from, name: m.name, addr: m.addr, when: m.when, flag: m.flag }); await sleep(400); }
      else if (m.t === 'voice') { await typing(g, m.from); push(g, { type: 'voice', from: m.from, dur: m.dur, asr: m.asr }); await sleep(600); }
      else if (m.t === 'msg') {
        if (!m.fast) await typing(g, m.from);
        push(g, { type: 'text', from: m.from, text: m.text });
        await sleep(m.fast ? 150 : (m.d || 500));
      }
    }
    state.busy = false;
    document.body.classList.remove('busy');
    scrollBottom(g, true);
    $('#input').placeholder = '说点什么';
  }

  document.addEventListener('DOMContentLoaded', boot);
  window.__game = state;
})();
