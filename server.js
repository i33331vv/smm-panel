const express = require('express');
const path = require('path');
const app = express();
const bcrypt = require('bcryptjs');
const multer = require('multer');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const axios = require('axios');

const DEPOSIT_BOT_TOKEN = '9075969471:AAH_G_KMD7S8rbMibf663_PavR41zb1dEhM';
const ORDERS_BOT_TOKEN = '9023175997:AAGuvzz3eLywKIBkTjs3w9NCVnmutRblCEc';
const ADMIN_CHAT_ID = '8671448765';
const TARGET_ASIACELL_NUMBER = '07738889080';

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const serviceAccount = require('./serviceAccountKey.json');

initializeApp({
    credential: cert(serviceAccount)
});

const db = getFirestore();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const port = process.env.PORT || 3000;

const storage = multer.diskStorage({
    destination: (req, file, cb) => { cb(null, __dirname); },
    filename: (req, file, cb) => { cb(null, 'receipt_' + Date.now() + path.extname(file.originalname)); }
});
const upload = multer({ storage: storage });

app.use(express.static(__dirname));
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

function getFormattedDateTime() {
    const now = new Date();
    return now.toLocaleString('ar-IQ', {
        timeZone: 'Asia/Baghdad',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: true
    });
}

function formatSafeDate(val) {
    if (!val) return getFormattedDateTime();
    if (typeof val === 'string') return val;
    if (typeof val.toDate === 'function') {
        return val.toDate().toLocaleString('ar-IQ', {
            timeZone: 'Asia/Baghdad',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hour12: true
        });
    }
    if (val._seconds || val.seconds) {
        return new Date((val._seconds || val.seconds) * 1000).toLocaleString('ar-IQ', {
            timeZone: 'Asia/Baghdad',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hour12: true
        });
    }
    return getFormattedDateTime();
}

function getFileHash(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', data => hash.update(data));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', err => reject(err));
    });
}

// ==========================================================
// 🤖 دوال التليجرام وبناء رسائل الطلبات والعداد
// ==========================================================

function sendTelegramTextMessage(token, chatId, text, replyMarkup = null) {
    return new Promise((resolve) => {
        const payload = { chat_id: chatId, text: text, parse_mode: 'HTML', disable_web_page_preview: true };
        if (replyMarkup) payload.reply_markup = replyMarkup;
        const data = JSON.stringify(payload);
        const options = {
            hostname: 'api.telegram.org',
            path: `/bot${token}/sendMessage`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
        };
        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(body);
                    resolve(parsed.result ? parsed.result.message_id : null);
                } catch (e) { resolve(null); }
            });
        });
        req.on('error', (e) => { console.error(e); resolve(null); });
        req.write(data);
        req.end();
    });
}

function answerCallbackQuery(token, callbackQueryId, text) {
    const data = JSON.stringify({ callback_query_id: callbackQueryId, text: text, show_alert: false });
    const options = { hostname: 'api.telegram.org', path: `/bot${token}/answerCallbackQuery`, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } };
    const req = https.request(options);
    req.on('error', () => {});
    req.write(data);
    req.end();
}

function editTelegramTextMessage(token, chatId, messageId, newText, replyMarkup = { inline_keyboard: [] }) {
    const data = JSON.stringify({ chat_id: chatId, message_id: messageId, text: newText, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: replyMarkup });
    const options = { hostname: 'api.telegram.org', path: `/bot${token}/editMessageText`, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } };
    const req = https.request(options);
    req.on('error', () => {});
    req.write(data);
    req.end();
}

function buildOrderTelegramMessage(orderId, order) {
    let counterLine = '';
    if (order.start_count !== null && order.start_count !== undefined) {
        const current = order.current_count ?? order.start_count;
        const target = order.target_count ?? (Number(order.start_count) + Number(order.quantity));
        if (order.status === 'مكتمل') {
            counterLine = `\n📊 <b>عدد حسابك هو:</b> ${order.start_count}/${current} — <b>العدد مكتمل ✅</b>`;
        } else if (order.account_private) {
            counterLine = `\n📊 <b>عدد حسابك هو:</b> ${order.start_count}/${current} (الهدف: ${target})\n⚠️ <b>تنبيه: الحساب تحول إلى خاص!</b>`;
        } else {
            counterLine = `\n📊 <b>عدد حسابك هو:</b> ${order.start_count}/${current} (الهدف: ${target})`;
        }
    }

    let statusBadge = `🔄 <b>الحالة: ${order.status || 'قيد المعالجة'}</b>`;
    if (order.status === 'مكتمل') statusBadge = `✅ <b>الحالة: مكتمل</b>`;
    else if (order.status === 'ملغي') statusBadge = `❌ <b>الحالة: ملغي</b>`;
    else if (order.account_private) statusBadge = `⚠️ <b>الحالة: متوقف مؤقتاً (الحساب خاص)</b>`;

    return `🚀 <b>طلب خدمة جديد</b>\n\n🆔 <b>رقم الطلب:</b> #${orderId}\n👤 <b>المستخدم:</b> ${order.username}\n📌 <b>الخدمة:</b> ${order.service}\n🔗 <b>الرابط:</b> ${order.link}\n📦 <b>الكمية:</b> ${order.quantity}\n💵 <b>السعر:</b> $${Number(order.charge || 0).toFixed(4)}${counterLine}\n🕒 <b>التاريخ والوقت:</b> ${formatSafeDate(order.created_at)}\n\n${statusBadge}`;
}

function getOrderMarkup(orderId, status) {
    if (status === 'مكتمل' || status === 'ملغي') {
        return { inline_keyboard: [] };
    }
    if (status === 'قيد التنفيذ') {
        return {
            inline_keyboard: [[
                { text: '✔️ تم الاكتمال', callback_data: `ord_complete_${orderId}` },
                { text: '❌ إلغاء واسترجاع', callback_data: `ord_cancel_${orderId}` }
            ]]
        };
    }
    return {
        inline_keyboard: [[
            { text: '🔄 قيد التنفيذ', callback_data: `ord_progress_${orderId}` },
            { text: '✔️ تم الاكتمال', callback_data: `ord_complete_${orderId}` },
            { text: '❌ إلغاء واسترجاع', callback_data: `ord_cancel_${orderId}` }
        ]]
    };
}

