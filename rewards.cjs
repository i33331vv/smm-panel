'use strict';
const crypto = require('crypto');
const RATE = 1000;
const toIQD = n => Math.round(Number(n || 0) * RATE * 10) / 10;
const rewardFor = n => Math.floor(toIQD(n) / 10000) * 500;
const amountIQD = value => {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n <= 0 || n > 100000000) throw Object.assign(new Error('أدخل مبلغاً صحيحاً بالدينار.'), { status: 400 });
    return n;
};
module.exports = { RATE, toIQD, rewardFor, amountIQD, install };

function install({ app, db, requireAuth, upload, sharp, fail, money, htmlEscape, telegram, DEPOSIT_BOT_TOKEN, ADMIN_CHAT_ID, ADMIN_TELEGRAM_USER_ID, APP_ORIGIN, hash, sensitiveLimit, findUserByUsername }) {
    const users = db.collection('users');
    const withdrawals = db.collection('profit_withdrawals');
    const ops = db.collection('profit_operations');
    const codeRef = code => db.collection('referral_codes').doc(code);
    const tokenFor = (req) => {
        const key = String(req.body.requestId || '');
        if (!/^[a-f0-9-]{36}$/.test(key)) throw fail('معرف العملية غير صالح. حدّث الصفحة.');
        return ops.doc(hash(req.user.id + ':' + key).slice(0,40));
    };
    async function initialiseSpent(ref) {
        return db.runTransaction(async tx => {
            const user = await tx.get(ref);
            if (!user.exists) throw fail('المستخدم غير موجود.', 404);
            if (Number.isFinite(user.data().spent)) return user.data();
            const orders = await tx.get(db.collection('orders').where('user_id', '==', ref.id));
            const owned = new Map(orders.docs.map(d => [d.id, d]));
            // Older records had only username. Include them only when ownership is unambiguous.
            if (typeof user.data().username === 'string') {
                const names = await tx.get(users.where('username','==',user.data().username).limit(2));
                if (names.size === 1 && names.docs[0].id === user.id) {
                    const legacy = await tx.get(db.collection('orders').where('username','==',user.data().username));
                    for (const d of legacy.docs) if (!d.data().user_id) owned.set(d.id,d);
                }
            }
            const spent = money([...owned.values()].reduce((sum, d) => sum + (d.data().status === 'ملغي' ? 0 : Number(d.data().charge || 0)), 0));
            if (!Number.isFinite(spent) || spent < 0) throw fail('سجل المصروف يحتاج مراجعة.');
            tx.update(ref, { spent });
            return { ...user.data(), spent };
        });
    }
    // Call BEFORE any transaction writes. The returned closure only writes.
    async function prepareReward(tx, payer, amount, depositId) {
        const bonus = rewardFor(amount);
        if (!bonus || !payer.supporterId) return () => {};
        const ledger = db.collection('referral_rewards').doc(depositId);
        const existing = await tx.get(ledger);
        const recipient = await tx.get(users.doc(payer.supporterId));
        if (existing.exists || !recipient.exists) return () => {};
        const old = Number(recipient.data().profitIQD || 0);
        if (!Number.isSafeInteger(old) || old < 0) throw fail('رصيد الأرباح يحتاج مراجعة.');
        return () => {
            tx.update(recipient.ref, { profitIQD: old + bonus });
            tx.create(ledger, { user_id: recipient.id, deposit_id: depositId, amountIQD: bonus, created_ms: Date.now() });
        };
    }

    app.use('/api/profits', requireAuth, sensitiveLimit('profits', 40, 60000, r => r.user.id));
    app.get('/api/profits', async (req, res) => {
        const u = (await req.user.ref.get()).data();
        const history = await withdrawals.where('user_id', '==', req.user.id).get();
        res.json({ success: true, code: u.referralCode || '', supporterCode: u.supporterCode || '', profitIQD: u.profitIQD || 0,
            withdrawals: history.docs.map(d => ({ id: d.id, amountIQD: d.data().amountIQD, status: d.data().status, created_ms: d.data().created_ms })).sort((a,b) => b.created_ms-a.created_ms).slice(0,50) });
    });
    app.post('/api/profits/activate', async (req, res) => {
        const code = crypto.randomBytes(6).toString('hex').toUpperCase();
        const result = await db.runTransaction(async tx => {
            const u = await tx.get(req.user.ref);
            if (u.data().disabled) throw fail('الحساب محظور.', 403);
            if (u.data().referralCode) return u.data().referralCode;
            const c = await tx.get(codeRef(code));
            if (c.exists) throw fail('حاول مرة أخرى.');
            tx.create(codeRef(code), { user_id: u.id });
            tx.update(u.ref, { referralCode: code });
            return code;
        });
        res.json({ success: true, code: result });
    });
    app.post('/api/profits/support', async (req, res) => {
        const code = String(req.body.code || '').trim().toUpperCase();
        if (!/^[A-F0-9]{12}$/.test(code)) throw fail('كود الدعم غير صحيح.');
        await db.runTransaction(async tx => {
            const u = await tx.get(req.user.ref);
            const targetCode = await tx.get(codeRef(code));
            if (!targetCode.exists) throw fail('الكود غير موجود.');
            const target = await tx.get(users.doc(targetCode.data().user_id));
            if (!u.data().referralCode) throw fail('فعّل كود الأرباح أولاً.');
            if (u.data().disabled) throw fail('الحساب محظور.', 403);
            if (u.data().supporterId) throw fail('سبق اختيار مستخدم لدعمه ولا يمكن تغييره.');
            if (!target.exists || target.data().disabled) throw fail('هذا الكود غير متاح.');
            if (target.id === u.id) throw fail('لا يمكنك دعم نفسك.');
            tx.update(u.ref, { supporterId: target.id, supporterCode: code, supported_ms: Date.now() });
        });
        res.json({ success: true, message: 'تم تثبيت المستخدم الذي تدعمه نهائياً.' });
    });
    app.post('/api/profits/convert', async (req, res) => {
        const amount = amountIQD(req.body.amountIQD);
        const op = tokenFor(req);
        await db.runTransaction(async tx => {
            const prior = await tx.get(op);
            const u = await tx.get(req.user.ref);
            if (prior.exists) return;
            if (u.data().disabled) throw fail('الحساب محظور.', 403);
            if (!Number.isFinite(Number(u.data().balance || 0))) throw fail('رصيد الخدمات يحتاج مراجعة.');
            if ((u.data().profitIQD || 0) < amount) throw fail('رصيد الأرباح غير كافٍ.');
            tx.update(u.ref, { profitIQD: u.data().profitIQD - amount, balance: money(Number(u.data().balance || 0) + amount / RATE) });
            tx.create(op, { user_id: u.id, type: 'conversion', amountIQD: amount, created_ms: Date.now() });
        });
        res.json({ success: true, message: 'تم تحويل الأرباح إلى رصيد الخدمات.' });
    });
    app.post('/api/profits/withdraw', upload.single('barcode'), async (req, res) => {
        if (!DEPOSIT_BOT_TOKEN || !ADMIN_CHAT_ID || !ADMIN_TELEGRAM_USER_ID) throw fail('سحب الأرباح غير متاح حالياً؛ تواصل مع الدعم.', 503);
        const amount = amountIQD(req.body.amountIQD);
        if (amount < 10000) throw fail('الحد الأدنى للسحب 10,000 دينار.');
        const card = String(req.body.card || '').replace(/[ -]/g, '');
        if (!/^\d{8,19}$/.test(card)) throw fail('أدخل رقم الماستر كارد/رقم الاستلام الصحيح.');
        if (!req.file) throw fail('أرفق صورة الباركود.');
        let bytes;
        try {
            bytes = await sharp(req.file.buffer, { limitInputPixels: 20000000 }).rotate().resize({ width:1600, height:1600, fit:'inside', withoutEnlargement:true }).jpeg({ quality:85 }).toBuffer();
        } catch { throw fail('صورة الباركود غير صالحة.'); }
        if (bytes.length > 700000) throw fail('اختر صورة أصغر.');
        const op = tokenFor(req);
        const ref = withdrawals.doc(op.id);
        const lock = db.collection('withdrawal_locks').doc(req.user.id);
        const imageRef = db.collection('private_receipts').doc('withdraw_' + ref.id);
        const secret = crypto.randomBytes(32).toString('hex');
        await db.runTransaction(async tx => {
            const existing = await tx.get(op);
            const u = await tx.get(req.user.ref);
            const l = await tx.get(lock);
            const pending = l.exists ? await tx.get(withdrawals.doc(l.data().id)) : null;
            if (existing.exists) return;
            if (u.data().disabled) throw fail('الحساب محظور.', 403);
            if (pending?.data()?.status === 'معلق') throw fail('لديك طلب سحب قيد المراجعة.');
            if (Number(u.data().profitIQD || 0) < amount) throw fail('رصيد الأرباح غير كافٍ.');
            tx.update(u.ref, { profitIQD: u.data().profitIQD - amount });
            tx.create(op, { user_id:u.id, type:'withdrawal', amountIQD:amount, created_ms:Date.now() });
            tx.create(ref, { user_id:u.id, username:u.data().username, amountIQD:amount, card, status:'معلق', created_ms:Date.now(), notification:'pending', receiptToken:secret, imageId:imageRef.id });
            tx.create(imageRef, { owner:u.id, bytes, tokenHash:hash(secret), tokenExpires:Date.now()+7*86400000 });
            tx.set(lock, { id:ref.id });
        });
        // Durable queue: a Telegram outage never loses the debit or the request.
        notifyPending().catch(() => {});
        res.json({ success:true, message:'تم خصم مبلغ السحب وإرسال الطلب للمراجعة. تابع حالته هنا.', id:ref.id });
    });
    async function handleWithdrawal(token, cb) {
        // Callback payload stays within Telegram's 64-byte limit.
        const short = /^(wp|wc)_([a-f0-9]{40})$/.exec(String(cb.data || ''));
        if (!short) return false;
        if (token !== DEPOSIT_BOT_TOKEN || String(cb.from?.id)!==ADMIN_TELEGRAM_USER_ID || String(cb.message?.chat?.id)!==ADMIN_CHAT_ID) return true;
        const action = short[1];
        const id = short[2];
        const ref = withdrawals.doc(id);
        const result = await db.runTransaction(async tx => {
            const w = await tx.get(ref);
            if (!w.exists) throw fail('الطلب غير موجود.');
            if (w.data().status !== 'معلق') return w.data();
            const u = await tx.get(users.doc(w.data().user_id));
            const cancelled = action==='wc';
            if (cancelled && !u.exists) throw fail('المستخدم غير موجود؛ راجع الطلب.');
            if (cancelled) tx.update(u.ref, { profitIQD:Number(u.data().profitIQD || 0)+w.data().amountIQD });
            const status = cancelled ? 'ملغي — تم استرجاع الأرباح' : 'تم سحب الأرباح';
            tx.update(ref, { status, completed_ms:Date.now() });
            return { ...w.data(), status };
        });
        await telegram(token, 'answerCallbackQuery', { callback_query_id:cb.id, text:result.status });
        await telegram(token, 'editMessageCaption', { chat_id:ADMIN_CHAT_ID, message_id:cb.message.message_id,
            caption:withdrawCaption(id,result), reply_markup:{ inline_keyboard:[] } });
        return true;
    }
    function withdrawCaption(id,w) {
        return `طلب سحب أرباح #${id}\nالمستخدم: ${w.username}\nالمبلغ: ${w.amountIQD.toLocaleString('en-US')} دينار\nرقم الاستلام: ${w.card}\nالحالة: ${w.status}`;
    }
    let notifying = false;
    async function notifyPending() {
        if (notifying || !DEPOSIT_BOT_TOKEN || !ADMIN_CHAT_ID) return;
        notifying = true;
        try {
            const list = await withdrawals.where('notification','==','pending').limit(20).get();
            for (const d of list.docs) {
                const lease = crypto.randomUUID();
                const w = await db.runTransaction(async tx => {
                    const fresh = await tx.get(d.ref);
                    const data = fresh.data();
                    if (data.notification!=='pending' || data.leaseUntil>Date.now()) return null;
                    tx.update(d.ref,{lease,leaseUntil:Date.now()+60000});
                    return data;
                });
                if (!w) continue;
                await db.collection('private_receipts').doc(w.imageId).update({ tokenExpires: Date.now()+7*86400000 });
                const result = await telegram(DEPOSIT_BOT_TOKEN,'sendPhoto',{
                    chat_id:ADMIN_CHAT_ID,
                    photo:`${APP_ORIGIN}/api/receipts/${w.imageId}?token=${w.receiptToken}`,
                    caption:withdrawCaption(d.id,w),
                    reply_markup:{inline_keyboard:w.status==='معلق' ? [[{text:'تم الشحن',callback_data:'wp_'+d.id},{text:'إلغاء',callback_data:'wc_'+d.id}]] : []}
                });
                if (result) await d.ref.update({notification:'sent',tg_message_id:result.message_id,leaseUntil:0});
            }
        } finally { notifying=false; }
    }
    if (require.main?.filename.endsWith('server.js') && process.env.ENABLE_BACKGROUND_JOBS !== 'false') {
        setInterval(() => notifyPending().catch(() => console.error('Withdrawal notification pending')),30000).unref();
    }

    app.get('/api/admin/users', async (req,res) => {
        const q = String(req.query.q || '').trim().toLowerCase();
        const page = Math.max(0, Math.min(100000, Number(req.query.page)||0));
        // Exact lookup avoids downloading all accounts to the browser.
        let docs;
        if (q) {
            const match = await findUserByUsername(String(req.query.q).trim());
            docs = match ? [match] : [];
        } else {
            docs = (await users.orderBy('__name__').offset(page*25).limit(26).get()).docs;
        }
        const more = !q && docs.length>25;
        const result=[];
        for (const d of docs.slice(0, q?50:25)) {
            const u=await initialiseSpent(d.ref);
            result.push({id:d.id,username:u.username,balanceIQD:toIQD(u.balance),spentIQD:toIQD(u.spent),profitIQD:u.profitIQD||0,disabled:!!u.disabled,role:u.role||'user'});
        }
        res.json({success:true,users:result,more});
    });
    app.post('/api/admin/users/:id/action', async (req,res) => {
        const id=String(req.params.id);
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw fail('معرف غير صالح.');
        const action=String(req.body.action);
        if (!['add','subtract','ban','unban'].includes(action)) throw fail('إجراء غير صالح.');
        const amount=['add','subtract'].includes(action)?amountIQD(req.body.amountIQD):0;
        const op=tokenFor(req);
        await db.runTransaction(async tx=>{
            const prior=await tx.get(op);
            const admin=await tx.get(req.user.ref);
            const u=await tx.get(users.doc(id));
            if(prior.exists)return;
            if(!admin.exists || admin.data().disabled || admin.data().role!=='admin')throw fail('غير مسموح.',403);
            if(!u.exists)throw fail('المستخدم غير موجود.',404);
            if(u.data().role==='admin' && ['ban','unban'].includes(action))throw fail('لا يمكن حظر حساب مدير من هذه الواجهة.');
            const balance=Number(u.data().balance||0);
            if(!Number.isFinite(balance) || balance < 0) throw fail('رصيد المستخدم يحتاج مراجعة.');
            if(action==='subtract' && toIQD(balance)<amount)throw fail('المبلغ أكبر من رصيد المستخدم.');
            const patch=action==='add'?{balance:money(balance+amount/RATE)}:action==='subtract'?{balance:money(balance-amount/RATE)}:{disabled:action==='ban'};
            tx.update(u.ref,patch);
            tx.create(op,{type:'admin',admin_id:admin.id,user_id:id,action,amountIQD:amount,created_ms:Date.now()});
        });
        res.json({success:true});
    });
    return { prepareReward, initialiseSpent, handleWithdrawal, notifyPending };
}
