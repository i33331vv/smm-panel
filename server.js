const express = require('express');
const path = require('path');
const app = express();
const bcrypt = require('bcryptjs');
const multer = require('multer');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');

// إعدادات بوتات التليجرام والمعرفات الخاصة بك
const DEPOSIT_BOT_TOKEN = '9075969471:AAH_G_KMD7S8rbMibf663_PavR41zb1dEhM';
const ORDERS_BOT_TOKEN = '9023175997:AAGuvzz3eLywKIBkTjs3w9NCVnmutRblCEc';
const ADMIN_CHAT_ID = '8671448765';
const TARGET_ASIACELL_NUMBER = '07738889080'; // رقمك الأساسي لاستلام الرصيد

// التسعيرة: 1 دولار = 1000 دينار رصيد آسياسيل
const IQD_PER_USD_RATE = 1000; 

// استيراد Firebase
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

// نظام الاستعلام المستمر للبوتات
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
// ⚡ نظام الدفع المتكامل عبر آسياسيل (محدث بالكامل مع حفظ الكوكيز والـ PID)
// ==========================================================

async function callAsiacellAPI(endpoint, method = 'POST', bodyData = null, accessToken = null, deviceId = null, cookies = '') {
    const currentDeviceId = deviceId || crypto.randomUUID();
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
        headers['Authorization'] = `Bearer ${accessToken}`;
    }
    if (cookies) {
        headers['Cookie'] = cookies;
    }

    const url = endpoint.startsWith('http') ? endpoint : `https://odpapp.asiacell.com/api/v1/${endpoint}`;

    const response = await fetch(url, {
        method: method,
        headers: headers,
        body: bodyData ? JSON.stringify(bodyData) : undefined
    });

    // التقاط الكوكيز (Cookies) لضمان استمرارية الجلسة مع سيرفر آسياسيل
    let newCookies = cookies;
    const setCookieHeader = response.headers.get('set-cookie');
    if (setCookieHeader) {
        newCookies = setCookieHeader.split(',').map(c => c.split(';')[0].trim()).join('; ');
    }

    const text = await response.text();
    console.log(`[Asiacell API - ${endpoint}] Status: ${response.status} | Body: ${text}`);

    let json = {};
    try {
        json = JSON.parse(text);
    } catch (err) {
        throw new Error(`استجابة غير متوقعة من آسياسيل (كود: ${response.status})`);
    }

    return { status: response.status, ok: response.ok, data: json, deviceId: currentDeviceId, cookies: newCookies };
}

// دالة استخراج الـ PID بذكاء من أي مكان في رد آسياسيل
function extractPID(data) {
    if (!data) return '';
    if (data.PID) return data.PID;
    if (data.pid) return data.pid;
    if (data.data?.PID) return data.data.PID;
    if (data.data?.pid) return data.data.pid;
    // في بعض التحديثات ترسل آسياسيل الـ PID داخل رابط nextStepUrl أو smsValidationUrl
    const urlStr = data.smsValidationUrl || data.nextStepUrl || data.data?.smsValidationUrl || data.data?.nextStepUrl || '';
    const match = urlStr.match(/[?&](?:PID|pid)=([^&]+)/);
    if (match) return match[1];
    return '';
}

function formatAsiacellErrorMessage(rawMessage) {
    if (!rawMessage) return 'تعذر إتمام العملية لدى شركة آسياسيل، يرجى المحاولة لاحقاً.';
    const msg = rawMessage.toLowerCase();
    if (msg.includes('insufficient') || msg.includes('balance') || msg.includes('رصيد') || msg.includes('كافي') || msg.includes('لا يكفي')) {
        return '❌ عذراً، رصيدك في شريحة آسياسيل لا يكفي لإتمام هذا التحويل، أو ليس لديك رصيد كافٍ لتغطية كلفة التحويل.';
    }
    if (msg.includes('fee') || msg.includes('charge') || msg.includes('كلفة') || msg.includes('رسوم')) {
        return '❌ عذراً، ليس لديك رصيد كافٍ لتغطية كلفة (رسوم) خدمة تحويل الرصيد من آسياسيل.';
    }
    return `⚠️ رد آسياسيل: ${rawMessage}`;
}

