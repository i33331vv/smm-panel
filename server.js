const express = require('express');
const path = require('path');
const app = express();
const bcrypt = require('bcryptjs');
const multer = require('multer');
const sharp = require('sharp');
const fs = require('fs');

// استيراد الوحدات بالطريقة الحديثة المتوافقة 100%
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

// إعداد التخزين المؤقت للإيصالات
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

// دالة توليد بصمة الصورة الذكية
async function generateImageHash(filePath) {
    try {
        const buffer = await sharp(filePath)
            .resize(8, 8, { fit: 'fill' })
            .grayscale()
            .raw()
            .toBuffer();
        
        let sum = 0;
        for (let i = 0; i < buffer.length; i++) {
            sum += buffer[i];
        }
        const avg = sum / buffer.length;
        
        let hash = '';
        for (let i = 0; i < buffer.length; i++) {
            hash += buffer[i] > avg ? '1' : '0';
        }
        return hash;
    } catch (e) {
        return null;
    }
}

// مسار إنشاء حساب جديد
app.post('/api/register', async (req, res) => {
    const { username, email, password } = req.body;
    try {
        const usersRef = db.collection('users');
        const snapshot = await usersRef.where('email', '==', email).get();
        if (!snapshot.empty) {
            return res.status(400).json({ success: false, message: 'البريد الإلكتروني مسجل مسبقاً.' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        await usersRef.add({
            username,
            email,
            password: hashedPassword,
            balance: 0.00,
            role: 'user',
            created_at: FieldValue.serverTimestamp()
        });

        res.json({ success: true, message: 'تم إنشاء الحساب بنجاح!', username, email, balance: 0.00 });
    } catch (error) {
        res.status(500).json({ success: false, message: 'حدث خطأ في الخادم.' });
    }
});

// مسار تسجيل الدخول
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const usersRef = db.collection('users');
        const snapshot = await usersRef.where('email', '==', email).get();
        if (snapshot.empty) {
            return res.status(400).json({ success: false, message: 'البريد الإلكتروني غير صحيح.' });
        }

        const userDoc = snapshot.docs[0];
        const user = userDoc.data();

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ success: false, message: 'كلمة المرور خاطئة.' });
        }

        res.json({ success: true, message: 'تم تسجيل الدخول بنجاح!', username: user.username, email: user.email, balance: user.balance });
    } catch (error) {
        res.status(500).json({ success: false, message: 'خطأ في الخادم.' });
    }
});

// جلب معلومات المستخدم
app.get('/api/user/:email', async (req, res) => {
    const email = req.params.email;
    try {
        const snapshot = await db.collection('users').where('email', '==', email).get();
        if (snapshot.empty) {
            return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
        }
        const user = snapshot.docs[0].data();
        res.json({ success: true, user: { username: user.username, email: user.email, balance: user.balance } });
    } catch (error) {
        res.status(500).json({ success: false, message: 'خطأ في الخادم' });
    }
});

// مسار استقبال طلب الشحن مع الفحص الذكي للإيصالات
app.post('/api/deposit/submit', upload.single('receiptImage'), async (req, res) => {
    const { email, gateway, amount, reference_id } = req.body;
    const uploadedFile = req.file;

    if (!email || !gateway || !amount || amount <= 0 || !reference_id || !uploadedFile) {
        return res.status(400).json({ success: false, message: 'الرجاء إدخال جميع بيانات الشحن ورفع صورة الإيصال.' });
    }

    const receiptImage = uploadedFile.filename;
    const imagePath = uploadedFile.path;

    try {
        const userSnap = await db.collection('users').where('email', '==', email).get();
        if (userSnap.empty) {
            fs.unlinkSync(imagePath);
            return res.status(400).json({ success: false, message: 'البريد الإلكتروني المدخل غير مسجل في النظام.' });
        }
        const username = userSnap.docs[0].data().username;

        const pendingSnap = await db.collection('deposit_requests').where('email', '==', email).where('status', '==', 'معلق').get();
        if (!pendingSnap.empty) {
            fs.unlinkSync(imagePath);
            return res.status(400).json({ success: false, message: 'لديك طلب شحن قيد المراجعة بالفعل! يرجى الانتظار لحين اكتماله.' });
        }

        const newImageHash = await generateImageHash(imagePath);
        const allDepsSnap = await db.collection('deposit_requests').get();
        
        for (const doc of allDepsSnap.docs) {
            const depData = doc.data();
            if (depData.receipt_image) {
                const oldImagePath = path.join(__dirname, depData.receipt_image);
                if (fs.existsSync(oldImagePath)) {
                    const oldImageHash = await generateImageHash(oldImagePath);
                    if (newImageHash && oldImageHash && newImageHash === oldImageHash) {
                        fs.unlinkSync(imagePath);
                        return res.status(400).json({ 
                            success: false, 
                            message: 'عذراً! لقطة الشاشة هذه تم استخدامها في طلب سابق ولا يمكن إعادة استخدامها.' 
                        });
                    }
                }
            }
        }

        await db.collection('deposit_requests').add({
            username,
            email,
            gateway,
            amount: parseFloat(amount),
            reference_id,
            receipt_image: receiptImage,
            status: 'معلق',
            created_at: FieldValue.serverTimestamp()
        });

        res.json({ success: true, message: 'تم إرسال طلب الشحن بنجاح، بانتظار مراجعة الإدارة.' });
    } catch (error) {
        if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
        res.status(500).json({ success: false, message: 'خطأ في الخادم أثناء معالجة الطلب.' });
    }
});

