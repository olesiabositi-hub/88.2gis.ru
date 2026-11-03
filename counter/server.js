'use strict';
/*
 * Счётчик «Пешком по графу». Хранит только суммы за день:
 *   дата | событие | источник | устройство | количество.
 * IP, User-Agent, точное время и идентификаторы посетителей не читаются и не сохраняются.
 * Данные лежат одним файлом в Object Storage Cloud.ru. Зависимостей нет.
 *
 * Контейнер должен работать в одном экземпляре (максимум экземпляров = 1).
 */
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const cfg = {
  port: +(process.env.PORT || 8080),
  endpoint: new URL(process.env.S3_ENDPOINT || 'https://s3.cloud.ru'),
  region: process.env.S3_REGION || 'ru-central-1',
  bucket: process.env.S3_BUCKET || '',
  accessKey: process.env.S3_ACCESS_KEY || '', // <tenant_id>:<key_id>
  secretKey: process.env.S3_SECRET_KEY || '',
  statsKey: process.env.STATS_KEY || '',
  origins: (process.env.ALLOWED_ORIGINS || 'https://graph.2gis.ru').split(',').map(s => s.trim()),
  flushMs: +(process.env.FLUSH_MS || 20000),
  object: 'stats.json',
};

const missing = ['bucket', 'accessKey', 'secretKey', 'statsKey'].filter(k => !cfg[k]);
if (missing.length) {
  console.error('Не заданы настройки: ' + missing.join(', '));
  process.exit(1);
}

const HALLS = ['hall_1', 'hall_2', 'hall_3', 'hall_4', 'hall_5', 'hall_6', 'letter'];
const ACH = ['route', 'close', 'jam', 'algos', 'seer', 'beat', 'robot', 'wave', 'detective', 'letter'];
const EVENTS = new Set(['visitor', 'view', 'talon', 'save_png', 'copy_text',
  ...HALLS.map(h => 'reach_' + h), ...ACH.map(a => 'ach_' + a)]);
const DEVICES = new Set(['phone', 'tablet', 'desktop']);
const SOURCE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const MAX_ROWS = 20000; // защита от засорения файла случайными источниками
const MAX_BODY = 512;

/* ---------- Object Storage (S3 API, подпись V4) ---------- */
const sha256 = d => crypto.createHash('sha256').update(d).digest('hex');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();

