// 本地服务：静态页面 + GM 接口
const http = require('http');
const fs = require('fs');
const path = require('path');
const { gmTurn } = require('./gm');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 5178);
const HOST = '127.0.0.1';
const KEY = process.env.ROLE_PLAYING_KEY || process.env.DEEPSEEK_API_KEY || '';

// 直接从 story.js 读开场，保证服务端和前端看到的是同一份
function loadStory() {
  try {
    const vm = require('vm');
    const sandbox = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'story.js'), 'utf8'), sandbox, { timeout: 2000 });
    return sandbox.window.STORY || null;
  } catch (e) {
    console.error('[story] 读取失败', e.message);
    return null;
  }
}
const STORY = loadStory();
const NAME = {};
if (STORY) STORY.meta.members.forEach((m) => { NAME[m.id] = m.name; });
const PRIOR = STORY ? STORY.intro.map((m) => {
  if (m.t === 'time') return '\n【' + m.v + '】';
  if (m.t === 'sys') return '· ' + m.text;
  if (m.t === 'msg') return (NAME[m.from] || m.from) + '：' + m.text;
  if (m.t === 'voice') return (NAME[m.from] || m.from) + '：[语音 ' + m.dur + '″] ' + (m.asr || '');
  if (m.t === 'loc') return (NAME[m.from] || m.from) + '：[位置] ' + m.name + '（' + (m.when || '') + '）' + (m.flag || '');
  return '';
}).filter(Boolean).join('\n') : '';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const sessions = new Map();

function newSession() {
  return { turn: 0, clock: '06:15', flags: {}, history: [], ended: null, prior: PRIOR, facts: [], startedAt: Date.now() };
}

