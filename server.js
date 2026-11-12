'use strict';

const express = require('express');
const path = require('path');
const app = express();
const bcrypt = require('bcryptjs');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');
const sharp = require('sharp');

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');

// القيم تُقرأ من Environment في Render.
const DEPOSIT_BOT_TOKEN = process.env.DEPOSIT_BOT_TOKEN || '';
const ORDERS_BOT_TOKEN = process.env.ORDERS_BOT_TOKEN || '';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '';
const ADMIN_TELEGRAM_USER_ID = process.env.ADMIN_TELEGRAM_USER_ID || '';

const TARGET_ASIACELL_NUMBER = '07738889080';

const production = process.env.NODE_ENV === 'production';

const APP_ORIGIN = new URL(
    process.env.APP_ORIGIN || 'http://localhost:3000'
).origin;

if (production && !APP_ORIGIN.startsWith('https://')) {
    throw new Error('APP_ORIGIN must use HTTPS');
}

const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
    : JSON.parse(
        fs.readFileSync(
            process.env.GOOGLE_APPLICATION_CREDENTIALS ||
            '/etc/secrets/serviceAccountKey.json',
            'utf8'
        )
    );

initializeApp({
    credential: cert(serviceAccount)
});

const db = getFirestore();
const port = Number(process.env.PORT || 3000);

// سنة، وتتجدد مع كل طلب موثّق.
// سجل الجلسة في قاعدة البيانات لا يحمل تاريخ انتهاء تلقائي.
const SESSION_MS = 365 * 24 * 60 * 60 * 1000;

const COOKIE = production
    ? '__Host-panel_session'
    : 'panel_session';

const hash = value => crypto
    .createHash('sha256')
    .update(Buffer.isBuffer(value) ? value : String(value))
    .digest('hex');

