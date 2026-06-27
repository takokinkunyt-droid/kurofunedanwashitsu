/**
 * /api/chat
 * GET  ?channel=kurofune   → 最新100件のメッセージを返す
 * POST body: { channel, playerId, playerName, message } → メッセージ送信
 */
const https = require('https');

const CHANNELS    = ['kurofune','study','casual','game','request'];
const MAX_MESSAGES = 100;
const MAX_LEN      = 300;
const RATE_SEC     = 3;

function redis(command) {
  return new Promise((resolve, reject) => {
    const url   = new URL(process.env.UPSTASH_REDIS_REST_URL);
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    const data  = JSON.stringify(command);
    const req   = https.request({
      hostname: url.hostname, port: 443,
      path: url.pathname + (url.search || ''),
      method: 'POST',
      headers: {
        'Authorization':  `Bearer ${token}`,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (r) => {
      let body = '';
      r.on('data', c => { body += c; });
      r.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Content-Type', 'application/json');
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

module.exports = async (req, res) => {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET: メッセージ取得 ──────────────────────────────
  if (req.method === 'GET') {
    const channel = ((req.query && req.query.channel) || 'kurofune').toLowerCase();
    if (!CHANNELS.includes(channel)) return res.status(400).json({ error: '無効なチャンネル' });

    const result = await redis(['lrange', `chat:${channel}`, 0, MAX_MESSAGES - 1]);
    const messages = (result.result || [])
      .map(s => { try { return JSON.parse(s); } catch (e) { return null; } })
      .filter(Boolean)
      .reverse();

    return res.status(200).json({ messages });
  }

  // ── POST: メッセージ送信 ─────────────────────────────
  if (req.method === 'POST') {
    const body = await readBody(req);
    const { channel, playerId, playerName, message } = body;

    if (!CHANNELS.includes(channel))  return res.status(400).json({ error: '無効なチャンネル' });
    if (!playerId)                    return res.status(400).json({ error: 'playerId が必要です' });
    if (!message || !message.trim())  return res.status(400).json({ error: 'メッセージが空です' });

    const trimmedMsg = message.trim().slice(0, MAX_LEN);
    const name = String(playerName || '名無しの船長').slice(0, 20);

    // BANチェック
    const banCheck = await redis(['sismember', 'banned_players', playerId]);
    if (banCheck.result === 1) {
      return res.status(403).json({ error: 'アカウントが停止されています', banned: true });
    }

    // 連投制限
    const rateKey = `chat_rate:${playerId}`;
    const rateCheck = await redis(['exists', rateKey]);
    if (rateCheck.result === 1) {
      return res.status(429).json({ error: `${RATE_SEC}秒に1回しか送れません` });
    }

    const entry = JSON.stringify({
      id:      genId(),
      name,
      playerId,
      msg:     trimmedMsg,
      ts:      Date.now(),
    });

    await redis(['lpush', `chat:${channel}`, entry]);
    await redis(['ltrim', `chat:${channel}`, 0, MAX_MESSAGES - 1]);
    await redis(['setex', rateKey, RATE_SEC, '1']);

    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
};