function startTelegramPolling(token) {
    let offset = 0;
    setInterval(() => {
        https.get(`https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=5`, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', async () => {
                try {
                    const data = JSON.parse(body);
                    if (data.ok && data.result.length > 0) {
                        for (const update of data.result) {
                            offset = update.update_id + 1;
                            if (update.callback_query) {
                                const callbackQuery = update.callback_query;
                                const cbData = callbackQuery.data || '';
                                const chatId = callbackQuery.message.chat.id;
                                const messageId = callbackQuery.message.message_id;

                                answerCallbackQuery(token, callbackQuery.id, 'جاري تنفيذ الطلب...');

                                try {
                                    if (cbData.startsWith('dep_accept_')) {
                                        const parts = cbData.split('_');
                                        const depId = parts[2];
                                        const depRef = db.collection('deposit_requests').doc(depId);
                                        const depDoc = await depRef.get();

                                        const email = depDoc.exists ? depDoc.data().email : parts[3];
                                        const amount = depDoc.exists ? parseFloat(depDoc.data().amount) : parseFloat(parts[4]);

                                        if (!depDoc.exists || depDoc.data().status !== 'مقبول') {
                                            const userSnap = await db.collection('users').where('email', '==', email).get();
                                            if (!userSnap.empty) {
                                                const userDoc = userSnap.docs[0];
                                                const currentBalance = parseFloat(userDoc.data().balance || 0);
                                                await userDoc.ref.update({ balance: parseFloat((currentBalance + amount).toFixed(4)) });
                                                if (depDoc.exists) await depRef.update({ status: 'مقبول' });
                                                const originalText = callbackQuery.message.text || '';
                                                editTelegramTextMessage(token, chatId, messageId, originalText + `\n\n✅ <b>تم شحن الرصيد بنجاح ($${amount}) وإضافته لحساب المستخدم!</b>`);
                                            }
                                        }
                                    } else if (cbData.startsWith('dep_reject_')) {
                                        const depId = cbData.slice('dep_reject_'.length);
                                        await db.collection('deposit_requests').doc(depId).update({ status: 'مرفوض' });
                                        const originalText = callbackQuery.message.text || '';
                                        editTelegramTextMessage(token, chatId, messageId, originalText + `\n\n❌ <b>تم رفض طلب شحن الرصيد.</b>`);
                                    } else if (cbData.startsWith('ord_progress_')) {
                                        const orderId = cbData.slice('ord_progress_'.length);
                                        const ordRef = db.collection('orders').doc(orderId);
                                        await ordRef.update({ status: 'قيد التنفيذ', tg_message_id: messageId });
                                        const ordSnap = await ordRef.get();
                                        if (ordSnap.exists) {
                                            editTelegramTextMessage(token, chatId, messageId, buildOrderTelegramMessage(orderId, ordSnap.data()), getOrderMarkup(orderId, 'قيد التنفيذ'));
                                        }
                                    } else if (cbData.startsWith('ord_complete_')) {
                                        const orderId = cbData.slice('ord_complete_'.length);
                                        const ordRef = db.collection('orders').doc(orderId);
                                        const ordSnap = await ordRef.get();
                                        if (ordSnap.exists) {
                                            const ordData = ordSnap.data();
                                            const completedCount = (ordData.target_count !== null && ordData.target_count !== undefined)
                                                ? ordData.target_count
                                                : (ordData.current_count ?? null);
                                            const updatePayload = {
                                                status: 'مكتمل',
                                                account_private: false,
                                                completion_notified: true,
                                                tg_message_id: messageId
                                            };
                                            if (completedCount !== null) updatePayload.current_count = completedCount;
                                            await ordRef.update(updatePayload);
                                            const updatedSnap = await ordRef.get();
                                            editTelegramTextMessage(token, chatId, messageId, buildOrderTelegramMessage(orderId, updatedSnap.data()), { inline_keyboard: [] });
                                        }
                                    } else if (cbData.startsWith('ord_cancel_')) {
                                        const orderId = cbData.slice('ord_cancel_'.length);
                                        const ordRef = db.collection('orders').doc(orderId);
                                        let refundedOrder = null;

                                        await db.runTransaction(async (tx) => {
                                            const ordDoc = await tx.get(ordRef);
                                            if (!ordDoc.exists || ordDoc.data().status === 'ملغي') return;
                                            const ordData = ordDoc.data();
                                            const userQuery = await db.collection('users').where('username', '==', ordData.username).limit(1).get();
                                            if (!userQuery.empty) {
                                                const uRef = userQuery.docs[0].ref;
                                                const uDoc = await tx.get(uRef);
                                                const curBal = parseFloat(uDoc.data().balance || 0);
                                                const refund = parseFloat(ordData.charge || 0);
                                                tx.update(uRef, { balance: parseFloat((curBal + refund).toFixed(4)) });
                                            }
                                            tx.update(ordRef, { status: 'ملغي', tg_message_id: messageId });
                                            refundedOrder = { ...ordData, status: 'ملغي' };
                                        });

                                        if (refundedOrder) {
                                            editTelegramTextMessage(token, chatId, messageId, buildOrderTelegramMessage(orderId, refundedOrder), { inline_keyboard: [] });
                                        }
                                    }
                                } catch (err) { console.error('خطأ قاعدة البيانات:', err); }
                            }
                        }
                    }
                } catch (e) {}
            });
        }).on('error', () => {});
    }, 2500);
}

startTelegramPolling(DEPOSIT_BOT_TOKEN);
startTelegramPolling(ORDERS_BOT_TOKEN);

// ==========================================================
// 📸 فحص حساب انستقرام والمراقبة المباشرة الفورية للعداد
// ==========================================================

function extractInstagramUsername(input) {
    const raw = String(input || '').trim();
    if (!raw) return null;

    if (/^@?[a-zA-Z0-9._]{1,30}$/.test(raw) && !raw.includes('/')) {
        return raw.replace(/^@/, '');
    }

    try {
        const normalized = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
        const u = new URL(normalized);
        if (!u.hostname.toLowerCase().includes('instagram.com')) return null;
        const segments = u.pathname.split('/').filter(Boolean);
        if (!segments.length) return null;
        const reserved = ['p', 'reel', 'reels', 'tv', 'stories', 'explore', 'accounts', 'direct', 'share'];
        if (reserved.includes(segments[0].toLowerCase())) return null;
        const cleanUser = segments[0].replace(/^@/, '');
        return /^[a-zA-Z0-9._]{1,30}$/.test(cleanUser) ? cleanUser : null;
    } catch (e) {
        return null;
    }
}

