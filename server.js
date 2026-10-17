// 本地服务：静态页面 + 剧本 + GM 接口（不含任何具体剧情）
const http = require('http');
const fs = require('fs');
const path = require('path');
const { gmTurn, loadScenario, listScenarios, KEY } = require('./gm');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 5178);
const HOST = '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

const sessions = new Map();

function newSession(scenarioId, prior) {
  return { scenarioId, turn: 0, clock: null, flags: {}, history: [], ended: null, prior: prior || '', facts: [], moved: false, grace: {}, startedAt: Date.now() };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 200000) { reject(new Error('too large')); req.destroy(); return; }
      buf += c;
    });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// 开场转成"已经发生过的对话"，喂给模型
function buildPrior(sc) {
  const name = {};
  (sc.meta.members || []).forEach((m) => { name[m.id] = m.name; });
  return (sc.intro || []).map((m) => {
    if (m.t === 'time') return '\n【' + m.v + '】';
    if (m.t === 'sys') return '· ' + m.text;
    if (m.t === 'msg') return (name[m.from] || m.from) + '：' + m.text;
    if (m.t === 'voice') return (name[m.from] || m.from) + '：[语音 ' + m.dur + '″] ' + (m.asr || '');
    if (m.t === 'loc') return (name[m.from] || m.from) + '：[位置] ' + m.name + '（' + (m.when || '') + '）' + (m.flag || '');
    return '';
  }).filter(Boolean).join('\n');
}

function publicScenario(sc) {
  // 只给浏览器看它需要的：剧透内容（canon / style / pacing / director / endings）一律不发
  return {
    id: sc.id,
    title: sc.title,
    subtitle: sc.subtitle,
    cover: sc.cover,
    meta: sc.meta,
    intro: sc.intro,
    archive: sc.archive,
    assets: sc.assets,
    rules: sc.rules || {}
  };
}

function eventsToText(events) {
  return events.map((e) => {
    if (e.t === 'msg') return e.from + '：' + e.text;
    if (e.t === 'sys') return '系统：' + e.text;
    if (e.t === 'recall') return '系统：' + e.from + ' 撤回了一条消息';
    if (e.t === 'rename') return '系统：群名被修改为「' + e.name + '」';
    if (e.t === 'notice') return '系统：群公告被修改为「' + e.text + '」';
    if (e.t === 'join') return '系统：「' + e.name + '」加入了群聊';
    if (e.t === 'leave') return '系统：「' + e.name + '」退出了群聊';
    if (e.t === 'voice') return e.from + '：[语音] ' + e.asr;
    if (e.t === 'loc') return e.from + '：[位置] ' + e.name;
    return '';
  }).filter(Boolean).join('\n');
}

function pickEnding(sc, s, intent) {
  for (const e of sc.endings || []) {
    const w = e.when || {};
    if (w.intent && w.intent !== intent) continue;
    if (w.minTurn && s.turn < w.minTurn) continue;
    if (w.flags && !w.flags.every((f) => s.flags[f])) continue;
    return e;
  }
  return null;
}