// جلب طلبات الشحن للمدير
app.get('/api/admin/deposits', async (req, res) => {
    try {
        const snapshot = await db.collection('deposit_requests').orderBy('created_at', 'desc').get();
        const deposits = [];
        snapshot.forEach(doc => {
            deposits.push({ id: doc.id, ...doc.data() });
        });
        res.json({ success: true, deposits });
    } catch (error) {
        res.status(500).json({ success: false, message: 'خطأ في جلب البيانات' });
    }
});

// مسار قبول أو رفض طلب الشحن
app.post('/api/admin/deposit/action', async (req, res) => {
    const { depositId, action } = req.body;

    try {
        const depRef = db.collection('deposit_requests').doc(depositId);
        const depDoc = await depRef.get();

        if (!depDoc.exists) {
            return res.status(400).json({ success: false, message: 'الطلب غير موجود.' });
        }

        const dep = depDoc.data();
        if (dep.status !== 'معلق') {
            return res.status(400).json({ success: false, message: 'تمت معالجة هذا الطلب مسبقاً.' });
        }

        if (action === 'مقبول') {
            const usersRef = db.collection('users');
            const userSnap = await usersRef.where('email', '==', dep.email).get();

            if (userSnap.empty) {
                return res.status(400).json({ success: false, message: 'المستخدم غير موجود بالنظام.' });
            }

            const userDocRef = userSnap.docs[0].ref;
            const userData = userSnap.docs[0].data();
            const newBalance = (userData.balance || 0) + dep.amount;

            await db.runTransaction(async (transaction) => {
                transaction.update(depRef, { status: 'مقبول' });
                transaction.update(userDocRef, { balance: newBalance });
                transaction.set(db.collection('transactions').doc(), {
                    username: userData.username,
                    gateway: dep.gateway,
                    amount: dep.amount,
                    reference_id: dep.reference_id,
                    status: 'مكتمل',
                    created_at: FieldValue.serverTimestamp()
                });
            });

            res.json({ 
                success: true, 
                message: `تم قبول الطلب وشحن رصيد البريد (${dep.email}) بمبلغ $${dep.amount} بنجاح!`, 
                newBalance 
            });
        } else {
            await depRef.update({ status: 'مرفوض' });
            res.json({ success: true, message: 'تم رفض طلب الشحن.' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: 'خطأ أثناء المعالجة' });
    }
});

// مسار إنشاء الطلب وخصم الرصيد
app.post('/api/order', async (req, res) => {
    const { username, service, link, quantity, charge } = req.body;

    try {
        const usersRef = db.collection('users');
        const userSnap = await usersRef.where('username', '==', username).get();

        if (userSnap.empty) {
            return res.status(400).json({ success: false, message: 'المستخدم غير موجود.' });
        }

        const userDocRef = userSnap.docs[0].ref;
        const userData = userSnap.docs[0].data();

        if (userData.balance < charge) {
            return res.status(400).json({ success: false, message: 'رصيدك غير كافٍ لإتمام هذا الطلب.' });
        }

        const newBalance = userData.balance - charge;

        let orderId = '';
        await db.runTransaction(async (transaction) => {
            transaction.update(userDocRef, { balance: newBalance });
            const newOrderRef = db.collection('orders').doc();
            orderId = newOrderRef.id;
            transaction.set(newOrderRef, {
                username,
                service,
                link,
                quantity,
                charge,
                status: 'قيد المعالجة',
                created_at: FieldValue.serverTimestamp()
            });
        });

        res.json({ success: true, newBalance, orderId });
    } catch (error) {
        res.status(500).json({ success: false, message: 'خطأ في حفظ الطلب.' });
    }
});

app.get('/api/orders/:username', async (req, res) => {
    try {
        const snapshot = await db.collection('orders').where('username', '==', req.params.username).get();
        const orders = [];
        snapshot.forEach(doc => {
            orders.push({ id: doc.id, ...doc.data() });
        });
        res.json({ success: true, orders });
    } catch (error) {
        res.json({ success: true, orders: [] });
    }
});

app.get('/api/admin/data', async (req, res) => {
    try {
        const usersSnap = await db.collection('users').get();
        const ordersSnap = await db.collection('orders').orderBy('created_at', 'desc').get();
        
        let totalSales = 0;
        const orders = [];
        ordersSnap.forEach(doc => {
            const data = doc.data();
            totalSales += (data.charge || 0);
            orders.push({ id: doc.id, ...data });
        });

        res.json({
            success: true,
            usersCount: usersSnap.size,
            totalSales,
            orders
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'خطأ في جلب بيانات لوحة التحكم' });
    }
});

app.post('/api/admin/update-order-status', async (req, res) => {
    try {
        await db.collection('orders').doc(req.body.orderId).update({ status: req.body.status });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.get('/api/services', async (req, res) => {
    try {
        const snapshot = await db.collection('services').get();
        const services = [];
        snapshot.forEach(doc => {
            services.push({ id: doc.id, ...doc.data() });
        });
        res.json({ success: true, services });
    } catch (error) {
        res.json({ success: true, services: [] });
    }
});

// مسار إضافة خدمة جديدة
app.post('/api/admin/add-service', async (req, res) => {
    const { category, name, price, description } = req.body;
    try {
        await db.collection('services').add({
            category,
            name,
            price: parseFloat(price),
            description,
            created_at: FieldValue.serverTimestamp()
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// مسار تعديل خدمة موجودة (الجديد)
app.post('/api/admin/update-service', async (req, res) => {
    const { id, category, name, price, description } = req.body;
    try {
        await db.collection('services').doc(id).update({
            category,
            name,
            price: parseFloat(price),
            description
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// مسار حذف خدمة
app.post('/api/admin/delete-service', async (req, res) => {
    try {
        await db.collection('services').doc(req.body.id).delete();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.listen(port, () => {
    console.log(`الخادم السحابي يعمل بنجاح على الرابط: http://localhost:${port}`);
});