// المرحلة 1: إدخال رقم الهاتف وإرسال رمز تسجيل الدخول
app.post('/api/asiacell/send-otp', async (req, res) => {
    const { phone } = req.body;
    if (!phone || !/^077\d{8}$/.test(phone.trim())) {
        return res.status(400).json({ success: false, message: 'يرجى إدخال رقم آسياسيل صحيح مكون من 11 رقماً ويبدأ بـ 077' });
    }

    const cleanPhone = phone.trim();

    try {
        const result = await callAsiacellAPI('login?lang=ar', 'POST', {
            username: cleanPhone,
            captchaCode: ''
        });

        const pid = extractPID(result.data);
        const nextStep = result.data?.nextStep || result.data?.data?.nextStep;

        if (result.ok || pid || nextStep === 'OTP' || nextStep === 'SMS_VALIDATION') {
            await db.collection('asiacell_sessions').doc(cleanPhone).set({
                phone: cleanPhone,
                pid: pid,
                deviceId: result.deviceId,
                cookies: result.cookies || '',
                rawLoginResponse: JSON.stringify(result.data),
                step: 'WAIT_LOGIN_OTP',
                updatedAt: Date.now()
            });

            return res.json({
                success: true,
                step: 'VERIFY_LOGIN_OTP',
                message: `✅ تم إرسال رمز تسجيل الدخول إلى الرقم ${cleanPhone}. ضع الرمز للمتابعة.`
            });
        } else {
            return res.status(400).json({
                success: false,
                message: formatAsiacellErrorMessage(result.data?.message || result.data?.error_description || JSON.stringify(result.data))
            });
        }
    } catch (error) {
        return res.status(500).json({ success: false, message: `❌ خطأ اتصال: ${error.message}` });
    }
});

// المرحلة 2: التحقق من رمز تسجيل الدخول والانتقال لاختيار المبلغ (1$ إلى 10$)
app.post('/api/asiacell/verify-login', async (req, res) => {
    const { phone, otp } = req.body;
    if (!phone || !otp) {
        return res.status(400).json({ success: false, message: 'يرجى إدخال رقم الهاتف ورمز تسجيل الدخول.' });
    }

    const cleanPhone = phone.trim();
    const cleanOtp = otp.trim();

    try {
        const sessionDoc = await db.collection('asiacell_sessions').doc(cleanPhone).get();
        if (!sessionDoc.exists) {
            return res.status(400).json({ success: false, message: 'لم يتم العثور على جلسة لهذا الرقم، اطلب الرمز من جديد.' });
        }

        const session = sessionDoc.data();

        // المحاولة 1: الصيغة الرسمية لتطبيق آسياسيل الحديث (PID + passcode فقط)
        let payload1 = { passcode: cleanOtp };
        if (session.pid) payload1.PID = session.pid;

        let verifyResult = await callAsiacellAPI('smsvalidation?lang=ar', 'POST', payload1, null, session.deviceId, session.cookies);
        let accessToken = verifyResult.data?.access_token || verifyResult.data?.data?.access_token || verifyResult.data?.token || verifyResult.data?.data?.token;

        // المحاولة 2: إذا لم ينجح، نجرب إرسال username مع PID و passcode
        if (!accessToken) {
            let payload2 = { username: cleanPhone, passcode: cleanOtp };
            if (session.pid) payload2.PID = session.pid;
            const retry1 = await callAsiacellAPI('smsvalidation?lang=ar', 'POST', payload2, null, session.deviceId, session.cookies);
            accessToken = retry1.data?.access_token || retry1.data?.data?.access_token || retry1.data?.token || retry1.data?.data?.token;
            if (accessToken) verifyResult = retry1;
        }

        // المحاولة 3: في حال كانت الواجهة تستخدم حقل otpCode بدلاً من passcode
        if (!accessToken) {
            let payload3 = { username: cleanPhone, passcode: cleanOtp, otp: cleanOtp, otpCode: cleanOtp, PID: session.pid || undefined };
            const retry2 = await callAsiacellAPI('smsvalidation?lang=ar', 'POST', payload3, null, session.deviceId, session.cookies);
            accessToken = retry2.data?.access_token || retry2.data?.data?.access_token || retry2.data?.token || retry2.data?.data?.token;
            if (accessToken) verifyResult = retry2;
        }

        if (!accessToken) {
            const errMsg = verifyResult.data?.message || verifyResult.data?.error_description || JSON.stringify(verifyResult.data);
            return res.status(400).json({
                success: false,
                message: `❌ رفض سيرفر آسياسيل الرمز. السبب من آسياسيل: (${errMsg}) | [PID: ${session.pid ? 'موجود' : 'مفقود'}]`
            });
        }

        const refreshToken = verifyResult.data?.refresh_token || verifyResult.data?.data?.refresh_token || '';

        await db.collection('asiacell_sessions').doc(cleanPhone).update({
            accessToken: accessToken,
            refreshToken: refreshToken,
            cookies: verifyResult.cookies || session.cookies || '',
            step: 'SELECT_AMOUNT',
            updatedAt: Date.now()
        });

        return res.json({
            success: true,
            step: 'SELECT_AMOUNT',
            message: '✅ تم تسجيل الدخول بنجاح! اختر الآن كم تريد أن تشحن حسابك (من 1$ إلى 10$).'
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: `حدث خطأ أثناء التحقق: ${error.message}` });
    }
});

