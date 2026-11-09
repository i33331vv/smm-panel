const express = require('express');
const path = require('path');
const app = express();
const bcrypt = require('bcryptjs');
const multer = require('multer');
const sharp = require('sharp');
const fs = require('fs');
const https = require('https');

// إعدادات بوتات التليجرام ومعرف الشات الخاص بك
const DEPOSIT_BOT_TOKEN = '9075969471:AAH_G_KMD7S8rbMibf663_PavR41zb1dEhM';
const ORDERS_BOT_TOKEN = '9023175997:AAGuvzz3eLywKIBkTjs3w9NCVnmutRblCEc';
const ADMIN_CHAT_ID = '8671448765';

// استيراد Firebase
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
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

// دالة لتوليد التاريخ والوقت بدقة تامة (السنة، الشهر، اليوم، الساعة، الدقيقة، الثانية)
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

// دالة إرسال رسالة مع صورة أو نص إلى تليجرام مع الأزرار الشفافة
function sendTelegramMessage(token, chatId, text, replyMarkup = null, photoPath = null) {
    const boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW';
    let postData = '';

    if (photoPath && fs.existsSync(photoPath)) {
        const fileData = fs.readFileSync(photoPath);
        const fileName = path.basename(photoPath);
        
        postData += `--${boundary}\r\n`;
        postData += `Content-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`;
        postData += `--${boundary}\r\n`;
        postData += `Content-Disposition: form-data; name="caption"\r\n\r\n${text}\r\n`;
        postData += `--${boundary}\r\n`;
        postData += `Content-Disposition: form-data; name="parse_mode"\r\n\r\nHTML\r\n`;
        if (replyMarkup) {
            postData += `--${boundary}\r\n`;
            postData += `Content-Disposition: form-data; name="reply_markup"\r\n\r\n${JSON.stringify(replyMarkup)}\r\n`;
        }
        postData += `--${boundary}\r\n`;
        postData += `Content-Disposition: form-data; name="photo"; filename="${fileName}"\r\n`;
        postData += `Content-Type: image/jpeg\r\n\r\n`;

        const bufferData = Buffer.concat([
            Buffer.from(postData, 'utf-8'),
            fileData,
            Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8')
        ]);

        const options = {
            hostname: 'api.telegram.org',
            path: `/bot${token}/sendPhoto`,
            method: 'POST',
            headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': bufferData.length
            }
        };

        const req = https.request(options, (res) => {});
        req.on('error', (e) => console.error(e));
        req.write(bufferData);
        req.end();
    } else {
        const data = JSON.stringify({
            chat_id: chatId,
            text: text,
            parse_mode: 'HTML',
            reply_markup: replyMarkup
        });

        const options = {
            hostname: 'api.telegram.org',
            path: `/bot${token}/sendMessage`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data)
            }
        };

        const req = https.request(options, (res) => {});
        req.on('error', (e) => console.error(e));
        req.write(data);
        req.end();
    }
}

// دالة لتعديل وصف الصورة (Caption) وإزالة الأزرار نهائياً وتحديث النص
function editTelegramCaption(token, chatId, messageId, newCaption) {
    const data = JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        caption: newCaption,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [] } // إرسال مصفوفة فارغة لإزالة الأزرار فوراً
    });

    const options = {
        hostname: 'api.telegram.org',
        path: `/bot${token}/editMessageCaption`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data)
        }
    };

    const req = https.request(options, (res) => {});
    req.on('error', (e) => {});
    req.write(data);
    req.end();
}

// دالة لتعديل رسالة نصية بحتة (للخدمات) وإزالة الأزرار أو تحديثها
function editTelegramText(token, chatId, messageId, newText, replyMarkup = { inline_keyboard: [] }) {
    const data = JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text: newText,
        parse_mode: 'HTML',
        reply_markup: replyMarkup
    });

    const options = {
        hostname: 'api.telegram.org',
        path: `/bot${token}/editMessageText`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data)
        }
    };

    const req = https.request(options, (res) => {});
    req.on('error', (e) => {});
    req.write(data);
    req.end();
}

