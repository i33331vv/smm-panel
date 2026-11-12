// ==========================================================
// 📓 Notebook: server.js (النسخة الكاملة المصححة)
// ==========================================================

const express = require('express');
const path = require('path');
const app = express();
const bcrypt = require('bcryptjs');
const multer = require('multer');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');

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

function getFileHash(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', data => hash.update(data));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', err => reject(err));
    });
}

function sendTelegramTextMessage(token, chatId, text, replyMarkup = null) {
    const data = JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: replyMarkup });
    const options = { hostname: 'api.telegram.org', path: `/bot${token}/sendMessage`, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } };
    const req = https.request(options);
    req.on('error', (e) => console.error(e));
    req.write(data); req.end();
}

function answerCallbackQuery(token, callbackQueryId, text) {
    const data = JSON.stringify({ callback_query_id: callbackQueryId, text: text, show_alert: false });
    const options = { hostname: 'api.telegram.org', path: `/bot${token}/answerCallbackQuery`, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } };
    const req = https.request(options); req.on('error', () => {}); req.write(data); req.end();
}

function editTelegramTextMessage(token, chatId, messageId, newText, replyMarkup = { inline_keyboard: [] }) {
    const data = JSON.stringify({ chat_id: chatId, message_id: messageId, text: newText, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: replyMarkup });
    const options = { hostname: 'api.telegram.org', path: `/bot${token}/editMessageText`, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } };
    const req = https.request(options); req.on('error', () => {}); req.write(data); req.end();
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
                                const cbData = callbackQuery.data;
                                const chatId = callbackQuery.message.chat.id;
                                const messageId = callbackQuery.message.message_id;

                                answerCallbackQuery(token, callbackQuery.id, 'جاري تنفيذ الطلب...');

                                try {
                                    if (cbData.startsWith('dep_accept_')) {
                                        const parts = cbData.split('_');
                                        const depId = parts[2];
                                        const email = parts[3];
                                        const amount = parseFloat(parts[4]);

                                        const userSnap = await db.collection('users').where('email', '==', email).get();
                                        if (!userSnap.empty) {
                                            const userDoc = userSnap.docs[0];
                                            const currentBalance = parseFloat(userDoc.data().balance || 0);
                                            await userDoc.ref.update({ balance: currentBalance + amount });
                                            await db.collection('deposit_requests').doc(depId).update({ status: 'مقبول' });
                                            const originalText = callbackQuery.message.text || '';
                                            const updatedText = originalText + `\n\n✅ <b>تم شحن الرصيد بنجاح ($${amount}) وإضافته لحساب المستخدم!</b>`;
                                            editTelegramTextMessage(token, chatId, messageId, updatedText);
                                        }
                                    } else if (cbData.startsWith('dep_reject_')) {
                                        const depId = cbData.split('_')[2];
                                        await db.collection('deposit_requests').doc(depId).update({ status: 'مرفوض' });
                                        const originalText = callbackQuery.message.text || '';
                                        const updatedText = originalText + `\n\n❌ <b>تم رفض طلب شحن الرصيد.</b>`;
                                        editTelegramTextMessage(token, chatId, messageId, updatedText);
                                    } else if (cbData.startsWith('ord_progress_')) {
                                        const orderId = cbData.split('_')[2];
                                        await db.collection('orders').doc(orderId).update({ status: 'قيد التنفيذ' });
                                        const originalText = callbackQuery.message.text || '';
                                        const updatedText = originalText.replace('🔄 الحالة: قيد المعالجة', '🔄 <b>الحالة: قيد التنفيذ حالياً</b>');
                                        const newMarkup = { inline_keyboard: [[{ text: '✔️ تم الاكتمال', callback_data: `ord_complete_${orderId}` }]] };
                                        editTelegramTextMessage(token, chatId, messageId, updatedText, newMarkup);
                                    } else if (cbData.startsWith('ord_complete_')) {
                                        const orderId = cbData.split('_')[2];
                                        await db.collection('orders').doc(orderId).update({ status: 'مكتمل' });
                                        const originalText = callbackQuery.message.text || '';
                                        const updatedText = originalText.replace('🔄 <b>الحالة: قيد التنفيذ حالياً</b>', '✅ <b>الحالة: تم إكمال الطلب بنجاح</b>');
                                        editTelegramTextMessage(token, chatId, messageId, updatedText);
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

// فحص شامل ومتعمق لاستخراج PID ورابط التحقق من جميع مستويات الكائن
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

// 1. طلب رمز تسجيل الدخول (OTP)
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

// 2. التحقق من رمز تسجيل الدخول
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
// بدء تحويل آسياسيل
app.post('/api/asiacell/initiate-transfer', async (req, res) => {
    const cleanPhone = String(req.body.phone || '').trim();
    const selectedUsd = Number(req.body.amountUSD);
    const amountIQD = selectedUsd * 1000;

    if (
        !/^077\d{8}$/.test(cleanPhone) ||
        !Number.isInteger(amountIQD) ||
        amountIQD < 1000 ||
        amountIQD > 10000
    ) {
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
            {
                amount: amountIQD,
                receiverMsisdn: TARGET_ASIACELL_NUMBER
            },
            s.accessToken,
            s.deviceId,
            s.cookies
        );

        if (
            !tr.ok ||
            tr.isWafBlocked ||
            tr.data?.success !== true ||
            !tr.data?.PID
        ) {
            await sessionRef.update({
                step: tr.data?.success === false
                    ? 'SELECT_AMOUNT'
                    : 'TRANSFER_REVIEW',
                updatedAt: Date.now()
            });

            return res.status(400).json({
                success: false,
                message: tr.data?.message ||
                    'لم يتم تأكيد بدء التحويل. تحقق من حالة العملية قبل المحاولة مجدداً.'
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
            await sessionRef.update({
                step: 'TRANSFER_REVIEW',
                updatedAt: Date.now()
            }).catch(() => {});
        }

        return res.status(400).json({
            success: false,
            message: e.message
        });
    }
});
// تأكيد تحويل آسياسيل وإضافة الرصيد مرة واحدة
app.post('/api/asiacell/confirm-transfer', async (req, res) => {
    const email = String(req.body.email || '').trim();
    const cleanPhone = String(req.body.phone || '').trim();
    const finalOtp = String(req.body.transferOtp || '').trim();

    if (
        !email ||
        !/^077\d{8}$/.test(cleanPhone) ||
        !/^\d{4,6}$/.test(finalOtp)
    ) {
        return res.status(400).json({
            success: false,
            message: 'أدخل رقم الهاتف ورمز تأكيد التحويل الصحيح.'
        });
    }

    const sessionRef = db.collection('asiacell_sessions').doc(cleanPhone);
    let claimed = false;
    let operatorConfirmed = false;

    try {
        const userSnap = await db.collection('users')
            .where('email', '==', email)
            .get();

        if (userSnap.empty) {
            return res.status(400).json({
                success: false,
                message: 'المستخدم غير موجود.'
            });
        }

        const userDoc = userSnap.docs[0];

        const s = await db.runTransaction(async tx => {
            const doc = await tx.get(sessionRef);

            if (!doc.exists) {
                throw new Error('انتهت الجلسة.');
            }

            const session = doc.data();

            if (
                session.step !== 'WAIT_TRANSFER_OTP' ||
                !session.transferPid ||
                !session.operationId
            ) {
                throw new Error(
                    'العملية غير جاهزة للتأكيد أو سبق إرسال تأكيدها.'
                );
            }

            if (
                !Number.isFinite(session.amountUSD) ||
                session.amountUSD <= 0 ||
                session.amountIQD !== session.amountUSD * 1000
            ) {
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
            {
                PID: s.transferPid,
                passcode: finalOtp
            },
            s.accessToken,
            s.deviceId,
            s.cookies
        );

        const d = cr.data || {};

        if (!cr.ok || cr.isWafBlocked || d.success !== true) {
            await sessionRef.update({
                step: d.success === false
                    ? 'WAIT_TRANSFER_OTP'
                    : 'TRANSFER_REVIEW',
                updatedAt: Date.now()
            });

            return res.status(400).json({
                success: false,
                message: d.message ||
                    'نتيجة التحويل غير مؤكدة. تحقق من الرصيد ورسائل الشركة قبل إعادة المحاولة.'
            });
        }

        operatorConfirmed = true;

        await sessionRef.update({
            step: 'TRANSFER_CONFIRMED',
            operatorConfirmed: true,
            updatedAt: Date.now()
        });

        const usdAmount = s.amountUSD;
        const depositRef = db.collection('deposit_requests')
            .doc('asiacell_' + s.operationId);

        const newBalance = await db.runTransaction(async tx => {
            const deposit = await tx.get(depositRef);
            const currentUser = await tx.get(userDoc.ref);

            if (!currentUser.exists) {
                throw new Error(
                    'تعذر العثور على حساب المستخدم بعد التحويل.'
                );
            }

            const balance = Number(currentUser.data().balance || 0);

            if (!Number.isFinite(balance)) {
                throw new Error('رصيد حساب الموقع غير صالح.');
            }

            if (deposit.exists) {
                return balance;
            }

            const updatedBalance = Number(
                (balance + usdAmount).toFixed(2)
            );

            tx.update(userDoc.ref, {
                balance: updatedBalance
            });

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

            tx.update(sessionRef, {
                step: 'COMPLETED',
                credited: true,
                updatedAt: Date.now()
            });

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
                step: operatorConfirmed
                    ? 'CREDIT_REVIEW'
                    : 'TRANSFER_REVIEW',
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
                    await userDoc.ref.update({ balance: currentBalance + amountUSD });

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
// 🛠️ إدارة النظام والخدمات
// ==========================================================
app.post('/api/admin/add-service', async (req, res) => {
    const { category, name, price, description } = req.body;
    if (!category || !name || isNaN(parseFloat(price))) return res.status(400).json({ success: false, message: 'بيانات غير مكتملة.' });
    try {
        const docRef = await db.collection('services').add({ category: category.trim(), name: name.trim(), price: parseFloat(price), description: (description || '').trim(), created_at: getFormattedDateTime() });
        res.json({ success: true, id: docRef.id, message: '✅ تم إضافة الخدمة بنجاح!' });
    } catch (e) { res.status(500).json({ success: false, message: 'خطأ في قاعدة البيانات.' }); }
});

app.post('/api/admin/update-service', async (req, res) => {
    const { id, category, name, price, description } = req.body;
    if (!id || !category || !name || isNaN(parseFloat(price))) return res.status(400).json({ success: false, message: 'بيانات غير مكتملة.' });
    try {
        await db.collection('services').doc(id).update({ category: category.trim(), name: name.trim(), price: parseFloat(price), description: (description || '').trim() });
        res.json({ success: true, message: '✅ تم تحديث الخدمة بنجاح!' });
    } catch (e) { res.status(500).json({ success: false, message: 'خطأ.' }); }
});

app.post('/api/admin/delete-service', async (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, message: 'مفقود.' });
    try {
        await db.collection('services').doc(id).delete();
        res.json({ success: true, message: 'تم الحذف بنجاح.' });
    } catch (e) { res.status(500).json({ success: false, message: 'خطأ.' }); }
});

app.get('/api/admin/data', async (req, res) => {
    try {
        const usersSnap = await db.collection('users').get();
        let totalSales = 0;
        const ordersSnap = await db.collection('orders').get();
        ordersSnap.forEach(doc => { totalSales += parseFloat(doc.data().charge || 0); });
        res.json({ success: true, usersCount: usersSnap.size, totalSales });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/api/register', async (req, res) => {
    const { username, email, password } = req.body;
    try {
        const usersRef = db.collection('users');
        const snapshot = await usersRef.where('email', '==', email).get();
        if (!snapshot.empty) return res.status(400).json({ success: false, message: 'البريد مسجل مسبقاً.' });
        const hashedPassword = await bcrypt.hash(password, 10);
        await usersRef.add({ username, email, password: hashedPassword, balance: 0.00, role: 'user', created_at: getFormattedDateTime() });
        res.json({ success: true, message: 'تم إنشاء الحساب بنجاح!', username, email, balance: 0.00 });
    } catch (e) { res.status(500).json({ success: false, message: 'خطأ في الخادم.' }); }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const snapshot = await db.collection('users').where('email', '==', email).get();
        if (snapshot.empty) return res.status(400).json({ success: false, message: 'البريد غير صحيح.' });
        const user = snapshot.docs[0].data();
        if (!await bcrypt.compare(password, user.password)) return res.status(400).json({ success: false, message: 'كلمة المرور خطأ.' });
        res.json({ success: true, message: 'تم تسجيل الدخول!', username: user.username, email: user.email, balance: user.balance });
    } catch (e) { res.status(500).json({ success: false, message: 'خطأ في الخادم.' }); }
});

app.get('/api/user/:email', async (req, res) => {
    try {
        const snapshot = await db.collection('users').where('email', '==', req.params.email).get();
        if (snapshot.empty) return res.status(404).json({ success: false });
        res.json({ success: true, user: snapshot.docs[0].data() });
    } catch (e) { res.status(500).json({ success: false }); }
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
        if (userSnap.empty) { fs.unlinkSync(uploadedFile.path); return res.status(400).json({ success: false, message: 'المستخدم غير موجود.' }); }

        const username = userSnap.docs[0].data().username;
        const dateTime = getFormattedDateTime();

        const depRef = await db.collection('deposit_requests').add({
            username, email, gateway, amount: parseFloat(amount),
            receipt_image: uploadedFile.filename, image_hash: fileHash,
            status: 'معلق', created_at: dateTime
        });

        const receiptUrl = `https://mtnajm.com/${uploadedFile.filename}`;
        const text = `📥 <b>طلب شحن رصيد جديد</b>\n\n👤 <b>المستخدم:</b> ${username}\n📧 <b>البريد:</b> ${email}\n💰 <b>المبلغ:</b> $${amount}\n💳 <b>البوابة:</b> ${gateway}\n🕒 <b>التاريخ والوقت:</b> ${dateTime}\n\n🔗 <a href="${receiptUrl}"><b>[ عرض صورة الإيصال ]</b></a>`;
        const replyMarkup = { inline_keyboard: [[ { text: '✅ شحن الرصيد', callback_data: `dep_accept_${depRef.id}_${email}_${amount}` }, { text: '❌ رفض', callback_data: `dep_reject_${depRef.id}` } ]] };
        sendTelegramTextMessage(DEPOSIT_BOT_TOKEN, ADMIN_CHAT_ID, text, replyMarkup);

        res.json({ success: true, message: 'تم إرسال طلب الشحن بنجاح.' });
    } catch (e) {
        if (uploadedFile && fs.existsSync(uploadedFile.path)) fs.unlinkSync(uploadedFile.path);
        res.status(500).json({ success: false, message: 'خطأ في الخادم.' });
    }
});

app.post('/api/order', async (req, res) => {
    const { username, service, link, quantity, charge } = req.body;
    try {
        const userSnap = await db.collection('users').where('username', '==', username).get();
        if (userSnap.empty) return res.status(400).json({ success: false, message: 'المستخدم غير موجود.' });
        const userRef = userSnap.docs[0].ref;
        const userData = userSnap.docs[0].data();
        if (userData.balance < charge) return res.status(400).json({ success: false, message: 'رصيد غير كافٍ.' });

        const newBalance = userData.balance - charge;
        const dateTime = getFormattedDateTime();
        let orderId = '';

        await db.runTransaction(async (transaction) => {
            transaction.update(userRef, { balance: newBalance });
            const newOrderRef = db.collection('orders').doc();
            orderId = newOrderRef.id;
            transaction.set(newOrderRef, { username, service, link, quantity, charge, status: 'قيد المعالجة', created_at: dateTime });
        });

        const text = `🚀 <b>طلب خدمة جديد</b>\n\n🆔 <b>رقم الطلب:</b> #${orderId}\n👤 <b>المستخدم:</b> ${username}\n📌 <b>الخدمة:</b> ${service}\n🔗 <b>الرابط:</b> ${link}\n📦 <b>الكمية:</b> ${quantity}\n💵 <b>السعر:</b> $${charge}\n🕒 <b>التاريخ والوقت:</b> ${dateTime}\n\n🔄 <b>الحالة: قيد المعالجة</b>`;
        const replyMarkup = { inline_keyboard: [[{ text: '🔄 قيد التنفيذ', callback_data: `ord_progress_${orderId}` }]] };
        sendTelegramTextMessage(ORDERS_BOT_TOKEN, ADMIN_CHAT_ID, text, replyMarkup);
        res.json({ success: true, newBalance, orderId });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.get('/api/orders/:username', async (req, res) => {
    try {
        const snapshot = await db.collection('orders').where('username', '==', req.params.username).get();
        const orders = [];
        snapshot.forEach(doc => orders.push({ id: doc.id, ...doc.data() }));
        res.json({ success: true, orders });
    } catch (e) { res.json({ success: true, orders: [] }); }
});

app.get('/api/services', async (req, res) => {
    try {
        const snapshot = await db.collection('services').get();
        const services = [];
        snapshot.forEach(doc => services.push({ id: doc.id, ...doc.data() }));
        res.json({ success: true, services });
    } catch (e) { res.json({ success: true, services: [] }); }
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