const htmlEscape = value => String(value ?? '')
    .replace(/[&<>"']/g, c => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[c]));

const validId = value =>
    typeof value === 'string' &&
    /^[A-Za-z0-9_-]{1,128}$/.test(value);

const money = n => Math.round(Number(n) * 10000) / 10000;

function fail(message, status = 400) {
    const e = new Error(message);
    e.status = status;
    return e;
}

function safeUser(u) {
    return {
        username: u.username,
        email: u.email,
        balance: u.balance || 0,
        role: u.role || 'user'
    };
}

function readCookie(req) {
    const item = String(req.headers.cookie || '')
        .split(';')
        .map(s => s.trim())
        .find(s => s.startsWith(COOKIE + '='));

    const token = item ? item.slice(COOKIE.length + 1) : '';

    return /^[a-f0-9]{64}$/.test(token) ? token : '';
}

async function issueSession(req, res, uid) {
    const token = crypto.randomBytes(32).toString('hex');
    const old = readCookie(req);

    if (old) {
        await db.collection('web_sessions')
            .doc(hash(old))
            .delete();
    }

    await db.collection('web_sessions')
        .doc(hash(token))
        .set({
            uid,
            createdAt: Timestamp.now(),
            persistent: true
        });

    res.cookie(COOKIE, token, {
        httpOnly: true,
        secure: production,
        sameSite: 'strict',
        path: '/',
        maxAge: SESSION_MS
    });
}

async function requireAuth(req, res, next) {
    try {
        const token = readCookie(req);

        if (!token) {
            throw fail('سجّل الدخول أولاً.', 401);
        }

        const session = await db.collection('web_sessions')
            .doc(hash(token))
            .get();

        if (!session.exists || session.data().revoked) {
            throw fail('انتهت الجلسة. سجّل الدخول مجدداً.', 401);
        }

        const legacyExpiry = session.data().expiresAt;

        if (legacyExpiry && legacyExpiry.toMillis() <= Date.now()) {
            throw fail(
                'انتهت الجلسة القديمة؛ سجّل الدخول مرة واحدة.',
                401
            );
        }

        const user = await db.collection('users')
            .doc(session.data().uid)
            .get();

        if (!user.exists || user.data().disabled) {
            throw fail('الحساب غير متاح.', 401);
        }

        req.user = {
            ...safeUser(user.data()),
            id: user.id,
            ref: user.ref
        };

        if (legacyExpiry) {
            // استبدال الجلسة القديمة الصالحة بجلسة دون expiresAt.
            await issueSession(req, res, user.id);
        } else {
            // تجديد كوكي الجلسة دون مطالبة المستخدم بالدخول.
            res.cookie(COOKIE, token, {
                httpOnly: true,
                secure: production,
                sameSite: 'strict',
                path: '/',
                maxAge: SESSION_MS
            });
        }

        next();
    } catch (e) {
        next(e);
    }
}

function requireAdmin(req, res, next) {
    if (req.user.role !== 'admin') {
        return next(fail('ليس لديك صلاحية الإدارة.', 403));
    }

    next();
}

// حدود مشتركة بين عمليات السيرفر.
async function consumeLimit(key, maximum, windowMs) {
    const ref = db.collection('security_limits').doc(hash(key));

    await db.runTransaction(async tx => {
        const snap = await tx.get(ref);
        const now = Date.now();
        const old = snap.exists ? snap.data() : {};
        const active = old.until > now;
        const count = active ? old.count : 0;

        if (count >= maximum) {
            throw fail(
                'محاولات كثيرة، انتظر قليلاً ثم حاول مجدداً.',
                429
            );
        }

        const until = active ? old.until : now + windowMs;

        tx.set(ref, {
            count: count + 1,
            until,
            expiresAt: Timestamp.fromMillis(until)
        });
    });
}

function sensitiveLimit(label, maximum, windowMs, identity) {
    return async (req, res, next) => {
        try {
            await consumeLimit(
                label + ':ip:' + req.ip,
                maximum * 3,
                windowMs
            );

            await consumeLimit(
                label + ':identity:' + identity(req),
                maximum,
                windowMs
            );

            next();
        } catch (e) {
            next(e);
        }
    };
}

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((req, res, next) => {
    res.set({
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'same-origin',
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
        'Cross-Origin-Resource-Policy': 'same-origin'
    });

    if (production) {
        res.set('Strict-Transport-Security', 'max-age=31536000');
    }

    res.set(
        'Content-Security-Policy',
        "default-src 'self'; " +
        "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://cdn.tailwindcss.com https://www.gstatic.com; " +
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; " +
        "font-src 'self' data: https://fonts.gstatic.com https://cdnjs.cloudflare.com; " +
        "img-src 'self' data: https:; " +
        "connect-src 'self'; " +
        "object-src 'none'; " +
        "base-uri 'self'; " +
        "frame-ancestors 'none'; " +
        "form-action 'self'"
    );

    if (req.path.startsWith('/api/')) {
        res.set('Cache-Control', 'no-store');
    }

    next();
});

const traffic = new Map();

setInterval(() => {
    const now = Date.now();

    for (const [key, v] of traffic) {
        if (v.until < now) {
            traffic.delete(key);
        }
    }
}, 60000).unref();

app.use('/api', (req, res, next) => {
    const key = req.ip;
    const now = Date.now();

    let item = traffic.get(key);

    if (!item || item.until < now) {
        if (traffic.size > 20000) {
            return res.status(503).json({
                success: false,
                message: 'الخادم مشغول.'
            });
        }

        item = {
            count: 0,
            until: now + 60000
        };

        traffic.set(key, item);
    }

    if (++item.count > 120) {
        return res.status(429).json({
            success: false,
            message: 'محاولات كثيرة، انتظر دقيقة.'
        });
    }

    next();
});

app.use(express.json({
    limit: '32kb',
    strict: true
}));

app.use(express.urlencoded({
    extended: false,
    limit: '32kb',
    parameterLimit: 30
}));

app.use('/api', (req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        if (
            req.headers.origin !== APP_ORIGIN ||
            req.headers['sec-fetch-site'] === 'cross-site'
        ) {
            return next(fail('مصدر الطلب غير مسموح.', 403));
        }
    }

    if (
        req.body &&
        (Array.isArray(req.body) || typeof req.body !== 'object')
    ) {
        return next(fail('بيانات الطلب غير صالحة.'));
    }

    next();
});

app.get('/healthz', (req, res) => {
    res.json({ ok: true });
});

app.use('/api/admin', requireAuth, requireAdmin);

app.use(
    '/api/asiacell',
    requireAuth,
    sensitiveLimit('asiacell', 20, 15 * 60000, req => req.user.id)
);

app.use(
    '/api/instagram',
    requireAuth,
    sensitiveLimit('instagram', 15, 10 * 60000, req => req.user.id)
);

app.use('/api/order', requireAuth);
app.use('/api/orders', requireAuth);
app.use('/api/user', requireAuth);
app.use('/api/deposit', requireAuth);

app.use('/api/wayl', (req, res) => {
    res.status(410).json({
        success: false,
        message: 'بوابة Wayl متوقفة.'
    });
});

// ضع index.html والصور العامة داخل public فقط.
app.use(express.static(path.join(__dirname, 'public'), {
    dotfiles: 'deny',
    index: 'index.html'
}));

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 5 * 1024 * 1024,
        files: 1,
        fields: 8,
        parts: 10
    },
    fileFilter: (req, file, cb) => {
        cb(null, [
            'image/jpeg',
            'image/png',
            'image/webp'
        ].includes(file.mimetype));
    }
});