function eventsToText(events) {
  return events.map((e) => {
    if (e.t === 'msg') return (e.from || '') + '：' + e.text;
    if (e.t === 'sys') return '系统：' + e.text;
    if (e.t === 'recall') return '系统：' + (e.from || '') + ' 撤回了一条消息';
    if (e.t === 'rename') return '系统：群名被修改为「' + e.name + '」';
    if (e.t === 'notice') return '系统：群公告被修改为「' + e.text + '」';
    if (e.t === 'join') return '系统：「' + e.name + '」加入了群聊';
    if (e.t === 'leave') return '系统：「' + e.name + '」退出了群聊';
    if (e.t === 'voice') return e.from + '：[语音] ' + (e.asr || '');
    if (e.t === 'loc') return e.from + '：[位置] ' + (e.name || '');
    if (e.t === 'img') return e.from + '：[图片] ' + (e.cap || '');
    return '';
  }).filter(Boolean).join('\n');
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
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function handleTurn(req, res) {
  const body = JSON.parse(await readBody(req));
  const sid = String(body.sid || 'default');
  let s = sessions.get(sid);
  if (!s) { s = newSession(); sessions.set(sid, s); }
  if (s.ended) return json(res, 200, { events: [], ended: s.ended });

  const channel = body.channel === 'group' || !body.channel ? 'group' : body.channel;
  const whoMap = { 'p:laok': 'laok', 'p:aqiao': 'aqiao', 'p:shiqi': 'shiqi', 'p:mo': 'mo' };
  const text = String(body.text || '').slice(0, 300);
  if (!text) return json(res, 400, { error: 'empty' });

  let out;
  try {
    out = await gmTurn({
      channel,
      text,
      history: s.history,
      state: { turn: s.turn, clock: s.clock, flags: s.flags, prior: s.prior, facts: s.facts, moved: !!s.moved, who: whoMap[channel] || '', whoState: whoMap[channel] || '' }
    });
  } catch (e) {
    return json(res, 500, { error: 'GM 掉线了：' + e.message, events: [] });
  }

  s.turn += 1;
  if (out.clock && /^\d{1,2}:\d{2}$/.test(out.clock)) s.clock = out.clock;
  if (Array.isArray(out.facts) && out.facts.length) {
    s.facts = s.facts.concat(out.facts.map(String).slice(0, 2)).slice(-15);
  }
  out.unlock.forEach((k) => { s.flags[k] = true; });
  out.events.forEach((e) => {
    if (e.t === 'rename' || e.t === 'notice') s.flags.renamed = true;
    if (e.t === 'join' && e.name === '小满') s.flags.xiaoman = true;
    if (e.t === 'img') s.flags.photo = true;
  });

  // 关键剧情节点由服务器保底投放
  if (channel === 'group') {
    if (s.turn >= 6 && !s.flags.xiaoman) {
      s.flags.xiaoman = true;
      out.events.push(
        { t: 'join', name: '小满' },
        { t: 'msg', from: 'u:小满', text: '别去' },
        { t: 'leave', name: '小满', text: '「小满」已被移出群聊' }
      );
    }
    if (s.turn >= 8 && !s.flags.photo) {
      s.flags.photo = true;
      out.events.push({ t: 'img', from: 'mo', cap: '松岭服务区 03:14' });
    }
    if (s.turn >= 9 && !s.flags.archive) {
      s.flags.archive = true;
      out.unlock.push('archive');
      out.events.push({ t: 'sys', text: '聊天记录里好像多出了几条', tone: 'warn' });
    }
  }

  // 结局判定（服务器说了算）
  let ending = null;
  const canEnd = s.turn >= 10 || s.flags.archive || s.flags.photo;
  if (channel === 'group') {
    if (out.intent === 'move') {
      if (!s.moved && s.turn < 12) {
        // 第一次移动只是"离开路灯"，还有一次回头机会
        s.moved = true;
        const narrated = out.events.some((e) => e.t === 'sys' && /离开|路灯|走了/.test(e.text || ''));
        if (!narrated) out.events.push({ t: 'sys', text: '你离开了南门那盏路灯。', tone: 'warn' });
        const laokSaid = out.events.some((e) => e.t === 'msg' && e.from === 'laok' && /走|往前/.test(e.text || ''));
        if (!laokSaid) out.events.push({ t: 'msg', from: 'laok', text: '往前走。' });
      } else {
        ending = 'bad';
      }
    } else if (out.intent === 'police' && canEnd) {
      ending = (s.flags.archive && s.flags.photo) ? 'hidden' : 'good';
    }
  }
  if (ending) s.ended = ending;

  const label = channel === 'group' ? '' : '（私聊）';
  s.history.push({ role: 'user', content: label + text });
  // 让模型在历史里看到自己上一条也是 JSON，避免它退回普通对话格式
  s.history.push({ role: 'assistant', content: JSON.stringify({ events: out.events, intent: out.intent }) });
  if (s.history.length > 60) s.history = s.history.slice(-60);

  // 会话落盘，方便复盘
  try {
    const dir = path.join(ROOT, '_sessions');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, encodeURIComponent(sid) + '.json'),
      JSON.stringify({ sid, turn: s.turn, clock: s.clock, flags: s.flags, moved: !!s.moved, ended: s.ended, history: s.history }, null, 1)
    );
  } catch (e) { /* 落盘失败不影响游戏 */ }

  json(res, 200, {
    events: out.events,
    clock: s.clock,
    unlock: out.unlock,
    ending
  });
}

async function handleSeen(req, res) {
  const body = JSON.parse(await readBody(req));
  const sid = String(body.sid || 'default');
  let s = sessions.get(sid);
  if (!s) { s = newSession(); sessions.set(sid, s); }
  const kind = String(body.kind || '');
  if (kind === 'archive' || kind === 'photo') s.flags[kind] = true;
  json(res, 200, { ok: true, flags: s.flags });
}

const server = http.createServer(async (req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, `http://${HOST}`).pathname);
  } catch {
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

  if (urlPath === '/') urlPath = '/index.html';
  const target = path.join(ROOT, urlPath);
  if (!target.startsWith(ROOT + path.sep) && target !== ROOT) {
    res.writeHead(403); return res.end('forbidden');
  }

  fs.readFile(target, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[game] http://${HOST}:${PORT}  key=${KEY ? 'ok' : 'MISSING'}`);
});
