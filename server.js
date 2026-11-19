'use strict';
// Ludo online server. No dependencies: plain Node (18+), Server-Sent Events for live updates.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const INDEX = path.join(__dirname, 'index.html');

const START_INDEX = [0, 13, 26, 39];
const SAFE = new Set([0, 8, 13, 21, 26, 34, 39, 47]);
const FINISHED = 56;
const rooms = new Map();

const trackIndex = (p, prog) => (START_INDEX[p] + prog) % 52;
const newId = () => crypto.randomBytes(8).toString('hex');

function makeCode() {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do {
    c = '';
    for (let i = 0; i < 4; i++) c += L[crypto.randomInt(L.length)];
  } while (rooms.has(c));
  return c;
}

// ---------- Sending ----------
function send(client, msg) {
  if (!client.res) return;
  try { client.res.write('data: ' + JSON.stringify(msg) + '\n\n'); } catch (e) { /* closed */ }
}

function snapshot(room, cid, anim) {
  const c = room.clients.get(cid);
  const m = { type: 'room', code: room.code, started: room.started, mySeat: c ? c.seat : -1, isHost: room.host === cid };
  if (!room.started) {
    m.seats = room.seats.map(s => ({
      type: s.type,
      state: s.type === 'human' ? (s.cid ? (s.cid === cid ? 'you' : 'taken') : 'open') : null
    }));
  } else {
    const g = room.game;
    m.types = room.seats.map(s => s.type);
    m.tokens = g.tokens;
    m.current = g.current;
    m.dice = g.dice;
    m.phase = g.phase;
    m.movable = g.phase === 'move' ? g.movable : [];
    m.winner = g.winner;
    if (anim) m.anim = anim;
  }
  return m;
}

function broadcast(room, anim) {
  if (room.started) room.game.seq++;
  room.clients.forEach((c, cid) => send(c, snapshot(room, cid, anim)));
}

const anyConnected = room => [...room.clients.values()].some(c => c.res);

// ---------- Game rules ----------
function getMovable(tokens, d) {
  const res = [];
  tokens.forEach((prog, i) => {
    if (prog === FINISHED) return;
    if (prog === -1) { if (d === 6) res.push(i); return; }
    if (prog + d <= FINISHED) res.push(i);
  });
  return res;
}

