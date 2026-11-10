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

const IQD_PER_USD_RATE = 1000; 

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
// ⚡ نظام الدفع المؤمّن عبر آسياسيل (معالجة الهيدرز ومسارات ODP الرسمية)
// ==========================================================

async function callAsiacellAPI(endpoint, method = 'POST', bodyData = null, accessToken = null, deviceId = null, cookies = '') {
    const currentDeviceId = deviceId || crypto.randomUUID();
    // الهيدرز الرسمية الدقيقة لتطبيق آسياسيل بدون أي هيدر غريب يبطل الجلسة
    const headers = {
        'Content-Type': 'application/json; charset=UTF-8',
        'Accept': 'application/json, text/plain, */*',
        'X-ODP-API-KEY': '1ccbc4c913bc4ce785a0a2de444aa0d6',
        'DeviceID': currentDeviceId,
        'X-OS-Version': '14',
        'X-Device-Type': 'Android',
        'X-ODP-APP-VERSION': '4.2.0',
        'X-ODP-CHANNEL': 'MOBILE',
        'Accept-Language': 'ar',
        'User-Agent': 'okhttp/4.11.0',
        'X-Forwarded-For': '37.236.100.15',
        'Client-IP': '37.236.100.15'
    };

    if (accessToken) {
        const cleanToken = String(accessToken).replace(/^Bearer\s+/i, '').trim();
        headers['Authorization'] = `Bearer ${cleanToken}`;
    }
    if (cookies) {
        headers['Cookie'] = cookies;
    }

    const cleanEp = endpoint.replace(/^\/+/, '');
    const url = cleanEp.startsWith('http') ? cleanEp : (cleanEp.startsWith('api/') ? `https://odpapp.asiacell.com/${cleanEp}` : `https://odpapp.asiacell.com/api/v1/${cleanEp}`);

    const response = await fetch(url, {
        method,
        headers,
        body: (method !== 'GET' && bodyData) ? (typeof bodyData === 'string' ? bodyData : JSON.stringify(bodyData)) : undefined
    });

    let cookieMap = {};
    if (cookies) {
        cookies.split(';').forEach(pair => {
            const [k, ...v] = pair.trim().split('=');
            if (k) cookieMap[k] = v.join('=');
        });
    }
    let setCookies = [];
    if (typeof response.headers.getSetCookie === 'function') {
        setCookies = response.headers.getSetCookie() || [];
    } else {
        const sc = response.headers.get('set-cookie');
        if (sc) setCookies = sc.split(/,(?=\s*[a-zA-Z0-9_-]+=)/);
    }
    setCookies.forEach(c => {
        const firstPart = c.split(';')[0].trim();
        const [k, ...v] = firstPart.split('=');
        if (k) cookieMap[k] = v.join('=');
    });
    const mergedCookies = Object.entries(cookieMap).map(([k, v]) => `${k}=${v}`).join('; ');

    const text = await response.text();
    console.log(`[Asiacell API - ${method} ${endpoint}] Status: ${response.status} | Body: ${text.substring(0, 500)}`);

    let json = {};
    try { json = JSON.parse(text); } catch (e) { json = { rawText: text, httpStatus: response.status }; }

    return { status: response.status, ok: response.ok, data: json, deviceId: currentDeviceId, cookies: mergedCookies };
}

