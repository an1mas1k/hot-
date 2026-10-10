const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const https = require('https');
const { parse: parseUrl } = require('url');

const PORT = process.env.PORT || 3000;
const USERS_FILE = path.join(__dirname, 'users.json');
const POSTS_FILE = path.join(__dirname, 'posts.json');
const DM_FILE = path.join(__dirname, 'dm.json');
const CHANNELS_FILE = path.join(__dirname, 'channels.json');
const CHATS_FILE = path.join(__dirname, 'chats.json');
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
const RESET_FILE = path.join(__dirname, 'password_resets.json');
const HTML_FILE = path.join(__dirname, 'index.html');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (e) {}

const MAX_BODY_SIZE = 30 * 1024 * 1024;
const DEFAULT_BODY_SIZE = 256 * 1024;
const MAX_ATTACH_SIZE = 20 * 1024 * 1024;
const VIDEO_EXT = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/ogg': 'ogv', 'video/x-m4v': 'm4v' };
const VIDEO_MIME = { mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', ogv: 'video/ogg', m4v: 'video/mp4' };
const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const POSTS_PER_WALL = 100;
const FEED_LIMIT = 100;
const DM_HISTORY_LIMIT = 300;
const HANDLE_RE = /^[a-zA-Z0-9_]{3,20}$/;
const IMAGE_DATA_RE = /^data:image\/(png|jpeg|jpg|webp|gif);base64,/i;
const IMAGE_EXT = { png: 'png', jpeg: 'jpg', jpg: 'jpg', webp: 'webp', gif: 'gif' };
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;
const REGISTER_MAX_ATTEMPTS = 12;
const rateBuckets = new Map();
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '240353019911-kqidnu791scvkfq4f93sdoull23eonnk.apps.googleusercontent.com';

const callSignals = {};
const CALL_TYPES = ['offer', 'answer', 'candidate', 'hangup', 'decline', 'busy'];
function pushCallSignal(toUser, signal) {
    const key = toUser.toLowerCase();
    const q = callSignals[key] || (callSignals[key] = []);
    q.push(signal);
    if (q.length > 200) q.splice(0, q.length - 200);
}
function popCallSignals(user) {
    const key = user.toLowerCase();
    const now = Date.now();
    const signals = (callSignals[key] || []).filter(s => now - s.time < 90000);
    delete callSignals[key];
    return signals;
}

function ensureFile(filePath) { if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '[]', 'utf8'); }
[USERS_FILE, POSTS_FILE, DM_FILE, CHANNELS_FILE, CHATS_FILE, SESSIONS_FILE, RESET_FILE].forEach(ensureFile);

function readJSON(fp) {
    let raw = '';
    try { raw = fs.readFileSync(fp, 'utf8'); } catch (e) { return []; }
    try { return JSON.parse(raw || '[]'); }
    catch (e) {
        try { fs.copyFileSync(fp, fp + '.corrupt-' + Date.now()); } catch (e2) {}
        console.error('Повреждён файл ' + path.basename(fp) + ', копия сохранена рядом');
        return [];
    }
}
function writeJSON(fp, data) {
    const tmp = fp + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, fp);
}

function readUsers() { return readJSON(USERS_FILE); }
function saveUsers(u) { writeJSON(USERS_FILE, u); }
function readPosts() { return readJSON(POSTS_FILE); }
function savePosts(p) { writeJSON(POSTS_FILE, p); }
function readDms() { return readJSON(DM_FILE); }
function saveDms(d) { writeJSON(DM_FILE, d); }
function readChannels() { return readJSON(CHANNELS_FILE); }
function saveChannels(c) { writeJSON(CHANNELS_FILE, c); }
function readChats() { return readJSON(CHATS_FILE); }
function saveChats(c) { writeJSON(CHATS_FILE, c); }
function readSessions() { return readJSON(SESSIONS_FILE); }
function saveSessions(s) { writeJSON(SESSIONS_FILE, s); }

function normalizeHandle(raw) { return (raw || '').trim().replace(/^@+/, ''); }
function dmKey(a, b) { return [String(a).toLowerCase(), String(b).toLowerCase()].sort().join('::'); }

/* ========== ВЛОЖЕНИЯ ========== */
function saveImageData(dataUrl) {
    if (typeof dataUrl !== 'string' || !IMAGE_DATA_RE.test(dataUrl)) return null;
    const m = IMAGE_DATA_RE.exec(dataUrl);
    const mime = (m[1] || '').toLowerCase();
    const ext = IMAGE_EXT[mime];
    if (!ext) return null;
    const encoded = dataUrl.slice(m[0].length);
    let buf;
    try { buf = Buffer.from(encoded, 'base64'); } catch (e) { return null; }
    if (!buf.length || buf.length > MAX_IMAGE_SIZE) return null;
    const signatures = {
        png: buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])),
        jpg: buf.length >= 3 && buf.slice(0, 3).equals(Buffer.from([0xff,0xd8,0xff])),
        webp: buf.length >= 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP',
        gif: buf.length >= 6 && (buf.slice(0, 6).toString('ascii') === 'GIF87a' || buf.slice(0, 6).toString('ascii') === 'GIF89a')
    };
    if (!signatures[ext]) return null;
    const name = crypto.randomBytes(16).toString('hex') + '.' + ext;
    try { fs.writeFileSync(path.join(UPLOAD_DIR, name), buf); } catch (e) { return null; }
    return '/uploads/' + name;
}

function isStoredImageUrl(value) {
    return typeof value === 'string' && /^\/uploads\/[a-f0-9]{32}\.(?:png|jpg|webp|gif)$/i.test(value);
}

function processImageInput(value, allowEmpty) {
    if (value === '' && allowEmpty) return '';
    if (typeof value !== 'string') return null;
    if (isStoredImageUrl(value)) return value;
    return saveImageData(value);
}

function rateLimit(req, bucket, maxAttempts, idOverride) {
    const ip = idOverride ? String(idOverride).toLowerCase() : getClientIP(req);
    const now = Date.now();
    const key = bucket + ':' + ip;
    let item = rateBuckets.get(key);
    if (!item || now - item.startedAt >= RATE_WINDOW_MS) {
        item = { startedAt: now, count: 0 };
        rateBuckets.set(key, item);
    }
    item.count++;
    if (item.count > maxAttempts) {
        return Math.max(1, Math.ceil((RATE_WINDOW_MS - (now - item.startedAt)) / 1000));
    }
    if (rateBuckets.size > 2000) {
        for (const [k, v] of rateBuckets) if (now - v.startedAt >= RATE_WINDOW_MS) rateBuckets.delete(k);
    }
    return 0;
}

function saveAttachment(dataUrl, kind, origName) {
    if (typeof dataUrl !== 'string') return null;
    const m = /^data:([^;,]*)[^,]*;base64,/.exec(dataUrl);
    if (!m) return null;
    const mime = (m[1] || '').toLowerCase();
    let ext = '';
    if (kind === 'video') {
        ext = VIDEO_EXT[mime];
        if (!ext) return null;
    } else {
        const em = /\.([a-zA-Z0-9]{1,8})$/.exec(origName || '');
        ext = em ? em[1].toLowerCase() : '';
    }
    const buf = Buffer.from(dataUrl.slice(m[0].length), 'base64');
    if (!buf.length || buf.length > MAX_ATTACH_SIZE) return null;
    if (kind === 'video') {
        const head4 = buf.slice(0, 4);
        const okMagic = (ext === 'webm' && head4.equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])))
            || (ext === 'ogv' && head4.toString('ascii') === 'OggS')
            || (['mp4', 'mov', 'm4v'].includes(ext) && buf.length > 12 && buf.slice(4, 8).toString('ascii') === 'ftyp');
        if (!okMagic) return null;
    }
    const name = crypto.randomBytes(16).toString('hex') + (ext ? '.' + ext : '');
    try { fs.writeFileSync(path.join(UPLOAD_DIR, name), buf); } catch (e) { return null; }
    return { url: '/uploads/' + name, size: buf.length };
}

function serveUpload(req, res, url) {
    const name = path.basename(url.slice('/uploads/'.length));
    if (!/^[a-f0-9]{32}(\.[a-z0-9]{1,8})?$/.test(name)) return sendJSON(res, 404, { error: 'Не найдено' });
    const fp = path.join(UPLOAD_DIR, name);
    fs.stat(fp, (err, st) => {
        if (err || !st.isFile()) return sendJSON(res, 404, { error: 'Не найдено' });
        const ext = path.extname(name).slice(1).toLowerCase();
        const isVideo = !!VIDEO_MIME[ext];
        const isImage = !!IMAGE_MIME[ext];
        const headers = {
            'Content-Type': isVideo ? VIDEO_MIME[ext] : (isImage ? IMAGE_MIME[ext] : 'application/octet-stream'),
            'Accept-Ranges': 'bytes',
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'public, max-age=31536000, immutable'
        };
        if (!isVideo && !isImage) headers['Content-Disposition'] = 'attachment';
        const range = req.headers.range;
        if (range) {
            const r = /bytes=(\d*)-(\d*)/.exec(range);
            let start = r && r[1] ? parseInt(r[1], 10) : 0;
            let end = r && r[2] ? parseInt(r[2], 10) : st.size - 1;
            if (isNaN(start) || isNaN(end) || start > end || start >= st.size) {
                res.writeHead(416, { 'Content-Range': 'bytes */' + st.size });
                return res.end();
            }
            end = Math.min(end, st.size - 1);
            headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + st.size;
            headers['Content-Length'] = end - start + 1;
            res.writeHead(206, headers);
            fs.createReadStream(fp, { start, end }).pipe(res);
        } else {
            headers['Content-Length'] = st.size;
            res.writeHead(200, headers);
            fs.createReadStream(fp).pipe(res);
        }
    });
}

const MSG_COOLDOWN_MS = 500;
const MAX_MESSAGE_LEN = 4000, MAX_POST_LEN = 3000, MAX_COMMENT_LEN = 1000;
const msgLastSent = new Map();
function msgCooldownLeft(username) {
    const wait = MSG_COOLDOWN_MS - (Date.now() - (msgLastSent.get(String(username).toLowerCase()) || 0));
    return wait > 0 ? wait : 0;
}
function msgCooldownMark(username) {
    const now = Date.now();
    msgLastSent.set(String(username).toLowerCase(), now);
    if (msgLastSent.size > 5000) { for (const [k, v] of msgLastSent) if (now - v > 60000) msgLastSent.delete(k); }
}
function cooldownReply(res, waitMs) {
    return sendJSON(res, 429, { error: 'Не так быстро, подожди полсекунды', retryAfterMs: waitMs });
}

/* ========== ОБРЕЗКА ИСТОРИИ ========== */
// Лимиты считаются отдельно для каждой переписки и автора, чтобы одни люди не вытесняли чужую историю.
const DM_PER_CONVERSATION = 2000, SYSTEM_PER_USER = 30, POSTS_PER_AUTHOR = 1000;
function trimDms(dms) {
    if (dms.length < 3000) return dms;
    const seen = new Map(), keep = new Array(dms.length);
    for (let i = dms.length - 1; i >= 0; i--) {
        const m = dms[i];
        const a = String(m.from || '').toLowerCase(), b = String(m.to || '').toLowerCase();
        const key = m.system ? 'sys:' + b : (a < b ? a + '|' + b : b + '|' + a);
        const limit = m.system ? SYSTEM_PER_USER : DM_PER_CONVERSATION;
        const n = (seen.get(key) || 0) + 1;
        seen.set(key, n);
        keep[i] = n <= limit;
    }
    return dms.filter((m, i) => keep[i]);
}
function trimPosts(posts) {
    if (posts.length < 3000) return posts;
    const seen = new Map(), keep = new Array(posts.length);
    for (let i = posts.length - 1; i >= 0; i--) {
        const key = String(posts[i].author || posts[i].username || '').toLowerCase();
        const n = (seen.get(key) || 0) + 1;
        seen.set(key, n);
        keep[i] = n <= POSTS_PER_AUTHOR;
    }
    return posts.filter((p, i) => keep[i]);
}

function makeId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

/* ========== СИСТЕМНЫЙ АККАУНТ HOT ========== */
const SYSTEM_USER = 'HOT';
function isSystemUser(username) {
    if (!username) return false;
    return String(username).toUpperCase() === SYSTEM_USER;
}
const TRUST_PROXY_HOPS = Math.max(0, parseInt(process.env.TRUST_PROXY_HOPS || '1', 10) || 0);
function getClientIP(req) {
    // Левая часть X-Forwarded-For подделывается клиентом. Берём запись, добавленную доверенным прокси
    // (TRUST_PROXY_HOPS = сколько прокси стоит перед сервером, на Render обычно 1).
    let ip = String(req.socket.remoteAddress || '');
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean);
    if (TRUST_PROXY_HOPS > 0 && xff.length) ip = xff[Math.max(0, xff.length - TRUST_PROXY_HOPS)];
    ip = ip.replace(/^::ffff:/, '');
    return net.isIP(ip) ? ip : 'неизвестен';
}
function getClientAgent(req) {
    return String(req.headers['user-agent'] || 'unknown').slice(0, 300);
}
function shortUA(ua) {
    if (/Android/i.test(ua)) return 'Android';
    if (/iPhone|iPad|iPod/i.test(ua)) return 'iPhone / iPad';
    if (/Windows/i.test(ua)) return 'Windows';
    if (/Macintosh/i.test(ua)) return 'macOS';
    if (/Linux/i.test(ua)) return 'Linux';
    return 'Неизвестное устройство';
}
function deviceKey(ip, ua) { return shortUA(ua) + '|' + ip; }
function sendSecurityNotice(toUsername, ip, ua) {
    var dms = readDms();
    var msg = {
        id: makeId(),
        from: SYSTEM_USER,
        to: toUsername,
        text: 'Новый вход в аккаунт\n\nУстройство: ' + shortUA(ua) + '\nIP: ' + ip + '\nВремя: {{time:' + new Date().toISOString() + '}}\n\nЕсли это не ты, смени пароль.',
        system: true,
        delivered: true,
        read: false,
        createdAt: new Date().toISOString()
    };
    dms.push(msg);
    saveDms(trimDms(dms));
}