function chooseCpuMove(room) {
  const g = room.game, cur = g.current;
  let best = g.movable[0], bestScore = -1;
  for (const i of g.movable) {
    const prog = g.tokens[cur][i];
    const np = prog === -1 ? 0 : prog + g.dice;
    let score = np;
    if (np === FINISHED) score += 1000;
    if (prog === -1) score += 60;
    if (np <= 50) {
      const ti = trackIndex(cur, np);
      if (SAFE.has(ti)) score += 30;
      g.tokens.forEach((toks, oi) => {
        if (oi === cur) return;
        toks.forEach(oprog => {
          if (oprog >= 0 && oprog <= 50 && trackIndex(oi, oprog) === ti && !SAFE.has(ti)) score += 200;
        });
      });
    }
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best;
}

// A seat is played by the server if it is a computer seat, or a human who has disconnected.
function isBot(room, p) {
  const s = room.seats[p];
  if (s.type === 'cpu') return true;
  if (s.type !== 'human') return false;
  const c = s.cid && room.clients.get(s.cid);
  return !(c && c.res);
}

function alive(room) { return rooms.get(room.code) === room; }

function beginTurn(room) {
  if (!alive(room)) return;
  const g = room.game;
  g.phase = 'roll';
  g.movable = [];
  broadcast(room);
  drive(room);
}

function nextPlayer(room) {
  if (!alive(room)) return;
  const g = room.game;
  g.sixes = 0;
  do { g.current = (g.current + 1) % 4; } while (room.seats[g.current].type === 'off');
  beginTurn(room);
}

function doRoll(room) {
  const g = room.game;
  if (g.phase !== 'roll') return;
  g.phase = 'rolling';
  g.dice = 1 + crypto.randomInt(6);
  g.movable = [];
  broadcast(room, { type: 'roll' });
  // 1300ms dice animation + 700ms rest, matching the page
  setTimeout(() => afterRoll(room), 2000);
}

function afterRoll(room) {
  if (!alive(room)) return;
  const g = room.game;
  if (g.dice === 6) g.sixes++; else g.sixes = 0;
  if (g.sixes === 3) {
    g.sixes = 0;
    setTimeout(() => nextPlayer(room), 900);
    return;
  }
  g.movable = getMovable(g.tokens[g.current], g.dice);
  if (!g.movable.length) {
    setTimeout(() => (g.dice === 6 ? beginTurn(room) : nextPlayer(room)), 900);
    return;
  }
  g.phase = 'move';
  broadcast(room);
  drive(room);
}

function doMove(room, i) {
  const g = room.game;
  if (g.phase !== 'move' || !g.movable.includes(i)) return;
  const cur = g.current;
  const toks = g.tokens[cur];
  const from = toks[i];
  const to = from === -1 ? 0 : from + g.dice;
  toks[i] = to;
  g.phase = 'moving';
  g.movable = [];
  let bonus = g.dice === 6;
  const captured = [];
  if (to <= 50) {
    const ti = trackIndex(cur, to);
    if (!SAFE.has(ti)) {
      for (let oi = 0; oi < 4; oi++) {
        if (oi === cur || room.seats[oi].type === 'off') continue;
        for (let oj = 0; oj < 4; oj++) {
          const oprog = g.tokens[oi][oj];
          if (oprog >= 0 && oprog <= 50 && trackIndex(oi, oprog) === ti) {
            g.tokens[oi][oj] = -1;
            captured.push({ p: oi, i: oj });
            bonus = true;
          }
        }
      }
    }
  }
  if (to === FINISHED) bonus = true;

  const won = toks.every(t => t === FINISHED);
  if (won) { g.phase = 'over'; g.winner = cur; }
  broadcast(room, { type: 'move', player: cur, token: i, from, to, captured });
  if (won) return;

  const animMs = from === -1 ? 350 : (to - from) * 170;
  setTimeout(() => (bonus ? beginTurn(room) : nextPlayer(room)), animMs + 700);
}

// Schedules the server to act when the player whose turn it is is a computer or has disconnected.
function drive(room) {
  if (!room.started) return;
  const g = room.game;
  if (g.phase !== 'roll' && g.phase !== 'move') return;
  if (!anyConnected(room)) return;
  if (!isBot(room, g.current)) {
    if (room.botTimer) { clearTimeout(room.botTimer); room.botTimer = null; }
    return;
  }
  if (room.botTimer) {
    if (room.botSeq === g.seq) return;
    clearTimeout(room.botTimer);
    room.botTimer = null;
  }
  const delay = room.seats[g.current].type === 'cpu' ? 900 : 5000;
  room.botSeq = g.seq;
  room.botTimer = setTimeout(() => {
    room.botTimer = null;
    if (!alive(room)) return;
    if (g.seq !== room.botSeq || !isBot(room, g.current)) { drive(room); return; }
    if (g.phase === 'roll') doRoll(room);
    else if (g.phase === 'move') doMove(room, chooseCpuMove(room));
  }, delay);
}

// ---------- Rooms ----------
function removeClient(room, cid) {
  const c = room.clients.get(cid);
  if (!c) return;
  room.seats.forEach(s => { if (s.cid === cid) s.cid = null; });
  if (c.hb) clearInterval(c.hb);
  if (c.res) { try { c.res.end(); } catch (e) { /* ignore */ } c.res = null; }
  room.clients.delete(cid);
  if (room.host === cid) room.host = room.clients.size ? room.clients.keys().next().value : null;
  if (!room.clients.size && !room.started) { rooms.delete(room.code); return; }
  if (!room.started) broadcast(room);
}

function startGame(room) {
  room.seats.forEach(s => { if (s.type === 'human' && !s.cid) s.type = 'cpu'; });
  const first = room.seats.findIndex(s => s.type !== 'off');
  room.started = true;
  room.game = {
    tokens: [[-1, -1, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1]],
    current: first, dice: 0, sixes: 0, phase: 'roll', movable: [], winner: -1, seq: 0
  };
  broadcast(room);
  drive(room);
}

// ---------- HTTP ----------
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', d => { data += d; if (data.length > 10000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function handleEvents(req, res, url) {
  const code = String(url.searchParams.get('code') || '').toUpperCase();
  const cid = String(url.searchParams.get('cid') || '');
  const room = rooms.get(code);
  const client = room && room.clients.get(cid);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  if (!client) { res.write('data: {"type":"gone"}\n\n'); return res.end(); }
  if (client.res && client.res !== res) { try { client.res.end(); } catch (e) { /* ignore */ } }
  if (client.hb) clearInterval(client.hb);
  client.res = res;
  room.lastActive = Date.now();
  res.write(':ok\n\n');
  client.hb = setInterval(() => { try { res.write(':hb\n\n'); } catch (e) { /* ignore */ } }, 20000);
  if (room.started) {
    send(client, snapshot(room, cid));
    drive(room);
  } else {
    broadcast(room);
  }
  req.on('close', () => {
    if (client.res !== res) return;
    client.res = null;
    clearInterval(client.hb);
    room.lastActive = Date.now();
    if (!room.started) {
      setTimeout(() => {
        if (alive(room) && room.clients.get(cid) === client && !client.res) removeClient(room, cid);
      }, 15000);
    } else {
      drive(room);
    }
  });
}