function getFormattedDateTime() {
    const now = new Date();

    return now.toLocaleString('ar-IQ', {
        timeZone: 'Asia/Baghdad',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
    });
}

function formatSafeDate(val) {
    if (!val) return getFormattedDateTime();
    if (typeof val === 'string') return val;

    if (typeof val.toDate === 'function') {
        return val.toDate().toLocaleString('ar-IQ', {
            timeZone: 'Asia/Baghdad',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
        });
    }

    if (val._seconds || val.seconds) {
        return new Date(
            (val._seconds || val.seconds) * 1000
        ).toLocaleString('ar-IQ', {
            timeZone: 'Asia/Baghdad',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
        });
    }

    return getFormattedDateTime();
}

// Telegram

async function telegram(token, method, payload) {
    if (!token) return null;

    try {
        const response = await fetch(
            `https://api.telegram.org/bot${token}/${method}`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(12000)
            }
        );

        const data = await response.json();
        return data.ok ? data.result : null;
    } catch {
        console.error('Telegram request failed');
        return null;
    }
}

async function sendTelegramTextMessage(
    token,
    chatId,
    text,
    replyMarkup = null
) {
    const result = await telegram(token, 'sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    });

    return result?.message_id || null;
}

function answerCallbackQuery(token, id, text) {
    return telegram(token, 'answerCallbackQuery', {
        callback_query_id: id,
        text
    });
}

function editTelegramTextMessage(
    token,
    chatId,
    messageId,
    text,
    markup = { inline_keyboard: [] }
) {
    return telegram(token, 'editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: markup
    });
}

function buildOrderTelegramMessage(id, o) {
    const current = o.current_count ?? o.start_count;

    const counter = o.start_count == null
        ? ''
        : `\n📊 العدد: ${o.start_count}/${current} — الهدف: ${o.target_count}${o.account_private ? '\n⚠️ الحساب خاص' : ''}`;

    return `🚀 <b>طلب خدمة</b>\n🆔 ${htmlEscape(id)}\n👤 ${htmlEscape(o.username)}\n📌 ${htmlEscape(o.service)}\n🔗 ${htmlEscape(o.link)}\n📦 ${o.quantity}\n💵 $${Number(o.charge).toFixed(4)}${counter}\n🕒 ${htmlEscape(formatSafeDate(o.created_at))}\nالحالة: <b>${htmlEscape(o.status)}</b>`;
}

function getOrderMarkup(id, status) {
    if (['مكتمل', 'ملغي'].includes(status)) {
        return { inline_keyboard: [] };
    }

    return {
        inline_keyboard: [[
            ...(status === 'قيد التنفيذ' ? [] : [{
                text: '🔄 قيد التنفيذ',
                callback_data: `ord_progress_${id}`
            }]),
            {
                text: '✔️ تم الاكتمال',
                callback_data: `ord_complete_${id}`
            },
            {
                text: '❌ إلغاء واسترجاع',
                callback_data: `ord_cancel_${id}`
            }
        ]]
    };
}