// مسار تسجيل الحساب
app.post('/api/register', async (req, res) => {
    const { username, email, password } = req.body;
    try {
        const usersRef = db.collection('users');
        const snapshot = await usersRef.where('email', '==', email).get();
        if (!snapshot.empty) return res.status(400).json({ success: false, message: 'البريد مسجل مسبقاً.' });

        const hashedPassword = await bcrypt.hash(password, 10);
        await usersRef.add({
            username, email, password: hashedPassword, balance: 0.00, role: 'user', created_at: getFormattedDateTime()
        });

        res.json({ success: true, message: 'تم إنشاء الحساب بنجاح!', username, email, balance: 0.00 });
    } catch (e) { res.status(500).json({ success: false, message: 'خطأ في الخادم.' }); }
});

// مسار تسجيل الدخول
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

// 1. استقبال طلب الشحن وإرساله لبوت التليجرام مع صورة الإيصال والأزرار (شحن / رفض)
app.post('/api/deposit/submit', upload.single('receiptImage'), async (req, res) => {
    const { email, gateway, amount } = req.body;
    const uploadedFile = req.file;

    if (!email || !gateway || !amount || !uploadedFile) {
        return res.status(400).json({ success: false, message: 'الرجاء إكمال البيانات.' });
    }

    try {
        const userSnap = await db.collection('users').where('email', '==', email).get();
        if (userSnap.empty) {
            fs.unlinkSync(uploadedFile.path);
            return res.status(400).json({ success: false, message: 'المستخدم غير موجود.' });
        }
        const username = userSnap.docs[0].data().username;
        const dateTime = getFormattedDateTime();

        const depRef = await db.collection('deposit_requests').add({
            username, email, gateway, amount: parseFloat(amount),
            receipt_image: uploadedFile.filename,
            status: 'معلق',
            created_at: dateTime
        });

        const text = `📥 <b>طلب شحن رصيد جديد</b>\n\n👤 <b>المستخدم:</b> ${username}\n📧 <b>البريد:</b> ${email}\n💰 <b>المبلغ:</b> $${amount}\n💳 <b>البوابة:</b> ${gateway}\n🕒 <b>التاريخ والوقت:</b> ${dateTime}`;
        const replyMarkup = {
            inline_keyboard: [
                [
                    { text: '✅ شحن الرصيد', callback_data: `dep_accept_${depRef.id}_${email}_${amount}` },
                    { text: '❌ رفض', callback_data: `dep_reject_${depRef.id}` }
                ]
            ]
        };

        sendTelegramMessage(DEPOSIT_BOT_TOKEN, ADMIN_CHAT_ID, text, replyMarkup, uploadedFile.path);

        res.json({ success: true, message: 'تم إرسال طلب الشحن بنجاح وبانتظار المراجعة.' });
    } catch (e) {
        if (uploadedFile && fs.existsSync(uploadedFile.path)) fs.unlinkSync(uploadedFile.path);
        res.status(500).json({ success: false, message: 'خطأ في الخادم.' });
    }
});

// 2. استقبال طلب الخدمة وإرساله لبوت الخدمات مع زر (قيد التنفيذ)
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
            transaction.set(newOrderRef, {
                username, service, link, quantity, charge,
                status: 'قيد المعالجة',
                created_at: dateTime
            });
        });

        const text = `🚀 <b>طلب خدمة جديد</b>\n\n🆔 <b>رقم الطلب:</b> #${orderId}\n👤 <b>المستخدم:</b> ${username}\n📌 <b>الخدمة:</b> ${service}\n🔗 <b>الرابط:</b> ${link}\n📦 <b>الكمية:</b> ${quantity}\n💵 <b>السعر:</b> $${charge}\n🕒 <b>التاريخ والوقت:</b> ${dateTime}\n\n🔄 <b>الحالة: قيد المعالجة</b>`;
        const replyMarkup = {
            inline_keyboard: [
                [{ text: '🔄 قيد التنفيذ', callback_data: `ord_progress_${orderId}` }]
            ]
        };

        sendTelegramMessage(ORDERS_BOT_TOKEN, ADMIN_CHAT_ID, text, replyMarkup);

        res.json({ success: true, newBalance, orderId });
    } catch (e) { res.status(500).json({ success: false, message: 'خطأ في الخادم.' }); }
});