const failBuckets = new Map();
function loginLocked(key) {
    const it = failBuckets.get(key);
    if (!it) return false;
    if (Date.now() - it.startedAt >= RATE_WINDOW_MS) { failBuckets.delete(key); return false; }
    return it.count >= 10;
}
function noteLoginFail(key) {
    const it = failBuckets.get(key);
    if (!it || Date.now() - it.startedAt >= RATE_WINDOW_MS) failBuckets.set(key, { startedAt: Date.now(), count: 1 });
    else it.count++;
    if (failBuckets.size > 5000) { const now = Date.now(); for (const [k, v] of failBuckets) if (now - v.startedAt >= RATE_WINDOW_MS) failBuckets.delete(k); }
}
function safeEqualHex(a, b) {
    const x = Buffer.from(String(a), 'utf8'), y = Buffer.from(String(b), 'utf8');
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function hashPassword(password, salt) {
    return crypto.scryptSync(password, salt, 64).toString('hex');
}
function generateSalt() { return crypto.randomBytes(16).toString('hex'); }
function generateToken() { return crypto.randomBytes(32).toString('hex'); }

function createSession(username, ip, ua) {
    const sessions = readSessions().filter(s => Date.now() - s.createdAt < SESSION_TTL);
    const token = generateToken();
    sessions.push({ token, username, ip: ip || '', ua: ua || '', createdAt: Date.now() });
    saveSessions(sessions);
    return token;
}
function getSessionUser(token) {
    if (!token) return null;
    const sessions = readSessions();
    const s = sessions.find(x => x.token === token);
    if (!s) return null;
    if (Date.now() - s.createdAt > SESSION_TTL) return null;
    const users = readUsers();
    return users.find(u => u.username.toLowerCase() === s.username.toLowerCase()) || null;
}
function destroySession(token) {
    if (!token) return;
    const sessions = readSessions().filter(s => s.token !== token);
    saveSessions(sessions);
}
function destroyUserSessions(username) {
    const sessions = readSessions().filter(s => s.username.toLowerCase() !== username.toLowerCase());
    saveSessions(sessions);
}

function sendFail(res, e) {
    if (e && e.badRequest) return sendJSON(res, e.status || 400, { error: e.message });
    if (e instanceof TypeError || e instanceof RangeError) {
        console.error('Некорректные данные в запросе:', e.message);
        return sendJSON(res, 400, { error: 'Некорректные данные запроса' });
    }
    console.error(e);
    return sendJSON(res, 500, { error: 'Ошибка сервера' });
}
function badRequest(message, status) { const e = new Error(message); e.badRequest = true; e.status = status || 400; return e; }
function sendJSON(res, status, data) {
    res.writeHead(status, {
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS'
    });
    res.end(JSON.stringify(data));
}
function readBody(req, maxBytes) {
    const limit = maxBytes || DEFAULT_BODY_SIZE;
    return new Promise(function (resolve, reject) {
        const chunks = [];
        let size = 0, dead = false;
        req.on('data', function (chunk) {
            if (dead) return;
            size += chunk.length;
            if (size > limit) { dead = true; reject(badRequest('Слишком большой запрос', 413)); req.destroy(); return; }
            chunks.push(chunk);
        });
        req.on('end', function () {
            if (dead) return;
            try {
                const body = Buffer.concat(chunks).toString('utf8');
                const v = body ? JSON.parse(body) : {};
                if (v === null || typeof v !== 'object' || Array.isArray(v)) return reject(badRequest('Ожидался JSON-объект'));
                resolve(v);
            } catch (e) { reject(badRequest('Некорректный JSON')); }
        });
        req.on('error', function (e) { if (!dead) reject(e); });
    });
}
function getToken(req) {
    const auth = req.headers['authorization'] || '';
    if (auth.startsWith('Bearer ')) return auth.slice(7);
    return null;
}
function authUser(req) {
    return getSessionUser(getToken(req));
}

/* ========== HOT ADMIN — DEV ONLY ========== */
function ensureDevFounder(user){
    if(!user) return user;
    if(String(user.username||'').toLowerCase()==='dev') user.adminRole='founder';
    return user;
}
function isDevUser(user){ return !!user && String(user.username||'').toLowerCase()==='dev'; }
function adminRoleLabel(role){
    if(role==='founder') return 'Основатель';
    if(role==='admin') return 'Администратор';
    if(role==='moderator') return 'Модератор';
    return '';
}
function adminDisplayName(user){
    if(!user) return '';
    ensureDevFounder(user);
    const role=adminRoleLabel(user.adminRole);
    return role ? role+' | '+(user.username||'') : (user.username||'');
}
function getStaffRole(user){
    if(!user) return null;
    ensureDevFounder(user);
    return user.adminRole || null;
}
function requireStaff(req,res){
    const me=authUser(req);
    const role=getStaffRole(me);
    if(!me || !role){ sendJSON(res,403,{error:'Админ меню доступно только сотрудникам Hot'}); return null; }
    return me;
}
function requireDev(req,res){
    const me=authUser(req);
    if(!me || !isDevUser(me)){ sendJSON(res,403,{error:'Только Основатель | Dev'}); return null; }
    ensureDevFounder(me); return me;
}
function staffCan(me, action){
    const role=getStaffRole(me);
    if(role==='founder') return true;
    if(role==='admin') return ['mute','unmute','send_channel','send_chat'].indexOf(action)!==-1;
    if(role==='moderator') return ['mute','unmute'].indexOf(action)!==-1;
    return false;
}
async function handleAdminPanel(req,res){
    const me=requireStaff(req,res); if(!me)return;
    const myRole=getStaffRole(me);
    const users=readUsers().map(function(u){ensureDevFounder(u);return {username:u.username,email:u.email||'',avatar:u.avatar||'',adminRole:u.adminRole||null,displayName:adminDisplayName(u),muted:!!u.muted,banned:!!u.banned,lastSeen:u.lastSeen||''};});
    const channels=readChannels().map(function(c){return {id:c.id,username:c.username,name:c.name,description:c.description||'',owner:c.owner,members:Array.isArray(c.members)?c.members.length:0,memberList:Array.isArray(c.members)?c.members.slice(0,100):[],messages:Array.isArray(c.messages)?c.messages.length:0,createdAt:c.createdAt||''};});
    const chats=readChats().map(function(c){return {id:c.id,name:c.name,owner:c.owner,members:Array.isArray(c.members)?c.members:[],memberCount:Array.isArray(c.members)?c.members.length:0,messages:Array.isArray(c.messages)?c.messages.length:0,createdAt:c.createdAt||''};});
    sendJSON(res,200,{role:myRole,displayName:adminDisplayName(me),users:users,channels:channels,chats:chats,permissions:{mute:myRole!=='user',write:myRole==='founder'||myRole==='admin',manage:myRole==='founder',roles:myRole==='founder'}});
}
async function handleAdminAction(req,res){
    const me=requireStaff(req,res); if(!me)return;
    try{
        const data=await readBody(req); const action=String(data.action||'');
        if(!staffCan(me,action)) return sendJSON(res,403,{error:'У этой роли нет доступа к этому действию'});
        const username=String(data.username||'').trim();
        if(action==='delete_channel' || action==='send_channel'){
            const key=String(data.channel||'').trim().toLowerCase();
            const channels=readChannels();
            const idx=channels.findIndex(function(c){return String(c.username||'').toLowerCase()===key || String(c.id||'')===String(data.channel||'');});
            if(idx<0)return sendJSON(res,404,{error:'Канал не найден'});
            const c=channels[idx];
            if(action==='delete_channel'){
                channels.splice(idx,1); saveChannels(channels); return sendJSON(res,200,{ok:true});
            }
            const text=String(data.text||'').trim(); if(!text)return sendJSON(res,400,{error:'Введите сообщение'});
            if(text.length>5000)return sendJSON(res,400,{error:'Сообщение слишком длинное'});
            const asUser=String(data.asUser||'').trim();
            let from='Основатель | Dev';
            if(asUser){
                const au=readUsers().find(function(u){return !u.system && String(u.username||'').toLowerCase()===asUser.toLowerCase();});
                if(!au)return sendJSON(res,404,{error:'Пользователь для отправки не найден'});
                from=adminDisplayName(au);
            }
            if(!Array.isArray(c.messages))c.messages=[];
            c.messages.push({id:makeId(),from:from,channelUsername:c.username,channelAvatar:c.avatar||'',text:text,file:null,reactions:{like:[],fire:[],demon:[]},createdAt:new Date().toISOString()});
            if(c.messages.length>300)c.messages=c.messages.slice(-300);
            saveChannels(channels); return sendJSON(res,200,{ok:true});
        }
        if(action==='delete_chat' || action==='send_chat'){
            const key=String(data.chat||'').trim();
            const chats=readChats();
            const idx=chats.findIndex(function(c){return String(c.id||'')===key;});
            if(idx<0)return sendJSON(res,404,{error:'Чат не найден'});
            const c=chats[idx];
            if(action==='delete_chat'){
                chats.splice(idx,1); saveChats(chats); return sendJSON(res,200,{ok:true});
            }
            const text=String(data.text||'').trim(); if(!text)return sendJSON(res,400,{error:'Введите сообщение'});
            if(text.length>5000)return sendJSON(res,400,{error:'Сообщение слишком длинное'});
            const asUser=String(data.asUser||'').trim();
            let from='Основатель | Dev';
            if(asUser){
                const au=readUsers().find(function(u){return !u.system && String(u.username||'').toLowerCase()===asUser.toLowerCase();});
                if(!au)return sendJSON(res,404,{error:'Пользователь для отправки не найден'});
                from=adminDisplayName(au);
            }
            if(!Array.isArray(c.messages))c.messages=[];
            c.messages.push({id:makeId(),from:from,text:text,file:null,read:[],createdAt:new Date().toISOString()});
            if(c.messages.length>300)c.messages=c.messages.slice(-300);
            saveChats(chats); return sendJSON(res,200,{ok:true});
        }
        if(!username)return sendJSON(res,400,{error:'Не указан пользователь'});
        const users=readUsers(); const idx=users.findIndex(function(u){return u.username.toLowerCase()===username.toLowerCase();});
        if(idx<0)return sendJSON(res,404,{error:'Пользователь не найден'});
        const u=users[idx]; ensureDevFounder(u);
        if(isDevUser(u)) return sendJSON(res,403,{error:'Аккаунт Dev защищён'});
        if(action==='mute')u.muted=!u.muted;
        else if(action==='unmute')u.muted=false;
        else if(action==='kick')destroyUserSessions(u.username);
        else if(action==='ban'){u.banned=true;destroyUserSessions(u.username);}
        else if(action==='unban')u.banned=false;
        else if(action==='set_role'){
            const role=String(data.role||''); u.adminRole=(role==='admin'||role==='moderator')?role:null;
        } else if(action==='delete'){users.splice(idx,1);destroyUserSessions(username);saveUsers(users);return sendJSON(res,200,{ok:true});}
        else return sendJSON(res,400,{error:'Неизвестное действие'});
        saveUsers(users); sendJSON(res,200,{ok:true});
    }catch(e){sendFail(res,e);}
}

/* ========== AUTH ========== */

async function handleRegister(req, res) {
    try {
        const retry = rateLimit(req, 'register', REGISTER_MAX_ATTEMPTS);
        if (retry) return sendJSON(res, 429, { error: 'Слишком много попыток регистрации', retryAfter: retry });
        const data = await readBody(req);
        const username = (data.username || '').trim();
        const email = (data.email || '').trim().replace(/[\s\u00A0\u200B\uFEFF]/g, '');
        const password = data.password || '';
        if (!HANDLE_RE.test(username)) return sendJSON(res, 400, { error: 'Ник: 3-20 символов, только латиница, цифры и _' });
        if (isSystemUser(username)) return sendJSON(res, 400, { error: 'Это имя зарезервировано' });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJSON(res, 400, { error: 'Некорректный email' });
        if (data.acceptedPrivacy !== true) return sendJSON(res, 400, { error: 'Нужно принять политику конфиденциальности' });
        if (password.length < 6) return sendJSON(res, 400, { error: 'Пароль — минимум 6 символов' });
        if (password.length > 200) return sendJSON(res, 400, { error: 'Пароль слишком длинный' });
        const users = readUsers();
        if (users.some(u => u.username.toLowerCase() === username.toLowerCase())) return sendJSON(res, 409, { error: 'Такое имя уже занято' });
        if (users.some(u => u.email.toLowerCase() === email.toLowerCase())) return sendJSON(res, 409, { error: 'Эта почта уже зарегистрирована' });
        const salt = generateSalt();
        const newUser = {
            username, email, salt,
            passwordHash: hashPassword(password, salt),
            avatar: '', handle: '', theme: 'dark', wallpaper: '', birthday: '',
            friends: [], incomingRequests: [], blocked: [],
            privacyAcceptedAt: new Date().toISOString(), privacyVersion: '2026-10-04',
            devices: [deviceKey(getClientIP(req), getClientAgent(req))],
            createdAt: new Date().toISOString(), lastSeen: new Date().toISOString(), adminRole: username.toLowerCase() === 'dev' ? 'founder' : null
        };
        users.push(newUser);
        saveUsers(users);
        const token = createSession(newUser.username, getClientIP(req), getClientAgent(req));
        sendJSON(res, 201, {
            token,
            user: {
                username: newUser.username, email: newUser.email, avatar: '', handle: '',
                theme: 'dark', wallpaper: '', birthday: '',
                friends: [], incomingRequests: [], blocked: [], adminRole: newUser.adminRole || null, displayName: adminDisplayName(newUser)
            }
        });
    } catch (e) { sendFail(res, e); }
}

async function handleLogin(req, res) {
    try {
        const retry = rateLimit(req, 'login', LOGIN_MAX_ATTEMPTS);
        if (retry) return sendJSON(res, 429, { error: 'Слишком много попыток входа', retryAfter: retry });
        const data = await readBody(req);
        const login = (data.login || '').trim().toLowerCase();
        const password = data.password || '';
        if (!login || !password) return sendJSON(res, 400, { error: 'Введите логин и пароль' });
        const users = readUsers();
        if (password.length > 200) return sendJSON(res, 400, { error: 'Пароль слишком длинный' });
        if (loginLocked(login)) return sendJSON(res, 429, { error: 'Слишком много неверных попыток для этого аккаунта, подожди 10 минут' });
        const user = users.find(u => u.username.toLowerCase() === login || u.email.toLowerCase() === login);
        ensureDevFounder(user);
        if (!user || !user.passwordHash) {
            hashPassword(password, 'dummy-salt-for-timing');
            noteLoginFail(login);
            return sendJSON(res, 401, { error: 'Неверный логин или пароль' });
        }
        if (user.system) return sendJSON(res, 403, { error: 'Служебный аккаунт' });
        if (!safeEqualHex(hashPassword(password, user.salt), user.passwordHash)) {
            noteLoginFail(login);
            return sendJSON(res, 401, { error: 'Неверный логин или пароль' });
        }
        failBuckets.delete(login);
        user.lastSeen = new Date().toISOString();
        const currentIP = getClientIP(req);
        const currentUA = getClientAgent(req);
        // HOT пишет только при входе с нового устройства или адреса. У старых аккаунтов список заводится молча.
        const dKey = deviceKey(currentIP, currentUA);
        const known = Array.isArray(user.devices) ? user.devices : null;
        const isNewDevice = known !== null && !known.includes(dKey);
        user.devices = (known || []).filter(k => k !== dKey).concat(dKey).slice(-20);
        saveUsers(users);
        const token = createSession(user.username, currentIP, currentUA);
        if (isNewDevice) { try { sendSecurityNotice(user.username, currentIP, currentUA); } catch (e) { console.error('HOT security notice error:', e); } }

        sendJSON(res, 200, {
            token,
            user: {
                username: user.username, email: user.email, avatar: user.avatar || '',
                handle: user.handle || '', theme: user.theme || 'dark',
                wallpaper: user.wallpaper || '', birthday: user.birthday || '',
                friends: user.friends || [], incomingRequests: user.incomingRequests || [],
                blocked: user.blocked || [], adminRole: ensureDevFounder(user).adminRole || null, displayName: adminDisplayName(user)
            }
        });
    } catch (e) { sendFail(res, e); }
}

function httpsJson(options, body) {
    return new Promise(function (resolve, reject) {
        const req = https.request(options, function (response) {
            let data = '';
            response.setEncoding('utf8');
            response.on('data', function (chunk) { data += chunk; });
            response.on('end', function () {
                let json = null;
                try { json = JSON.parse(data || '{}'); } catch (e) {}
                if (response.statusCode < 200 || response.statusCode >= 300) {
                    const msg = json && (json.error_description || json.error || json.message);
                    return reject(new Error(msg || ('HTTP ' + response.statusCode)));
                }
                resolve(json || {});
            });
        });
        req.setTimeout(10000, function () { req.destroy(new Error('OAuth request timeout')); });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

function oauthUsername(name, email, users) {
    let base = String(name || '').trim().toLowerCase()
        .replace(/[^a-z0-9_]+/gi, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 16);
    if (!base) {
        base = String(email || 'user').split('@')[0]
            .toLowerCase().replace(/[^a-z0-9_]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 16) || 'user';
    }
    if (base.length < 3) base = (base + '_user').slice(0, 20);
    let candidate = base;
    let n = 1;
    while (users.some(function (u) { return String(u.username || '').toLowerCase() === candidate.toLowerCase(); })) {
        const suffix = '_' + n++;
        candidate = base.slice(0, Math.max(3, 20 - suffix.length)) + suffix;
    }
    return candidate;
}

function publicUser(user) {
    return {
        username: user.username, email: user.email, avatar: user.avatar || '',
        handle: user.handle || '', theme: user.theme || 'dark',
        wallpaper: user.wallpaper || '', birthday: user.birthday || '',
        friends: user.friends || [], incomingRequests: user.incomingRequests || [],
        blocked: user.blocked || []
    };
}

function loginOrCreateSocialUser(provider, providerId, profile, ip, ua) {
    const users = readUsers();
    const id = String(providerId || '').trim();
    const email = String(profile.email || '').trim().toLowerCase();
    if (!id) throw new Error('OAuth provider did not return a user id');
    let user = users.find(function (u) { return String(u[provider + 'Id'] || '') === id; });
    if (!user && email) {
        const emailMatch = users.find(function (u) { return String(u.email || '').toLowerCase() === email; });
        if (emailMatch) {
            if (emailMatch.passwordHash) throw new Error('Google-аккаунт не привязан к этому профилю');
            user = emailMatch;
        }
    }

    if (!user) {
        user = {
            username: oauthUsername(profile.name || profile.firstName || 'user', email, users),
            email: email || (provider + '_' + id + '@oauth.local'),
            salt: '', passwordHash: '',
            avatar: profile.avatar || '', handle: '', theme: 'dark', wallpaper: '', birthday: '',
            friends: [], incomingRequests: [], blocked: [],
            createdAt: new Date().toISOString(), lastSeen: new Date().toISOString()
        };
        user[provider + 'Id'] = id;
        users.push(user);
    } else {
        user[provider + 'Id'] = id;
        if (!user.avatar && profile.avatar) user.avatar = profile.avatar;
        if (profile.email && !user.email) user.email = profile.email;
        user.lastSeen = new Date().toISOString();
    }
    saveUsers(users);
    const token = createSession(user.username, ip, ua);
    return { token, user: publicUser(user) };
}

async function handleGoogleAuth(req, res) {
    try {
        const data = await readBody(req);
        const credential = String(data.credential || '').trim();
        if (!credential) return sendJSON(res, 400, { error: 'Google не передал ID token' });
        if (!GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID.indexOf('PASTE_') === 0) {
            return sendJSON(res, 503, { error: 'На сервере не настроен GOOGLE_CLIENT_ID' });
        }

        const info = await httpsJson({
            hostname: 'oauth2.googleapis.com',
            path: '/tokeninfo?id_token=' + encodeURIComponent(credential),
            method: 'GET',
            headers: { 'Accept': 'application/json' }
        });
        if (info.iss !== 'https://accounts.google.com' && info.iss !== 'accounts.google.com') {
            return sendJSON(res, 401, { error: 'Недействительный Google ID token' });
        }
        if (String(info.aud || '') !== GOOGLE_CLIENT_ID) {
            return sendJSON(res, 401, { error: 'Google Client ID не совпадает' });
        }
        if (String(info.email_verified) !== 'true') {
            return sendJSON(res, 401, { error: 'Google email не подтверждён' });
        }
        const currentIP = getClientIP(req);
        const currentUA = getClientAgent(req);
        const result = loginOrCreateSocialUser('google', info.sub, {
            name: info.name || info.email,
            email: info.email,
            avatar: info.picture || ''
        }, currentIP, currentUA);
        sendJSON(res, 200, result);
    } catch (e) {
        sendJSON(res, 401, { error: 'Ошибка авторизации Google: ' + (e.message || 'неизвестная ошибка') });
    }
}

function handleSession(req, res) {
    const token = getToken(req);
    const user = getSessionUser(token);
    if (!user) return sendJSON(res, 401, { error: 'Сессия истекла' });
    sendJSON(res, 200, {
        token,
        user: {
            username: user.username, email: user.email, avatar: user.avatar || '',
            handle: user.handle || '', theme: user.theme || 'dark',
            wallpaper: user.wallpaper || '', birthday: user.birthday || '',
            friends: user.friends || [], incomingRequests: user.incomingRequests || [],
            blocked: user.blocked || [], adminRole: ensureDevFounder(user).adminRole || null, displayName: adminDisplayName(user)
        }
    });
}

function handleLogout(req, res) {
    const token = getToken(req);
    destroySession(token);
    sendJSON(res, 200, { ok: true });
}

/* ========== ВОССТАНОВЛЕНИЕ ПАРОЛЯ (EmailJS) ========== */
// Коды хранятся в password_resets.json рядом с users.json. Хранится не сам код, а его scrypt-хеш с отдельным salt.
// Счётчик попыток тоже лежит в файле, поэтому перезапуск сервера не даёт «обнулить» попытки.
const EMAILJS_SERVICE_ID = process.env.EMAILJS_SERVICE_ID || 'service_hot_gmail';
const EMAILJS_TEMPLATE_ID = process.env.EMAILJS_TEMPLATE_ID || 'template_ckmu3u4';
const RESET_CODE_TTL_MS = 10 * 60 * 1000;
const RESET_CODE_MAX_ATTEMPTS = 5;
const RESET_RESEND_COOLDOWN_MS = 60 * 1000;
const RESET_REQUEST_IP_MAX = 6;
const RESET_REQUEST_EMAIL_MAX = 3;
const RESET_CONFIRM_IP_MAX = 15;
const resetLastRequest = new Map();

function readResets() { const v = readJSON(RESET_FILE); return Array.isArray(v) ? v : []; }
function saveResets(list) { writeJSON(RESET_FILE, list); }
function aliveResets(list) { const now = Date.now(); return list.filter(function (r) { return r && r.expiresAt > now; }); }
function normalizeResetEmail(raw) {
    if (typeof raw !== 'string') return '';
    const email = raw.trim().replace(/[\s\u00A0\u200B\uFEFF]/g, '').toLowerCase();
    if (!email || email.length > 254) return '';
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}
function generateResetCode() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); }
function hashResetCode(code, email, salt) { return hashPassword(code + '|' + email, salt); }

function sendResetEmail(email, code) {
    return new Promise(function (resolve, reject) {
        const publicKey = process.env.EMAILJS_PUBLIC_KEY;
        if (!publicKey) return reject(new Error('EMAILJS_PUBLIC_KEY не задан'));
        const payload = {
            service_id: EMAILJS_SERVICE_ID,
            template_id: EMAILJS_TEMPLATE_ID,
            user_id: publicKey,
            template_params: { email: email, passcode: code }
        };
        // Необязательно: если в EmailJS включена защита Private Key, добавь EMAILJS_PRIVATE_KEY в Railway Variables.
        if (process.env.EMAILJS_PRIVATE_KEY) payload.accessToken = process.env.EMAILJS_PRIVATE_KEY;
        const body = JSON.stringify(payload);
        const r = https.request({
            hostname: 'api.emailjs.com',
            path: '/api/v1.0/email/send',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, function (response) {
            let text = '';
            response.setEncoding('utf8');
            response.on('data', function (chunk) { if (text.length < 500) text += chunk; });
            response.on('end', function () {
                if (response.statusCode >= 200 && response.statusCode < 300) return resolve();
                reject(new Error('EmailJS ответил HTTP ' + response.statusCode + ': ' + text.slice(0, 200)));
            });
        });
        r.setTimeout(15000, function () { r.destroy(new Error('EmailJS: превышено время ожидания')); });
        r.on('error', reject);
        r.write(body);
        r.end();
    });
}

async function handlePasswordResetRequest(req, res) {
    try {
        const retryIp = rateLimit(req, 'reset-request', RESET_REQUEST_IP_MAX);
        if (retryIp) return sendJSON(res, 429, { error: 'Слишком много запросов. Попробуй позже', retryAfter: retryIp });
        const data = await readBody(req, 4096);
        const email = normalizeResetEmail(data.email);
        if (!email) return sendJSON(res, 400, { error: 'Введите корректную почту' });
        if (!process.env.EMAILJS_PUBLIC_KEY) {
            console.error('Восстановление пароля: не задана переменная EMAILJS_PUBLIC_KEY');
            return sendJSON(res, 503, { error: 'Восстановление пароля временно недоступно' });
        }
        // Пауза и лимит считаются по адресу почты независимо от того, есть ли такой аккаунт, чтобы ответы ничего не выдавали.
        const now = Date.now();
        const last = resetLastRequest.get(email) || 0;
        if (now - last < RESET_RESEND_COOLDOWN_MS) {
            const wait = Math.ceil((RESET_RESEND_COOLDOWN_MS - (now - last)) / 1000);
            return sendJSON(res, 429, { error: 'Код уже отправлен. Повторить можно через ' + wait + ' сек.', retryAfter: wait });
        }
        const retryEmail = rateLimit(req, 'reset-email', RESET_REQUEST_EMAIL_MAX, email);
        if (retryEmail) return sendJSON(res, 429, { error: 'Слишком много запросов для этой почты. Попробуй позже', retryAfter: retryEmail });
        resetLastRequest.set(email, now);
        if (resetLastRequest.size > 5000) {
            for (const [k, t] of resetLastRequest) if (now - t >= RESET_RESEND_COOLDOWN_MS) resetLastRequest.delete(k);
        }

        const user = readUsers().find(function (u) {
            return !u.system && u.passwordHash && String(u.email || '').toLowerCase() === email;
        });
        if (user) {
            const code = generateResetCode();
            const salt = generateSalt();
            const record = {
                email: email, username: user.username, salt: salt,
                codeHash: hashResetCode(code, email, salt),
                attempts: 0, createdAt: now, expiresAt: now + RESET_CODE_TTL_MS
            };
            const list = aliveResets(readResets()).filter(function (r) { return r.email !== email; });
            list.push(record);
            saveResets(list);
            // Письмо уходит в фоне, чтобы время ответа не показывало, есть ли такая почта в Hot.
            sendResetEmail(email, code).catch(function (err) {
                console.error('Восстановление пароля: письмо не отправлено —', err && err.message ? err.message : 'неизвестная ошибка');
                try { saveResets(readResets().filter(function (r) { return r.codeHash !== record.codeHash; })); } catch (e) {}
            });
        } else {
            hashResetCode('000000', email, 'dummy-salt-for-timing');
        }
        sendJSON(res, 200, {
            ok: true,
            expiresInSec: Math.round(RESET_CODE_TTL_MS / 1000),
            cooldownSec: Math.round(RESET_RESEND_COOLDOWN_MS / 1000),
            message: 'Если эта почта зарегистрирована в Hot, мы отправили на неё код'
        });
    } catch (e) { sendFail(res, e); }
}

async function handlePasswordResetConfirm(req, res) {
    try {
        const retryIp = rateLimit(req, 'reset-confirm', RESET_CONFIRM_IP_MAX);
        if (retryIp) return sendJSON(res, 429, { error: 'Слишком много попыток. Попробуй позже', retryAfter: retryIp });
        const data = await readBody(req, 4096);
        const email = normalizeResetEmail(data.email);
        const code = typeof data.code === 'string' ? data.code.trim() : '';
        const password = typeof data.password === 'string' ? data.password : '';
        if (!email) return sendJSON(res, 400, { error: 'Введите корректную почту' });
        if (!/^\d{6}$/.test(code)) return sendJSON(res, 400, { error: 'Код состоит из 6 цифр' });
        if (password.length < 6) return sendJSON(res, 400, { error: 'Пароль — минимум 6 символов' });
        if (password.length > 200) return sendJSON(res, 400, { error: 'Пароль слишком длинный' });

        const BAD_CODE = 'Неверный или просроченный код. Запроси новый код';
        const all = readResets();
        const list = aliveResets(all);
        const rec = list.find(function (r) { return r.email === email; });
        if (!rec) {
            hashResetCode(code, email, 'dummy-salt-for-timing');
            if (list.length !== all.length) saveResets(list);
            return sendJSON(res, 400, { error: BAD_CODE });
        }
        if (!safeEqualHex(hashResetCode(code, email, rec.salt), rec.codeHash)) {
            rec.attempts = (rec.attempts || 0) + 1;
            const next = rec.attempts >= RESET_CODE_MAX_ATTEMPTS ? list.filter(function (r) { return r !== rec; }) : list;
            saveResets(next);
            return sendJSON(res, 400, { error: BAD_CODE });
        }

        // Код верный: он больше не нужен ни при каком исходе (одноразовый).
        const rest = list.filter(function (r) { return r.email !== email; });
        const users = readUsers();
        const user = users.find(function (u) {
            return String(u.username || '').toLowerCase() === String(rec.username || '').toLowerCase()
                && String(u.email || '').toLowerCase() === email && !u.system && u.passwordHash;
        });
        if (!user) { saveResets(rest); return sendJSON(res, 400, { error: BAD_CODE }); }
        user.salt = generateSalt();
        user.passwordHash = hashPassword(password, user.salt);
        saveUsers(users);
        saveResets(rest);
        destroyUserSessions(user.username);
        failBuckets.delete(String(user.username).toLowerCase());
        failBuckets.delete(email);
        try {
            const dms = readDms();
            dms.push({
                id: makeId(), from: SYSTEM_USER, to: user.username,
                text: 'Пароль изменён\n\nПароль от аккаунта был изменён через восстановление по почте. Все старые сессии завершены.\nВремя: {{time:' + new Date().toISOString() + '}}\n\nЕсли это был не ты, срочно сообщи администратору Hot.',
                system: true, delivered: true, read: false, createdAt: new Date().toISOString()
            });
            saveDms(trimDms(dms));
        } catch (e) { console.error('HOT уведомление о смене пароля не записано'); }
        sendJSON(res, 200, { ok: true, message: 'Пароль изменён. Теперь войди с новым паролем' });
    } catch (e) { sendFail(res, e); }
}

/* ========== HEARTBEAT / STATUS ========== */

async function handleHeartbeat(req, res) {
    try {
        const me = authUser(req);
        if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
        const users = readUsers();
        const user = users.find(u => u.username.toLowerCase() === me.username.toLowerCase());
        if (user) {
            user.lastSeen = new Date().toISOString();
            saveUsers(users);
            const dms = readDms();
            let changed = false;
            dms.forEach(m => { if (m.to && m.to.toLowerCase() === me.username.toLowerCase() && !m.delivered) { m.delivered = true; changed = true; } });
            if (changed) saveDms(dms);
        }
        sendJSON(res, 200, { ok: true });
    } catch (e) { sendFail(res, e); }
}
function handleUserStatus(req, res, query) {
    const me = authUser(req);
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    const target = (query.username || '').trim().toLowerCase();
    const u = readUsers().find(x => x.username.toLowerCase() === target);
    if (!u) return sendJSON(res, 404, { error: 'User not found' });
    sendJSON(res, 200, { lastSeen: u.lastSeen || u.createdAt });
}

/* ========== CALLS ========== */

async function handleCallSignalSend(req, res) {
    try {
        const me = authUser(req);
        if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
        const data = await readBody(req);
        const { to, type, sdp, candidate } = data;
        const from = me.username;
        if (!to || !type) return sendJSON(res, 400, { error: 'Missing call params' });
        if (typeof to !== 'string' || !CALL_TYPES.includes(type)) return sendJSON(res, 400, { error: 'Некорректный сигнал' });
        if (sdp !== undefined && (typeof sdp !== 'string' || sdp.length > 80000)) return sendJSON(res, 400, { error: 'Некорректный сигнал' });
        if (candidate !== undefined && JSON.stringify(candidate).length > 3000) return sendJSON(res, 400, { error: 'Некорректный сигнал' });
        const retry = rateLimit(req, 'callsig', 800, me.username);
        if (retry) return sendJSON(res, 429, { error: 'Слишком много запросов', retryAfter: retry });
        const users = readUsers();
        const fromU = users.find(u => u.username.toLowerCase() === String(from).toLowerCase());
        const toU = users.find(u => u.username.toLowerCase() === String(to).toLowerCase());
        if (!fromU || !toU) return sendJSON(res, 404, { error: 'Пользователь не найден' });
        if (toU.system) return sendJSON(res, 403, { error: 'Служебный аккаунт' });
        if ((fromU.blocked || []).some(b => b.toLowerCase() === toU.username.toLowerCase())) return sendJSON(res, 403, { error: 'Вы заблокировали этого пользователя' });
        if ((toU.blocked || []).some(b => b.toLowerCase() === fromU.username.toLowerCase())) return sendJSON(res, 403, { error: 'Пользователь заблокировал вас' });
        pushCallSignal(toU.username, { from, to: toU.username, type, sdp, candidate, time: Date.now() });
        sendJSON(res, 200, { ok: true });
    } catch (e) { sendFail(res, e); }
}
function handleCallSignalPoll(req, res, query) {
    const me = authUser(req);
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    sendJSON(res, 200, { signals: popCallSignals(me.username) });
}

async function handleCallLog(req, res) {
    try {
        const me = authUser(req);
        if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
        const data = await readBody(req);
        const from = me.username;
        const to = (data.to || '').trim();
        const type = (data.type || '').trim();
        const duration = parseInt(data.duration || 0, 10) || 0;
        if (!to || !type) return sendJSON(res, 400, { error: 'Недостаточно данных' });
        if (!['outgoing', 'incoming', 'missed', 'cancelled', 'declined'].includes(type)) return sendJSON(res, 400, { error: 'Неизвестный тип звонка' });
        const allUsers = readUsers();
        const fromU = allUsers.find(u => u.username.toLowerCase() === from.toLowerCase());
        const toU = allUsers.find(u => u.username.toLowerCase() === to.toLowerCase());
        if (!fromU || !toU) return sendJSON(res, 404, { error: 'Пользователь не найден' });
        if (toU.system) return sendJSON(res, 403, { error: 'Служебный аккаунт' });
        if ((fromU.blocked || []).some(b => b.toLowerCase() === toU.username.toLowerCase()) || (toU.blocked || []).some(b => b.toLowerCase() === fromU.username.toLowerCase())) return sendJSON(res, 403, { error: 'Звонок невозможен: блокировка' });
        const msg = { id: makeId(), from, to: toU.username, type: 'call', callType: type, duration: Math.min(Math.max(duration, 0), 86400), delivered: true, read: true, createdAt: new Date().toISOString() };
        const dms = readDms();
        dms.push(msg);
        saveDms(trimDms(dms));
        sendJSON(res, 201, { message: msg });
    } catch (e) { sendFail(res, e); }
}

/* ========== BLOCK ========== */

async function handleBlockToggle(req, res) {
    try {
        const me = authUser(req);
        if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
        const data = await readBody(req);
        const target = (data.target || '').trim();
        if (!target) return sendJSON(res, 400, { error: 'Недостаточно данных' });
        if (me.username.toLowerCase() === target.toLowerCase()) return sendJSON(res, 400, { error: 'Нельзя заблокировать себя' });
        const users = readUsers();
        const meUser = users.find(u => u.username.toLowerCase() === me.username.toLowerCase());
        const targetUser = users.find(u => u.username.toLowerCase() === target.toLowerCase());
        if (!meUser || !targetUser) return sendJSON(res, 404, { error: 'Пользователь не найден' });
        if (targetUser.system) return sendJSON(res, 403, { error: 'Служебный аккаунт' });
        if (!Array.isArray(meUser.blocked)) meUser.blocked = [];
        const lowerTarget = targetUser.username.toLowerCase();
        const idx = meUser.blocked.findIndex(b => b.toLowerCase() === lowerTarget);
        let blocked;
        if (idx === -1) { meUser.blocked.push(targetUser.username); blocked = true; }
        else { meUser.blocked.splice(idx, 1); blocked = false; }
        saveUsers(users);
        sendJSON(res, 200, { blocked, blockedList: meUser.blocked });
    } catch (e) { sendFail(res, e); }
}
function handleBlockedList(req, res, query) {
    const me = authUser(req);
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    const users = readUsers();
    const meUser = users.find(u => u.username.toLowerCase() === me.username.toLowerCase());
    if (!meUser) return sendJSON(res, 404, { error: 'Пользователь не найден' });
    const blockedNames = Array.isArray(meUser.blocked) ? meUser.blocked : [];
    const list = users
        .filter(u => blockedNames.some(b => b.toLowerCase() === u.username.toLowerCase()))
        .map(u => ({ username: u.username, displayName: adminDisplayName(u), avatar: u.avatar || '', handle: u.handle || '' }));
    sendJSON(res, 200, { blocked: list });
}
function handleBlockStatus(req, res, query) {
    const me = authUser(req);
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    const target = (query.target || '').trim().toLowerCase();
    const users = readUsers();
    const meUser = users.find(u => u.username.toLowerCase() === me.username.toLowerCase());
    const targetUser = users.find(u => u.username.toLowerCase() === target);
    if (!meUser || !targetUser) return sendJSON(res, 404, { error: 'Пользователь не найден' });
    const iBlocked = (meUser.blocked || []).some(b => b.toLowerCase() === target);
    const heBlocked = (targetUser.blocked || []).some(b => b.toLowerCase() === me.username.toLowerCase());
    sendJSON(res, 200, { iBlocked, heBlocked, mutual: iBlocked || heBlocked });
}

/* ========== FORWARD ========== */

async function handleForward(req, res) {
    try {
        const me = authUser(req);
        if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
        const data = await readBody(req);
        const cdWait = msgCooldownLeft(me.username); if (cdWait > 0) return cooldownReply(res, cdWait);
        if (String(data.text || '').length > MAX_MESSAGE_LEN) return sendJSON(res, 400, { error: 'Сообщение слишком длинное (до ' + MAX_MESSAGE_LEN + ' символов)' });
        const to = (data.to || '').trim();
        const text = (data.text || '').trim();
        const originalFrom = (data.originalFrom || '').trim();
        if (!to || !text) return sendJSON(res, 400, { error: 'Недостаточно данных' });
        const users = readUsers();
        const sender = users.find(u => u.username.toLowerCase() === me.username.toLowerCase());
        const recipient = users.find(u => u.username.toLowerCase() === to.toLowerCase());
        if (!sender || !recipient) return sendJSON(res, 404, { error: 'Пользователь не найден' });
        if (recipient.system) return sendJSON(res, 403, { error: 'Служебный аккаунт' });
        if ((sender.blocked || []).some(b => b.toLowerCase() === to.toLowerCase())) return sendJSON(res, 403, { error: 'Вы заблокировали этого пользователя' });
        if ((recipient.blocked || []).some(b => b.toLowerCase() === me.username.toLowerCase())) return sendJSON(res, 403, { error: 'Пользователь заблокировал вас' });
        const isOnline = recipient.lastSeen && (Date.now() - new Date(recipient.lastSeen).getTime() < 35000);
        const image = typeof data.image === 'string' ? data.image : '';
        const file = data.file && typeof data.file === 'object' && typeof data.file.url === 'string' ? { name:String(data.file.name||'file').slice(0,120), size:Number(data.file.size||0), url:data.file.url } : null;
        const message = {
            id: makeId(), from: sender.username, to: recipient.username, text, image, file,
            forwardedFrom: originalFrom || null,
            delivered: !!isOnline, read: false, createdAt: new Date().toISOString()
        };
        const dms = readDms();
        msgCooldownMark(me.username);
        dms.push(message);
        saveDms(trimDms(dms));
        sendJSON(res, 201, { message });
    } catch (e) { sendFail(res, e); }
}

/* ========== PROFILE ========== */

async function handleUpdateProfile(req, res) {
    try {
        const me = authUser(req);
        if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
        const data = await readBody(req, MAX_BODY_SIZE);
        const newUsername = (data.newUsername || '').trim();
        const hasAvatar = Object.prototype.hasOwnProperty.call(data, 'avatar');
        const avatar = data.avatar;
        const hasHandle = Object.prototype.hasOwnProperty.call(data, 'handle');
        const handle = hasHandle ? normalizeHandle(typeof data.handle === 'string' ? data.handle : '') : null;
        const hasTheme = Object.prototype.hasOwnProperty.call(data, 'theme');
        const theme = hasTheme && (data.theme === 'light' || data.theme === 'dark') ? data.theme : null;
        const hasWallpaper = Object.prototype.hasOwnProperty.call(data, 'wallpaper');
        const wallpaper = hasWallpaper && typeof data.wallpaper === 'string' ? data.wallpaper : null;
        const hasBirthday = Object.prototype.hasOwnProperty.call(data, 'birthday');
        const birthdayRaw = hasBirthday && typeof data.birthday === 'string' ? data.birthday.trim() : '';
        if (hasBirthday && birthdayRaw && !/^\d{4}-\d{2}-\d{2}$/.test(birthdayRaw)) return sendJSON(res, 400, { error: 'Некорректная дата рождения' });
        if (hasBirthday && birthdayRaw) {
            const [y, m, d] = birthdayRaw.split('-').map(Number);
            const dt = new Date(Date.UTC(y, m - 1, d));
            if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return sendJSON(res, 400, { error: 'Некорректная дата рождения' });
            if (dt.getTime() > Date.now()) return sendJSON(res, 400, { error: 'Некорректная дата рождения' });
        }
        if (!HANDLE_RE.test(newUsername)) return sendJSON(res, 400, { error: 'Ник: 3-20 символов, только латиница, цифры и _' });
        if (isSystemUser(newUsername)) return sendJSON(res, 400, { error: 'Это имя зарезервировано' });
        if (hasAvatar && typeof avatar === 'string' && avatar.length > MAX_BODY_SIZE) return sendJSON(res, 400, { error: 'Аватар слишком большой' });
        if (hasHandle && handle && !HANDLE_RE.test(handle)) return sendJSON(res, 400, { error: 'Юзернейм: 3-20 символов, латиница, цифры и _' });
        const processedAvatar = hasAvatar ? processImageInput(avatar, true) : null;
        if (hasAvatar && processedAvatar === null) return sendJSON(res, 400, { error: 'Аватар: разрешены PNG, JPG, WEBP или GIF до 5 МБ' });
        const processedWallpaper = hasWallpaper ? processImageInput(wallpaper, true) : null;
        if (hasWallpaper && processedWallpaper === null) return sendJSON(res, 400, { error: 'Обои: разрешены PNG, JPG, WEBP или GIF до 5 МБ' });
        const users = readUsers();
        const user = users.find(u => u.username.toLowerCase() === me.username.toLowerCase());
        if (!user) return sendJSON(res, 404, { error: 'Пользователь не найден' });
        const lowerNewName = newUsername.toLowerCase();
        const lowerOldName = user.username.toLowerCase();
        const usernameChanged = lowerNewName !== lowerOldName;
        const avatarChanged = hasAvatar && processedAvatar !== user.avatar;
        if (usernameChanged && users.some(u => u !== user && u.username.toLowerCase() === lowerNewName)) return sendJSON(res, 409, { error: 'Такое имя уже занято' });
        if (hasHandle && handle && users.some(u => u !== user && (u.handle || '').toLowerCase() === handle.toLowerCase())) return sendJSON(res, 409, { error: 'Такой юзернейм уже занят' });
        user.username = newUsername;
        if (hasAvatar) user.avatar = processedAvatar;
        if (hasHandle) user.handle = handle;
        if (hasTheme && theme) user.theme = theme;
        if (hasWallpaper) user.wallpaper = processedWallpaper;
        if (hasBirthday) user.birthday = birthdayRaw;
        if (usernameChanged) {
            users.forEach(u => {
                if (Array.isArray(u.friends)) u.friends = u.friends.map(f => f.toLowerCase() === lowerOldName ? newUsername : f);
                if (Array.isArray(u.incomingRequests)) u.incomingRequests = u.incomingRequests.map(r => r.toLowerCase() === lowerOldName ? newUsername : r);
                if (Array.isArray(u.blocked)) u.blocked = u.blocked.map(b => b.toLowerCase() === lowerOldName ? newUsername : b);
            });
        }
        saveUsers(users);
        if (usernameChanged) {
            const sessions = readSessions();
            let sc = false;
            sessions.forEach(s => { if (s.username.toLowerCase() === lowerOldName) { s.username = newUsername; sc = true; } });
            if (sc) saveSessions(sessions);
        }
        if (usernameChanged || avatarChanged) {
            if (usernameChanged) {
                const dms = readDms();
                let changed = false;
                dms.forEach(m => {
                    if (m.from && m.from.toLowerCase() === lowerOldName) { m.from = newUsername; changed = true; }
                    if (m.to && m.to.toLowerCase() === lowerOldName) { m.to = newUsername; changed = true; }
                });
                if (changed) saveDms(dms);
            }
            const posts = readPosts();
            let pc = false;
            posts.forEach(p => {
                if (p.username.toLowerCase() === lowerOldName) { p.username = newUsername; if (avatarChanged) p.avatar = user.avatar; pc = true; }
                if (p.repostOf && p.repostOf.username && p.repostOf.username.toLowerCase() === lowerOldName) { p.repostOf.username = newUsername; if (avatarChanged) p.repostOf.avatar = user.avatar; pc = true; }
                if (Array.isArray(p.likes)) { const i = p.likes.findIndex(l => l.toLowerCase() === lowerOldName); if (i !== -1) { p.likes[i] = newUsername; pc = true; } }
                if (Array.isArray(p.comments)) p.comments.forEach(c => { if (c.username.toLowerCase() === lowerOldName) { c.username = newUsername; if (avatarChanged) c.avatar = user.avatar; pc = true; } });
            });
            if (pc) savePosts(posts);
            const channels = readChannels();
            let cc = false;
            channels.forEach(ch => {
                if (ch.owner.toLowerCase() === lowerOldName) { ch.owner = newUsername; cc = true; }
                if (Array.isArray(ch.members)) { const i = ch.members.findIndex(m => m.toLowerCase() === lowerOldName); if (i !== -1) { ch.members[i] = newUsername; cc = true; } }
            });
            if (cc) saveChannels(channels);
            const chats = readChats();
            let chc = false;
            chats.forEach(ch => {
                if (ch.owner.toLowerCase() === lowerOldName) { ch.owner = newUsername; chc = true; }
                if (Array.isArray(ch.members)) { const i = ch.members.findIndex(m => m.toLowerCase() === lowerOldName); if (i !== -1) { ch.members[i] = newUsername; chc = true; } }
                if (Array.isArray(ch.messages)) ch.messages.forEach(msg => {
                    if (msg.from && msg.from.toLowerCase() === lowerOldName) { msg.from = newUsername; chc = true; }
                    if (Array.isArray(msg.read)) msg.read = msg.read.map(r => r.toLowerCase() === lowerOldName ? newUsername : r);
                });
            });
            if (chc) saveChats(chats);
        }
        sendJSON(res, 200, {
            user: {
                username: user.username, email: user.email, avatar: user.avatar || '',
                handle: user.handle || '', theme: user.theme || 'dark',
                wallpaper: user.wallpaper || '', birthday: user.birthday || '',
                friends: user.friends || [], blocked: user.blocked || [], adminRole: ensureDevFounder(user).adminRole || null, displayName: adminDisplayName(user)
            }
        });
    } catch (e) { sendFail(res, e); }
}

/* ========== FRIENDS ========== */

async function handleFriendAction(req, res) {
    try {
        const me = authUser(req);
        if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
        const data = await readBody(req);
        const target = (data.target || '').trim();
        const action = (data.action || '').trim();
        if (!target || !action) return sendJSON(res, 400, { error: 'Недостаточно данных' });
        if (me.username.toLowerCase() === target.toLowerCase()) return sendJSON(res, 400, { error: 'Нельзя выполнить действие с собой' });
        const users = readUsers();
        const meUser = users.find(u => u.username.toLowerCase() === me.username.toLowerCase());
        const targetUser = users.find(u => u.username.toLowerCase() === target.toLowerCase());
        if (!meUser || !targetUser) return sendJSON(res, 404, { error: 'Пользователь не найден' });
        if (targetUser.system) return sendJSON(res, 403, { error: 'Служебный аккаунт' });
        if (!Array.isArray(meUser.friends)) meUser.friends = [];
        if (!Array.isArray(targetUser.friends)) targetUser.friends = [];
        if (!Array.isArray(meUser.incomingRequests)) meUser.incomingRequests = [];
        if (!Array.isArray(targetUser.incomingRequests)) targetUser.incomingRequests = [];
        const lowerMe = meUser.username.toLowerCase();
        const lowerTarget = targetUser.username.toLowerCase();
        if (action === 'send') {
            if ((meUser.blocked || []).some(b => b.toLowerCase() === lowerTarget)) return sendJSON(res, 403, { error: 'Вы заблокировали этого пользователя' });
            if ((targetUser.blocked || []).some(b => b.toLowerCase() === lowerMe)) return sendJSON(res, 403, { error: 'Пользователь заблокировал вас' });
            if (!targetUser.incomingRequests.some(r => r.toLowerCase() === lowerMe)) targetUser.incomingRequests.push(meUser.username);
        } else if (action === 'cancel') {
            targetUser.incomingRequests = targetUser.incomingRequests.filter(r => r.toLowerCase() !== lowerMe);
        } else if (action === 'accept') {
            meUser.incomingRequests = meUser.incomingRequests.filter(r => r.toLowerCase() !== lowerTarget);
            if (!meUser.friends.some(f => f.toLowerCase() === lowerTarget)) meUser.friends.push(targetUser.username);
            if (!targetUser.friends.some(f => f.toLowerCase() === lowerMe)) targetUser.friends.push(meUser.username);
        } else if (action === 'decline') {
            meUser.incomingRequests = meUser.incomingRequests.filter(r => r.toLowerCase() !== lowerTarget);
        } else if (action === 'remove') {
            meUser.friends = meUser.friends.filter(f => f.toLowerCase() !== lowerTarget);
            targetUser.friends = targetUser.friends.filter(f => f.toLowerCase() !== lowerMe);
        }
        saveUsers(users);
        sendJSON(res, 200, { ok: true, meFriends: meUser.friends, incomingCount: meUser.incomingRequests.length });
    } catch (e) { sendFail(res, e); }
}
function handleFriendStatus(req, res, query) {
    const me = authUser(req);
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    const target = (query.target || '').trim().toLowerCase();
    const users = readUsers();
    const meUser = users.find(u => u.username.toLowerCase() === me.username.toLowerCase());
    const targetUser = users.find(u => u.username.toLowerCase() === target);
    if (!meUser || !targetUser) return sendJSON(res, 404, { error: 'Пользователь не найден' });
    const isFriends = (meUser.friends || []).some(f => f.toLowerCase() === target);
    const isSent = (targetUser.incomingRequests || []).some(r => r.toLowerCase() === me.username.toLowerCase());
    const isReceived = (meUser.incomingRequests || []).some(r => r.toLowerCase() === target);
    let status = 'none';
    if (isFriends) status = 'friends';
    else if (isReceived) status = 'received';
    else if (isSent) status = 'sent';
    sendJSON(res, 200, { status });
}
function handleFriendsGet(req, res, query) {
    const me = authUser(req);
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    const users = readUsers();
    const user = users.find(u => u.username.toLowerCase() === me.username.toLowerCase());
    if (!user) return sendJSON(res, 404, { error: 'Пользователь не найден' });
    const friendNames = Array.isArray(user.friends) ? user.friends : [];
    const friends = users.filter(u => friendNames.some(fn => fn.toLowerCase() === u.username.toLowerCase())).map(u => ({ username: u.username, displayName: adminDisplayName(u), avatar: u.avatar || '', handle: u.handle || '', birthday: u.birthday || '' }));
    const reqNames = Array.isArray(user.incomingRequests) ? user.incomingRequests : [];
    const requests = users.filter(u => reqNames.some(rn => rn.toLowerCase() === u.username.toLowerCase())).map(u => ({ username: u.username, displayName: adminDisplayName(u), avatar: u.avatar || '', handle: u.handle || '' }));
    sendJSON(res, 200, { friends, requests });
}

/* ========== USERS ========== */

function handleUsersList(req, res) {
    const me = authUser(req);
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    const safe = readUsers()
        .filter(u => !u.system)
        .map(u => ({ username: u.username, displayName: adminDisplayName(u), avatar: u.avatar || '', handle: u.handle || '', theme: u.theme || 'dark', friends: u.friends || [], lastSeen: u.lastSeen || u.createdAt, createdAt: u.createdAt }));
    sendJSON(res, 200, { users: safe });
}
function handleUserSearch(req, res, query) {
    const me = authUser(req);
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    const q = normalizeHandle(query.q || '').toLowerCase();
    const users = readUsers().filter(u => !u.system);
    const results = q ? users.filter(u => (u.handle || '').toLowerCase().includes(q) || u.username.toLowerCase().includes(q)) : users;
    sendJSON(res, 200, { users: results.slice(0, 20).map(u => ({ username: u.username, displayName: adminDisplayName(u), avatar: u.avatar || '', handle: u.handle || '' })) });
}

/* ========== POSTS ========== */

function normalizePost(p, repostedByViewer) {
    return { id: p.id, username: p.username, displayName: adminDisplayName(readUsers().find(function(u){return u.username.toLowerCase()===String(p.username||'').toLowerCase();}) || {username:p.username}), avatar: p.avatar || '', text: p.text || '', image: p.image || '', createdAt: p.createdAt, likes: Array.isArray(p.likes) ? p.likes : [], comments: Array.isArray(p.comments) ? p.comments : [], repostOf: p.repostOf || null, repostCount: typeof p.repostCount === 'number' ? p.repostCount : 0, repostedByViewer: !!repostedByViewer };
}
function handleFeedGet(req, res, query) {
    const me = authUser(req);
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    const viewer = me.username.toLowerCase();
    const allPosts = readPosts();
    const feedPosts = allPosts.filter(p => !p.repostOf);
    const viewerReposts = new Set();
    allPosts.forEach(p => { if (p.username && p.username.toLowerCase() === viewer && p.repostOf && p.repostOf.id) viewerReposts.add(p.repostOf.id); });
    const posts = feedPosts.map(p => normalizePost(p, viewerReposts.has(p.id)));
    posts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    sendJSON(res, 200, { posts: posts.slice(0, FEED_LIMIT) });
}
function handlePostsGet(req, res, query) {
    const me = authUser(req);
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    const username = (query.username || '').trim();
    if (!username) return sendJSON(res, 400, { error: 'Не указан пользователь' });
    const allPosts = readPosts();
    const viewer = me.username.toLowerCase();
    const viewerReposts = new Set();
    allPosts.forEach(p => { if (p.username && p.username.toLowerCase() === viewer && p.repostOf && p.repostOf.id) viewerReposts.add(p.repostOf.id); });
    const posts = allPosts.map(p => normalizePost(p, viewerReposts.has(p.id) || (p.repostOf && viewerReposts.has(p.repostOf.id))));
    const filtered = posts.filter(p => p.username.toLowerCase() === username.toLowerCase());
    filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    sendJSON(res, 200, { posts: filtered.slice(0, POSTS_PER_WALL) });
}
async function handlePostsCreate(req, res) {
    try {
        const me = authUser(req);
        if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
        const data = await readBody(req, MAX_BODY_SIZE);
        if (String(data.text || '').length > MAX_POST_LEN) return sendJSON(res, 400, { error: 'Пост слишком длинный (до 3000 символов)' });
        const text = (data.text || '').trim();
        const image = processImageInput(typeof data.image === 'string' ? data.image : '', true);
        if (image === null) return sendJSON(res, 400, { error: 'Картинка: разрешены PNG, JPG, WEBP или GIF до 5 МБ' });
        if (!text && !image) return sendJSON(res, 400, { error: 'Пустой пост' });
        const author = readUsers().find(u => u.username.toLowerCase() === me.username.toLowerCase());
        if (!author) return sendJSON(res, 404, { error: 'Пользователь не найден' });
        const post = { id: makeId(), username: author.username, avatar: author.avatar || '', text, image, createdAt: new Date().toISOString(), likes: [], comments: [], repostOf: null, repostCount: 0 };
        const posts = readPosts();
        posts.push(post);
        savePosts(trimPosts(posts));
        sendJSON(res, 201, { post: normalizePost(post) });
    } catch (e) { sendFail(res, e); }
}
async function handlePostLike(req, res) {
    try {
        const me = authUser(req);
        if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
        const data = await readBody(req);
        const id = (data.id || '').trim();
        const username = me.username;
        const posts = readPosts();
        const idx = posts.findIndex(p => p.id === id);
        if (idx === -1) return sendJSON(res, 404, { error: 'Пост не найден' });
        if (!Array.isArray(posts[idx].likes)) posts[idx].likes = [];
        const lower = username.toLowerCase();
        const uIdx = posts[idx].likes.findIndex(u => u.toLowerCase() === lower);
        if (uIdx === -1) posts[idx].likes.push(username); else posts[idx].likes.splice(uIdx, 1);
        savePosts(posts);
        sendJSON(res, 200, { likes: posts[idx].likes, liked: uIdx === -1 });
    } catch (e) { sendFail(res, e); }
}
async function handlePostComment(req, res) {
    try {
        const me = authUser(req);
        if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
        const data = await readBody(req);
        if (String(data.text || '').length > MAX_COMMENT_LEN) return sendJSON(res, 400, { error: 'Комментарий слишком длинный (до 1000 символов)' });
        const id = (data.id || '').trim();
        const text = (data.text || '').trim();
        const author = readUsers().find(u => u.username.toLowerCase() === me.username.toLowerCase());
        if (!author) return sendJSON(res, 404, { error: 'Пользователь не найден' });
        const posts = readPosts();
        const idx = posts.findIndex(p => p.id === id);
        if (idx === -1) return sendJSON(res, 404, { error: 'Пост не найден' });
        if (!Array.isArray(posts[idx].comments)) posts[idx].comments = [];
        const comment = { id: makeId(), username: author.username, avatar: author.avatar || '', text, createdAt: new Date().toISOString() };
        posts[idx].comments.push(comment);
        savePosts(posts);
        sendJSON(res, 201, { comment, comments: posts[idx].comments });
    } catch (e) { sendFail(res, e); }
}
function handleCommentsGet(req, res, query) {
    const me = authUser(req);
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    const post = readPosts().find(p => p.id === (query.id || '').trim());
    if (!post) return sendJSON(res, 404, { error: 'Пост не найден' });
    sendJSON(res, 200, { comments: Array.isArray(post.comments) ? post.comments : [] });
}
async function handlePostRepost(req, res) {
    try {
        const me = authUser(req);
        if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
        const data = await readBody(req);
        const id = (data.id || '').trim();
        const author = readUsers().find(u => u.username.toLowerCase() === me.username.toLowerCase());
        if (!author) return sendJSON(res, 404, { error: 'Пользователь не найден' });
        const posts = readPosts();
        const target = posts.find(p => p.id === id);
        if (!target) return sendJSON(res, 404, { error: 'Пост не найден' });
        const originalId = target.repostOf && target.repostOf.id ? target.repostOf.id : target.id;
        const original = posts.find(p => p.id === originalId);
        if (!original) return sendJSON(res, 404, { error: 'Оригинал не найден' });
        let removed = 0;
        const kept = [];
        posts.forEach(p => {
            if (p.repostOf && p.repostOf.id === originalId && p.username && p.username.toLowerCase() === author.username.toLowerCase()) removed++;
            else kept.push(p);
        });
        if (removed > 0) {
            original.repostCount = Math.max(0, (original.repostCount || 0) - removed);
            savePosts(kept);
            return sendJSON(res, 200, { reposted: false, repostCount: original.repostCount });
        }
        const repost = { id: makeId(), username: author.username, avatar: author.avatar || '', text: '', image: '', createdAt: new Date().toISOString(), likes: [], comments: [], repostOf: { id: original.id, username: original.username, avatar: original.avatar || '', text: original.text || '', image: original.image || '', createdAt: original.createdAt }, repostCount: 0 };
        original.repostCount = (original.repostCount || 0) + 1;
        kept.push(repost);
        savePosts(kept);
        sendJSON(res, 201, { reposted: true, post: normalizePost(repost, true), repostCount: original.repostCount });
    } catch (e) { sendFail(res, e); }
}
async function handlePostDelete(req, res) {
    try {
        const me = authUser(req);
        if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
        const data = await readBody(req);
        const postId = (data.postId || '').trim();
        if (!postId) return sendJSON(res, 400, { error: 'Недостаточно данных' });
        const posts = readPosts();
        const idx = posts.findIndex(p => p.id === postId);
        if (idx === -1) return sendJSON(res, 404, { error: 'Пост не найден' });
        if (!posts[idx].username || posts[idx].username.toLowerCase() !== me.username.toLowerCase()) return sendJSON(res, 403, { error: 'Можно удалять только свои посты' });
        const removed = posts[idx];
        if (removed.repostOf && removed.repostOf.id) {
            const origIdx = posts.findIndex(p => p.id === removed.repostOf.id);
            if (origIdx !== -1 && typeof posts[origIdx].repostCount === 'number') {
                posts[origIdx].repostCount = Math.max(0, posts[origIdx].repostCount - 1);
            }
        }
        posts.splice(idx, 1);
        savePosts(posts);
        sendJSON(res, 200, { ok: true });
    } catch (e) { sendFail(res, e); }
}
async function handleCommentDelete(req, res) {
    try {
        const me = authUser(req);
        if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
        const data = await readBody(req);
        const postId = (data.postId || '').trim();
        const commentId = (data.commentId || '').trim();
        if (!postId || !commentId) return sendJSON(res, 400, { error: 'Недостаточно данных' });
        const posts = readPosts();
        const p = posts.find(x => x.id === postId);
        if (!p) return sendJSON(res, 404, { error: 'Пост не найден' });
        if (!Array.isArray(p.comments)) return sendJSON(res, 404, { error: 'Комментарий не найден' });
        const cIdx = p.comments.findIndex(c => c.id === commentId);
        if (cIdx === -1) return sendJSON(res, 404, { error: 'Комментарий не найден' });
        if (!p.comments[cIdx].username || p.comments[cIdx].username.toLowerCase() !== me.username.toLowerCase()) return sendJSON(res, 403, { error: 'Можно удалять только свои комментарии' });
        p.comments.splice(cIdx, 1);
        savePosts(posts);
        sendJSON(res, 200, { ok: true });
    } catch (e) { sendFail(res, e); }
}

/* ========== CHANNELS ========== */

function channelPublic(c, viewer) {
    const isSub = viewer ? (c.members || []).some(m => m.toLowerCase() === viewer.toLowerCase()) : false;
    return { id: c.id, username: c.username, name: c.name, description: c.description || '', avatar: c.avatar || '', owner: c.owner, createdAt: c.createdAt, members: Array.isArray(c.members) ? c.members.length : 0, memberNames: Array.isArray(c.members) ? c.members : [], isSubscribed: isSub, isOwner: !!(viewer && c.owner && String(c.owner).trim().toLowerCase() === String(viewer).trim().toLowerCase()), allowInvites: c.allowInvites !== false, writeMode: c.writeMode === 'members' ? 'members' : 'owner' };
}
async function handleChannelCreate(req, res) {
    try {
        const me = authUser(req);
        if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
        const data = await readBody(req, MAX_BODY_SIZE);
        const name = (data.name || '').trim();
        const username = normalizeHandle(data.username || '');
        if (!name || !username) return sendJSON(res, 400, { error: 'Заполните название и юзернейм канала' });
        if (!HANDLE_RE.test(username)) return sendJSON(res, 400, { error: 'Юзернейм: 3-20 символов' });
        const channels = readChannels();
        if (channels.some(c => c.username.toLowerCase() === username.toLowerCase())) return sendJSON(res, 409, { error: 'Юзернейм канала занят' });
        const channelAvatar = processImageInput(typeof data.avatar === 'string' ? data.avatar : '', true);
        if (channelAvatar === null) return sendJSON(res, 400, { error: 'Аватар канала: разрешены PNG, JPG, WEBP или GIF до 5 МБ' });
        const channel = { id: makeId(), username, name, description: (data.description || '').trim(), avatar: channelAvatar, owner: me.username, members: [me.username], allowInvites: true, writeMode: 'owner', messages: [], pinnedMessageId: null, createdAt: new Date().toISOString() };
        channels.push(channel); saveChannels(channels);
        sendJSON(res, 201, { channel: channelPublic(channel, me.username) });
    } catch (e) { sendFail(res, e); }
}
async function handleChannelUpdate(req, res) {
    try {
        const me = authUser(req);
        if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
        const data = await readBody(req, MAX_BODY_SIZE);
        const originalUsername = normalizeHandle(data.originalUsername || '');
        const newName = (data.name || '').trim();
        const newUsername = normalizeHandle(data.username || '');
        const description = (data.description || '').trim();
        const avatarInput = typeof data.avatar === 'string' ? data.avatar : null;
        const removeAvatar = avatarInput === '';
        const avatar = (avatarInput === null || removeAvatar) ? null : processImageInput(avatarInput, true);
        if (avatarInput !== null && !removeAvatar && avatar === null) return sendJSON(res, 400, { error: 'Аватар канала: разрешены PNG, JPG, WEBP или GIF до 5 МБ' });
        if (!originalUsername || !newName || !newUsername) return sendJSON(res, 400, { error: 'Заполните все поля' });
        if (!HANDLE_RE.test(newUsername)) return sendJSON(res, 400, { error: 'Юзернейм: 3-20 символов' });
        const channels = readChannels();
        const ch = channels.find(c => c.username.toLowerCase() === originalUsername.toLowerCase());
        if (!ch) return sendJSON(res, 404, { error: 'Канал не найден' });
        if (ch.owner.toLowerCase() !== me.username.toLowerCase()) return sendJSON(res, 403, { error: 'Только владелец' });
        if (newUsername.toLowerCase() !== originalUsername.toLowerCase() && channels.some(c => c.username.toLowerCase() === newUsername.toLowerCase())) return sendJSON(res, 409, { error: 'Занят' });
        ch.name = newName; ch.username = newUsername; ch.description = description;
        if (removeAvatar) ch.avatar = '';
        else if (avatar !== null) ch.avatar = avatar;
        if (typeof data.allowInvites === 'boolean') ch.allowInvites = data.allowInvites;
        if (data.writeMode === 'members' || data.writeMode === 'owner') ch.writeMode = data.writeMode;
        saveChannels(channels);
        sendJSON(res, 200, { channel: channelPublic(ch, me.username) });
    } catch (e) { sendFail(res, e); }
}
async function handleChannelDelete(req, res) {
    try {
        const me = authUser(req);
        if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
        const data = await readBody(req);
        const username = normalizeHandle(data.username || data.channel || '');
        const channels = readChannels();
        const idx = channels.findIndex(c => c.username.toLowerCase() === username.toLowerCase());
        if (idx < 0) return sendJSON(res, 404, { error: 'Канал не найден' });
        if (channels[idx].owner.toLowerCase() !== me.username.toLowerCase()) return sendJSON(res, 403, { error: 'Только владелец' });
        channels.splice(idx, 1);
        saveChannels(channels);
        sendJSON(res, 200, { ok: true });
    } catch (e) { sendFail(res, e); }
}
async function handleChannelSubscribe(req, res) {
    try {
        const me = authUser(req);
        if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
        const data = await readBody(req);
        const channelUsername = normalizeHandle(data.channel || data.username || '');
        if (!channelUsername) return sendJSON(res, 400, { error: 'Не хватает данных' });
        const channels = readChannels();
        const ch = channels.find(c => c.username.toLowerCase() === channelUsername.toLowerCase());
        if (!ch) return sendJSON(res, 404, { error: 'Канал не найден' });
        if (!Array.isArray(ch.members)) ch.members = [];
        const lowerUser = me.username.toLowerCase();
        const idx = ch.members.findIndex(m => m.toLowerCase() === lowerUser);
        let subscribed;
        if (idx === -1) { ch.members.push(me.username); subscribed = true; } else { ch.members.splice(idx, 1); subscribed = false; }
        saveChannels(channels);
        sendJSON(res, 200, { subscribed, memberCount: ch.members.length });
    } catch (e) { sendFail(res, e); }
}
function handleChannelGet(req, res, query) {
    const me = authUser(req);
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    const c = readChannels().find(x => x.username.toLowerCase() === normalizeHandle(query.username || '').toLowerCase());
    if (!c) return sendJSON(res, 404, { error: 'Канал не найден' });
    sendJSON(res, 200, { channel: channelPublic(c, me.username) });
}
function handleChannelSearch(req, res, query) {
    const me = authUser(req);
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    const q = normalizeHandle(query.q || '').toLowerCase();
    const channels = readChannels();
    const found = q ? channels.filter(c => c.username.toLowerCase().includes(q) || c.name.toLowerCase().includes(q)) : channels;
    sendJSON(res, 200, { channels: found.slice(0, 20).map(c => channelPublic(c, me.username)) });
}
function handleChannelMessagesGet(req, res, query) {
    const me = authUser(req);
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    const c = readChannels().find(x => x.username.toLowerCase() === normalizeHandle(query.username || '').toLowerCase());
    if (!c) return sendJSON(res, 404, { error: 'Канал не найден' });
    const staffUsers=readUsers();
    const messages=(c.messages || []).slice(-300).map(function(m){ const u=staffUsers.find(function(x){return String(x.username||'').toLowerCase()===String(m.from||'').toLowerCase();}); return Object.assign({},m,{fromDisplay:u?adminDisplayName(u):m.from}); });
    sendJSON(res, 200, { messages: messages, pinnedMessageId: c.pinnedMessageId || null });
}
async function handleChannelMessageCreate(req, res) {
    try {
        const me = authUser(req);
        if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
        const data = await readBody(req, MAX_BODY_SIZE);
        const cdWait = msgCooldownLeft(me.username); if (cdWait > 0) return cooldownReply(res, cdWait);
        if (String(data.text || '').length > MAX_MESSAGE_LEN) return sendJSON(res, 400, { error: 'Сообщение слишком длинное (до ' + MAX_MESSAGE_LEN + ' символов)' });
        const channels = readChannels();
        const c = channels.find(x => x.username.toLowerCase() === normalizeHandle(data.channel || '').toLowerCase());
        if (!c) return sendJSON(res, 404, { error: 'Канал не найден' });
        if (c.owner.toLowerCase() !== me.username.toLowerCase() && c.writeMode !== 'members') return sendJSON(res, 403, { error: 'Писать может только владелец' });
        let fileInfo = null;
        if (data.file && typeof data.file === 'object' && typeof data.file.data === 'string') {
            { const upRetry = rateLimit(req, 'upload', 30, me.username); if (upRetry) return sendJSON(res, 429, { error: 'Слишком много загрузок, подожди ' + upRetry + ' с' }); }
            const fname = String(data.file.name || 'file').replace(/[\\/\r\n<>"]/g, '_').slice(0, 120);
            const a = saveAttachment(data.file.data, 'file', fname);
            if (!a) return sendJSON(res, 400, { error: 'Файл слишком большой или имеет недопустимый формат (до 20 МБ)' });
            fileInfo = { name: fname, size: a.size, url: a.url };
        }
        const text = (data.text || '').trim();
        if (!text && !fileInfo) return sendJSON(res, 400, { error: 'Пустое сообщение' });
        const msg = { id: makeId(), from: c.name, author: me.username, channelUsername: c.username, channelAvatar: c.avatar || '', text, file: fileInfo, replyTo: data.replyTo && data.replyTo.id ? { id:String(data.replyTo.id), from:String(data.replyTo.from||''), text:String(data.replyTo.text||'').slice(0,500) } : null, reactions: { like: [], fire: [], demon: [] }, createdAt: new Date().toISOString() };
        if (!Array.isArray(c.messages)) c.messages = [];
        msgCooldownMark(me.username);
        c.messages.push(msg);
        if (c.messages.length > 300) c.messages = c.messages.slice(-300);
        saveChannels(channels);
        sendJSON(res, 201, { message: msg });
    } catch (e) { sendFail(res, e); }
}
async function handleChannelMessageReaction(req, res) {
    try {
        const me = authUser(req);
        if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
        const data = await readBody(req);
        const channelUsername = normalizeHandle(data.channel || '');
        const messageId = (data.messageId || '').trim();
        const reactionType = (data.type || '').trim();
        if (!['like', 'fire', 'demon'].includes(reactionType)) return sendJSON(res, 400, { error: 'Неизвестный тип реакции' });
        const channels = readChannels();
        const c = channels.find(x => x.username.toLowerCase() === channelUsername.toLowerCase());
        if (!c) return sendJSON(res, 404, { error: 'Канал не найден' });
        const msg = (c.messages || []).find(m => m.id === messageId);
        if (!msg) return sendJSON(res, 404, { error: 'Сообщение не найдено' });
        if (!msg.reactions) msg.reactions = { like: [], fire: [], demon: [] };
        if (!Array.isArray(msg.reactions[reactionType])) msg.reactions[reactionType] = [];
        const lowerUser = me.username.toLowerCase();
        const idx = msg.reactions[reactionType].findIndex(u => u.toLowerCase() === lowerUser);
        if (idx === -1) msg.reactions[reactionType].push(me.username);
        else msg.reactions[reactionType].splice(idx, 1);
        saveChannels(channels);
        sendJSON(res, 200, { reactions: msg.reactions });
    } catch (e) { sendFail(res, e); }
}
async function handleChannelPin(req, res) {
    try {
        const me = authUser(req);
        if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
        const data = await readBody(req);
        const channelUsername = normalizeHandle(data.channel || '');
        const messageId = (data.messageId || '').trim();
        const pinned = !!data.pinned;
        if (!channelUsername) return sendJSON(res, 400, { error: 'Недостаточно данных' });
        const channels = readChannels();
        const c = channels.find(x => x.username.toLowerCase() === channelUsername.toLowerCase());
        if (!c) return sendJSON(res, 404, { error: 'Канал не найден' });
        if (c.owner.toLowerCase() !== me.username.toLowerCase() && !['founder','admin'].includes(getStaffRole(me))) return sendJSON(res, 403, { error: 'Только создатель или администратор может закреплять' });
        if (pinned) {
            if (!messageId) return sendJSON(res, 400, { error: 'Не указано сообщение' });
            const msg = (c.messages || []).find(m => String(m.id) === String(messageId));
            if (!msg) return sendJSON(res, 404, { error: 'Сообщение не найдено' });
            (c.messages || []).forEach(m => { m.pinned = String(m.id) === String(messageId); });
            c.pinnedMessageId = String(messageId);
        } else {
            (c.messages || []).forEach(m => { m.pinned = false; });
            c.pinnedMessageId = null;
        }
        saveChannels(channels);
        sendJSON(res, 200, { ok: true, pinnedMessageId: c.pinnedMessageId });
    } catch (e) { sendFail(res, e); }
}
async function handleChannelMessageDelete(req, res) {
    try {
        const me = authUser(req);
        if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
        const data = await readBody(req);
        const channelUsername = normalizeHandle(data.channel || '');
        const messageId = (data.messageId || '').trim();
        if (!channelUsername || !messageId) return sendJSON(res, 400, { error: 'Недостаточно данных' });
        const channels = readChannels();
        const c = channels.find(x => x.username.toLowerCase() === channelUsername.toLowerCase());
        if (!c) return sendJSON(res, 404, { error: 'Канал не найден' });
        const msg = (c.messages || []).find(m => m.id === messageId);
        if (!msg) return sendJSON(res, 404, { error: 'Сообщение не найдено' });
        const isAuthor = (msg.author && String(msg.author).toLowerCase() === me.username.toLowerCase()) || (!msg.author && c.owner && String(c.owner).toLowerCase() === me.username.toLowerCase() && String(msg.from||'').toLowerCase() === String(c.name||'').toLowerCase());
        if (!isAuthor) return sendJSON(res, 403, { error: 'Можно удалять только свои сообщения' });
        const before = (c.messages || []).length;
        c.messages = (c.messages || []).filter(m => m.id !== messageId);
        if (c.messages.length === before) return sendJSON(res, 404, { error: 'Сообщение не найдено' });
        if (c.pinnedMessageId === messageId) c.pinnedMessageId = null;
        saveChannels(channels);
        sendJSON(res, 200, { ok: true });
    } catch (e) { sendFail(res, e); }
}

/* ========== CHATS ========== */

async function handleChatCreate(req, res) {
    try {
        const me = authUser(req);
        if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
        const data = await readBody(req);
        const name = (data.name || '').trim();
        if (!name || name.length > 80) return sendJSON(res, 400, { error: 'Название чата: 1-80 символов' });
        const allUsers = readUsers();
        let members = Array.isArray(data.members) ? data.members.map(x => String(x).trim()).filter(Boolean) : [];
        members = members.map(function (name) { const u = allUsers.find(x => x.username.toLowerCase() === name.toLowerCase() && !x.system); return u ? u.username : null; }).filter(Boolean);
        if (!members.some(x => x.toLowerCase() === me.username.toLowerCase())) members.unshift(me.username);
        members = Array.from(new Map(members.map(x => [x.toLowerCase(), x])).values()).slice(0, 100);
        const chat = { id: makeId(), name, description: (data.description || '').trim(), avatar: processImageInput(typeof data.avatar === 'string' ? data.avatar : '', true), allowInvites: true, allowMembersWrite: true, owner: me.username, members, messages: [], pinnedMessageId: null, createdAt: new Date().toISOString() };
        const chats = readChats();
        chats.push(chat);
        saveChats(chats);
        sendJSON(res, 201, { chat: { id: chat.id, name: chat.name, owner: chat.owner, members: chat.members, memberCount: chat.members.length } });
    } catch (e) { sendFail(res, e); }
}
function handleChatsGet(req, res, query) {
    const me = authUser(req);
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    const user = me.username.toLowerCase();
    const list = readChats().filter(c => (c.members || []).some(m => m.toLowerCase() === user)).map(c => {
        const last = c.messages && c.messages.length ? c.messages[c.messages.length - 1] : null;
        let unread = 0;
        (c.messages || []).forEach(m => {
            if (m.from.toLowerCase() === user) return;
            if (!Array.isArray(m.read)) return;
            if (!m.read.some(u => u.toLowerCase() === user)) unread++;
        });
        return { id: c.id, name: c.name, description: c.description || '', avatar: c.avatar || '', owner: c.owner, members: c.members, memberCount: c.members.length, lastText: last ? last.text : '', lastAt: last ? last.createdAt : c.createdAt, unread };
    });
    sendJSON(res, 200, { chats: list });
}
async function handleChatUpdate(req, res) {
    try {
        const me = authUser(req);
        if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
        const data = await readBody(req, MAX_BODY_SIZE);
        const id = String(data.id || '').trim();
        const chats = readChats();
        const c = chats.find(x => x.id === id);
        if (!c) return sendJSON(res, 404, { error: 'Чат не найден' });
        if (c.owner.toLowerCase() !== me.username.toLowerCase()) return sendJSON(res, 403, { error: 'Только создатель' });
        const name = String(data.name || '').trim();
        if (!name || name.length > 80) return sendJSON(res, 400, { error: 'Название чата: 1-80 символов' });
        c.name = name;
        c.description = String(data.description || '').trim();
        if (typeof data.avatar === 'string') {
            const avatar = processImageInput(data.avatar, true);
            if (avatar === null) return sendJSON(res, 400, { error: 'Аватар: разрешены PNG, JPG, WEBP или GIF до 5 МБ' });
            c.avatar = avatar;
        }
        if (typeof data.allowInvites === 'boolean') c.allowInvites = data.allowInvites;
        if (typeof data.allowMembersWrite === 'boolean') c.allowMembersWrite = data.allowMembersWrite;
        saveChats(chats);
        sendJSON(res, 200, { chat: { id:c.id, name:c.name, description:c.description || '', avatar:c.avatar || '', owner:c.owner, members:c.members, memberCount:c.members.length, allowInvites:c.allowInvites !== false, allowMembersWrite:c.allowMembersWrite !== false } });
    } catch (e) { sendFail(res, e); }
}
async function handleChatDelete(req, res) {
    try {
        const me = authUser(req);
        if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
        const data = await readBody(req);
        const chats = readChats();
        const idx = chats.findIndex(x => x.id === String(data.id || '').trim());
        if (idx < 0) return sendJSON(res, 404, { error: 'Чат не найден' });
        if (chats[idx].owner.toLowerCase() !== me.username.toLowerCase()) return sendJSON(res, 403, { error: 'Только создатель' });
        chats.splice(idx, 1); saveChats(chats); sendJSON(res, 200, { ok:true });
    } catch (e) { sendFail(res, e); }
}
function handleChatMessagesGet(req, res, query) {
    const me = authUser(req);
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    const chatId = (query.id || '').trim();
    const chats = readChats();
    const chat = chats.find(x => x.id === chatId);
    if (!chat) return sendJSON(res, 404, { error: 'Чат не найден' });
    if (!(chat.members || []).some(m => m.toLowerCase() === me.username.toLowerCase())) return sendJSON(res, 403, { error: 'Нет доступа к этому чату' });
    let changed = false;
    (chat.messages || []).forEach(m => {
        if (!Array.isArray(m.read)) m.read = [];
        if (m.from.toLowerCase() !== me.username.toLowerCase() && !m.read.some(u => u.toLowerCase() === me.username.toLowerCase())) {
            m.read.push(me.username);
            changed = true;
        }
    });
    if (changed) saveChats(chats);
    sendJSON(res, 200, {
        chat: { id: chat.id, name: chat.name, description: chat.description || '', avatar: chat.avatar || '', memberCount: chat.members.length, members: chat.members, owner: chat.owner, allowInvites: chat.allowInvites !== false, allowMembersWrite: chat.allowMembersWrite !== false, pinnedMessageId: chat.pinnedMessageId || null },
        messages: (chat.messages || []).slice(-300).map(function(m){ const u=readUsers().find(function(x){return String(x.username||'').toLowerCase()===String(m.from||'').toLowerCase();}); return Object.assign({},m,{fromDisplay:u?adminDisplayName(u):m.from}); })
    });
}
async function handleChatMessageCreate(req, res) {
    try {
        const me = authUser(req);
        if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
        const data = await readBody(req, MAX_BODY_SIZE);
        const cdWait = msgCooldownLeft(me.username); if (cdWait > 0) return cooldownReply(res, cdWait);
        if (String(data.text || '').length > MAX_MESSAGE_LEN) return sendJSON(res, 400, { error: 'Сообщение слишком длинное (до ' + MAX_MESSAGE_LEN + ' символов)' });
        const chats = readChats();
        const c = chats.find(x => x.id === data.id);
        if (!c) return sendJSON(res, 404, { error: 'Чат не найден' });
        if (!(c.members || []).some(m => m.toLowerCase() === me.username.toLowerCase())) return sendJSON(res, 403, { error: 'Нет доступа к этому чату' });
        if (c.owner.toLowerCase() !== me.username.toLowerCase() && c.allowMembersWrite === false) return sendJSON(res, 403, { error: 'Писать в этот чат может только создатель' });
        const text = (data.text || '').trim();
        if (text.length > 5000) return sendJSON(res, 400, { error: 'Сообщение: максимум 5000 символов' });
        let fileInfo = null;
        if (data.file && typeof data.file === 'object' && typeof data.file.data === 'string') {
            { const upRetry = rateLimit(req, 'upload', 30, me.username); if (upRetry) return sendJSON(res, 429, { error: 'Слишком много загрузок, подожди ' + upRetry + ' с' }); }
            const fname = String(data.file.name || 'file').replace(/[\\/\r\n<>"]/g, '_').slice(0, 120);
            const a = saveAttachment(data.file.data, 'file', fname);
            if (!a) return sendJSON(res, 400, { error: 'Файл слишком большой или имеет недопустимый формат (до 20 МБ)' });
            fileInfo = { name: fname, size: a.size, url: a.url };
        }
        if (!text && !fileInfo) return sendJSON(res, 400, { error: 'Пустое сообщение' });
        const msg = { id: makeId(), from: me.username, text, file: fileInfo, replyTo: data.replyTo && data.replyTo.id ? { id:String(data.replyTo.id), from:String(data.replyTo.from||''), text:String(data.replyTo.text||'').slice(0,500) } : null, read: [], createdAt: new Date().toISOString() };
        if (!Array.isArray(c.messages)) c.messages = [];
        msgCooldownMark(me.username);
        c.messages.push(msg);
        if (c.messages.length > 300) c.messages = c.messages.slice(-300);
        saveChats(chats);
        sendJSON(res, 201, { message: msg });
    } catch (e) { sendFail(res, e); }
}
async function handleChatPin(req, res) {
    try {
        const me = authUser(req);
        if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
        const data = await readBody(req);
        const chatId = (data.chatId || '').trim();
        const messageId = (data.messageId || '').trim();
        const pinned = !!data.pinned;
        if (!chatId) return sendJSON(res, 400, { error: 'Недостаточно данных' });
        const chats = readChats();
        const c = chats.find(x => x.id === chatId);
        if (!c) return sendJSON(res, 404, { error: 'Чат не найден' });
        if (c.owner.toLowerCase() !== me.username.toLowerCase() && !['founder','admin'].includes(getStaffRole(me))) return sendJSON(res, 403, { error: 'Только создатель или администратор может закреплять' });
        if (pinned) {
            if (!messageId) return sendJSON(res, 400, { error: 'Не указано сообщение' });
            const msg = (c.messages || []).find(m => String(m.id) === String(messageId));
            if (!msg) return sendJSON(res, 404, { error: 'Сообщение не найдено' });
            (c.messages || []).forEach(m => { m.pinned = String(m.id) === String(messageId); });
            c.pinnedMessageId = String(messageId);
        } else {
            (c.messages || []).forEach(m => { m.pinned = false; });
            c.pinnedMessageId = null;
        }
        saveChats(chats);
        sendJSON(res, 200, { ok: true, pinnedMessageId: c.pinnedMessageId });
    } catch (e) { sendFail(res, e); }
}
async function handleChatMessageDelete(req, res) {
    try {
        const me = authUser(req);
        if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
        const data = await readBody(req);
        const chatId = (data.chatId || '').trim();
        const messageId = (data.messageId || '').trim();
        if (!chatId || !messageId) return sendJSON(res, 400, { error: 'Недостаточно данных' });
        const chats = readChats();
        const c = chats.find(x => x.id === chatId);
        if (!c) return sendJSON(res, 404, { error: 'Чат не найден' });
        const msg = (c.messages || []).find(m => m.id === messageId);
        if (!msg) return sendJSON(res, 404, { error: 'Сообщение не найдено' });
        const isAuthor = msg.from && msg.from.toLowerCase() === me.username.toLowerCase();
        if (!isAuthor) return sendJSON(res, 403, { error: 'Можно удалять только свои сообщения' });
        c.messages = (c.messages || []).filter(m => m.id !== messageId);
        if (c.pinnedMessageId === messageId) c.pinnedMessageId = null;
        saveChats(chats);
        sendJSON(res, 200, { ok: true });
    } catch (e) { sendFail(res, e); }
}

const DM_PINS_FILE = path.join(__dirname, 'dm_pins.json');
function readDmPins(){ try{ return JSON.parse(fs.readFileSync(DM_PINS_FILE,'utf8')); }catch(e){ return {}; } }
function saveDmPins(x){ fs.writeFileSync(DM_PINS_FILE, JSON.stringify(x,null,2)); }
function getDmPinnedMessageId(key){ return readDmPins()[key] || null; }

async function handleDmPin(req,res){
    try{
        const me=authUser(req); if(!me) return sendJSON(res,401,{error:'Не авторизован'});
        const data=await readBody(req); const messageId=String(data.messageId||'').trim(); const pinned=!!data.pinned;
        if(!messageId) return sendJSON(res,400,{error:'Не указано сообщение'});
        const dms=readDms(); const msg=dms.find(m=>m.id===messageId);
        if(!msg) return sendJSON(res,404,{error:'Сообщение не найдено'});
        const key=dmKey(msg.from,msg.to);
        if(msg.from.toLowerCase()!==me.username.toLowerCase() && msg.to.toLowerCase()!==me.username.toLowerCase()) return sendJSON(res,403,{error:'Нет доступа'});
        const pins=readDmPins();
        if(pinned) pins[key]=messageId; else if(pins[key]===messageId) delete pins[key];
        saveDmPins(pins); sendJSON(res,200,{ok:true,pinnedMessageId:pins[key]||null});
    }catch(e){sendFail(res,e);}
}

/* ========== DM ========== */

function handleDmGet(req, res, query) {
    const me = authUser(req);
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    const user = me.username;
    const withUser = (query.with || '').trim();
    const key = dmKey(user, withUser);
    const dms = readDms();
    let changed = false;
    dms.forEach(m => {
        if (dmKey(m.from, m.to) === key && m.to.toLowerCase() === user.toLowerCase() && m.type !== 'call') {
            if (!m.delivered) { m.delivered = true; changed = true; }
            if (!m.read) { m.read = true; changed = true; }
        }
    });
    if (changed) saveDms(dms);
    const conv = dms.filter(m => dmKey(m.from, m.to) === key);
    const users=readUsers();
    sendJSON(res, 200, { messages: conv.slice(-DM_HISTORY_LIMIT).map(function(m){const u=users.find(function(x){return String(x.username||'').toLowerCase()===String(m.from||'').toLowerCase();});return Object.assign({},m,{fromDisplay:u?adminDisplayName(u):m.from});}), pinnedMessageId: getDmPinnedMessageId(key) });
}
async function handleDmCreate(req, res) {
    try {
        const me = authUser(req);
        if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
        const data = await readBody(req, MAX_BODY_SIZE);
        const cdWait = msgCooldownLeft(me.username); if (cdWait > 0) return cooldownReply(res, cdWait);
        if (String(data.text || '').length > MAX_MESSAGE_LEN) return sendJSON(res, 400, { error: 'Сообщение слишком длинное (до ' + MAX_MESSAGE_LEN + ' символов)' });
        if (String(data.to || '').trim().toLowerCase() === me.username.toLowerCase()) return sendJSON(res, 400, { error: 'Нельзя писать самому себе' });
        const toLower = (data.to || '').trim().toLowerCase();
        const users = readUsers();
        const sender = users.find(u => u.username.toLowerCase() === me.username.toLowerCase());
        const recipient = users.find(u => u.username.toLowerCase() === toLower);
        if (!sender || !recipient) return sendJSON(res, 404, { error: 'Пользователь не найден' });
        if (recipient.system) return sendJSON(res, 403, { error: 'Служебный аккаунт' });
        if ((sender.blocked || []).some(b => b.toLowerCase() === toLower)) return sendJSON(res, 403, { error: 'Вы заблокировали этого пользователя' });
        if ((recipient.blocked || []).some(b => b.toLowerCase() === me.username.toLowerCase())) return sendJSON(res, 403, { error: 'Пользователь заблокировал вас' });
        const isOnline = recipient.lastSeen && (Date.now() - new Date(recipient.lastSeen).getTime() < 35000);
        let videoUrl = '', fileInfo = null;
        if (typeof data.video === 'string' && data.video) {
            { const upRetry = rateLimit(req, 'upload', 30, me.username); if (upRetry) return sendJSON(res, 429, { error: 'Слишком много загрузок, подожди ' + upRetry + ' с' }); }
            const a = saveAttachment(data.video, 'video', '');
            if (!a) return sendJSON(res, 400, { error: 'Видео не принято (форматы mp4, webm, mov, до 20 МБ)' });
            videoUrl = a.url;
        }
        if (data.file && typeof data.file === 'object' && typeof data.file.data === 'string') {
            { const upRetry = rateLimit(req, 'upload', 30, me.username); if (upRetry) return sendJSON(res, 429, { error: 'Слишком много загрузок, подожди ' + upRetry + ' с' }); }
            const fname = String(data.file.name || 'file').replace(/[\\/\r\n<>"]/g, '_').slice(0, 120);
            const a = saveAttachment(data.file.data, 'file', fname);
            if (!a) return sendJSON(res, 400, { error: 'Файл слишком большой (до 20 МБ)' });
            fileInfo = { name: fname, size: a.size, url: a.url };
        }
        const imageUrl = processImageInput(typeof data.image === 'string' ? data.image : '', true);
        if (imageUrl === null) return sendJSON(res, 400, { error: 'Картинка: разрешены PNG, JPG, WEBP или GIF до 5 МБ' });
        if (!(data.text || '').trim() && !imageUrl && !videoUrl && !fileInfo) return sendJSON(res, 400, { error: 'Пустое сообщение' });
        const message = { id: makeId(), from: sender.username, to: recipient.username, text: (data.text || '').trim(), image: imageUrl, video: videoUrl, file: fileInfo, replyTo: data.replyTo && data.replyTo.id ? { id:String(data.replyTo.id), from:String(data.replyTo.from||''), text:String(data.replyTo.text||'').slice(0,500) } : null, delivered: !!isOnline, read: false, createdAt: new Date().toISOString() };
        const dms = readDms();
        msgCooldownMark(me.username);
        dms.push(message);
        saveDms(trimDms(dms));
        sendJSON(res, 201, { message });
    } catch (e) { sendFail(res, e); }
}
function handleDmConversations(req, res, query) {
    const me = authUser(req);
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    const user = me.username.toLowerCase();
    const dms = readDms();
    const users = readUsers();
    const map = {};
    dms.forEach(m => {
        const fromLower = (m.from || '').toLowerCase();
        const toLower = (m.to || '').toLowerCase();
        if (fromLower !== user && toLower !== user) return;
        const partnerName = fromLower === user ? m.to : m.from;
        const partnerLower = partnerName.toLowerCase();
        if (!map[partnerLower]) map[partnerLower] = { partnerUsername: partnerName, lastMessage: m, unread: 0 };
        if (new Date(m.createdAt) > new Date(map[partnerLower].lastMessage.createdAt)) map[partnerLower].lastMessage = m;
        if (toLower === user && !m.read && m.type !== 'call') map[partnerLower].unread++;
    });
    const callLabels = { outgoing: 'Исходящий', incoming: 'Входящий', missed: 'Пропущенный', cancelled: 'Отменён', declined: 'Отклонён' };
    const list = Object.keys(map).map(k => {
        const partner = users.find(u => u.username.toLowerCase() === k);
        const lastMsg = map[k].lastMessage;
        let previewText = lastMsg.text || '';
        if (lastMsg.forwardedFrom) previewText = '↪ ' + previewText;
        if (lastMsg.type === 'call') {
            let label = callLabels[lastMsg.callType] || 'Звонок';
            let durStr = '';
            if (lastMsg.duration > 0) {
                const mm = Math.floor(lastMsg.duration / 60);
                const ss = lastMsg.duration % 60;
                durStr = ' ' + (mm < 10 ? '0' : '') + mm + ':' + (ss < 10 ? '0' : '') + ss;
            }
            previewText = label + durStr;
        }
        if (!previewText && lastMsg.image) previewText = '📷 Фото';
        if (!previewText && lastMsg.video) previewText = '🎬 Видео';
        if (!previewText && lastMsg.file) previewText = '📎 Файл';
        if (lastMsg.system) previewText = String(previewText || 'Системное сообщение').split('\n')[0];
        return { username: partner ? partner.username : map[k].partnerUsername, avatar: partner ? partner.avatar : '', handle: partner ? partner.handle : '', lastText: previewText, lastType: lastMsg.type || '', lastCallType: lastMsg.callType || '', lastSystem: !!lastMsg.system, lastFrom: lastMsg.from, lastAt: lastMsg.createdAt, unread: map[k].unread };
    }).sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));
    sendJSON(res, 200, { conversations: list });
}
function handleDmUnreadCount(req, res, query) {
    const me = authUser(req);
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    const user = me.username.toLowerCase();
    const count = readDms().filter(m => m.to && m.to.toLowerCase() === user && !m.read && m.type !== 'call').length;
    sendJSON(res, 200, { count });
}
async function handleDmDelete(req, res) {
    try {
        const me = authUser(req);
        if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
        const data = await readBody(req);
        const messageId = (data.messageId || '').trim();
        if (!messageId) return sendJSON(res, 400, { error: 'Недостаточно данных' });
        const dms = readDms();
        const idx = dms.findIndex(m => m.id === messageId);
        if (idx === -1) return sendJSON(res, 404, { error: 'Сообщение не найдено' });
        if (dms[idx].system) return sendJSON(res, 403, { error: 'Системное сообщение нельзя удалить' });
        if (!dms[idx].from || dms[idx].from.toLowerCase() !== me.username.toLowerCase()) return sendJSON(res, 403, { error: 'Можно удалять только свои сообщения' });
        dms.splice(idx, 1);
        saveDms(dms);
        sendJSON(res, 200, { ok: true });
    } catch (e) { sendFail(res, e); }
}

/* ========== COMMUNICATION ========== */

function handleCommunication(req, res, query) {
    const me = authUser(req);
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    const user = me.username.toLowerCase();
    const channelsList = readChannels()
        .filter(c => {
            if (c.owner.toLowerCase() === user) return true;
            if ((c.members || []).some(m => m.toLowerCase() === user)) return true;
            return false;
        })
        .map(c => {
            const last = c.messages && c.messages.length ? c.messages[c.messages.length - 1] : null;
            const isOwner = c.owner.toLowerCase() === user;
            return { type: 'channel', id: c.id, username: c.username, name: c.name, avatar: c.avatar || '', members: Array.isArray(c.members) ? c.members.length : 0, isOwner, lastText: last ? last.text : '', lastAt: last ? last.createdAt : c.createdAt, unread: 0 };
        });
    const chatsList = readChats()
        .filter(c => (c.members || []).some(m => m.toLowerCase() === user))
        .map(c => {
            const last = c.messages && c.messages.length ? c.messages[c.messages.length - 1] : null;
            let unread = 0;
            (c.messages || []).forEach(m => {
                if (m.from.toLowerCase() === user) return;
                if (!Array.isArray(m.read)) return;
                if (!m.read.some(u => u.toLowerCase() === user)) unread++;
            });
            return { type: 'chat', id: c.id, name: c.name, avatar: '', members: (c.members || []).length, isOwner: c.owner.toLowerCase() === user, lastText: last ? (last.from + ': ' + last.text) : '', lastAt: last ? last.createdAt : c.createdAt, unread };
        });
    const all = channelsList.concat(chatsList).sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));
    sendJSON(res, 200, { items: all });
}
function handleCommunicationUnreadCount(req, res, query) {
    const me = authUser(req);
    if (!me) return sendJSON(res, 401, { error: 'Не авторизован' });
    const user = me.username.toLowerCase();
    let count = 0;
    readChats().forEach(c => {
        if (!(c.members || []).some(m => m.toLowerCase() === user)) return;
        (c.messages || []).forEach(m => {
            if (m.from.toLowerCase() === user) return;
            if (!Array.isArray(m.read)) return;
            if (!m.read.some(u => u.toLowerCase() === user)) count++;
        });
    });
    sendJSON(res, 200, { count });
}

/* ========== SERVER ========== */

const server = http.createServer(function (req, res) {
    const parsedUrl = parseUrl(req.url, true);
    const url = parsedUrl.pathname;
    const query = parsedUrl.query;

    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS'
        });
        res.end();
        return;
    }

    if (url === '/api/register' && req.method === 'POST') return handleRegister(req, res);
    if (url === '/api/login' && req.method === 'POST') return handleLogin(req, res);
    if (url === '/api/auth/google' && req.method === 'POST') return handleGoogleAuth(req, res);
    if (url === '/api/password-reset/request' && req.method === 'POST') return handlePasswordResetRequest(req, res);
    if (url === '/api/password-reset/confirm' && req.method === 'POST') return handlePasswordResetConfirm(req, res);
    if (url === '/api/logout' && req.method === 'POST') return handleLogout(req, res);
    if (url === '/api/auth/session' && req.method === 'GET') return handleSession(req, res);
    if ((url === '/api/admin/panel' || url === '/api/admin/users') && req.method === 'GET') return handleAdminPanel(req, res);
    if (url === '/api/admin/action' && req.method === 'POST') return handleAdminAction(req, res);

    if (url === '/api/users' && req.method === 'GET') return handleUsersList(req, res);
    if (url === '/api/update-profile' && req.method === 'POST') return handleUpdateProfile(req, res);
    if (url === '/api/users/search' && req.method === 'GET') return handleUserSearch(req, res, query);
    if (url === '/api/user/heartbeat' && req.method === 'POST') return handleHeartbeat(req, res);
    if (url === '/api/user/status' && req.method === 'GET') return handleUserStatus(req, res, query);

    if (url === '/api/call/signal' && req.method === 'POST') return handleCallSignalSend(req, res);
    if (url === '/api/call/poll' && req.method === 'GET') return handleCallSignalPoll(req, res, query);
    if (url === '/api/call/log' && req.method === 'POST') return handleCallLog(req, res);

    if (url === '/api/friends/action' && req.method === 'POST') return handleFriendAction(req, res);
    if (url === '/api/friends/status' && req.method === 'GET') return handleFriendStatus(req, res, query);
    if (url === '/api/friends' && req.method === 'GET') return handleFriendsGet(req, res, query);

    if (url === '/api/users/block' && req.method === 'POST') return handleBlockToggle(req, res);
    if (url === '/api/users/blocked' && req.method === 'GET') return handleBlockedList(req, res, query);
    if (url === '/api/users/block-status' && req.method === 'GET') return handleBlockStatus(req, res, query);

    if (url === '/api/channels' && req.method === 'GET') return handleChannelGet(req, res, query);
    if (url === '/api/channels' && req.method === 'POST') return handleChannelCreate(req, res);
    if (url === '/api/channels/update' && req.method === 'POST') return handleChannelUpdate(req, res);
    if (url === '/api/channels/delete' && req.method === 'POST') return handleChannelDelete(req, res);
    if (url === '/api/channels/subscribe' && req.method === 'POST') return handleChannelSubscribe(req, res);
    if (url === '/api/channels/search' && req.method === 'GET') return handleChannelSearch(req, res, query);
    if (url === '/api/channels/messages' && req.method === 'GET') return handleChannelMessagesGet(req, res, query);
    if (url === '/api/channels/message' && req.method === 'POST') return handleChannelMessageCreate(req, res);
    if (url === '/api/channels/message/reaction' && req.method === 'POST') return handleChannelMessageReaction(req, res);
    if (url === '/api/channels/message/delete' && req.method === 'POST') return handleChannelMessageDelete(req, res);
    if (url === '/api/channels/pin' && req.method === 'POST') return handleChannelPin(req, res);

    if (url === '/api/chats' && req.method === 'GET') return handleChatsGet(req, res, query);
    if (url === '/api/chats' && req.method === 'POST') return handleChatCreate(req, res);
    if (url === '/api/chats/update' && req.method === 'POST') return handleChatUpdate(req, res);
    if (url === '/api/chats/delete' && req.method === 'POST') return handleChatDelete(req, res);
    if (url === '/api/chats/messages' && req.method === 'GET') return handleChatMessagesGet(req, res, query);
    if (url === '/api/chats/message' && req.method === 'POST') return handleChatMessageCreate(req, res);
    if (url === '/api/chats/message/delete' && req.method === 'POST') return handleChatMessageDelete(req, res);
    if (url === '/api/chats/pin' && req.method === 'POST') return handleChatPin(req, res);

    if (url === '/api/posts/feed' && req.method === 'GET') return handleFeedGet(req, res, query);
    if (url === '/api/posts' && req.method === 'GET') return handlePostsGet(req, res, query);
    if (url === '/api/posts' && req.method === 'POST') return handlePostsCreate(req, res);
    if (url === '/api/posts/like' && req.method === 'POST') return handlePostLike(req, res);
    if (url === '/api/posts/comment' && req.method === 'POST') return handlePostComment(req, res);
    if (url === '/api/posts/comments' && req.method === 'GET') return handleCommentsGet(req, res, query);
    if (url === '/api/posts/repost' && req.method === 'POST') return handlePostRepost(req, res);
    if (url === '/api/posts/delete' && req.method === 'POST') return handlePostDelete(req, res);
    if (url === '/api/posts/comment/delete' && req.method === 'POST') return handleCommentDelete(req, res);

    if (url === '/api/dm' && req.method === 'GET') return handleDmGet(req, res, query);
    if (url === '/api/dm' && req.method === 'POST') return handleDmCreate(req, res);
    if (url === '/api/dm/forward' && req.method === 'POST') return handleForward(req, res);
    if (url === '/api/dm/delete' && req.method === 'POST') return handleDmDelete(req, res);
    if (url === '/api/dm/pin' && req.method === 'POST') return handleDmPin(req, res);
    if (url === '/api/dm/conversations' && req.method === 'GET') return handleDmConversations(req, res, query);
    if (url === '/api/dm/unread-count' && req.method === 'GET') return handleDmUnreadCount(req, res, query);

    if (url === '/api/communication' && req.method === 'GET') return handleCommunication(req, res, query);
    if (url === '/api/communication/unread-count' && req.method === 'GET') return handleCommunicationUnreadCount(req, res, query);

    if (url.indexOf('/uploads/') === 0 && req.method === 'GET') return serveUpload(req, res, url);

    if (url === '/' || url === '/index.html') {
        try {
            const html = fs.readFileSync(HTML_FILE, 'utf8');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'", 'Referrer-Policy': 'strict-origin-when-cross-origin' });
            res.end(html);
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('index.html не найден рядом с server.js');
        }
        return;
    }

    sendJSON(res, 404, { error: 'Не найдено' });
});

server.listen(PORT, '0.0.0.0', function () {
    console.log('');
    console.log('🔥 Сервер Hot успешно запущен!');
    console.log('👉 Открой в браузере: http://localhost:' + PORT);
    console.log('');
});