function parseCompactCount(str) {
    if (!str) return NaN;
    const clean = String(str).trim().replace(/,/g, '').toUpperCase();
    let mult = 1;
    if (clean.endsWith('K')) mult = 1000;
    else if (clean.endsWith('M')) mult = 1000000;
    const num = parseFloat(clean.replace(/[KM]/g, ''));
    return isNaN(num) ? NaN : Math.round(num * mult);
}

async function checkInstagramProfile(link) {
    const igUser = extractInstagramUsername(link);
    if (!igUser) {
        return { valid: false, message: '❌ الرابط خطأ! يرجى وضع رابط حساب انستقرام صحيح (مثال: https://instagram.com/username).' };
    }

    const cacheBuster = Date.now();

    // المحاولة 1: واجهة الويب المباشرة لانستقرام مع منع الكاش لقراءة الرقم اللحظي
    try {
        const res = await axios.get(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(igUser)}&_=${cacheBuster}`, {
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
            validateStatus: () => true
        });

        if (res.status === 404 || (res.status === 200 && res.data && res.data.data && res.data.data.user === null)) {
            return { valid: false, message: '❌ الرابط خطأ! هذا الحساب غير موجود في انستقرام.' };
        }

        const user = res.data?.data?.user;
        if (user) {
            return {
                valid: true,
                username: igUser,
                isPrivate: Boolean(user.is_private),
                followers: Number(user.edge_followed_by?.count ?? 0)
            };
        }
    } catch (e) {}

    // المحاولة 2: واجهة الهاتف البديلة
    try {
        const mobileRes = await axios.get(`https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(igUser)}&_=${cacheBuster}`, {
            headers: {
                'x-ig-app-id': '936619743392459',
                'User-Agent': 'Instagram 275.0.0.27.98 Android (33/13; 420dpi; 1080x2400; samsung; SM-G991B; o1s; exynos2100; en_US; 458229237)',
                'Cache-Control': 'no-cache'
            },
            timeout: 10000,
            validateStatus: () => true
        });

        if (mobileRes.status === 404) {
            return { valid: false, message: '❌ الرابط خطأ! هذا الحساب غير موجود في انستقرام.' };
        }

        const mUser = mobileRes.data?.data?.user;
        if (mUser) {
            return {
                valid: true,
                username: igUser,
                isPrivate: Boolean(mUser.is_private),
                followers: Number(mUser.edge_followed_by?.count ?? mUser.follower_count ?? 0)
            };
        }
    } catch (e) {}

    // المحاولة 3: فحص صفحة الحساب العامة
    try {
        const pageRes = await axios.get(`https://www.instagram.com/${encodeURIComponent(igUser)}/?_=${cacheBuster}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
                'Accept-Language': 'en-US,en;q=0.9',
                'Cache-Control': 'no-cache'
            },
            timeout: 10000,
            validateStatus: () => true
        });

        const html = String(pageRes.data || '');
        if (pageRes.status === 404 || html.includes('Page Not Found') || html.includes("Sorry, this page isn't available")) {
            return { valid: false, message: '❌ الرابط خطأ! هذا الحساب غير موجود في انستقرام.' };
        }

        const isPriv = html.includes('"is_private":true') || html.includes('This Account is Private');
        const exactJsonMatch = html.match(/"edge_followed_by":\{"count":(\d+)\}/);
        const metaMatch = html.match(/content="([\d.,KMkm]+)\s+Followers/i);

        if (exactJsonMatch) {
            return { valid: true, username: igUser, isPrivate: isPriv, followers: parseInt(exactJsonMatch[1], 10) };
        }
        if (metaMatch) {
            const parsedCount = parseCompactCount(metaMatch[1]);
            if (!isNaN(parsedCount)) {
                return { valid: true, username: igUser, isPrivate: isPriv, followers: parsedCount };
            }
        }
    } catch (e) {}

    return { valid: false, unreachable: true, message: '⚠️ تعذر قراءة بيانات الحساب من انستقرام حالياً، تأكد من صحة الرابط وحاول مجدداً.' };
}

