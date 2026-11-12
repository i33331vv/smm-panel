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

async function callAsiacellAPI(endpoint, method = 'POST', bodyData = null, accessToken = null, deviceId = null, cookies = '', appVersion = '4.2.0') {
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
    let url = cleanEp.startsWith('http') ? cleanEp : (cleanEp.startsWith('api/') ? `https://odpapp.asiacell.com/${cleanEp}` : `https://odpapp.asiacell.com/api/v1/${cleanEp}`);

    const response = await fetch(url, {
        method,
        headers,
        body: (method !== 'GET' && bodyData) ? (typeof bodyData === 'string' ? bodyData : JSON.stringify(bodyData)) : undefined
    });

    let newCookies = cookies;
    const sc = response.headers.get('set-cookie');
    if (sc) newCookies = sc.split(/,(?=\s*[a-zA-Z0-9_-]+=)/).map(c => c.split(';')[0].trim()).join('; ');

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
    const urlMatch = str.match(/https?:\/\/[^"'\s]+smsvalidation[^"'\s]*/i);
    if (urlMatch) result.validationUrl = urlMatch[0];
    const pidInUrl = str.match(/[?&](?:PID|pid|processId|requestId)=([a-zA-Z0-9_-]+)/);
    if (pidInUrl) result.pid = pidInUrl[1];
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

// 3. بدء عملية التحويل وطلب رمز التأكيد
app.post('/api/asiacell/initiate-transfer', async (req, res) => {
    const cleanPhone = (req.body.phone || '').trim();
    const selectedUsd = parseInt(req.body.amountUSD) || 1;
    const amountIQD = selectedUsd * 1000;
    const amountDecimal = `${amountIQD}.0`;

    if (!cleanPhone) {
        return res.status(400).json({
            success: false,
            message: 'رقم الهاتف مفقود.'
        });
    }

    try {
        const doc = await db
            .collection('asiacell_sessions')
            .doc(cleanPhone)
            .get();

        if (!doc.exists || !doc.data().accessToken) {
            return res.status(400).json({
                success: false,
                message: 'انتهت الجلسة، سجل دخولك مجدداً.'
            });
        }

        const s = doc.data();

        const homeRes = await callAsiacellAPI(
            'api/v1/home?lang=ar',
            'GET',
            null,
            s.accessToken,
            s.deviceId,
            s.cookies
        );

        const allUrls = (homeRes.rawText || '').match(
            /[a-zA-Z0-9_\/-]+(?:transfer|me2u|credit|balance|send)[a-zA-Z0-9_\/?-]*/gi
        ) || [];

        // نفس المسارات الموجودة في كودك، لم يتم إثبات صحتها بعد.
        const candidateEndpoints = [
            ...allUrls,
            'api/v1/credit-transfer?lang=ar',
            'api/v1/me2u?lang=ar',
            'api/v1/balance-transfer?lang=ar'
        ];

        const payload = {
            receiverMsisdn: TARGET_ASIACELL_NUMBER,
            msisdn: TARGET_ASIACELL_NUMBER,
            amount: amountIQD,
            transferAmount: amountDecimal
        };

        let tr = null;
        let trInfo = {
            pid: '',
            validationUrl: ''
        };

        for (const ep of [...new Set(candidateEndpoints)]) {
            const attempt = await callAsiacellAPI(
                ep,
                'POST',
                payload,
                s.accessToken,
                s.deviceId,
                s.cookies
            );

            const info = extractLoginSessionInfo(attempt.data);

            // التعديل: تسجيل معلومات التشخيص دون طباعة بيانات الجلسة.
            console.log('ASIACELL_TRANSFER_DEBUG', {
                endpoint: ep.split('?')[0],
                httpStatus: attempt.status,
                wafBlocked: attempt.isWafBlocked,
                success: attempt.data?.success,
                message: attempt.data?.message,
                status: attempt.data?.status,
                nextStep:
                    attempt.data?.nextStep ??
                    attempt.data?.data?.nextStep,
                responseKeys: Object.keys(attempt.data || {}),
                dataKeys:
                    attempt.data?.data &&
                    typeof attempt.data.data === 'object'
                        ? Object.keys(attempt.data.data)
                        : [],
                hasProcessId: Boolean(info.pid),
                hasValidationUrl: Boolean(info.validationUrl)
            });

            if (
                !attempt.isWafBlocked &&
                attempt.data?.success === true &&
                (
                    info.pid ||
                    info.validationUrl ||
                    attempt.data?.nextStep
                )
            ) {
                tr = attempt;
                trInfo = info;
                break;
            }
        }

        if (!tr) {
            return res.status(400).json({
                success: false,
                message:
                    'لم يتم تأكيد إرسال رمز التحويل. راجع سجل الخادم لمعرفة رد آسياسيل.'
            });
        }

        await db
            .collection('asiacell_sessions')
            .doc(cleanPhone)
            .update({
                transferPid: trInfo.pid || '',
                transferValidationUrl:
                    trInfo.validationUrl || 'smsvalidation?lang=ar',
                amountUSD: selectedUsd,
                amountIQD,
                amountDecimal,
                step: 'WAIT_TRANSFER_OTP',
                updatedAt: Date.now()
            });

        return res.json({
            success: true,
            message:
                `📲 تم إرسال رمز تأكيد تحويل (${amountIQD} د.ع) إلى رقمك.`
        });
    } catch (e) {
        return res.status(500).json({
            success: false,
            message: e.message
        });
    }
});
// 4. تأكيد رمز التحويل النهائي وإضافة الرصيد للمستخدم
app.post('/api/asiacell/confirm-transfer', async (req, res) => {
    const { email, phone, transferOtp, amount } = req.body;
    const cleanPhone = (phone || '').trim();
    const finalOtp = (transferOtp || '').trim();
    const usdAmount = parseFloat(amount) || 1;

    if (!email || !/^\d{4,6}$/.test(finalOtp)) return res.status(400).json({ success: false, message: 'أدخل رمز تأكيد التحويل الصحيح.' });

    try {
        const doc = await db.collection('asiacell_sessions').doc(cleanPhone).get();
        if (!doc.exists) return res.status(400).json({ success: false, message: 'انتهت الجلسة.' });
        const s = doc.data();

        const confirmEp = s.transferValidationUrl || 'smsvalidation?lang=ar';
        const confirmPayload = { username: cleanPhone, passcode: finalOtp, otp: finalOtp, receiverMsisdn: TARGET_ASIACELL_NUMBER, amount: s.amountDecimal || "1000.0" };
        if (s.transferPid) confirmPayload.PID = s.transferPid;

        const cr = await callAsiacellAPI(confirmEp, 'POST', confirmPayload, s.accessToken, s.deviceId, s.cookies);
        const d = cr.data || {};

        if (cr.isWafBlocked || d.success === false || d.status === 'FAILED') {
            return res.status(400).json({ success: false, message: `❌ رمز التحويل غير صحيح أو مرفوض من الشركة.` });
        }

        await db.collection('asiacell_sessions').doc(cleanPhone).delete();

        const userSnap = await db.collection('users').where('email', '==', email).get();
        if (userSnap.empty) return res.status(400).json({ success: false, message: 'المستخدم غير موجود.' });

        const userDoc = userSnap.docs[0];
        const newBalance = parseFloat((parseFloat(userDoc.data().balance || 0) + usdAmount).toFixed(2));
        await userDoc.ref.update({ balance: newBalance });

        await db.collection('deposit_requests').add({
            username: userDoc.data().username, email, gateway: 'Asiacell OTP Auto',
            sender_phone: cleanPhone, amount: usdAmount, amount_iqd: s.amountIQD || (usdAmount * 1000),
            recipient: TARGET_ASIACELL_NUMBER, status: 'مقبول تلقائياً', created_at: getFormattedDateTime()
        });

        sendTelegramTextMessage(DEPOSIT_BOT_TOKEN, ADMIN_CHAT_ID, `✅ <b>شحن آسياسيل تلقائي ناجح (OTP):</b>\nالمستخدم: ${email}\nالمبلغ: $${usdAmount} (${s.amountIQD} د.ع)\nمن الرقم: ${cleanPhone}`);
        return res.json({ success: true, message: `🎉 تم شحن رصيدك بنجاح بمبلغ $${usdAmount}!`, newBalance });
    } catch (e) {
        return res.status(500).json({ success: false, message: e.message });
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
