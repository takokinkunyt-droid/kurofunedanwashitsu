/**
 * /api/chat
 * GET  ?channel=kurofune        → 最新100件のメッセージを返す
 * GET  ?action=check-name&name= → 名前が使用可能か確認
 * POST { action: 'register-name', playerId, playerName } → 名前を登録（重複不可）
 * POST { channel, playerId, playerName, message }        → メッセージ送信
 */
const https = require('https');

const CHANNELS    = ['kurofune','study','casual','game','request'];
const MAX_MESSAGES = 100;
const MAX_LEN      = 300;
const RATE_SEC     = 3;
const NAME_MAX_LEN = 20;

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

// 名前の正規化キー（大文字小文字・前後の空白の違いを同一名として扱うため）
function nameKey(name) {
  return String(name || '').trim().toLowerCase();
}

module.exports = async (req, res) => {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET: メッセージ取得 / 名前の利用可否チェック ──────────
  if (req.method === 'GET') {
    const action = (req.query && req.query.action) || '';

    // 名前の利用可否チェック（登録前のリアルタイム検証用）
    if (action === 'check-name') {
      const name = String((req.query && req.query.name) || '').trim();
      if (!name) return res.status(400).json({ error: '名前を入力してください' });
      if (name.length > NAME_MAX_LEN) return res.status(400).json({ error: `名前は${NAME_MAX_LEN}文字以内にしてください` });

      const key = nameKey(name);
      const owner = await redis(['hget', 'chat_names', key]);
      const available = !owner.result;
      return res.status(200).json({ available });
    }

    const channel = ((req.query && req.query.channel) || 'kurofune').toLowerCase();
    if (!CHANNELS.includes(channel)) return res.status(400).json({ error: '無効なチャンネル' });

    const result = await redis(['lrange', `chat:${channel}`, 0, MAX_MESSAGES - 1]);
    const messages = (result.result || [])
      .map(s => { try { return JSON.parse(s); } catch (e) { return null; } })
      .filter(Boolean)
      .reverse();

    return res.status(200).json({ messages });
  }

  // ── POST: 名前登録 / メッセージ送信 ───────────────────────
  if (req.method === 'POST') {
    const body = await readBody(req);

    // 名前登録（重複不可・1playerIdにつき1名前を恒久的に割り当てる）
    if (body.action === 'register-name') {
      const { playerId } = body;
      const name = String(body.playerName || '').trim();

      if (!playerId) return res.status(400).json({ error: 'playerId が必要です' });
      if (!name)     return res.status(400).json({ error: '名前を入力してください' });
      if (name.length > NAME_MAX_LEN) return res.status(400).json({ error: `名前は${NAME_MAX_LEN}文字以内にしてください` });

      const key = nameKey(name);

      // すでにこのplayerIdが別の名前を登録済みなら、その名前を解放してから付け替える
      const existing = await redis(['hget', 'chat_playerid_to_name', playerId]);
      if (existing.result) {
        const existingKey = nameKey(existing.result);
        if (existingKey === key) {
          // 同じ名前を再登録しようとしている場合はそのまま成功扱い
          return res.status(200).json({ success: true, name: existing.result });
        }
      }

      // 名前の重複チェック（Hashで「正規化名 → 所有playerId」を管理）
      const owner = await redis(['hget', 'chat_names', key]);
      if (owner.result && owner.result !== playerId) {
        return res.status(409).json({ error: 'その名前はすでに使われています', taken: true });
      }

      // 古い名前の登録があれば解放
      if (existing.result) {
        const oldKey = nameKey(existing.result);
        await redis(['hdel', 'chat_names', oldKey]);
      }

      await redis(['hset', 'chat_names', key, playerId]);
      await redis(['hset', 'chat_playerid_to_name', playerId, name]);

      return res.status(200).json({ success: true, name });
    }

    // メッセージ送信
    const { channel, playerId, playerName, message } = body;

    if (!CHANNELS.includes(channel))  return res.status(400).json({ error: '無効なチャンネル' });
    if (!playerId)                    return res.status(400).json({ error: 'playerId が必要です' });
    if (!message || !message.trim())  return res.status(400).json({ error: 'メッセージが空です' });

    // 送信者の登録名をサーバー側で確定する（クライアントが偽名を送ってもサーバー記録を優先）
    const registered = await redis(['hget', 'chat_playerid_to_name', playerId]);
    if (!registered.result) {
      return res.status(403).json({ error: '名前が未登録です。先に名前を登録してください', needsName: true });
    }
    const name = registered.result;

    const trimmedMsg = message.trim().slice(0, MAX_LEN);

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