async function handleApi(req, res, name) {
  const b = await readBody(req);
  const code = String(b.code || '').toUpperCase();
  const room = rooms.get(code);
  const cid = String(b.cid || '');

  if (name === 'create') {
    const cfg = b.config;
    const ok = Array.isArray(cfg) && cfg.length === 4 && cfg.every(t => ['human', 'cpu', 'off'].includes(t));
    if (!ok || !cfg.includes('human') || cfg.filter(t => t !== 'off').length < 2) {
      return json(res, 400, { error: 'Pick at least two players, and at least one Human.' });
    }
    const r = { code: makeCode(), seats: cfg.map(t => ({ type: t, cid: null })), clients: new Map(), host: null, started: false, game: null, botTimer: null, botSeq: -1, lastActive: Date.now() };
    const id = newId();
    const seat = cfg.indexOf('human');
    r.seats[seat].cid = id;
    r.clients.set(id, { res: null, seat });
    r.host = id;
    rooms.set(r.code, r);
    return json(res, 200, { code: r.code, cid: id, seat });
  }

  if (!room) return json(res, 404, { error: 'Room not found. Check the code.' });
  room.lastActive = Date.now();

  if (name === 'join') {
    if (room.started) return json(res, 400, { error: 'That game has already started.' });
    const seat = room.seats.findIndex(s => s.type === 'human' && !s.cid);
    if (seat < 0) return json(res, 400, { error: 'This room is full.' });
    const id = newId();
    room.seats[seat].cid = id;
    room.clients.set(id, { res: null, seat });
    return json(res, 200, { code: room.code, cid: id, seat });
  }

  const client = room.clients.get(cid);
  if (!client) return json(res, 403, { error: 'You are not in this room.' });

  if (name === 'seat') {
    const s = Number(b.seat);
    if (room.started || !(s >= 0 && s < 4) || room.seats[s].type !== 'human' || room.seats[s].cid) {
      return json(res, 400, { error: 'That seat is not available.' });
    }
    room.seats[client.seat].cid = null;
    room.seats[s].cid = cid;
    client.seat = s;
    broadcast(room);
    return json(res, 200, { ok: true });
  }
  if (name === 'start') {
    if (room.host !== cid) return json(res, 403, { error: 'Only the host can start.' });
    if (!room.started) startGame(room);
    return json(res, 200, { ok: true });
  }
  if (name === 'leave') {
    if (!room.started) removeClient(room, cid);
    else { if (client.res) { try { client.res.end(); } catch (e) { /* ignore */ } } client.res = null; drive(room); }
    return json(res, 200, { ok: true });
  }
  if (name === 'roll') {
    const g = room.game;
    if (!room.started || g.phase !== 'roll' || room.seats[g.current].cid !== cid) return json(res, 400, { error: 'Not your turn.' });
    if (room.botTimer) { clearTimeout(room.botTimer); room.botTimer = null; }
    doRoll(room);
    return json(res, 200, { ok: true });
  }
  if (name === 'move') {
    const g = room.game;
    const t = Number(b.token);
    if (!room.started || g.phase !== 'move' || room.seats[g.current].cid !== cid || !g.movable.includes(t)) {
      return json(res, 400, { error: 'That move is not allowed.' });
    }
    if (room.botTimer) { clearTimeout(room.botTimer); room.botTimer = null; }
    doMove(room, t);
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: 'Unknown request.' });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET') {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return fs.readFile(INDEX, (err, data) => {
        if (err) { res.writeHead(500); return res.end('index.html missing'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(data);
      });
    }
    if (url.pathname === '/api/events') return handleEvents(req, res, url);
    if (url.pathname === '/health') { res.writeHead(200); return res.end('ok'); }
    res.writeHead(404); return res.end('Not found');
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    return handleApi(req, res, url.pathname.slice(5)).catch(() => json(res, 500, { error: 'Server error.' }));
  }
  res.writeHead(404); res.end('Not found');
});

// Remove rooms that nobody has been connected to for 2 hours.
setInterval(() => {
  const now = Date.now();
  rooms.forEach((room, code) => {
    if (!anyConnected(room) && now - room.lastActive > 2 * 3600 * 1000) {
      if (room.botTimer) clearTimeout(room.botTimer);
      rooms.delete(code);
    }
  });
}, 10 * 60 * 1000).unref();

server.listen(PORT, () => console.log('Ludo server running on port ' + PORT));
