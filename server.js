const express = require('express');
const path = require('path');
const app = express();
const bcrypt = require('bcryptjs');
const multer = require('multer');
const fs = require('fs');
const https = require('https');

// إعدادات بوتات التليجرام والمعرفات الخاصة بك
const DEPOSIT_BOT_TOKEN = '9075969471:AAH_G_KMD7S8rbMibf663_PavR41zb1dEhM';
const ORDERS_BOT_TOKEN = '9023175997:AAGuvzz3eLywKIBkTjs3w9NCVnmutRblCEc';
const ADMIN_CHAT_ID = '8671448765';

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
const port = 3000;

// إعداد التخزين للإيصالات
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, __dirname);
    },
    filename: (req, file, cb) => {
        cb(null, 'receipt_' + Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// دالة لتوليد التاريخ والوقت بدقة تامة
function getFormattedDateTime() {
    const now = new Date();
    return now.toLocaleString('ar-IQ', {
        timeZone: 'Asia/Baghdad',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: true
    });
}

// إرسال رسالة نصية لتليجرام
function sendTelegramTextMessage(token, chatId, text, replyMarkup = null) {
    const data = JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: replyMarkup
    });

    const options = {
        hostname: 'api.telegram.org', path: `/bot${token}/sendMessage`,
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    };

    const req = https.request(options);
    req.on('error', (e) => console.error(e));
    req.write(data); req.end();
}

// دالة لإيقاف دوران الزر في تليجرام فوراً (إجابة تليجرام)
function answerCallbackQuery(token, callbackQueryId, text) {
    const data = JSON.stringify({
        callback_query_id: callbackQueryId,
        text: text,
        show_alert: false
    });

    const options = {
        hostname: 'api.telegram.org', path: `/bot${token}/answerCallbackQuery`,
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    };

    const req = https.request(options);
    req.on('error', () => {});
    req.write(data); req.end();
}

// دالة لتعديل الرسالة النصية وإزالة الأزرار
function editTelegramTextMessage(token, chatId, messageId, newText, replyMarkup = { inline_keyboard: [] }) {
    const data = JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text: newText,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: replyMarkup
    });

    const options = {
        hostname: 'api.telegram.org', path: `/bot${token}/editMessageText`,
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    };

    const req = https.request(options);
    req.on('error', () => {});
    req.write(data); req.end();
}

// نظام الاستعلام المستمر (Polling) - يحل مشكلة الـ Webhook الجدار الناري 100%
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

                                // 🚨 إيقاف دوران الزر فوراً عند الضغط
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
                                        const updatedText = originalText.replace('🔄 الحالة: قيد التنفيذ حالياً', '✅ <b>الحالة: تم إكمال الطلب بنجاح</b>');
                                        editTelegramTextMessage(token, chatId, messageId, updatedText);
                                    }
                                } catch (err) { console.error('خطأ قاعدة البيانات:', err); }
                            }
                        }
                    }
                } catch (e) {}
            });
        }).on('error', () => {});
    }, 2500); // تحديث كل ثانيتين ونصف
}

// تفعيل نظام الاستعلام المباشر للبوتين
startTelegramPolling(DEPOSIT_BOT_TOKEN);
startTelegramPolling(ORDERS_BOT_TOKEN);

// مسارات الموقع
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

// طلب شحن
app.post('/api/deposit/submit', upload.single('receiptImage'), async (req, res) => {
    const { email, gateway, amount } = req.body;
    const uploadedFile = req.file;
    if (!email || !gateway || !amount || !uploadedFile) return res.status(400).json({ success: false, message: 'الرجاء إكمال البيانات.' });

    try {
        const userSnap = await db.collection('users').where('email', '==', email).get();
        if (userSnap.empty) { fs.unlinkSync(uploadedFile.path); return res.status(400).json({ success: false, message: 'المستخدم غير موجود.' }); }
        
        const username = userSnap.docs[0].data().username;
        const dateTime = getFormattedDateTime();
        const depRef = await db.collection('deposit_requests').add({ username, email, gateway, amount: parseFloat(amount), receipt_image: uploadedFile.filename, status: 'معلق', created_at: dateTime });
        
        const receiptUrl = `https://mtnajm.com/${uploadedFile.filename}`;
        const text = `📥 <b>طلب شحن رصيد جديد</b>\n\n👤 <b>المستخدم:</b> ${username}\n📧 <b>البريد:</b> ${email}\n💰 <b>المبلغ:</b> $${amount}\n💳 <b>البوابة:</b> ${gateway}\n🕒 <b>التاريخ والوقت:</b> ${dateTime}\n\n🔗 <a href="${receiptUrl}"><b>[ اضغط هنا لعرض صورة إيصال الدفع ]</b></a>`;
        
        const replyMarkup = { inline_keyboard: [[ { text: '✅ شحن الرصيد', callback_data: `dep_accept_${depRef.id}_${email}_${amount}` }, { text: '❌ رفض', callback_data: `dep_reject_${depRef.id}` } ]] };
        sendTelegramTextMessage(DEPOSIT_BOT_TOKEN, ADMIN_CHAT_ID, text, replyMarkup);
        res.json({ success: true, message: 'تم إرسال طلب الشحن بنجاح.' });
    } catch (e) {
        if (uploadedFile && fs.existsSync(uploadedFile.path)) fs.unlinkSync(uploadedFile.path);
        res.status(500).json({ success: false });
    }
});

// طلب خدمة
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
    console.log(`الخادم السحابي يعمل بنجاح على الرابط: http://localhost:${port}`);
});