app.post('/api/instagram/check', async (req, res) => {
    const info = await checkInstagramProfile(req.body.link);
    if (!info.valid) {
        return res.status(400).json({ success: false, message: info.message });
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
    if (!ord.ig_username || ord.start_count === null || ord.start_count === undefined) return;
    if (ord.status === 'مكتمل' || ord.status === 'ملغي') return;

    // فاصل 15 ثانية لكل طلب لحماية السيرفر من حظر انستقرام مع بقاء التحديث فورياً
    const now = Date.now();
    if (ord.last_checked_ms && (now - ord.last_checked_ms) < 15000) return;

    const check = await checkInstagramProfile(`https://www.instagram.com/${ord.ig_username}/`);
    await doc.ref.update({ last_checked_ms: now }).catch(() => {});

    if (!check.valid) return;

    // 1. إذا قام المستخدم بتحويل حسابه إلى خاص أثناء المراقبة
    if (check.isPrivate) {
        if (!ord.account_private || !ord.private_notified) {
            await doc.ref.update({ account_private: true, private_notified: true });
            await sendTelegramTextMessage(
                ORDERS_BOT_TOKEN,
                ADMIN_CHAT_ID,
                `⚠️ <b>تنبيه مراقبة الحساب!</b>\n\nالمستخدم <b>${ord.username}</b> قام بتحويل حسابه (<code>@${ord.ig_username}</code>) إلى <b>خاص (Private)</b> أثناء تنفيذ الطلب <code>#${doc.id.substring(0, 6)}</code>!\n🔗 الرابط: ${ord.link}`
            );
            if (ord.tg_message_id) {
                editTelegramTextMessage(
                    ORDERS_BOT_TOKEN,
                    ADMIN_CHAT_ID,
                    ord.tg_message_id,
                    buildOrderTelegramMessage(doc.id, { ...ord, account_private: true }),
                    getOrderMarkup(doc.id, ord.status)
                );
            }
        }
        return;
    }

    // 2. تحديث العداد مباشرة عند تغير عدد المتابعين (مثلاً 73/73 -> 73/74)
    const newCurrent = check.followers;
    const target = ord.target_count ?? (Number(ord.start_count) + Number(ord.quantity));
    const isCompletedNow = newCurrent >= target;
    const nextStatus = isCompletedNow ? 'مكتمل' : ord.status;
    const hasChanged = (newCurrent !== ord.current_count) || (ord.account_private === true) || isCompletedNow;

    if (!hasChanged) return;

    let sendCompletionAlert = false;
    await db.runTransaction(async (tx) => {
        const freshDoc = await tx.get(doc.ref);
        if (!freshDoc.exists) return;
        const freshData = freshDoc.data();
        if (freshData.status === 'مكتمل' || freshData.status === 'ملغي') return;

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

    // تحديث رسالة الطلب الأصلية داخل البوت بالرقم الجديد مباشرة
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

    // إرسال إشعار فوري لبوت التليجرام يخبرك بوصول الحساب إلى العدد المطلوب
    if (sendCompletionAlert) {
        await sendTelegramTextMessage(
            ORDERS_BOT_TOKEN,
            ADMIN_CHAT_ID,
            `🎉 <b>إشعار اكتمال العدد المطلوب!</b>\n\nحساب انستقرام (<code>@${ord.ig_username}</code>) وصل إلى العدد المطلوب بنجاح.\n👤 <b>المستخدم:</b> ${ord.username}\n🆔 <b>رقم الطلب:</b> #${doc.id.substring(0, 6)}\n📊 <b>العداد النهائي:</b> ${ord.start_count}/${newCurrent} (المطلوب: ${target})\n✅ <b>الحالة الآن:</b> مكتمل`
        );
    }
}

async function monitorActiveInstagramOrders() {
    if (isMonitoringOrders) return;
    isMonitoringOrders = true;
    try {
        const snap = await db.collection('orders')
            .where('status', 'in', ['قيد المعالجة', 'قيد التنفيذ'])
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

// مراقبة مستمرة ومباشرة في الخلفية كل 20 ثانية
setInterval(monitorActiveInstagramOrders, 20 * 1000);

// ==========================================================
// ⚡ مسارات شحن آسياسيل المتسلسلة (OTP) المتوافقة مع الواجهة
// ==========================================================

async function callAsiacellAPI(endpoint, method = 'POST', bodyData = null, accessToken = null, deviceId = null, cookies = '', appVersion = '5.8.0') {
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

    if (method !== 'GET') headers['Content-Type'] = 'application/json; charset=UTF-8';
    if (accessToken) headers['Authorization'] = `Bearer ${String(accessToken).replace(/^Bearer\s+/i, '').trim()}`;
    if (cookies) headers['Cookie'] = cookies;

    const cleanEp = endpoint.replace(/^\/+/, '');
    let url = cleanEp.startsWith('http')
        ? cleanEp
        : (cleanEp.startsWith('api/') ? `https://odpapp.asiacell.com/${cleanEp}` : `https://odpapp.asiacell.com/api/v1/${cleanEp}`);

    const response = await fetch(url, {
        method,
        headers,
        body: (method !== 'GET' && bodyData) ? (typeof bodyData === 'string' ? bodyData : JSON.stringify(bodyData)) : undefined
    });

    let newCookies = cookies;
    if (typeof response.headers.getSetCookie === 'function') {
        const list = response.headers.getSetCookie();
        if (list?.length) newCookies = list.map(c => c.split(';')[0].trim()).join('; ');
    } else {
        const sc = response.headers.get('set-cookie');
        if (sc) newCookies = sc.split(/,(?=\s*[a-zA-Z0-9_-]+=)/).map(c => c.split(';')[0].trim()).join('; ');
    }

    const text = await response.text();
    const isWafBlocked = text.includes('Access Blocked') || text.includes('<!DOCTYPE html');
    let json = {};
    if (!isWafBlocked) {
        try { json = JSON.parse(text); } catch (e) { json = { rawText: text }; }
    } else {
        json = { wafBlocked: true, message: 'WAF Access Blocked' };
    }

    return { status: response.status, ok: response.ok, isWafBlocked, data: json, rawText: text, deviceId: currentDeviceId, cookies: newCookies };
}

function extractLoginSessionInfo(obj) {
    let result = { pid: '', validationUrl: '' };
    if (!obj || typeof obj !== 'object') return result;

    const str = JSON.stringify(obj);
    const urlMatch = str.match(/https?:\/\/[^"'\s]+(?:smsvalidation|verify|otp|confirm)[^"'\s]*/i);
    if (urlMatch) result.validationUrl = urlMatch[0];

    const pidInUrl = str.match(/[?&](?:PID|pid|processId|requestId|transactionId)=([a-zA-Z0-9_-]+)/);
    if (pidInUrl) result.pid = pidInUrl[1];

    function searchKeys(o) {
        for (const [k, v] of Object.entries(o)) {
            if (v && typeof v === 'object') {
                searchKeys(v);
            } else if (typeof v === 'string' || typeof v === 'number') {
                const keyLower = k.toLowerCase();
                if (!result.pid && ['pid', 'processid', 'requestid', 'transactionid', 'referenceid'].includes(keyLower)) {
                    result.pid = String(v);
                }
                if (!result.validationUrl && (keyLower.includes('url') || keyLower.includes('link') || keyLower.includes('endpoint')) && /smsvalidation|verify|otp/i.test(String(v))) {
                    result.validationUrl = String(v);
                }
            }
        }
    }
    searchKeys(obj);
    return result;
}

app.post('/api/asiacell/send-otp', async (req, res) => {
    const cleanPhone = (req.body.phone || '').trim();
    if (!/^077\d{8}$/.test(cleanPhone)) return res.status(400).json({ success: false, message: 'يرجى إدخال رقم آسياسيل صحيح يبدأ بـ 077.' });

    try {
        const result = await callAsiacellAPI('login?lang=ar', 'POST', { username: cleanPhone, captchaCode: '' });
        const info = extractLoginSessionInfo(result.data);
        const nextStep = result.data?.nextStep || result.data?.data?.nextStep;

        if (Boolean(info.pid) || Boolean(info.validationUrl) || nextStep === 'OTP' || nextStep === 'SMS_VALIDATION' || result.data?.success === true) {
            await db.collection('asiacell_sessions').doc(cleanPhone).set({
                phone: cleanPhone, pid: info.pid, validationUrl: info.validationUrl,
                deviceId: result.deviceId, cookies: result.cookies || '', step: 'WAIT_LOGIN_OTP', updatedAt: Date.now()
            });
            return res.json({ success: true, message: `✅ تم إرسال رمز تسجيل الدخول إلى الرقم ${cleanPhone}.` });
        }
        return res.status(400).json({ success: false, message: `⚠️ رد آسياسيل: ${result.data?.message || 'تعذر إرسال الرمز.'}` });
    } catch (e) {
        return res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/asiacell/verify-login', async (req, res) => {
    const cleanPhone = (req.body.phone || '').trim();
    const cleanOtp = (req.body.otp || '').trim();
    if (!cleanPhone || !cleanOtp) return res.status(400).json({ success: false, message: 'أدخل رقم الهاتف ورمز الدخول.' });

    try {
        const doc = await db.collection('asiacell_sessions').doc(cleanPhone).get();
        if (!doc.exists) return res.status(400).json({ success: false, message: 'انتهت الجلسة، أعد إرسال الرمز.' });
        const s = doc.data();

        const targetEndpoint = s.validationUrl || 'smsvalidation?lang=ar';
        const verifyPayload = { username: cleanPhone, passcode: cleanOtp };
        if (s.pid) verifyPayload.PID = s.pid;

        let vr = await callAsiacellAPI(targetEndpoint, 'POST', verifyPayload, null, s.deviceId, s.cookies);
        let token = vr.data?.access_token || vr.data?.data?.access_token || vr.data?.token || vr.data?.data?.token;

        if (!token && s.pid) {
            vr = await callAsiacellAPI(`smsvalidation?PID=${s.pid}&lang=ar`, 'POST', verifyPayload, null, s.deviceId, s.cookies);
            token = vr.data?.access_token || vr.data?.data?.access_token || vr.data?.token || vr.data?.data?.token;
        }

        if (!token || vr.data?.success === false) {
            return res.status(400).json({ success: false, message: `❌ رمز الدخول خطأ أو مرفوض من الشركة.` });
        }

        await db.collection('asiacell_sessions').doc(cleanPhone).update({
            accessToken: token, cookies: vr.cookies || s.cookies || '', step: 'SELECT_AMOUNT', updatedAt: Date.now()
        });

        return res.json({ success: true, message: '✅ تم تسجيل الدخول بنجاح! اختر المبلغ الآن.' });
    } catch (e) {
        return res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/asiacell/initiate-transfer', async (req, res) => {
    const cleanPhone = String(req.body.phone || '').trim();
    const selectedUsd = Number(req.body.amountUSD);
    const amountIQD = selectedUsd * 1000;

    if (!/^077\d{8}$/.test(cleanPhone) || !Number.isInteger(amountIQD) || amountIQD < 1000 || amountIQD > 10000) {
        return res.status(400).json({
            success: false,
            message: 'أدخل رقم آسياسيل صحيحاً ومبلغاً بين 1000 و10000 دينار.'
        });
    }

    const sessionRef = db.collection('asiacell_sessions').doc(cleanPhone);
    const operationId = crypto.randomUUID();
    let started = false;

    try {
        const s = await db.runTransaction(async tx => {
            const doc = await tx.get(sessionRef);
            if (!doc.exists || !doc.data().accessToken) {
                throw new Error('انتهت الجلسة، سجل دخولك مجدداً.');
            }
            const session = doc.data();
            if (session.step !== 'SELECT_AMOUNT') {
                throw new Error('توجد عملية قيد التنفيذ؛ لا تكرر طلب التحويل.');
            }
            tx.update(sessionRef, {
                step: 'STARTING_TRANSFER',
                operationId,
                amountUSD: selectedUsd,
                amountIQD,
                updatedAt: Date.now()
            });
            return session;
        });

        started = true;

        const tr = await callAsiacellAPI(
            'credit-transfer/start?lang=ar',
            'POST',
            { amount: amountIQD, receiverMsisdn: TARGET_ASIACELL_NUMBER },
            s.accessToken,
            s.deviceId,
            s.cookies
        );

        if (!tr.ok || tr.isWafBlocked || tr.data?.success !== true || !tr.data?.PID) {
            await sessionRef.update({
                step: tr.data?.success === false ? 'SELECT_AMOUNT' : 'TRANSFER_REVIEW',
                updatedAt: Date.now()
            });
            return res.status(400).json({
                success: false,
                message: tr.data?.message || 'لم يتم تأكيد بدء التحويل. تحقق من حالة العملية قبل المحاولة مجدداً.'
            });
        }

        await sessionRef.update({
            transferPid: String(tr.data.PID),
            transferValidationUrl: 'credit-transfer/do-transfer?lang=ar',
            cookies: tr.cookies || s.cookies || '',
            step: 'WAIT_TRANSFER_OTP',
            updatedAt: Date.now()
        });

        return res.json({
            success: true,
            message: `📲 تم إرسال رمز تأكيد تحويل (${amountIQD} د.ع) إلى رقمك.`
        });
    } catch (e) {
        if (started) {
            await sessionRef.update({ step: 'TRANSFER_REVIEW', updatedAt: Date.now() }).catch(() => {});
        }
        return res.status(400).json({ success: false, message: e.message });
    }
});

app.post('/api/asiacell/confirm-transfer', async (req, res) => {
    const email = String(req.body.email || '').trim();
    const cleanPhone = String(req.body.phone || '').trim();
    const finalOtp = String(req.body.transferOtp || '').trim();

    if (!email || !/^077\d{8}$/.test(cleanPhone) || !/^\d{4,6}$/.test(finalOtp)) {
        return res.status(400).json({
            success: false,
            message: 'أدخل رقم الهاتف ورمز تأكيد التحويل الصحيح.'
        });
    }

    const sessionRef = db.collection('asiacell_sessions').doc(cleanPhone);
    let claimed = false;
    let operatorConfirmed = false;

    try {
        const userSnap = await db.collection('users').where('email', '==', email).get();
        if (userSnap.empty) {
            return res.status(400).json({ success: false, message: 'المستخدم غير موجود.' });
        }
        const userDoc = userSnap.docs[0];

        const s = await db.runTransaction(async tx => {
            const doc = await tx.get(sessionRef);
            if (!doc.exists) throw new Error('انتهت الجلسة.');
            const session = doc.data();

            if (session.step !== 'WAIT_TRANSFER_OTP' || !session.transferPid || !session.operationId) {
                throw new Error('العملية غير جاهزة للتأكيد أو سبق إرسال تأكيدها.');
            }
            if (!Number.isFinite(session.amountUSD) || session.amountUSD <= 0 || session.amountIQD !== session.amountUSD * 1000) {
                throw new Error('مبلغ العملية المحفوظ غير صالح.');
            }

            tx.update(sessionRef, {
                step: 'CONFIRMING_TRANSFER',
                creditUserId: userDoc.id,
                updatedAt: Date.now()
            });
            return session;
        });

        claimed = true;

        const cr = await callAsiacellAPI(
            'credit-transfer/do-transfer?lang=ar',
            'POST',
            { PID: s.transferPid, passcode: finalOtp },
            s.accessToken,
            s.deviceId,
            s.cookies
        );

        const d = cr.data || {};
        if (!cr.ok || cr.isWafBlocked || d.success !== true) {
            await sessionRef.update({
                step: d.success === false ? 'WAIT_TRANSFER_OTP' : 'TRANSFER_REVIEW',
                updatedAt: Date.now()
            });
            return res.status(400).json({
                success: false,
                message: d.message || 'نتيجة التحويل غير مؤكدة. تحقق من الرصيد ورسائل الشركة قبل إعادة المحاولة.'
            });
        }

        operatorConfirmed = true;
        await sessionRef.update({
            step: 'TRANSFER_CONFIRMED',
            operatorConfirmed: true,
            updatedAt: Date.now()
        });

        const usdAmount = s.amountUSD;
        const depositRef = db.collection('deposit_requests').doc('asiacell_' + s.operationId);

        const newBalance = await db.runTransaction(async tx => {
            const deposit = await tx.get(depositRef);
            const currentUser = await tx.get(userDoc.ref);
            if (!currentUser.exists) throw new Error('تعذر العثور على حساب المستخدم بعد التحويل.');

            const balance = Number(currentUser.data().balance || 0);
            if (!Number.isFinite(balance)) throw new Error('رصيد حساب الموقع غير صالح.');
            if (deposit.exists) return balance;

            const updatedBalance = Number((balance + usdAmount).toFixed(2));
            tx.update(userDoc.ref, { balance: updatedBalance });
            tx.set(depositRef, {
                username: currentUser.data().username || '',
                email,
                gateway: 'Asiacell OTP Auto',
                sender_phone: cleanPhone,
                amount: usdAmount,
                amount_iqd: s.amountIQD,
                recipient: TARGET_ASIACELL_NUMBER,
                status: 'مقبول تلقائياً',
                created_at: getFormattedDateTime()
            });
            tx.update(sessionRef, { step: 'COMPLETED', credited: true, updatedAt: Date.now() });
            return updatedBalance;
        });

        sendTelegramTextMessage(
            DEPOSIT_BOT_TOKEN,
            ADMIN_CHAT_ID,
            `✅ <b>شحن آسياسيل تلقائي ناجح (OTP):</b>\nالمستخدم: ${email}\nالمبلغ: $${usdAmount} (${s.amountIQD} د.ع)\nمن الرقم: ${cleanPhone}`
        );

        return res.json({
            success: true,
            message: `🎉 تم شحن رصيدك بنجاح بمبلغ $${usdAmount}!`,
            newBalance
        });
    } catch (e) {
        if (claimed) {
            await sessionRef.update({
                step: operatorConfirmed ? 'CREDIT_REVIEW' : 'TRANSFER_REVIEW',
                updatedAt: Date.now()
            }).catch(() => {});
        }
        return res.status(500).json({
            success: false,
            message: operatorConfirmed
                ? 'أكدت آسياسيل نجاح التحويل، لكن تعذر إكمال إضافة رصيد الموقع. راجع الإدارة ولا تعِد التحويل.'
                : e.message
        });
    }
});

// ==========================================================
// 💳 بوابة Wayl (البطاقات الإلكترونية)
// ==========================================================
app.post('/api/wayl/webhook', async (req, res) => {
    const event = req.body;
    try {
        if (event && (event.event === 'payment.completed' || event.status === 'success')) {
            const email = event.customer?.email || event.metadata?.email;
            const amountUSD = parseFloat(event.amount_usd || (event.amount / 1000) || 0);

            if (email && amountUSD > 0) {
                const userSnap = await db.collection('users').where('email', '==', email).get();
                if (!userSnap.empty) {
                    const userDoc = userSnap.docs[0];
                    const currentBalance = parseFloat(userDoc.data().balance || 0);
                    await userDoc.ref.update({ balance: parseFloat((currentBalance + amountUSD).toFixed(4)) });

                    await db.collection('deposit_requests').add({
                        username: userDoc.data().username, email, gateway: 'Wayl Electronic Card',
                        amount: amountUSD, status: 'مقبول تلقائياً عبر Wayl', created_at: getFormattedDateTime()
                    });

                    sendTelegramTextMessage(DEPOSIT_BOT_TOKEN, ADMIN_CHAT_ID, `💳 <b>شحن إلكتروني ناجح (Wayl):</b>\nالمستخدم: ${email}\nالمبلغ: $${amountUSD}`);
                }
            }
        }
        res.status(200).send('OK');
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// ==========================================================
// 🛠️ إدارة النظام والخدمات (القسم، النوع، العدد، السعر، الحدود)
// ==========================================================
app.post('/api/admin/add-service', async (req, res) => {
    const { category, name, baseQuantity, price, minQty, maxQty, description } = req.body;
    const parsedPrice = parseFloat(price);
    const parsedBase = parseInt(baseQuantity) || 1000;
    const parsedMin = parseInt(minQty) || 100;
    const parsedMax = (maxQty !== undefined && maxQty !== null && String(maxQty).trim() !== '' && parseInt(maxQty) > 0)
        ? parseInt(maxQty)
        : null;

    if (!category || !name || isNaN(parsedPrice) || parsedPrice <= 0) {
        return res.status(400).json({ success: false, message: 'بيانات غير مكتملة.' });
    }
    if (parsedMax !== null && parsedMax < parsedMin) {
        return res.status(400).json({ success: false, message: 'الحد الأقصى يجب أن يكون أكبر من أو يساوي الحد الأدنى.' });
    }

    try {
        const docRef = await db.collection('services').add({
            category: category.trim(),
            name: name.trim(),
            baseQuantity: parsedBase,
            price: parsedPrice,
            minQty: parsedMin,
            maxQty: parsedMax,
            description: (description || '').trim(),
            created_at: getFormattedDateTime()
        });
        res.json({ success: true, id: docRef.id, message: '✅ تم إضافة الخدمة بنجاح!' });
    } catch (e) {
        res.status(500).json({ success: false, message: 'خطأ في قاعدة البيانات.' });
    }
});

app.post('/api/admin/update-service', async (req, res) => {
    const { id, category, name, baseQuantity, price, minQty, maxQty, description } = req.body;
    const parsedPrice = parseFloat(price);
    const parsedBase = parseInt(baseQuantity) || 1000;
    const parsedMin = parseInt(minQty) || 100;
    const parsedMax = (maxQty !== undefined && maxQty !== null && String(maxQty).trim() !== '' && parseInt(maxQty) > 0)
        ? parseInt(maxQty)
        : null;

    if (!id || !category || !name || isNaN(parsedPrice) || parsedPrice <= 0) {
        return res.status(400).json({ success: false, message: 'بيانات غير مكتملة.' });
    }
    if (parsedMax !== null && parsedMax < parsedMin) {
        return res.status(400).json({ success: false, message: 'الحد الأقصى يجب أن يكون أكبر من أو يساوي الحد الأدنى.' });
    }

    try {
        await db.collection('services').doc(id).update({
            category: category.trim(),
            name: name.trim(),
            baseQuantity: parsedBase,
            price: parsedPrice,
            minQty: parsedMin,
            maxQty: parsedMax,
            description: (description || '').trim()
        });
        res.json({ success: true, message: '✅ تم تحديث الخدمة بنجاح!' });
    } catch (e) {
        res.status(500).json({ success: false, message: 'خطأ في التحديث.' });
    }
});

app.post('/api/admin/delete-service', async (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, message: 'معرف الخدمة مفقود.' });
    try {
        await db.collection('services').doc(id).delete();
        res.json({ success: true, message: 'تم الحذف بنجاح.' });
    } catch (e) {
        res.status(500).json({ success: false, message: 'خطأ.' });
    }
});

app.get('/api/admin/data', async (req, res) => {
    try {
        const usersSnap = await db.collection('users').get();
        let totalSales = 0;
        const ordersSnap = await db.collection('orders').get();
        ordersSnap.forEach(doc => {
            if (doc.data().status !== 'ملغي') {
                totalSales += parseFloat(doc.data().charge || 0);
            }
        });
        res.json({ success: true, usersCount: usersSnap.size, totalSales });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// ==========================================================
// 👤 حسابات المستخدمين والإيداع والطلبات
// ==========================================================
app.post('/api/register', async (req, res) => {
    const { username, email, password } = req.body;
    try {
        const usersRef = db.collection('users');
        const snapshot = await usersRef.where('email', '==', email).get();
        if (!snapshot.empty) return res.status(400).json({ success: false, message: 'البريد مسجل مسبقاً.' });
        const hashedPassword = await bcrypt.hash(password, 10);
        await usersRef.add({ username, email, password: hashedPassword, balance: 0.00, role: 'user', created_at: getFormattedDateTime() });
        res.json({ success: true, message: 'تم إنشاء الحساب بنجاح!', username, email, balance: 0.00 });
    } catch (e) {
        res.status(500).json({ success: false, message: 'خطأ في الخادم.' });
    }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const snapshot = await db.collection('users').where('email', '==', email).get();
        if (snapshot.empty) return res.status(400).json({ success: false, message: 'البريد غير صحيح.' });
        const user = snapshot.docs[0].data();
        if (!await bcrypt.compare(password, user.password)) return res.status(400).json({ success: false, message: 'كلمة المرور خطأ.' });
        res.json({ success: true, message: 'تم تسجيل الدخول!', username: user.username, email: user.email, balance: user.balance });
    } catch (e) {
        res.status(500).json({ success: false, message: 'خطأ في الخادم.' });
    }
});

app.get('/api/user/:email', async (req, res) => {
    try {
        const snapshot = await db.collection('users').where('email', '==', req.params.email).get();
        if (snapshot.empty) return res.status(404).json({ success: false });
        res.json({ success: true, user: snapshot.docs[0].data() });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

app.post('/api/deposit/submit', upload.single('receiptImage'), async (req, res) => {
    const { email, gateway, amount } = req.body;
    const uploadedFile = req.file;
    if (!email || !gateway || !amount || !uploadedFile) return res.status(400).json({ success: false, message: 'الرجاء إكمال البيانات.' });

    try {
        const pendingSnap = await db.collection('deposit_requests').where('email', '==', email).where('status', '==', 'معلق').get();
        if (!pendingSnap.empty) {
            if (fs.existsSync(uploadedFile.path)) fs.unlinkSync(uploadedFile.path);
            return res.status(400).json({ success: false, message: 'عذراً، لديك طلب شحن قيد المراجعة بالفعل.' });
        }

        const fileHash = await getFileHash(uploadedFile.path);
        const hashCheckSnap = await db.collection('deposit_requests').where('image_hash', '==', fileHash).get();
        if (!hashCheckSnap.empty) {
            if (fs.existsSync(uploadedFile.path)) fs.unlinkSync(uploadedFile.path);
            return res.status(400).json({ success: false, message: '🚫 عذراً! تم استخدام صورة هذا الإيصال مسبقاً.' });
        }

        const userSnap = await db.collection('users').where('email', '==', email).get();
        if (userSnap.empty) {
            if (fs.existsSync(uploadedFile.path)) fs.unlinkSync(uploadedFile.path);
            return res.status(400).json({ success: false, message: 'المستخدم غير موجود.' });
        }

        const username = userSnap.docs[0].data().username;
        const dateTime = getFormattedDateTime();

        const depRef = await db.collection('deposit_requests').add({
            username, email, gateway, amount: parseFloat(amount),
            receipt_image: uploadedFile.filename, image_hash: fileHash,
            status: 'معلق', created_at: dateTime
        });

        const receiptUrl = `https://mtnajm.com/${uploadedFile.filename}`;
        const text = `📥 <b>طلب شحن رصيد جديد</b>\n\n👤 <b>المستخدم:</b> ${username}\n📧 <b>البريد:</b> ${email}\n💰 <b>المبلغ:</b> $${amount}\n💳 <b>البوابة:</b> ${gateway}\n🕒 <b>التاريخ والوقت:</b> ${dateTime}\n\n🔗 <a href="${receiptUrl}"><b>[ عرض صورة الإيصال ]</b></a>`;
        const replyMarkup = { inline_keyboard: [[{ text: '✅ شحن الرصيد', callback_data: `dep_accept_${depRef.id}_${email}_${amount}` }, { text: '❌ رفض', callback_data: `dep_reject_${depRef.id}` }]] };
        sendTelegramTextMessage(DEPOSIT_BOT_TOKEN, ADMIN_CHAT_ID, text, replyMarkup);

        res.json({ success: true, message: 'تم إرسال طلب الشحن بنجاح.' });
    } catch (e) {
        if (uploadedFile && fs.existsSync(uploadedFile.path)) fs.unlinkSync(uploadedFile.path);
        res.status(500).json({ success: false, message: 'خطأ في الخادم.' });
    }
});

app.post('/api/order', async (req, res) => {
    const { username, serviceId, link, quantity } = req.body;
    const qty = parseInt(quantity);

    if (!username || !serviceId || !link || isNaN(qty) || qty <= 0) {
        return res.status(400).json({ success: false, message: 'يرجى إكمال كافة بيانات الطلب بشكل صحيح.' });
    }

    try {
        const servDoc = await db.collection('services').doc(serviceId).get();
        if (!servDoc.exists) return res.status(400).json({ success: false, message: 'الخدمة المختارة غير موجودة.' });
        const serv = servDoc.data();

        const minAllowed = serv.minQty || 100;
        const maxAllowed = serv.maxQty || null;
        if (qty < minAllowed) {
            return res.status(400).json({ success: false, message: `الحد الأدنى للطلب في هذه الخدمة هو ${minAllowed}.` });
        }
        if (maxAllowed !== null && qty > maxAllowed) {
            return res.status(400).json({ success: false, message: `الحد الأقصى للطلب في هذه الخدمة هو ${maxAllowed}.` });
        }

        const baseQty = serv.baseQuantity || 1000;
        const calculatedCharge = parseFloat(((qty / baseQty) * parseFloat(serv.price)).toFixed(4));

        // فحص رابط حساب انستقرام قبل إنشاء الطلب
        const igCheck = await checkInstagramProfile(link);
        if (!igCheck.valid) {
            return res.status(400).json({ success: false, message: igCheck.message });
        }
        if (igCheck.isPrivate) {
            return res.status(400).json({
                success: false,
                message: '🔒 حسابك خاص! قم بتحويله إلى عام (Public) ثم اطلب من جديد.'
            });
        }

        const igUsername = igCheck.username;
        const cleanLink = `https://www.instagram.com/${igUsername}/`;
        const startCount = igCheck.followers;
        const currentCount = igCheck.followers;
        const targetCount = startCount + qty;

        const userSnap = await db.collection('users').where('username', '==', username).get();
        if (userSnap.empty) return res.status(400).json({ success: false, message: 'المستخدم غير موجود.' });
        const userRef = userSnap.docs[0].ref;

        const dateTime = getFormattedDateTime();
        const serviceFullTitle = `[${serv.category}] ${serv.name}`;
        let orderId = '';
        let newBalance = 0;

        await db.runTransaction(async (transaction) => {
            const freshUser = await transaction.get(userRef);
            const currentBalance = parseFloat(freshUser.data().balance || 0);
            if (currentBalance < calculatedCharge) {
                throw new Error('INSUFFICIENT_BALANCE');
            }

            newBalance = parseFloat((currentBalance - calculatedCharge).toFixed(4));
            transaction.update(userRef, { balance: newBalance });

            const newOrderRef = db.collection('orders').doc();
            orderId = newOrderRef.id;
            transaction.set(newOrderRef, {
                username,
                service: serviceFullTitle,
                service_id: serviceId,
                link: cleanLink,
                ig_username: igUsername,
                quantity: qty,
                charge: calculatedCharge,
                start_count: startCount,
                current_count: currentCount,
                target_count: targetCount,
                account_private: false,
                private_notified: false,
                completion_notified: false,
                last_checked_ms: Date.now(),
                status: 'قيد المعالجة',
                created_at: dateTime,
                created_ms: Date.now()
            });
        });

        const orderView = {
            username,
            service: serviceFullTitle,
            link: cleanLink,
            quantity: qty,
            charge: calculatedCharge,
            start_count: startCount,
            current_count: currentCount,
            target_count: targetCount,
            account_private: false,
            status: 'قيد المعالجة',
            created_at: dateTime
        };

        const tgMsgId = await sendTelegramTextMessage(
            ORDERS_BOT_TOKEN,
            ADMIN_CHAT_ID,
            buildOrderTelegramMessage(orderId, orderView),
            getOrderMarkup(orderId, 'قيد المعالجة')
        );

        if (tgMsgId) {
            await db.collection('orders').doc(orderId).update({ tg_message_id: tgMsgId });
        }

        res.json({
            success: true,
            newBalance,
            orderId,
            startCount,
            currentCount,
            targetCount
        });
    } catch (e) {
        if (e.message === 'INSUFFICIENT_BALANCE') {
            return res.status(400).json({ success: false, message: 'رصيد غير كافٍ.' });
        }
        res.status(500).json({ success: false, message: 'حدث خطأ أثناء إنشاء الطلب.' });
    }
});

app.get('/api/orders/:username', async (req, res) => {
    try {
        const snapshot = await db.collection('orders').where('username', '==', req.params.username).get();

        // فحص لحظي للطلبات النشطة لتحديث العداد أمام المستخدم مباشرة
        const activeDocs = snapshot.docs.filter(d => ['قيد المعالجة', 'قيد التنفيذ'].includes(d.data().status));
        if (activeDocs.length > 0) {
            await Promise.all(activeDocs.map(d => syncSingleOrderCount(d)));
        }

        const freshSnapshot = await db.collection('orders').where('username', '==', req.params.username).get();
        const orders = [];
        freshSnapshot.forEach(doc => {
            const d = doc.data();
            orders.push({
                id: doc.id,
                ...d,
                created_at: formatSafeDate(d.created_at)
            });
        });
        orders.sort((a, b) => (b.created_ms || 0) - (a.created_ms || 0));
        res.json({ success: true, orders });
    } catch (e) {
        res.json({ success: true, orders: [] });
    }
});

app.get('/api/services', async (req, res) => {
    try {
        const snapshot = await db.collection('services').get();
        const services = [];
        snapshot.forEach(doc => services.push({ id: doc.id, ...doc.data() }));
        res.json({ success: true, services });
    } catch (e) {
        res.json({ success: true, services: [] });
    }
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