// المرحلة 3: اختيار المبلغ (1$ - 10$) وطلب التحويل (فحص الرصيد + كلفة التحويل + إرسال رمز التأكيد)
app.post('/api/asiacell/initiate-transfer', async (req, res) => {
    const { phone, amountUSD } = req.body;
    const usd = parseInt(amountUSD);

    if (!phone || isNaN(usd) || usd < 1 || usd > 10) {
        return res.status(400).json({ success: false, message: 'يرجى اختيار مبلغ صحيح بين 1$ و 10$.' });
    }

    const cleanPhone = phone.trim();
    const transferAmountIQD = usd * IQD_PER_USD_RATE;

    try {
        const sessionDoc = await db.collection('asiacell_sessions').doc(cleanPhone).get();
        if (!sessionDoc.exists || !sessionDoc.data().accessToken) {
            return res.status(400).json({ success: false, message: 'انتهت جلسة الدخول، يرجى كتابة رقمك من جديد.' });
        }

        const session = sessionDoc.data();

        const transferResult = await callAsiacellAPI('credit-transfer/transfer?lang=ar', 'POST', {
            receiverMsisdn: TARGET_ASIACELL_NUMBER,
            amount: transferAmountIQD
        }, session.accessToken, session.deviceId, session.cookies);

        const transferPid = extractPID(transferResult.data) || transferResult.data?.transactionId || '';
        const nextStep = transferResult.data?.nextStep || transferResult.data?.data?.nextStep;

        if (!transferResult.ok && !transferPid && nextStep !== 'OTP' && nextStep !== 'SMS_VALIDATION') {
            return res.status(400).json({
                success: false,
                message: formatAsiacellErrorMessage(transferResult.data?.message || transferResult.data?.error_description || JSON.stringify(transferResult.data))
            });
        }

        await db.collection('asiacell_sessions').doc(cleanPhone).update({
            transferPid: transferPid,
            amountUSD: usd,
            amountIQD: transferAmountIQD,
            step: 'WAIT_TRANSFER_OTP',
            updatedAt: Date.now()
        });

        return res.json({
            success: true,
            step: 'CONFIRM_TRANSFER_OTP',
            message: `📲 تم إرسال رمز تأكيد تحويل (${transferAmountIQD} دينار = ${usd}$) إلى هاتفك. ضع رمز التأكيد لإتمام الشحن.`
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'حدث خطأ أثناء طلب تحويل الرصيد من آسياسيل.' });
    }
});