async function handleTelegramCallback(token, cb) {
    if (
        String(cb.from?.id) !== ADMIN_TELEGRAM_USER_ID ||
        String(cb.message?.chat?.id) !== ADMIN_CHAT_ID
    ) {
        return;
    }

    const data = String(cb.data || '');

    const match = data.match(
        /^(dep_accept|dep_reject|ord_progress|ord_complete|ord_cancel)_([A-Za-z0-9_-]{1,100})$/
    );

    if (!match) return;

    const [, action, id] = match;

    if (action.startsWith('dep_') && token !== DEPOSIT_BOT_TOKEN) {
        return;
    }

    if (action.startsWith('ord_') && token !== ORDERS_BOT_TOKEN) {
        return;
    }

    await answerCallbackQuery(
        token,
        cb.id,
        'جاري تنفيذ الطلب...'
    );

    if (action.startsWith('dep_')) {
        const ref = db.collection('deposit_requests').doc(id);

        const result = await db.runTransaction(async tx => {
            const snap = await tx.get(ref);

            if (!snap.exists || snap.data().status !== 'معلق') {
                return null;
            }

            const d = snap.data();

            if (!validId(d.user_id)) {
                throw fail('طلب قديم يحتاج مراجعة يدوية.');
            }

            if (action === 'dep_reject') {
                tx.update(ref, { status: 'مرفوض' });
                return { status: 'مرفوض' };
            }

            const userRef = db.collection('users').doc(d.user_id);
            const user = await tx.get(userRef);

            const amount = Number(d.amount);
            const balance = Number(user.data()?.balance || 0);

            if (
                !user.exists ||
                !Number.isFinite(amount) ||
                amount <= 0 ||
                !Number.isFinite(balance)
            ) {
                throw fail('بيانات الرصيد غير صالحة.');
            }

            tx.update(userRef, {
                balance: money(balance + amount)
            });

            tx.update(ref, {
                status: 'مقبول'
            });

            return {
                status: 'مقبول',
                amount
            };
        });

        if (result) {
            await editTelegramTextMessage(
                token,
                ADMIN_CHAT_ID,
                cb.message.message_id,
                `طلب الشحن ${htmlEscape(id)}\nالحالة: ${result.status}${result.amount ? '\nالمبلغ: $' + result.amount : ''}`
            );
        }

        return;
    }

    const ref = db.collection('orders').doc(id);

    const updated = await db.runTransaction(async tx => {
        const snap = await tx.get(ref);

        if (
            !snap.exists ||
            ['مكتمل', 'ملغي'].includes(snap.data().status)
        ) {
            return null;
        }

        const o = snap.data();

        const status = action === 'ord_cancel'
            ? 'ملغي'
            : action === 'ord_complete'
                ? 'مكتمل'
                : 'قيد التنفيذ';

        if (action === 'ord_cancel') {
            if (!validId(o.user_id)) {
                throw fail('طلب قديم يحتاج مراجعة يدوية.');
            }

            const uref = db.collection('users').doc(o.user_id);
            const u = await tx.get(uref);

            const amount = Number(o.charge);
            const balance = Number(u.data()?.balance || 0);

            if (
                !u.exists ||
                !Number.isFinite(amount) ||
                amount < 0 ||
                !Number.isFinite(balance)
            ) {
                throw fail('تعذر استرجاع الرصيد.');
            }

            tx.update(uref, {
                balance: money(balance + amount)
            });
        }

        const patch = {
            status,
            tg_message_id: cb.message.message_id
        };

        if (action === 'ord_complete') {
            patch.completion_notified = true;
        }

        tx.update(ref, patch);

        return {
            ...o,
            ...patch
        };
    });

    if (updated) {
        await editTelegramTextMessage(
            token,
            ADMIN_CHAT_ID,
            cb.message.message_id,
            buildOrderTelegramMessage(id, updated),
            getOrderMarkup(id, updated.status)
        );
    }
}

function startTelegramPolling(token) {
    if (!token || !ADMIN_CHAT_ID || !ADMIN_TELEGRAM_USER_ID) {
        return;
    }

    let offset = 0;
    let busy = false;

    setInterval(async () => {
        if (busy) return;
        busy = true;

        try {
            const updates = await telegram(token, 'getUpdates', {
                offset,
                timeout: 5,
                allowed_updates: ['callback_query']
            });

            for (const u of updates || []) {
                if (u.callback_query) {
                    try {
                        await handleTelegramCallback(
                            token,
                            u.callback_query
                        );
                    } catch {
                        console.error('Telegram action failed');
                    }
                }

                offset = u.update_id + 1;
            }
        } finally {
            busy = false;
        }
    }, 2500).unref();
}

if (process.env.ENABLE_BACKGROUND_JOBS !== 'false') {
    startTelegramPolling(DEPOSIT_BOT_TOKEN);
    startTelegramPolling(ORDERS_BOT_TOKEN);
}

// Instagram

function extractInstagramUsername(input) {
    const raw = String(input || '').trim();

    if (!raw) return null;

    if (
        /^@?[a-zA-Z0-9._]{1,30}$/.test(raw) &&
        !raw.includes('/')
    ) {
        return raw.replace(/^@/, '');
    }

    try {
        const normalized = /^https?:\/\//i.test(raw)
            ? raw
            : `https://${raw}`;

        const u = new URL(normalized);

        if (
            !['instagram.com', 'www.instagram.com'].includes(
                u.hostname.toLowerCase()
            ) ||
            u.username ||
            u.password ||
            u.port ||
            !['https:', 'http:'].includes(u.protocol)
        ) {
            return null;
        }

        const segments = u.pathname.split('/').filter(Boolean);

        if (segments.length !== 1) return null;

        const reserved = [
            'p',
            'reel',
            'reels',
            'tv',
            'stories',
            'explore',
            'accounts',
            'direct',
            'share'
        ];

        if (reserved.includes(segments[0].toLowerCase())) {
            return null;
        }

        const cleanUser = segments[0].replace(/^@/, '');

        return /^[a-zA-Z0-9._]{1,30}$/.test(cleanUser)
            ? cleanUser
            : null;
    } catch {
        return null;
    }
}