// 3. مسار استقبال الأزرار الشفافة وتحديث النظام فوراً (Webhook)
app.post('/api/telegram-webhook/:type', async (req, res) => {
    const type = req.params.type; // 'deposit' أو 'order'
    const update = req.body;

    if (update.callback_query) {
        const callbackQuery = update.callback_query;
        const data = callbackQuery.data;
        const chatId = callbackQuery.message.chat.id;
        const messageId = callbackQuery.message.message_id;
        const token = type === 'deposit' ? DEPOSIT_BOT_TOKEN : ORDERS_BOT_TOKEN;

        try {
            if (data.startsWith('dep_accept_')) {
                const parts = data.split('_');
                const depId = parts[2];
                const email = parts[3];
                const amount = parseFloat(parts[4]);

                const userSnap = await db.collection('users').where('email', '==', email).get();
                if (!userSnap.empty) {
                    const userRef = userSnap.docs[0].ref;
                    const userData = userSnap.docs[0].data();
                    const newBalance = (userData.balance || 0) + amount;

                    await userRef.update({ balance: newBalance });
                    await db.collection('deposit_requests').doc(depId).update({ status: 'مقبول' });

                    // تعديل وصف الصورة، إضافة عبارة النجاح تحت التاريخ والوقت، وإزالة الأزرار تماماً
                    const originalText = callbackQuery.message.caption || '';
                    const updatedText = originalText + `\n\n✅ <b>تم شحن الرصيد بنجاح ($${amount}) للمستخدم!</b>`;
                    editTelegramCaption(token, chatId, messageId, updatedText);
                }
            } else if (data.startsWith('dep_reject_')) {
                const depId = data.split('_')[2];
                await db.collection('deposit_requests').doc(depId).update({ status: 'مرفوض' });

                const originalText = callbackQuery.message.caption || '';
                const updatedText = originalText + `\n\n❌ <b>تم رفض طلب شحن الرصيد.</b>`;
                editTelegramCaption(token, chatId, messageId, updatedText);
            } else if (data.startsWith('ord_progress_')) {
                const orderId = data.split('_')[2];
                await db.collection('orders').doc(orderId).update({ status: 'قيد التنفيذ' });

                const originalText = callbackQuery.message.text || '';
                const updatedText = originalText.replace('🔄 الحالة: قيد المعالجة', '🔄 الحالة: قيد التنفيذ حالياً');
                const newMarkup = {
                    inline_keyboard: [
                        [{ text: '✔️ تم الاكتمال', callback_data: `ord_complete_${orderId}` }]
                    ]
                };
                editTelegramText(token, chatId, messageId, updatedText, newMarkup);
            } else if (data.startsWith('ord_complete_')) {
                const orderId = data.split('_')[2];
                await db.collection('orders').doc(orderId).update({ status: 'مكتمل' });

                const originalText = callbackQuery.message.text || '';
                const updatedText = originalText.replace('🔄 الحالة: قيد التنفيذ حالياً', '✅ الحالة: تم إكمال الطلب بنجاح');
                editTelegramText(token, chatId, messageId, updatedText, { inline_keyboard: [] });
            }
        } catch (e) {
            console.error('خطأ في معالجة تفاعل التليجرام:', e);
        }
    }
    res.sendStatus(200);
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

app.post('/api/admin/add-service', async (req, res) => {
    const { category, name, price, description } = req.body;
    try {
        await db.collection('services').add({ category, name, price: parseFloat(price), description, created_at: getFormattedDateTime() });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/api/admin/update-service', async (req, res) => {
    const { id, category, name, price, description } = req.body;
    try {
        await db.collection('services').doc(id).update({ category, name, price: parseFloat(price), description });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/api/admin/delete-service', async (req, res) => {
    try {
        await db.collection('services').doc(req.body.id).delete();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.listen(port, () => {
    console.log(`الخادم السحابي يعمل بنجاح على الرابط: http://localhost:${port}`);
});
