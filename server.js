// 本地服务：静态页面 + 剧本 + GM 接口（不含任何具体剧情）
const http = require('http');
const fs = require('fs');
const path = require('path');
const { gmTurn, loadScenario, listScenarios, KEY } = require('./gm');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 5178);
const HOST = '127.0.0.1';
const BOOT_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

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

function newSession(sc, sid, prior) {
  const npcs = {};
  (sc.meta.members || []).forEach((m) => {
    if (m.id === 'me') return;
    const c = sc.cast[m.id] || {};
    npcs[m.id] = {
      memory: [],
      knowledge: c.knows || '',
      mood: '',
      goal: '',
      inbox: []
    };
  });
  const initial = sc.state && sc.state.initial ? JSON.parse(JSON.stringify(sc.state.initial)) : {};
  const phase = (sc.arc && sc.arc[0] && sc.arc[0].id) || '';
  return {
    sid,
    scenarioId: sc.id,
    turn: 0,
    clock: sc.meta.startClock || null,
    phase,
    state: initial,
    publicFacts: [],
    npcs,
    threads: {},
    playedSetpieces: [],
    ended: null,
    prior: prior || '',
    history: [],
    flags: {},
    groupName: sc.meta.groupName || '',
    notice: {
      from: sc.meta.noticeFrom || '',
      text: sc.meta.notice || '',
      meta: sc.meta.noticeMeta || ''
    },
    startedAt: Date.now()
  };
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

function persist(s) {
  try {
    const dir = path.join(ROOT, '_sessions');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, encodeURIComponent(s.sid || 'default') + '.json'),
      JSON.stringify(s, null, 1)
    );
  } catch (e) { /* 落盘失败不影响游戏 */ }
}

// 开场转成"已经发生过的对话"，喂给模型
function buildPrior(sc) {
  const name = {};
  (sc.meta.members || []).forEach((m) => { name[m.id] = m.name; });
  const nm = (id) => name[id] || String(id || '').replace(/^u:/, '');
  return (sc.intro || []).map((m) => {
    if (m.t === 'time') return '\n【' + m.v + '】';
    if (m.t === 'sys') return '· ' + m.text;
    if (m.t === 'msg') return nm(m.from) + '：' + m.text;
    if (m.t === 'voice') return nm(m.from) + '：[语音 ' + m.dur + '″] ' + (m.asr || '');
    if (m.t === 'loc') return nm(m.from) + '：[位置] ' + m.name + '（' + (m.when || '') + '）' + (m.flag || '');
    if (m.t === 'img') return nm(m.from) + '：[图片] ' + (m.cap || '');
    if (m.t === 'rename') return '· 群名被改成「' + m.name + '」';
    if (m.t === 'notice') return '· 群公告被改成「' + m.text + '」';
    if (m.t === 'join') return '· 「' + m.name + '」加入了群聊';
    if (m.t === 'leave') return '· 「' + m.name + '」离开了群聊';
    return '';
  }).filter(Boolean).join('\n');
}

function publicScenario(sc) {
  // 只给浏览器看它需要的：剧透内容（canon / style / cast / state / arc / endings / setpieces）一律不发
  return {
    id: sc.id,
    title: sc.title,
    subtitle: sc.subtitle,
    cover: sc.cover,
    meta: sc.meta,
    intro: sc.intro,
    archive: sc.archive,
    assets: sc.assets,
    rules: sc.rules || {},
    bootId: BOOT_ID
  };
}

async function handleTurn(req, res) {
  const body = JSON.parse(await readBody(req));
  const sid = String(body.sid || 'default');
  const scenarioId = String(body.scenario || '');
  if (!scenarioId) return json(res, 400, { error: '缺少 scenario', events: [] });
  const sc = loadScenario(scenarioId);

  let s = sessions.get(sid);
  if (!s || s.scenarioId !== scenarioId) {
    s = newSession(sc, sid, buildPrior(sc));
    s.clock = sc.meta.startClock;
    sessions.set(sid, s);
  }
  if (s.ended) return json(res, 200, { events: [], ended: true });

  // 私聊频道形如 p:<成员id>，成员表由剧本声明。对不上就明确拒绝，
  // 别把一个陌生频道交给随机演员，让回复落进错的会话。
  const channel = !body.channel || body.channel === 'group' ? 'group' : String(body.channel);
  let who = '';
  if (channel !== 'group') {
    const target = channel.startsWith('p:') ? channel.slice(2) : '';
    const memberIds = (sc.meta.members || []).map((m) => m.id);
    if (!target || target === 'me' || !memberIds.includes(target)) {
      return json(res, 400, { error: '这个人不在群里', events: [] });
    }
    who = target;
  }
  const text = String(body.text || '').slice(0, 300);
  if (!text) return json(res, 400, { error: 'empty' });

  let out;
  try {
    out = await gmTurn({ scenario: sc, session: s, channel, text, who });
  } catch (e) {
    return json(res, 500, { error: 'GM 掉线了：' + e.message, events: [] });
  }

  persist(s);
  json(res, 200, {
    events: out.events,
    dmEvents: out.dmEvents,
    clock: s.clock,
    unlock: out.unlock,
    ending: out.ending
  });
}

async function handleSeen(req, res) {
  const body = JSON.parse(await readBody(req));
  const sid = String(body.sid || 'default');
  const s = sessions.get(sid);
  const kind = String(body.kind || '');
  if (s && kind) {
    s.flags[kind] = true;
    persist(s);
  }
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
      const scenarioId = String(url.searchParams.get('id') || '');
      if (!scenarioId) return json(res, 400, { error: '缺少 id' });
      const sc = loadScenario(scenarioId);
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
  console.log(`[game] http://${HOST}:${PORT}  key=${KEY ? 'ok' : 'MISSING'}  boot=${BOOT_ID}`);
  console.log('[scenarios] ' + listScenarios().map((s) => s.id).join(', '));
});