function parseCompactCount(str) {
    if (!str) return NaN;

    const clean = String(str)
        .trim()
        .replace(/,/g, '')
        .toUpperCase();

    let mult = 1;

    if (clean.endsWith('K')) mult = 1000;
    else if (clean.endsWith('M')) mult = 1000000;

    const num = parseFloat(clean.replace(/[KM]/g, ''));

    return isNaN(num) ? NaN : Math.round(num * mult);
}

async function checkInstagramProfile(link) {
    const igUser = extractInstagramUsername(link);

    if (!igUser) {
        return {
            valid: false,
            message: '❌ الرابط خطأ! يرجى وضع رابط حساب انستقرام صحيح (مثال: https://instagram.com/username).'
        };
    }

    const cacheBuster = Date.now();

    try {
        const response = await axios.get(
            `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(igUser)}&_=${cacheBuster}`,
            {
                headers: {
                    'x-ig-app-id': '936619743392459',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                    'Accept': '*/*',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    'Pragma': 'no-cache',
                    'Referer': `https://www.instagram.com/${igUser}/`
                },
                timeout: 10000,
                maxRedirects: 0,
                maxContentLength: 2 * 1024 * 1024,
                validateStatus: () => true
            }
        );

        if (
            response.status === 404 ||
            (
                response.status === 200 &&
                response.data &&
                response.data.data &&
                response.data.data.user === null
            )
        ) {
            return {
                valid: false,
                message: '❌ الرابط خطأ! هذا الحساب غير موجود في انستقرام.'
            };
        }

        const user = response.data?.data?.user;

        if (
            user &&
            typeof user.is_private === 'boolean' &&
            Number.isSafeInteger(user.edge_followed_by?.count) &&
            user.edge_followed_by.count >= 0
        ) {
            return {
                valid: true,
                username: igUser,
                isPrivate: Boolean(user.is_private),
                followers: Number(user.edge_followed_by?.count ?? 0)
            };
        }
    } catch {}

    try {
        const mobileRes = await axios.get(
            `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(igUser)}&_=${cacheBuster}`,
            {
                headers: {
                    'x-ig-app-id': '936619743392459',
                    'User-Agent': 'Instagram 275.0.0.27.98 Android (33/13; 420dpi; 1080x2400; samsung; SM-G991B; o1s; exynos2100; en_US; 458229237)',
                    'Cache-Control': 'no-cache'
                },
                timeout: 10000,
                maxRedirects: 0,
                maxContentLength: 2 * 1024 * 1024,
                validateStatus: () => true
            }
        );

        if (mobileRes.status === 404) {
            return {
                valid: false,
                message: '❌ الرابط خطأ! هذا الحساب غير موجود في انستقرام.'
            };
        }

        const mUser = mobileRes.data?.data?.user;

        if (
            mUser &&
            typeof mUser.is_private === 'boolean' &&
            Number.isSafeInteger(
                mUser.edge_followed_by?.count ?? mUser.follower_count
            ) &&
            (mUser.edge_followed_by?.count ?? mUser.follower_count) >= 0
        ) {
            return {
                valid: true,
                username: igUser,
                isPrivate: Boolean(mUser.is_private),
                followers: Number(
                    mUser.edge_followed_by?.count ??
                    mUser.follower_count ??
                    0
                )
            };
        }
    } catch {}

    try {
        const pageRes = await axios.get(
            `https://www.instagram.com/${encodeURIComponent(igUser)}/?_=${cacheBuster}`,
            {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Cache-Control': 'no-cache'
                },
                timeout: 10000,
                maxRedirects: 0,
                maxContentLength: 2 * 1024 * 1024,
                validateStatus: () => true
            }
        );

        const html = String(pageRes.data || '');

        if (
            pageRes.status === 404 ||
            html.includes('Page Not Found') ||
            html.includes("Sorry, this page isn't available")
        ) {
            return {
                valid: false,
                message: '❌ الرابط خطأ! هذا الحساب غير موجود في انستقرام.'
            };
        }

        const isPriv =
            html.includes('"is_private":true') ||
            html.includes('This Account is Private');

        const exactJsonMatch = html.match(
            /"edge_followed_by":\{"count":(\d+)\}/
        );

        if (
            exactJsonMatch &&
            /"is_private":(?:true|false)/.test(html)
        ) {
            return {
                valid: true,
                username: igUser,
                isPrivate: isPriv,
                followers: parseInt(exactJsonMatch[1], 10)
            };
        }
    } catch {}

    return {
        valid: false,
        unreachable: true,
        message: '⚠️ تعذر قراءة بيانات الحساب من انستقرام حالياً، تأكد من صحة الرابط وحاول مجدداً.'
    };
}

