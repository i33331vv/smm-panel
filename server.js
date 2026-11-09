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

// إعدادات سعر الصرف (عدّل هذا الرقم حسب تسعيرتك: مثلاً كل 1 دولار = 1500 دينار رصيد آسيا)
const IQD_PER_USD_RATE = 1500; 

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
// ⚡ نظام الدفع المباشر عبر آسياسيل (نسخة التشخيص الدقيق لنظام كيدي)
// ==========================================================

const activeOtpSessions = {};

async function callAsiacellAPI(endpoint, method = 'POST', bodyData = null, accessToken = null, deviceId = null) {
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
        // إرسال IP عراقي افتراضي لتجاوز الحجب المبدئي لبعض البوابات
        'X-Forwarded-For': '37.236.100.15',
        'Client-IP': '37.236.100.15'
    };

    if (accessToken) {
        headers['Authorization'] = `Bearer ${accessToken}`;
    }

    const response = await fetch(`https://odpapp.asiacell.com/api/v1/${endpoint}`, {
        method: method,
        headers: headers,
        body: bodyData ? JSON.stringify(bodyData) : undefined
    });

    const text = await response.text();
    console.log(`[Asiacell Raw Response - ${endpoint}] Status: ${response.status} | Body: ${text}`);

    let json = {};
    try {
        json = JSON.parse(text);
    } catch (err) {
        throw new Error(`حظر من جدار حماية آسياسيل (Cloudflare) - الكود: ${response.status}`);
    }

    return { status: response.status, ok: response.ok, data: json, deviceId: currentDeviceId };
}

// 1. الزبون يكتب رقمه ويطلب رمز التحقق
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

        // استخراج معرف عملية التحقق PID الذي يثبت أن آسياسيل أرسلت الرسالة فعلياً
        const pid = result.data?.PID || result.data?.data?.PID || result.data?.pid;
        const nextStep = result.data?.nextStep || result.data?.data?.nextStep;

        if (pid || nextStep === 'OTP' || nextStep === 'SMS_VALIDATION') {
            activeOtpSessions[cleanPhone] = {
                pid: pid || '',
                deviceId: result.deviceId,
                timestamp: Date.now()
            };

            return res.json({
                success: true,
                message: `✅ تم إرسال رمز التحقق فعلياً إلى الرقم ${cleanPhone} (معرف الجلسة: ${pid ? 'نشط' : 'مباشر'})`
            });
        } else {
            // إظهار السبب الحقيقي الذي أرجعته شركة آسياسيل بدلاً من رسالة نجاح وهمية
            const serverMsg = result.data?.message || result.data?.error_description || JSON.stringify(result.data);
            return res.status(400).json({
                success: false,
                message: `⚠️ رد سيرفر آسياسيل: ${serverMsg}`
            });
        }
    } catch (error) {
        console.error('[Asiacell Send OTP Error]:', error.message);
        return res.status(500).json({
            success: false,
            message: `❌ خطأ اتصال: ${error.message}`
        });
    }
});

// 2. الزبون يدخل الرمز المستلم -> التحقق وتحويل الرصيد
app.post('/api/asiacell/confirm-transfer', async (req, res) => {
    const { email, phone, otp, amount } = req.body;
    if (!email || !phone || !otp || !amount) {
        return res.status(400).json({ success: false, message: 'يرجى إكمال جميع الحقول المطلوبة.' });
    }

    const cleanPhone = phone.trim();
    const cleanOtp = otp.trim();
    const session = activeOtpSessions[cleanPhone];

    if (!session || (Date.now() - session.timestamp > 5 * 60 * 1000)) {
        return res.status(400).json({ success: false, message: 'انتهت صلاحية الجلسة، يرجى طلب رمز تحقق جديد.' });
    }

    try {
        const verifyPayload = {
            username: cleanPhone,
            passcode: cleanOtp
        };
        if (session.pid) verifyPayload.PID = session.pid;

        const verifyResult = await callAsiacellAPI('smsvalidation?lang=ar', 'POST', verifyPayload, null, session.deviceId);
        const accessToken = verifyResult.data?.access_token || verifyResult.data?.data?.access_token || verifyResult.data?.token;

        if (!verifyResult.ok || !accessToken) {
            return res.status(400).json({
                success: false,
                message: verifyResult.data?.message || '❌ رمز التحقق (OTP) غير صحيح أو منتهي الصلاحية.'
            });
        }

        const rawAmount = parseFloat(amount);
        const transferAmountIQD = rawAmount < 250 ? Math.round(rawAmount * IQD_PER_USD_RATE) : Math.round(rawAmount);
        const creditAmountUSD = rawAmount < 250 ? rawAmount : parseFloat((rawAmount / IQD_PER_USD_RATE).toFixed(2));

        const transferResult = await callAsiacellAPI('credit-transfer/transfer?lang=ar', 'POST', {
            receiverMsisdn: TARGET_ASIACELL_NUMBER,
            amount: transferAmountIQD
        }, accessToken, session.deviceId);

        if (!transferResult.ok && transferResult.data?.success !== true) {
            return res.status(400).json({
                success: false,
                message: transferResult.data?.message || 'فشل استقطاع الرصيد: تأكد من وجود رصيد كافٍ في شريحة آسياسيل الخاصة بك.'
            });
        }

        delete activeOtpSessions[cleanPhone];

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
            gateway: 'Asiacell Auto (Kidi Style)',
            sender_phone: cleanPhone,
            amount: creditAmountUSD,
            amount_iqd: transferAmountIQD,
            recipient: TARGET_ASIACELL_NUMBER,
            status: 'مقبول تلقائياً',
            created_at: dateTime
        });

        const telegramMsg = `⚡ <b>شحن آسياسيل تلقائي ناجح (نظام كيدي)</b>\n\n👤 <b>المستخدم:</b> ${userDoc.data().username}\n📱 <b>رقم الزبون:</b> ${cleanPhone}\n📲 <b>تم التحويل لرقمك:</b> ${TARGET_ASIACELL_NUMBER}\n💴 <b>المبلغ المستقطع:</b> ${transferAmountIQD} د.ع\n💵 <b>الرصيد المضاف للموقع:</b> $${creditAmountUSD}\n🕒 <b>الوقت:</b> ${dateTime}`;
        sendTelegramTextMessage(DEPOSIT_BOT_TOKEN, ADMIN_CHAT_ID, telegramMsg);

        return res.json({
            success: true,
            message: `تم التحقق واستقطاع الرصيد بنجاح! تمت إضافة $${creditAmountUSD} إلى حسابك فوراً.`,
            newBalance
        });

    } catch (error) {
        console.error('[Asiacell Confirm Transfer Error]:', error.message);
        return res.status(500).json({
            success: false,
            message: 'حدث خطأ أثناء معالجة التحويل مع سيرفر آسياسيل.'
        });
    }
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

app.get('/api/admin/data', async (req, res) => {
    try {
        const usersSnap = await db.collection('users').get();
        let totalSales = 0;
        const ordersSnap = await db.collection('orders').get();
        ordersSnap.forEach(doc => { totalSales += parseFloat(doc.data().charge || 0); });
        res.json({ success: true, usersCount: usersSnap.size, totalSales });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