// المرحلة 4: إدخال رمز تأكيد التحويل النهائي وإضافة الرصيد لحساب المستخدم في الموقع
app.post('/api/asiacell/confirm-transfer', async (req, res) => {
    const { email, phone, transferOtp, otp, amount } = req.body;
    const finalOtp = (transferOtp || otp || '').trim();

    if (!email || !finalOtp) {
        return res.status(400).json({ success: false, message: 'يرجى إدخال رمز تأكيد التحويل.' });
    }

    try {
        let cleanPhone = phone ? phone.trim() : '';
        let sessionDoc;

        if (cleanPhone) {
            sessionDoc = await db.collection('asiacell_sessions').doc(cleanPhone).get();
        } else {
            const recentSnap = await db.collection('asiacell_sessions').orderBy('updatedAt', 'desc').limit(1).get();
            if (!recentSnap.empty) {
                sessionDoc = recentSnap.docs[0];
                cleanPhone = sessionDoc.id;
            }
        }

        if (!sessionDoc || !sessionDoc.exists) {
            return res.status(400).json({ success: false, message: 'لم يتم العثور على جلسة تحويل نشطة، يرجى البدء من جديد.' });
        }

        const session = sessionDoc.data();

        const confirmPayload = {
            PID: session.transferPid || undefined,
            passcode: finalOtp,
            otp: finalOtp,
            receiverMsisdn: TARGET_ASIACELL_NUMBER,
            amount: session.amountIQD || (parseInt(amount || 1) * IQD_PER_USD_RATE)
        };

        const confirmResult = await callAsiacellAPI('credit-transfer/confirm?lang=ar', 'POST', confirmPayload, session.accessToken, session.deviceId, session.cookies);

        if (!confirmResult.ok && confirmResult.data?.success !== true && confirmResult.data?.status !== 'SUCCESS') {
            return res.status(400).json({
                success: false,
                message: formatAsiacellErrorMessage(confirmResult.data?.message || confirmResult.data?.error_description || 'رمز تأكيد التحويل غير صحيح أو الرصيد غير كافٍ.')
            });
        }

        const creditAmountUSD = session.amountUSD || parseInt(amount || 1);
        const transferAmountIQD = session.amountIQD || (creditAmountUSD * IQD_PER_USD_RATE);

        await db.collection('asiacell_sessions').doc(cleanPhone).delete();

        const userSnap = await db.collection('users').where('email', '==', email).get();
        if (userSnap.empty) return res.status(400).json({ success: false, message: 'المستخدم غير موجود في الموقع.' });

        const userDoc = userSnap.docs[0];
        const currentBalance = parseFloat(userDoc.data().balance || 0);
        const newBalance = parseFloat((currentBalance + creditAmountUSD).toFixed(2));

        await userDoc.ref.update({ balance: newBalance });

        const dateTime = getFormattedDateTime();
        await db.collection('deposit_requests').add({
            username: userDoc.data().username,
            email: email,
            gateway: 'Asiacell Auto Transfer',
            sender_phone: cleanPhone,
            amount: creditAmountUSD,
            amount_iqd: transferAmountIQD,
            recipient: TARGET_ASIACELL_NUMBER,
            status: 'مقبول تلقائياً',
            created_at: dateTime
        });

        const telegramMsg = `✅ <b>شحن آسياسيل تلقائي مكتمل</b>\n\n👤 <b>المستخدم:</b> ${userDoc.data().username}\n📱 <b>رقم المحول:</b> ${cleanPhone}\n📲 <b>إلى رقمك:</b> ${TARGET_ASIACELL_NUMBER}\n💴 <b>الرصيد المحول:</b> ${transferAmountIQD} د.ع\n💵 <b>المضاف للموقع:</b> $${creditAmountUSD}\n🕒 <b>الوقت:</b> ${dateTime}`;
        sendTelegramTextMessage(DEPOSIT_BOT_TOKEN, ADMIN_CHAT_ID, telegramMsg);

        return res.json({
            success: true,
            message: `🎉 تم تأكيد التحويل واستقطاع ${transferAmountIQD} دينار بنجاح! تمت إضافة $${creditAmountUSD} إلى حسابك.`,
            newBalance
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'حدث خطأ أثناء تأكيد التحويل النهائي.' });
    }
});

// ==========================================================
// 🛡️ مسارات لوحة المدير (إضافة / تعديل / حذف الخدمات + الإحصائيات)
// ==========================================================
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
        console.error('Add Service Error:', e);
        res.status(500).json({ success: false, message: 'حدث خطأ في قاعدة البيانات أثناء إضافة الخدمة.' });
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
        console.error('Update Service Error:', e);
        res.status(500).json({ success: false, message: 'حدث خطأ أثناء تحديث الخدمة.' });
    }
});

app.post('/api/admin/delete-service', async (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, message: 'معرف الخدمة مفقود.' });
    try {
        await db.collection('services').doc(id).delete();
        res.json({ success: true, message: 'تم حذف الخدمة بنجاح.' });
    } catch (e) {
        console.error('Delete Service Error:', e);
        res.status(500).json({ success: false, message: 'حدث خطأ أثناء حذف الخدمة.' });
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

// ==========================================================
// المسارات الأساسية الأخرى للموقع
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