app.post('/api/instagram/check', async (req, res) => {
    const info = await checkInstagramProfile(req.body.link);

    if (!info.valid) {
        return res.status(400).json({
            success: false,
            message: info.message
        });
    }

    if (info.isPrivate) {
        return res.status(400).json({
            success: false,
            isPrivate: true,
            message: '🔒 حسابك خاص! قم بتحويله إلى عام (Public) ثم اطلب من جديد.'
        });
    }

    return res.json({
        success: true,
        username: info.username,
        followers: info.followers,
        message: `✅ الحساب عام وجاهز | عدد المتابعين الحالي: ${info.followers}`
    });
});

let isMonitoringOrders = false;

async function syncSingleOrderCount(doc) {
    const ord = doc.data();

    if (
        !ord.ig_username ||
        ord.start_count === null ||
        ord.start_count === undefined
    ) {
        return;
    }

    if (ord.status === 'مكتمل' || ord.status === 'ملغي') {
        return;
    }

    const now = Date.now();

    if (
        ord.last_checked_ms &&
        now - ord.last_checked_ms < 600000
    ) {
        return;
    }

    const check = await checkInstagramProfile(
        `https://www.instagram.com/${htmlEscape(ord.ig_username)}/`
    );

    await doc.ref.update({
        last_checked_ms: now
    }).catch(() => {});

    if (!check.valid) return;

    if (check.isPrivate) {
        if (!ord.account_private || !ord.private_notified) {
            await doc.ref.update({
                account_private: true,
                private_notified: true
            });

            await sendTelegramTextMessage(
                ORDERS_BOT_TOKEN,
                ADMIN_CHAT_ID,
                `⚠️ <b>تنبيه مراقبة الحساب!</b>\n\nالمستخدم <b>${htmlEscape(ord.username)}</b> قام بتحويل حسابه (<code>@${htmlEscape(ord.ig_username)}</code>) إلى <b>خاص (Private)</b> أثناء تنفيذ الطلب <code>#${doc.id.substring(0, 6)}</code>!\n🔗 الرابط: ${htmlEscape(ord.link)}`
            );

            if (ord.tg_message_id) {
                editTelegramTextMessage(
                    ORDERS_BOT_TOKEN,
                    ADMIN_CHAT_ID,
                    ord.tg_message_id,
                    buildOrderTelegramMessage(doc.id, {
                        ...ord,
                        account_private: true
                    }),
                    getOrderMarkup(doc.id, ord.status)
                );
            }
        }

        return;
    }

    const newCurrent = check.followers;

    const target = ord.target_count ??
        (Number(ord.start_count) + Number(ord.quantity));

    const isCompletedNow = newCurrent >= target;
    const nextStatus = isCompletedNow ? 'مكتمل' : ord.status;

    const hasChanged =
        newCurrent !== ord.current_count ||
        ord.account_private === true ||
        isCompletedNow;

    if (!hasChanged) return;

    let sendCompletionAlert = false;

    await db.runTransaction(async tx => {
        const freshDoc = await tx.get(doc.ref);

        if (!freshDoc.exists) return;

        const freshData = freshDoc.data();

        if (
            freshData.status === 'مكتمل' ||
            freshData.status === 'ملغي'
        ) {
            return;
        }

        const updates = {
            current_count: newCurrent,
            account_private: false,
            private_notified: false,
            status: nextStatus
        };

        if (isCompletedNow && !freshData.completion_notified) {
            updates.completion_notified = true;
            sendCompletionAlert = true;
        }

        tx.update(doc.ref, updates);
    });

    if (ord.tg_message_id) {
        const updatedView = {
            ...ord,
            current_count: newCurrent,
            account_private: false,
            status: nextStatus
        };

        editTelegramTextMessage(
            ORDERS_BOT_TOKEN,
            ADMIN_CHAT_ID,
            ord.tg_message_id,
            buildOrderTelegramMessage(doc.id, updatedView),
            getOrderMarkup(doc.id, nextStatus)
        );
    }

    if (sendCompletionAlert) {
        await sendTelegramTextMessage(
            ORDERS_BOT_TOKEN,
            ADMIN_CHAT_ID,
            `🎉 <b>إشعار اكتمال العدد المطلوب!</b>\n\nحساب انستقرام (<code>@${htmlEscape(ord.ig_username)}</code>) وصل إلى العدد المطلوب بنجاح.\n👤 <b>المستخدم:</b> ${htmlEscape(ord.username)}\n🆔 <b>رقم الطلب:</b> #${doc.id.substring(0, 6)}\n📊 <b>العداد النهائي:</b> ${ord.start_count}/${newCurrent} (المطلوب: ${target})\n✅ <b>الحالة الآن:</b> مكتمل`
        );
    }
}