function s3(method, key, body) {
  const payload = body || '';
  const now = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = now.slice(0, 8);
  const host = cfg.endpoint.host;
  const path = '/' + cfg.bucket + '/' + key.split('/').map(encodeURIComponent).join('/');
  const hash = sha256(payload);
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonical = [method, path, '', `host:${host}`, `x-amz-content-sha256:${hash}`,
    `x-amz-date:${now}`, '', signedHeaders, hash].join('\n');
  const scope = `${day}/${cfg.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', now, scope, sha256(canonical)].join('\n');
  const signing = ['s3', 'aws4_request'].reduce(hmac,
    hmac(hmac('AWS4' + cfg.secretKey, day), cfg.region));
  const signature = crypto.createHmac('sha256', signing).update(toSign).digest('hex');
  const headers = {
    'x-amz-content-sha256': hash,
    'x-amz-date': now,
    Authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
  if (body) headers['Content-Length'] = Buffer.byteLength(body);
  const lib = cfg.endpoint.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = lib.request({
      method, host: cfg.endpoint.hostname, port: cfg.endpoint.port || undefined, path, headers, timeout: 15000,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('таймаут Object Storage')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/* ---------- Суммы ---------- */
let rows = new Map();   // "дата|событие|источник|устройство" -> количество
let loaded = false;     // пока файл не прочитан, запись запрещена: иначе можно затереть старые данные
let loading = null;
let dirty = false;
let flushing = null;
let backedUpDay = '';

const today = () => new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10); // день по Москве

function load() {
  if (loaded) return Promise.resolve();
  if (loading) return loading;
  loading = s3('GET', cfg.object).then(r => {
    if (r.status === 200) {
      const saved = new Map(Object.entries(JSON.parse(r.body)));
      // Суммы, накопленные до чтения файла, прибавляем к сохранённым.
      for (const [k, v] of rows) saved.set(k, (saved.get(k) || 0) + v);
      rows = saved;
    } else if (r.status !== 404) {
      throw new Error('чтение файла: код ' + r.status);
    }
    loaded = true;
  }).finally(() => { loading = null; });
  return loading;
}

function flush() {
  if (!dirty) return Promise.resolve();
  if (flushing) return flushing;
  flushing = (async () => {
    await load();
    dirty = false;
    const body = JSON.stringify(Object.fromEntries(rows));
    const day = today();
    try {
      if (backedUpDay !== day) { // копия файла раз в день, на случай ошибки
        const b = await s3('PUT', `backup/${day}.json`, body);
        if (b.status === 200) backedUpDay = day;
      }
      const r = await s3('PUT', cfg.object, body);
      if (r.status !== 200) throw new Error('запись файла: код ' + r.status);
    } catch (e) {
      dirty = true;
      throw e;
    }
  })().finally(() => { flushing = null; });
  return flushing;
}

const safeFlush = () => flush().catch(e => console.error('Не удалось сохранить:', e.message));
setInterval(safeFlush, cfg.flushMs).unref();

function add(event, source, device) {
  const k = [today(), event, source, device].join('|');
  if (!rows.has(k) && rows.size >= MAX_ROWS) return;
  rows.set(k, (rows.get(k) || 0) + 1);
  dirty = true;
}

function csv() {
  const out = ['date,event,source,device,count'];
  [...rows.entries()].sort(([a], [b]) => (a < b ? -1 : 1))
    .forEach(([k, v]) => out.push(k.split('|').join(',') + ',' + v));
  return out.join('\n') + '\n';
}

/* ---------- HTTP ---------- */
function keyOk(given) {
  const a = crypto.createHash('sha256').update(given || '').digest();
  const b = crypto.createHash('sha256').update(cfg.statsKey).digest();
  return crypto.timingSafeEqual(a, b);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const origin = req.headers.origin;
  const send = (code, type, text, extra) => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
    res.end(text);
  };

  if (url.pathname === '/healthz') return send(200, 'text/plain', 'ok');

  if (url.pathname === '/stats.csv' && req.method === 'GET') {
    if (!keyOk(url.searchParams.get('key'))) return send(403, 'text/plain', 'forbidden');
    return load().then(
      () => send(200, 'text/csv; charset=utf-8', csv()),
      e => { console.error('Не удалось прочитать:', e.message); send(503, 'text/plain', 'storage unavailable'); });
  }

  if (url.pathname === '/e') {
    if (!cfg.origins.includes(origin)) return send(403, 'text/plain', 'forbidden');
    const cors = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
    if (req.method === 'OPTIONS') {
      return send(204, 'text/plain', '', { ...cors, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Max-Age': '86400' });
    }
    if (req.method !== 'POST') return send(405, 'text/plain', 'method not allowed');
    let body = '';
    let tooBig = false;
    req.on('data', c => {
      if (body.length + c.length > MAX_BODY) { tooBig = true; return; }
      body += c;
    });
    req.on('end', () => {
      if (tooBig) return send(413, 'text/plain', 'too large', cors);
      try {
        const { e, s, d } = JSON.parse(body);
        const list = Array.isArray(e) ? e.slice(0, 5) : [e];
        if (!DEVICES.has(d) || !SOURCE.test(s) || !list.length || !list.every(x => EVENTS.has(x))) throw 0;
        list.forEach(x => add(x, s, d));
      } catch (_) {
        return send(400, 'text/plain', 'bad request', cors);
      }
      load().catch(err => console.error('Не удалось прочитать:', err.message));
      send(204, 'text/plain', '', cors);
    });
    return;
  }

  send(404, 'text/plain', 'not found');
});

// Перед остановкой контейнера дописываем накопленное.
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  server.close();
  safeFlush().finally(() => process.exit(0));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

server.listen(cfg.port, () => console.log('Счётчик запущен, порт ' + cfg.port));