function extractLoginSessionInfo(obj) {
    let result = { pid: '', validationUrl: '' };
    if (!obj || typeof obj !== 'object') return result;

    const str = JSON.stringify(obj);
    const urlMatch = str.match(/https?:\/\/[^"'\s]+(?:smsvalidation|confirm|verify)[^"'\s]*/i);
    if (urlMatch) result.validationUrl = urlMatch[0];

    const pidInUrl = str.match(/[?&](?:PID|pid|processId|requestId)=([a-zA-Z0-9_-]+)/);
    if (pidInUrl) result.pid = pidInUrl[1];

    function searchKeys(o) {
        for (const [k, v] of Object.entries(o)) {
            if (v && typeof v === 'object') {
                searchKeys(v);
            } else if (typeof v === 'string' || typeof v === 'number') {
                const keyLower = k.toLowerCase();
                if (!result.pid && (keyLower === 'pid' || keyLower === 'processid' || keyLower === 'requestid' || keyLower === 'transactionid')) {
                    result.pid = String(v);
                }
                if (!result.validationUrl && (keyLower.includes('url') || keyLower.includes('link')) && String(v).includes('smsvalidation')) {
                    result.validationUrl = String(v);
                }
            }
        }
    }
    searchKeys(obj);
    return result;
}

// استخراج جميع المسارات والروابط من أي كائن في التطبيق
function extractTransferPaths(obj) {
    let allPaths = [];
    let bestTransferEp = '';
    if (!obj || typeof obj !== 'object') return { allPaths, bestTransferEp };

    function scan(node) {
        if (!node || typeof node !== 'object') return;
        const flat = JSON.stringify(node);
        const isTransferNode = flat.includes('تحويل الرصيد') || flat.toLowerCase().includes('transfer credit') || flat.toLowerCase().includes('credit transfer') || flat.toLowerCase().includes('credit-transfer');

        for (const [k, v] of Object.entries(node)) {
            if (v && typeof v === 'object') {
                scan(v);
            } else if (typeof v === 'string') {
                const valTrim = v.trim();
                if (!valTrim.endsWith('.png') && !valTrim.endsWith('.svg') && !valTrim.endsWith('.jpg') && valTrim.length > 2 && valTrim.length < 180) {
                    if (valTrim.includes('/') || valTrim.toLowerCase().includes('transfer') || k.toLowerCase().includes('url') || k.toLowerCase().includes('link') || k.toLowerCase().includes('route') || k.toLowerCase().includes('action')) {
                        allPaths.push(`${k}:${valTrim}`);
                        if (isTransferNode && !bestTransferEp && (valTrim.includes('/') || valTrim.toLowerCase().includes('transfer'))) {
                            bestTransferEp = valTrim;
                        }
                    }
                }
            }
        }
    }
    scan(obj);
    return { allPaths: [...new Set(allPaths)], bestTransferEp };
}

// 1. طلب رمز الدخول
app.post('/api/asiacell/send-otp', async (req, res) => {
    const cleanPhone = (req.body.phone || '').trim();
    if (!/^077\d{8}$/.test(cleanPhone)) {
        return res.status(400).json({ success: false, message: 'يرجى إدخال رقم آسياسيل صحيح.' });
    }

    try {
        const result = await callAsiacellAPI('login?lang=ar', 'POST', { username: cleanPhone, captchaCode: '' });
        const info = extractLoginSessionInfo(result.data);
        const nextStep = result.data?.nextStep || result.data?.data?.nextStep;

        if (Boolean(info.pid) || Boolean(info.validationUrl) || nextStep === 'OTP' || nextStep === 'SMS_VALIDATION' || result.data?.success === true) {
            await db.collection('asiacell_sessions').doc(cleanPhone).set({
                phone: cleanPhone,
                pid: info.pid,
                validationUrl: info.validationUrl,
                deviceId: result.deviceId,
                cookies: result.cookies || '',
                step: 'WAIT_LOGIN_OTP',
                updatedAt: Date.now()
            });
            return res.json({ success: true, message: `✅ تم إرسال رمز تسجيل الدخول إلى الرقم ${cleanPhone}.` });
        }
        return res.status(400).json({ success: false, message: `⚠️ رد آسياسيل: ${result.data?.message || JSON.stringify(result.data)}` });
    } catch (e) {
        return res.status(500).json({ success: false, message: e.message });
    }
});

// 2. التحقق من رمز الدخول
app.post('/api/asiacell/verify-login', async (req, res) => {
    const cleanPhone = (req.body.phone || '').trim();
    const cleanOtp = (req.body.otp || '').trim();
    if (!cleanPhone || !cleanOtp) {
        return res.status(400).json({ success: false, message: 'يرجى إدخال رقم الهاتف ورمز الدخول.' });
    }

    try {
        const doc = await db.collection('asiacell_sessions').doc(cleanPhone).get();
        if (!doc.exists) return res.status(400).json({ success: false, message: 'اطلب الرمز أولاً.' });
        const s = doc.data();

        const targetEndpoint = s.validationUrl || 'smsvalidation?lang=ar';
        const verifyPayload = {
            username: cleanPhone,
            passcode: cleanOtp
        };
        if (s.pid) {
            verifyPayload.PID = s.pid;
        }

        const vr = await callAsiacellAPI(targetEndpoint, 'POST', verifyPayload, null, s.deviceId, s.cookies);
        const token = vr.data?.access_token || vr.data?.data?.access_token || vr.data?.token || vr.data?.data?.token || vr.data?.accessToken || vr.data?.data?.accessToken;

        if (!token || vr.data?.success === false) {
            return res.status(400).json({ success: false, message: `❌ رد آسياسيل: ${vr.data?.message || JSON.stringify(vr.data)}` });
        }

        await db.collection('asiacell_sessions').doc(cleanPhone).update({
            accessToken: token,
            cookies: vr.cookies || s.cookies || '',
            step: 'SELECT_AMOUNT',
            updatedAt: Date.now()
        });

        return res.json({ success: true, message: '✅ تم تسجيل الدخول بنجاح! اختر المبلغ الآن.' });
    } catch (e) {
        return res.status(500).json({ success: false, message: e.message });
    }
});

// 3. طلب تحويل الرصيد إلى 07738889080
app.post('/api/asiacell/initiate-transfer', async (req, res) => {
    const cleanPhone = (req.body.phone || '').trim();
    const usd = parseInt(req.body.amountUSD);
    if (!cleanPhone || isNaN(usd) || usd < 1 || usd > 10) {
        return res.status(400).json({ success: false, message: 'يرجى اختيار مبلغ صحيح بين 1$ و 10$.' });
    }

    const amountIQD = usd * IQD_PER_USD_RATE;
    const formattedAmountDecimal = amountIQD.toFixed(1);

    try {
        const doc = await db.collection('asiacell_sessions').doc(cleanPhone).get();
        if (!doc.exists || !doc.data().accessToken) {
            return res.status(400).json({ success: false, message: 'سجل دخولك أولاً.' });
        }
        const s = doc.data();

        // 1. استعلام نظيف من مسار profile/lineinfo?lang=ar (بواسطة GET كما ظهر في حسابك) لاستخراج مسارات الحساب
        let discoveredEp = '';
        let collectedPaths = [];
        let lineInfoSummary = '';

        const liRes = await callAsiacellAPI('profile/lineinfo?lang=ar', 'GET', null, s.accessToken, s.deviceId, s.cookies);
        lineInfoSummary = JSON.stringify(liRes.data || {}).substring(0, 260);
        const extLi = extractTransferPaths(liRes.data);
        collectedPaths.push(...extLi.allPaths);
        if (extLi.bestTransferEp) discoveredEp = extLi.bestTransferEp;

        // فحص مسار القوائم في تطبيق ODP إذا لم يكن الرابط داخل lineinfo
        for (const menuEp of ['app/init?lang=ar', 'menu?lang=ar', 'dashboard?lang=ar']) {
            if (discoveredEp) break;
            const mRes = await callAsiacellAPI(menuEp, 'GET', null, s.accessToken, s.deviceId, s.cookies);
            const extM = extractTransferPaths(mRes.data);
            collectedPaths.push(...extM.allPaths);
            if (extM.bestTransferEp) discoveredEp = extM.bestTransferEp;
        }

        const transferPayload = {
            receiverMsisdn: TARGET_ASIACELL_NUMBER,
            recipientMsisdn: TARGET_ASIACELL_NUMBER,
            msisdn: TARGET_ASIACELL_NUMBER,
            targetMsisdn: TARGET_ASIACELL_NUMBER,
            phoneNumber: TARGET_ASIACELL_NUMBER,
            amount: formattedAmountDecimal,
            transferAmount: amountIQD
        };

        // المسارات الفعلية المعتمدة في نظام ODP Asiacell لتحويل الرصيد
        const candidateEndpoints = [];
        if (discoveredEp) candidateEndpoints.push(discoveredEp);
        candidateEndpoints.push(
            'credit-transfer?lang=ar',
            'balance-transfer?lang=ar',
            'transfer-credit?lang=ar',
            'profile/credit-transfer?lang=ar',
            'cdr/credit-transfer?lang=ar',
            'vas/credit-transfer?lang=ar',
            'services/credit-transfer?lang=ar',
            'recharge/transfer?lang=ar'
        );

        let tr = null;
        let trInfo = { pid: '', validationUrl: '' };
        let nonNotFoundReplies = [];

        for (const ep of candidateEndpoints) {
            const attempt = await callAsiacellAPI(ep, 'POST', transferPayload, s.accessToken, s.deviceId, s.cookies);
            const info = extractLoginSessionInfo(attempt.data);
            const rawReply = JSON.stringify(attempt.data || {});

            if (!rawReply.includes('Resource not found') && attempt.status !== 404) {
                nonNotFoundReplies.push(`${ep}->${rawReply.substring(0, 140)}`);
            }

            const isGenuineTransferOtpSent = (
                attempt.data?.success === true &&
                (Boolean(info.pid) || Boolean(info.validationUrl) || attempt.data?.nextStep === 'OTP' || attempt.data?.nextStep === 'SMS_VALIDATION')
            );

            if (isGenuineTransferOtpSent) {
                tr = attempt;
                trInfo = info;
                break;
            }
        }

        if (!tr) {
            return res.status(400).json({
                success: false,
                message: `🔍 محتوى lineinfo(GET): (${lineInfoSummary}) | المسارات المكتشفة: [${[...new Set(collectedPaths)].slice(0, 10).join(' , ')}] | ردود مختلفة عن Not Found: [${nonNotFoundReplies.join(' | ')}]`
            });
        }

        await db.collection('asiacell_sessions').doc(cleanPhone).update({
            transferPid: trInfo.pid,
            transferValidationUrl: trInfo.validationUrl || 'smsvalidation?lang=ar',
            amountUSD: usd,
            amountIQD: amountIQD,
            amountDecimal: formattedAmountDecimal,
            step: 'WAIT_TRANSFER_OTP',
            updatedAt: Date.now()
        });

        return res.json({
            success: true,
            step: 'CONFIRM_TRANSFER_OTP',
            message: `📲 تم إرسال رمز تأكيد التحويل (${formattedAmountDecimal} د.ع) إلى هاتفك (${cleanPhone}) بنجاح.`
        });
    } catch (e) {
        return res.status(500).json({ success: false, message: e.message });
    }
});

// 4. تأكيد رمز التحويل النهائي (إغلاق تام لثغرة الرمز العشوائي)
app.post('/api/asiacell/confirm-transfer', async (req, res) => {
    const { email, phone, transferOtp, otp } = req.body;
    const cleanPhone = (phone || '').trim();
    const finalOtp = (transferOtp || otp || '').trim();

    if (!email || !/^\d{4,6}$/.test(finalOtp)) {
        return res.status(400).json({ success: false, message: 'أدخل رمز التأكيد الصحيح المكون من 6 أرقام.' });
    }

    try {
        const doc = await db.collection('asiacell_sessions').doc(cleanPhone).get();
        if (!doc.exists || doc.data().step !== 'WAIT_TRANSFER_OTP') {
            return res.status(400).json({ success: false, message: 'لا توجد عملية تحويل نشطة لهذا الرقم.' });
        }

        const s = doc.data();

        if (!s.transferPid) {
            return res.status(400).json({
                success: false,
                message: '🚫 عملية غير مصرح بها: لم يتم إصدار معرّف تحويل (PID) حقيقي من شركة آسياسيل.'
            });
        }

        const confirmEp = s.transferValidationUrl || 'smsvalidation?lang=ar';
        const confirmPayload = {
            PID: s.transferPid,
            username: cleanPhone,
            passcode: finalOtp,
            receiverMsisdn: TARGET_ASIACELL_NUMBER,
            amount: s.amountDecimal || s.amountIQD.toFixed(1)
        };

        const cr = await callAsiacellAPI(confirmEp, 'POST', confirmPayload, s.accessToken, s.deviceId, s.cookies);
        const d = cr.data || {};
        const dStr = JSON.stringify(d).toLowerCase();

        const isStrictlyConfirmed = (
            d.success === true &&
            !d.error &&
            d.status !== 'FAILED' &&
            !dStr.includes('not found') &&
            !dStr.includes('unauthorized') &&
            !dStr.includes('invalid') &&
            (Boolean(d.transactionId) || Boolean(d.data?.transactionId) || d.status === 'SUCCESS' || d.data?.status === 'SUCCESS')
        );

        if (!isStrictlyConfirmed) {
            return res.status(400).json({
                success: false,
                message: `❌ رفضت آسياسيل الرمز ولم يتم استقطاع أي رصيد! رد الشركة: (${d.message || JSON.stringify(d)})`
            });
        }

        await db.collection('asiacell_sessions').doc(cleanPhone).delete();

        const userSnap = await db.collection('users').where('email', '==', email).get();
        const userDoc = userSnap.docs[0];
        const newBalance = parseFloat((parseFloat(userDoc.data().balance || 0) + s.amountUSD).toFixed(2));
        await userDoc.ref.update({ balance: newBalance });

        await db.collection('deposit_requests').add({
            username: userDoc.data().username, email, gateway: 'Asiacell Auto',
            sender_phone: cleanPhone, amount: s.amountUSD, amount_iqd: s.amountIQD,
            recipient: TARGET_ASIACELL_NUMBER, status: 'مقبول تلقائياً', created_at: getFormattedDateTime()
        });

        sendTelegramTextMessage(DEPOSIT_BOT_TOKEN, ADMIN_CHAT_ID, `✅ <b>شحن آسياسيل ناجح:</b> $${s.amountUSD} (${s.amountIQD} د.ع) من ${cleanPhone} إلى ${TARGET_ASIACELL_NUMBER}`);
        return res.json({ success: true, message: `🎉 تم الشحن بنجاح! أضيف $${s.amountUSD} لحسابك.`, newBalance });
    } catch (e) {
        return res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/admin/add-service', async (req, res) => {
    const { category, name, price, description } = req.body;
    if (!category || !name || isNaN(parseFloat(price))) {
        return res.status(400).json({ success: false, message: 'يرجى إكمال بيانات الخدمة بشكل صحيح.' });
    }
    try {
        const docRef = await db.collection('services').add({
            category: category.trim(),
            name: name.trim(),
            price: parseFloat(price),
            description: (description || '').trim(),
            created_at: getFormattedDateTime()
        });
        res.json({ success: true, id: docRef.id, message: '✅ تم إضافة الخدمة للنظام بنجاح!' });
    } catch (e) {
        res.status(500).json({ success: false, message: 'حدث خطأ في قاعدة البيانات.' });
    }
});

app.post('/api/admin/update-service', async (req, res) => {
    const { id, category, name, price, description } = req.body;
    if (!id || !category || !name || isNaN(parseFloat(price))) {
        return res.status(400).json({ success: false, message: 'بيانات التعديل غير مكتملة.' });
    }
    try {
        await db.collection('services').doc(id).update({
            category: category.trim(),
            name: name.trim(),
            price: parseFloat(price),
            description: (description || '').trim()
        });
        res.json({ success: true, message: '✅ تم تحديث الخدمة بنجاح!' });
    } catch (e) {
        res.status(500).json({ success: false, message: 'حدث خطأ.' });
    }
});

app.post('/api/admin/delete-service', async (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, message: 'معرف الخدمة مفقود.' });
    try {
        await db.collection('services').doc(id).delete();
        res.json({ success: true, message: 'تم حذف الخدمة بنجاح.' });
    } catch (e) {
        res.status(500).json({ success: false, message: 'حدث خطأ.' });
    }
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