async function monitorActiveInstagramOrders() {
    if (isMonitoringOrders) return;

    isMonitoringOrders = true;

    try {
        const snap = await db.collection('orders')
            .where('status', 'in', [
                'قيد المعالجة',
                'قيد التنفيذ'
            ])
            .get();

        for (const doc of snap.docs) {
            await syncSingleOrderCount(doc);
        }
    } catch (err) {
        console.error('خطأ في المراقبة المباشرة:', err.message);
    } finally {
        isMonitoringOrders = false;
    }
}

if (process.env.ENABLE_BACKGROUND_JOBS !== 'false') {
    setInterval(
        monitorActiveInstagramOrders,
        600000
    ).unref();
}

// Asiacell

async function callAsiacellAPI(
    endpoint,
    method = 'POST',
    bodyData = null,
    accessToken = null,
    deviceId = null,
    cookies = '',
    appVersion = '5.8.0'
) {
    const currentDeviceId = deviceId || crypto.randomUUID();

    const headers = {
        'Accept': 'application/json, text/plain, */*',
        'X-ODP-API-KEY': '1ccbc4c913bc4ce785a0a2de444aa0d6',
        'DeviceID': currentDeviceId,
        'X-OS-Version': '14',
        'X-Device-Type': 'Android',
        'X-ODP-APP-VERSION': appVersion,
        'X-ODP-CHANNEL': 'MOBILE',
        'Accept-Language': 'ar',
        'User-Agent': 'okhttp/4.11.0',
        'X-Forwarded-For': '37.236.100.15',
        'Client-IP': '37.236.100.15'
    };

    if (method !== 'GET') {
        headers['Content-Type'] = 'application/json; charset=UTF-8';
    }

    if (accessToken) {
        headers['Authorization'] =
            `Bearer ${String(accessToken).replace(/^Bearer\s+/i, '').trim()}`;
    }

    if (cookies) {
        headers['Cookie'] = cookies;
    }

    const cleanEp = endpoint.replace(/^\/+/, '');

    const url = cleanEp.startsWith('http')
        ? cleanEp
        : cleanEp.startsWith('api/')
            ? `https://odpapp.asiacell.com/${cleanEp}`
            : `https://odpapp.asiacell.com/api/v1/${cleanEp}`;

    const checkedURL = new URL(url);

    if (
        checkedURL.protocol !== 'https:' ||
        ![
            'odpapp.asiacell.com',
            'app.asiacell.com'
        ].includes(checkedURL.hostname) ||
        checkedURL.port ||
        checkedURL.username ||
        checkedURL.password ||
        !checkedURL.pathname.startsWith('/api/')
    ) {
        throw fail('عنوان خدمة آسياسيل غير صالح.');
    }

    const response = await fetch(url, {
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
        method,
        headers,
        body: method !== 'GET' && bodyData
            ? typeof bodyData === 'string'
                ? bodyData
                : JSON.stringify(bodyData)
            : undefined
    });

    let newCookies = cookies;

    if (typeof response.headers.getSetCookie === 'function') {
        const list = response.headers.getSetCookie();

        if (list?.length) {
            newCookies = list
                .map(c => c.split(';')[0].trim())
                .join('; ');
        }
    } else {
        const sc = response.headers.get('set-cookie');

        if (sc) {
            newCookies = sc
                .split(/,(?=\s*[a-zA-Z0-9_-]+=)/)
                .map(c => c.split(';')[0].trim())
                .join('; ');
        }
    }

    const text = await response.text();

    const isWafBlocked =
        text.includes('Access Blocked') ||
        text.includes('<!DOCTYPE html');

    let json = {};

    if (!isWafBlocked) {
        try {
            json = JSON.parse(text);
        } catch {
            json = { rawText: text };
        }
    } else {
        json = {
            wafBlocked: true,
            message: 'WAF Access Blocked'
        };
    }

    return {
        status: response.status,
        ok: response.ok,
        isWafBlocked,
        data: json,
        rawText: text,
        deviceId: currentDeviceId,
        cookies: newCookies
    };
}