async function handleTurn(req, res) {
  const body = JSON.parse(await readBody(req));
  const sid = String(body.sid || 'default');
  const scenarioId = String(body.scenario || 'richu');
  const sc = loadScenario(scenarioId);

  let s = sessions.get(sid);
  if (!s || s.scenarioId !== scenarioId) {
    s = newSession(scenarioId, buildPrior(sc));
    s.clock = sc.meta.startClock;
    sessions.set(sid, s);
  }
  if (s.ended) return json(res, 200, { events: [], ended: true });

  const channel = body.channel === 'group' || !body.channel ? 'group' : body.channel;
  const whoMap = { 'p:laok': 'laok', 'p:aqiao': 'aqiao', 'p:shiqi': 'shiqi', 'p:mo': 'mo' };
  const who = whoMap[channel] || '';
  const text = String(body.text || '').slice(0, 300);
  if (!text) return json(res, 400, { error: 'empty' });

  let out;
  try {
    out = await gmTurn({
      scenario: sc,
      channel,
      text,
      history: s.history,
      state: { turn: s.turn, clock: s.clock || sc.meta.startClock, flags: s.flags, prior: s.prior, facts: s.facts, moved: s.moved, who }
    });
  } catch (e) {
    return json(res, 500, { error: 'GM 掉线了：' + e.message, events: [] });
  }

  s.turn += 1;
  if (out.clock && /^\d{1,2}:\d{2}$/.test(out.clock)) s.clock = out.clock;
  if (out.facts.length) s.facts = s.facts.concat(out.facts).slice(-15);
  out.unlock.forEach((k) => { s.flags[k] = true; });
  out.events.forEach((e) => {
    if (e.t === 'rename' || e.t === 'notice') s.flags.renamed = true;
    if (e.t === 'img') s.flags.photo = true;
  });

  // 剧本配置的关键节点保底
  if (channel === 'group') {
    for (const b of sc.beats || []) {
      if (s.turn >= b.atTurn && !s.flags[b.flag]) {
        s.flags[b.flag] = true;
        (b.events || []).forEach((ev) => out.events.push(ev));
        (b.unlock || []).forEach((u) => { s.flags[u] = true; out.unlock.push(u); });
      }
    }
  }

  // 结局判定
  let ending = null;
  if (channel === 'group') {
    const hit = pickEnding(sc, s, out.intent);
    if (hit) {
      const grace = Number(hit.grace || 0);
      const used = s.grace[hit.id] || 0;
      if (used < grace) {
        s.grace[hit.id] = used + 1;
        const seen = new Set(out.events.map((e) => e.text || ''));
        (hit.graceEvents || []).forEach((ev) => {
          if (!seen.has(ev.text)) out.events.push(ev);
        });
      } else {
        ending = { id: hit.id, title: hit.title, text: hit.text };
        s.ended = hit.id;
      }
    }
  }

  s.history.push({ role: 'user', content: (channel === 'group' ? '' : '（私聊）') + text });
  s.history.push({ role: 'assistant', content: JSON.stringify({ events: out.events, intent: out.intent }) });
  if (s.history.length > 60) s.history = s.history.slice(-60);

  try {
    const dir = path.join(ROOT, '_sessions');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, encodeURIComponent(sid) + '.json'),
      JSON.stringify({ sid, scenario: scenarioId, turn: s.turn, clock: s.clock, flags: s.flags, moved: s.moved, ended: s.ended, history: s.history }, null, 1)
    );
  } catch (e) { /* 落盘失败不影响游戏 */ }

  json(res, 200, { events: out.events, clock: s.clock, unlock: out.unlock, ending });
}

async function handleSeen(req, res) {
  const body = JSON.parse(await readBody(req));
  const sid = String(body.sid || 'default');
  const s = sessions.get(sid);
  const kind = String(body.kind || '');
  if (s && kind) s.flags[kind] = true;
  json(res, 200, { ok: true, flags: s ? s.flags : {} });
}

function serveAsset(req, res, query) {
  const id = String(query.get('id') || '');
  const kind = String(query.get('kind') || '');
  let sc;
  try { sc = loadScenario(id); } catch (e) { res.writeHead(404); return res.end('no scenario'); }
  const rel = (sc.assets || {})[kind];
  if (!rel) { res.writeHead(404); return res.end('no asset'); }
  const target = path.join(sc.dir, rel);
  if (!target.startsWith(sc.dir + path.sep)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(target, (err, data) => {
    if (err) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  let url, urlPath;
  try {
    url = new URL(req.url, `http://${HOST}`);
    urlPath = decodeURIComponent(url.pathname);
  } catch (e) {
    res.writeHead(400); return res.end('bad request');
  }

  if (req.method === 'POST') {
    try {
      if (urlPath === '/api/turn') return await handleTurn(req, res);
      if (urlPath === '/api/seen') return await handleSeen(req, res);
      if (urlPath === '/api/reset') {
        const body = JSON.parse(await readBody(req));
        sessions.delete(String(body.sid || 'default'));
        return json(res, 200, { ok: true });
      }
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  if (urlPath === '/api/scenarios') return json(res, 200, { scenarios: listScenarios() });

  if (urlPath === '/api/scenario') {
    try {
      const sc = loadScenario(String(url.searchParams.get('id') || 'richu'));
      return json(res, 200, publicScenario(sc));
    } catch (e) {
      return json(res, 404, { error: e.message });
    }
  }

  if (urlPath === '/api/asset') return serveAsset(req, res, url.searchParams);

  // 剧本目录绝不静态暴露（canon.md 是剧透）
  if (urlPath.startsWith('/scenarios/')) { res.writeHead(403); return res.end('forbidden'); }

  if (urlPath === '/') urlPath = '/index.html';
  const target = path.join(ROOT, urlPath);
  if (!target.startsWith(ROOT + path.sep) && target !== ROOT) {
    res.writeHead(403); return res.end('forbidden');
  }

  fs.readFile(target, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[game] http://${HOST}:${PORT}  key=${KEY ? 'ok' : 'MISSING'}`);
  console.log('[scenarios] ' + listScenarios().map((s) => s.id).join(', '));
});