function extractLoginSessionInfo(obj) {
    const result = {
        pid: '',
        validationUrl: ''
    };

    if (!obj || typeof obj !== 'object') return result;

    const str = JSON.stringify(obj);

    const urlMatch = str.match(
        /https?:\/\/[^"'\s]+(?:smsvalidation|verify|otp|confirm)[^"'\s]*/i
    );

    if (urlMatch) {
        result.validationUrl = urlMatch[0];
    }

    const pidInUrl = str.match(
        /[?&](?:PID|pid|processId|requestId|transactionId)=([a-zA-Z0-9_-]+)/
    );

    if (pidInUrl) {
        result.pid = pidInUrl[1];
    }

    function searchKeys(o) {
        for (const [k, v] of Object.entries(o)) {
            if (v && typeof v === 'object') {
                searchKeys(v);
            } else if (
                typeof v === 'string' ||
                typeof v === 'number'
            ) {
                const keyLower = k.toLowerCase();

                if (
                    !result.pid &&
                    [
                        'pid',
                        'processid',
                        'requestid',
                        'transactionid',
                        'referenceid'
                    ].includes(keyLower)
                ) {
                    result.pid = String(v);
                }

                if (
                    !result.validationUrl &&
                    (
                        keyLower.includes('url') ||
                        keyLower.includes('link') ||
                        keyLower.includes('endpoint')
                    ) &&
                    /smsvalidation|verify|otp/i.test(String(v))
                ) {
                    result.validationUrl = String(v);
                }
            }
        }
    }

    searchKeys(obj);
    return result;
}

app.post('/api/asiacell/send-otp', async (req, res) => {
    const cleanPhone = String(req.body.phone || '').trim();

    if (!/^077\d{8}$/.test(cleanPhone)) {
        return res.status(400).json({
            success: false,
            message: 'رقم الهاتف غير صالح.'
        });
    }

    try {
        await consumeLimit(
            'otp-phone:' + cleanPhone,
            3,
            15 * 60000
        );

        const loginRef = db.collection('asiacell_sessions')
            .doc(req.user.id + '_' + cleanPhone);

        await db.runTransaction(async tx => {
            const old = await tx.get(loginRef);

            if (old.exists) {
                const state = old.data();

                if ([
                    'STARTING_TRANSFER',
                    'WAIT_TRANSFER_OTP',
                    'CONFIRMING_TRANSFER',
                    'TRANSFER_REVIEW',
                    'TRANSFER_CONFIRMED',
                    'CREDIT_REVIEW'
                ].includes(state.step)) {
                    throw fail(
                        'توجد عملية تحويل لم تُغلق بعد؛ راجع الإدارة قبل إنشاء جلسة جديدة.'
                    );
                }

                if (
                    [
                        'SENDING_LOGIN_OTP',
                        'VERIFYING_LOGIN'
                    ].includes(state.step) &&
                    Date.now() - state.updatedAt < 120000
                ) {
                    throw fail('طلب الرمز قيد التنفيذ.');
                }
            }

            tx.set(loginRef, {
                ownerId: req.user.id,
                step: 'SENDING_LOGIN_OTP',
                updatedAt: Date.now()
            });
        });

        const result = await callAsiacellAPI(
            'login?lang=ar',
            'POST',
            {
                username: cleanPhone,
                captchaCode: ''
            }
        );

        const info = extractLoginSessionInfo(result.data);

        if (
            result.ok &&
            !result.isWafBlocked &&
            result.data?.success !== false &&
            info.pid
        ) {
            await loginRef.set({
                ownerId: req.user.id,
                phone: cleanPhone,
                pid: info.pid,
                validationUrl: info.validationUrl,
                deviceId: result.deviceId,
                cookies: result.cookies || '',
                step: 'WAIT_LOGIN_OTP',
                updatedAt: Date.now()
            });

            return res.json({
                success: true,
                message: `✅ تم
