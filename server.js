
const express = require('express');
const path = require('path');
const app = express();
const bcrypt = require('bcryptjs');
const multer = require('multer');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');

const DEPOSIT_BOT_TOKEN = process.env.DEPOSIT_BOT_TOKEN;
const ORDERS_BOT_TOKEN = process.env.ORDERS_BOT_TOKEN;
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
    destination: (req, file, cb) => {
        cb(null, __dirname);
    },
    filename: (req, file, cb) => {
        cb(
            null,
            'receipt_' + Date.now() +
            path.extname(file.originalname)
        );
    }
});

const upload = multer({ storage });

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

function getFormattedDateTime() {
    return new Date().toLocaleString('ar-IQ', {
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

function getFileHash(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);

        stream.on('data', data => hash.update(data));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

// Telegram

function sendTelegramTextMessage(
    token,
    chatId,
    text,
    replyMarkup = null
) {
    if (!token) {
        console.error('Telegram token is missing');
        return;
    }

    const data = JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
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

    const req = https.request(options);

    req.on('error', console.error);
    req.write(data);
    req.end();
}

function answerCallbackQuery(token, callbackQueryId, text) {
    const data = JSON.stringify({
        callback_query_id: callbackQueryId,
        text,
        show_alert: false
    });

    const options = {
        hostname: 'api.telegram.org',
        path: `/bot${token}/answerCallbackQuery`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data)
        }
    };

    const req = https.request(options);
    req.on('error', console.error);
    req.write(data);
    req.end();
}

function editTelegramTextMessage(
    token,
    chatId,
    messageId,
    newText,
    replyMarkup = { inline_keyboard: [] }
) {
    const data = JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text: newText,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
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

    const req = https.request(options);
    req.on('error', console.error);
    req.write(data);
    req.end();
}

function startTelegramPolling(token) {
    if (!token) return;

    let offset = 0;
    let polling = false;

    setInterval(async () => {
        if (polling) return;
        polling = true;

        try {
            const response = await fetch(
                `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=5`
            );

            const data = await response.json();

            if (!data.ok) return;

            for (const update of data.result || []) {
                offset = update.update_id + 1;

                if (!update.callback_query) continue;

                const callbackQuery = update.callback_query;
                const cbData = callbackQuery.data || '';
                const chatId = callbackQuery.message?.chat?.id;
                const messageId = callbackQuery.message?.message_id;

                if (!chatId || !messageId) continue;

                answerCallbackQuery(
                    token,
                    callbackQuery.id,
                    'جاري تنفيذ الطلب...'
                );

                try {
                    if (cbData.startsWith('dep_accept_')) {
                        const parts = cbData.split('_');
                        const depId = parts[2];
                        const email = parts[3];
                        const amount = parseFloat(parts[4]);

                        const userSnap = await db.collection('users')
                            .where('email', '==', email).get();

                        if (!userSnap.empty) {
                            const userDoc = userSnap.docs[0];

                            await db.runTransaction(async transaction => {
                                const depositRef = db.collection(
                                    'deposit_requests'
                                ).doc(depId);

                                const dep = await transaction.get(depositRef);
                                const user = await transaction.get(userDoc.ref);

                                if (!dep.exists || dep.data().status !== 'معلق') {
                                    throw new Error('تمت معالجة الطلب مسبقاً');
                                }

                                transaction.update(userDoc.ref, {
                                    balance:
                                        Number(user.data().balance || 0) +
                                        amount
                                });

                                transaction.update(depositRef, {
                                    status: 'مقبول'
                                });
                            });

                            editTelegramTextMessage(
                                token,
                                chatId,
                                messageId,
                                (callbackQuery.message.text || '') +
                                `\n\n✅ تم شحن الرصيد بنجاح ($${amount})`
                            );
                        }
                    } else if (cbData.startsWith('dep_reject_')) {
                        const depId = cbData.split('_')[2];

                        await db.collection('deposit_requests')
                            .doc(depId)
                            .update({ status: 'مرفوض' });

                        editTelegramTextMessage(
                            token,
                            chatId,
                            messageId,
                            (callbackQuery.message.text || '') +
                            '\n\n❌ تم رفض طلب شحن الرصيد.'
                        );
                    } else if (cbData.startsWith('ord_progress_')) {
                        const orderId = cbData.split('_')[2];

                        await db.collection('orders')
                            .doc(orderId)
                            .update({ status: 'قيد التنفيذ' });

                        const newMarkup = {
                            inline_keyboard: [[{
                                text: '✔️ تم الاكتمال',
                                callback_data: `ord_complete_${orderId}`
                            }]]
                        };

                        editTelegramTextMessage(
                            token,
                            chatId,
                            messageId,
                            (callbackQuery.message.text || '') +
                            '\n🔄 الحالة: قيد التنفيذ حالياً',
                            newMarkup
                        );
                    } else if (cbData.startsWith('ord_complete_')) {
                        const orderId = cbData.split('_')[2];

                        await db.collection('orders')
                            .doc(orderId)
                            .update({ status: 'مكتمل' });

                        editTelegramTextMessage(
                            token,
                            chatId,
                            messageId,
                            (callbackQuery.message.text || '') +
                            '\n✅ الحالة: تم إكمال الطلب بنجاح'
                        );
                    }
                } catch (err) {
                    console.error('Telegram callback error:', err.message);
                }
            }
        } catch (err) {
            console.error('Telegram polling error:', err.message);
        } finally {
            polling = false;
        }
    }, 2500);
}

startTelegramPolling(DEPOSIT_BOT_TOKEN);
startTelegramPolling(ORDERS_BOT_TOKEN);

// Asiacell API

async function callAsiacellAPI(
    endpoint,
    method = 'POST',
    bodyData = null,
    accessToken = null,
    deviceId = null,
    cookies = '',
    appVersion = '4.2.0'
) {
    const currentDeviceId = deviceId || crypto.randomUUID();

    const headers = {
        'Accept': 'application/json, text/plain, */*',
        'X-ODP-API-KEY': process.env.ASIACELL_API_KEY || '',
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

    if (method !== 'GET') {
        headers['Content-Type'] =
            'application/json; charset=UTF-8';
    }

    if (accessToken) {
        const cleanToken = String(accessToken)
            .replace(/^Bearer\s+/i, '')
            .trim();

        headers.Authorization = `Bearer ${cleanToken}`;
    }

    if (cookies) {
        headers.Cookie = cookies;
    }

    const cleanEp = endpoint.replace(/^\/+/, '');

    let url = cleanEp;

    if (!cleanEp.startsWith('http')) {
        url = cleanEp.startsWith('api/')
            ? `https://odpapp.asiacell.com/${cleanEp}`
            : `https://odpapp.asiacell.com/api/v1/${cleanEp}`;
    }

    const response = await fetch(url, {
        method,
        headers,
        body: method !== 'GET' && bodyData
            ? typeof bodyData === 'string'
                ? bodyData
                : JSON.stringify(bodyData)
            : undefined,
        signal: AbortSignal.timeout(20000)
    });

    let newCookies = cookies;

    if (typeof response.headers.getSetCookie === 'function') {
        const list = response.headers.getSetCookie();

        if (list?.length) {
            newCookies = list.map(c =>
                c.split(';')[0].trim()
            ).join('; ');
        }
    } else {
        const sc = response.headers.get('set-cookie');

        if (sc) {
            newCookies = sc
                .split(/,(?=\s*[a-zA-Z0-9_-]+=)/)
                .map(c => c.split(';')[0].trim())
                .join('; ');
        }
    }

    const responseText = await response.text();

    const isWafBlocked =
        responseText.includes('Access Blocked') ||
        responseText.includes('<!DOCTYPE html');

    let json = {};

    if (!isWafBlocked) {
        try {
            json = JSON.parse(responseText);
        } catch {
            json = { rawText: responseText.slice(0, 500) };
        }
    } else {
        json = {
            wafBlocked: true,
            message: 'WAF Access Blocked'
        };
    }

    return {
        status: response.status,
        ok: response.ok,
        isWafBlocked,
        data: json,
        deviceId: currentDeviceId,
        cookies: newCookies
    };
}

function extractLoginSessionInfo(obj) {
    const result = {
        pid: '',
        validationUrl: ''
    };

    if (!obj || typeof obj !== 'object') return result;

    function searchKeys(o, depth = 0) {
        if (depth > 10 || !o || typeof o !== 'object') return;

        for (const [key, value] of Object.entries(o)) {
            if (value && typeof value === 'object') {
                searchKeys(value, depth + 1);
                continue;
            }

            if (typeof value !== 'string' &&
                typeof value !== 'number') continue;

            const k = key.toLowerCase();
            const v = String(value);

            if (
                !result.pid &&
                ['pid', 'processid', 'requestid', 'transactionid']
                    .includes(k)
            ) {
                result.pid = v;
            }

            if (
                !result.validationUrl &&
                (k.includes('url') || k.includes('link')) &&
                v.includes('smsvalidation')
            ) {
                result.validationUrl = v;
            }
        }
    }

    searchKeys(obj);
    return result;
}

function extractProviderMessage(data) {
    const candidates = [
        data?.message,
        data?.data?.message,
        data?.error_description,
        data?.errorMessage,
        data?.error?.message,
        typeof data?.error === 'string' ? data.error : null,
        data?.data?.errorMessage
    ];

    return candidates.find(v =>
        typeof v === 'string' && v.trim()
    ) || 'لم يقدم مزود الخدمة سبباً واضحاً.';
}

function getTransferOtpStatus(data) {
    const step = String(
        data?.nextStep ||
        data?.data?.nextStep ||
        ''
    ).toUpperCase();

    const rejected =
        data?.success === false ||
        data?.data?.success === false ||
        Boolean(data?.error) ||
        Boolean(data?.errorCode);

    const requested =
        data?.otpRequired === true ||
        data?.data?.otpRequired === true ||
        step === 'OTP' ||
        step === 'SMS_VALIDATION';

    return { rejected, requested, step };
}

// 1. Send login OTP

app.post('/api/asiacell/send-otp', async (req, res) => {
    const cleanPhone = String(req.body.phone || '').trim();

    if (!/^077\d{8}$/.test(cleanPhone)) {
        return res.status(400).json({
            success: false,
            message: 'يرجى إدخال رقم آسياسيل صحيح.'
        });
    }

    try {
        const result = await callAsiacellAPI(
            'login?lang=ar',
            'POST',
            {
                username: cleanPhone,
                captchaCode: ''
            },
            null,
            null,
            '',
            '4.2.0'
        );

        const info = extractLoginSessionInfo(result.data);

        const nextStep =
            result.data?.nextStep ||
            result.data?.data?.nextStep;

        const accepted =
            result.ok &&
            !result.isWafBlocked &&
            (
                Boolean(info.pid) ||
                Boolean(info.validationUrl) ||
                nextStep === 'OTP' ||
                nextStep === 'SMS_VALIDATION' ||
                result.data?.success === true
            );

        if (!accepted) {
            return res.status(400).json({
                success: false,
                message:
                    'رد آسياسيل: ' +
                    extractProviderMessage(result.data)
            });
        }

        await db.collection('asiacell_sessions')
            .doc(cleanPhone).set({
                phone: cleanPhone,
                pid: info.pid,
                validationUrl: info.validationUrl,
                deviceId: result.deviceId,
                cookies: result.cookies || '',
                step: 'WAIT_LOGIN_OTP',
                updatedAt: Date.now()
            });

        return res.json({
            success: true,
            message:
                `تم طلب رمز تسجيل الدخول للرقم ${cleanPhone}.`
        });
    } catch (e) {
        return res.status(500).json({
            success: false,
            message: e.message
        });
    }
});

// 2. Verify login OTP

app.post('/api/asiacell/verify-login', async (req, res) => {
    const cleanPhone = String(req.body.phone || '').trim();
    const cleanOtp = String(req.body.otp || '').trim();

    if (!cleanPhone || !cleanOtp) {
        return res.status(400).json({
            success: false,
            message: 'يرجى إدخال رقم الهاتف ورمز الدخول.'
        });
    }

    try {
        const ref = db.collection('asiacell_sessions')
            .doc(cleanPhone);

        const doc = await ref.get();

        if (!doc.exists) {
            return res.status(400).json({
                success: false,
                message: 'اطلب الرمز أولاً.'
            });
        }

        const s = doc.data();

        const targetEndpoint =
            s.validationUrl || 'smsvalidation?lang=ar';

        const verifyPayload = {
            username: cleanPhone,
            passcode: cleanOtp
        };

        if (s.pid) verifyPayload.PID = s.pid;

        let vr = await callAsiacellAPI(
            targetEndpoint,
            'POST',
            verifyPayload,
            null,
            s.deviceId,
            s.cookies,
            '4.2.0'
        );

        let token =
            vr.data?.access_token ||
            vr.data?.data?.access_token ||
            vr.data?.token ||
            vr.data?.data?.token;

        if (!token && s.pid) {
            vr = await callAsiacellAPI(
                `smsvalidation?PID=${encodeURIComponent(s.pid)}&lang=ar`,
                'POST',
                {
                    username: cleanPhone,
                    passcode: cleanOtp
                },
                null,
                s.deviceId,
                s.cookies,
                '4.2.0'
            );

            token =
                vr.data?.access_token ||
                vr.data?.data?.access_token ||
                vr.data?.token ||
                vr.data?.data?.token;
        }

        if (!token || vr.data?.success === false) {
            return res.status(400).json({
                success: false,
                message:
                    'رد آسياسيل: ' +
                    extractProviderMessage(vr.data)
            });
        }

        await ref.update({
            accessToken: token,
            cookies: vr.cookies || s.cookies || '',
            step: 'SELECT_AMOUNT',
            updatedAt: Date.now()
        });

        return res.json({
            success: true,
            message: 'تم تسجيل الدخول بنجاح! اختر المبلغ الآن.'
        });
    } catch (e) {
        return res.status(500).json({
            success: false,
            message: e.message
        });
    }
});

// 3. Initiate transfer - diagnostic fix

app.post('/api/asiacell/initiate-transfer', async (req, res) => {
    const cleanPhone = String(req.body.phone || '').trim();

    if (!/^077\d{8}$/.test(cleanPhone)) {
        return res.status(400).json({
            success: false,
            message: 'يرجى إدخال رقم آسياسيل صحيح.'
        });
    }

    try {
        const sessionRef = db.collection('asiacell_sessions')
            .doc(cleanPhone);

        const doc = await sessionRef.get();

        if (!doc.exists || !doc.data().accessToken) {
            return res.status(400).json({
                success: false,
                message: 'سجل دخولك أولاً.'
            });
        }

        const s = doc.data();

        const transferPayload = {
            msisdn: TARGET_ASIACELL_NUMBER,
            receiverMsisdn: TARGET_ASIACELL_NUMBER,
            amount: "1000.0",
            transferAmount: 1000
        };

        // Original candidate endpoints.
        // These are not verified official transfer endpoints.
        const endpointsToTry = [
            'api/v2/creditTransfer?lang=ar',
            'api/v1/creditTransfer?lang=ar',
            'api/v2/transfer/send-otp?lang=ar',
            'api/v1/transfer/send-otp?lang=ar'
        ];

        const diagnostics = [];
        let confirmedRequest = null;
        let transferInfo = null;

        for (const endpoint of endpointsToTry) {
            let attempt;

            try {
                attempt = await callAsiacellAPI(
                    endpoint,
                    'POST',
                    transferPayload,
                    s.accessToken,
                    s.deviceId,
                    s.cookies,
                    '4.2.0'
                );
            } catch (error) {
                diagnostics.push({
                    endpoint,
                    error: error.message
                });
                continue;
            }

            const data = attempt.data || {};
            const status = getTransferOtpStatus(data);
            const info = extractLoginSessionInfo(data);

            diagnostics.push({
                endpoint,
                httpStatus: attempt.status,
                wafBlocked: attempt.isWafBlocked,
                nextStep: status.step,
                otpRequired: status.requested,
                rejected: status.rejected,
                providerMessage: extractProviderMessage(data)
            });

            // HTTP 200 alone does not prove SMS delivery.
            if (
                attempt.ok &&
                !attempt.isWafBlocked &&
                !status.rejected &&
                status.requested
            ) {
                confirmedRequest = attempt;
                transferInfo = info;
                break;
            }
        }

        if (!confirmedRequest) {
            console.error(
                'ASIACELL_TRANSFER_DIAGNOSTICS',
                JSON.stringify(diagnostics, null, 2)
            );

            const lastError = diagnostics
                .slice()
                .reverse()
                .find(x =>
                    x.providerMessage &&
                    x.providerMessage !==
                    'لم يقدم مزود الخدمة سبباً واضحاً.'
                );

            return res.status(502).json({
                success: false,
                message:
                    'لم يؤكد آسياسيل إرسال رمز التحويل. ' +
                    (lastError
                        ? lastError.providerMessage
                        : 'تحقق من سجلات الخادم لمعرفة سبب الفشل.'),
                diagnostics
            });
        }

        await sessionRef.update({
            transferPid: transferInfo.pid || '',
            transferValidationUrl:
                transferInfo.validationUrl || '',
            amountUSD: 1,
            amountIQD: 1000,
            amountDecimal: "1000.0",
            cookies: confirmedRequest.cookies || s.cookies,
            step: 'WAIT_TRANSFER_OTP',
            updatedAt: Date.now()
        });

        return res.json({
            success: true,
            step: 'CONFIRM_TRANSFER_OTP',
            message:
                'أكد خادم آسياسيل طلب رمز التحويل. ' +
                'يرجى إدخال الرمز عند وصوله.'
        });

    } catch (e) {
        console.error('TRANSFER_ERROR:', e.message);

        return res.status(500).json({
            success: false,
            message: 'تعذر طلب رمز التحويل: ' + e.message
        });
    }
});

// 4. Confirm transfer

app.post('/api/asiacell/confirm-transfer', async (req, res) => {
    const { email, phone, transferOtp, otp } = req.body;

    const cleanPhone = String(phone || '').trim();
    const finalOtp = String(transferOtp || otp || '').trim();

    if (!email || !/^\d{4,6}$/.test(finalOtp)) {
        return res.status(400).json({
            success: false,
            message: 'أدخل رمز التأكيد الصحيح.'
        });
    }

    try {
        const sessionRef = db.collection('asiacell_sessions')
            .doc(cleanPhone);

        const doc = await sessionRef.get();

        if (
            !doc.exists ||
            doc.data().step !== 'WAIT_TRANSFER_OTP'
        ) {
            return res.status(400).json({
                success: false,
                message: 'لا توجد عملية تحويل نشطة لهذا الرقم.'
            });
        }

        const s = doc.data();

        if (!s.transferValidationUrl) {
            return res.status(400).json({
                success: false,
                message:
                    'عنوان تأكيد التحويل غير متوفر من آسياسيل.'
            });
        }

        const confirmPayload = {
            username: cleanPhone,
            passcode: finalOtp,
            otp: finalOtp,
            receiverMsisdn: TARGET_ASIACELL_NUMBER,
            amount: s.amountDecimal || "1000.0"
        };

        if (s.transferPid) {
            confirmPayload.PID = s.transferPid;
        }

        const cr = await callAsiacellAPI(
            s.transferValidationUrl,
            'POST',
            confirmPayload,
            s.accessToken,
            s.deviceId,
            s.cookies,
            '4.2.0'
        );

        const confirmed =
            cr.ok &&
            !cr.isWafBlocked &&
            (
                cr.data?.success === true ||
                cr.data?.data?.success === true
            );

        if (!confirmed) {
            console.error('TRANSFER_CONFIRMATION_FAILED', {
                httpStatus: cr.status,
                providerMessage: extractProviderMessage(cr.data)
            });

            return res.status(400).json({
                success: false,
                message:
                    'لم يؤكد آسياسيل نجاح التحويل: ' +
                    extractProviderMessage(cr.data)
            });
        }

        // The provider's success flag is not necessarily
        // a final settlement confirmation.
        // A verified transaction reference/status is needed
        // before automatic financial crediting.

        await sessionRef.update({
            step: 'TRANSFER_AWAITING_RECONCILIATION',
            updatedAt: Date.now()
        });

        await db.collection('deposit_requests').add({
            email,
            gateway: 'Asiacell Auto',
            sender_phone: cleanPhone,
            amount: s.amountUSD,
            amount_iqd: s.amountIQD,
            recipient: TARGET_ASIACELL_NUMBER,
            status: 'بانتظار التحقق من التحويل',
            created_at: getFormattedDateTime()
        });

        sendTelegramTextMessage(
            DEPOSIT_BOT_TOKEN,
            ADMIN_CHAT_ID,
            `📥 طلب تحويل آسياسيل يحتاج التحقق:
المرسل: ${cleanPhone}
المستلم: ${TARGET_ASIACELL_NUMBER}
المبلغ: ${s.amountIQD} د.ع
الحالة: بانتظار التحقق من التحويل`
        );

        return res.json({
            success: true,
            pending: true,
            message:
                'تم استلام تأكيد الطلب، وهو بانتظار ' +
                'التحقق من اكتمال التحويل قبل إضافة الرصيد.'
        });

    } catch (e) {
        console.error('CONFIRM_TRANSFER_ERROR:', e.message);

        return res.status(500).json({
            success: false,
            message: e.message
        });
    }
});

// Admin services

app.post('/api/admin/add-service', async (req, res) => {
    const { category, name, price, description } = req.body;

    if (!category || !name || isNaN(parseFloat(price))) {
        return res.status(400).json({
            success: false,
            message: 'يرجى إكمال بيانات الخدمة بشكل صحيح.'
        });
    }

    try {
        const docRef = await db.collection('services').add({
            category: category.trim(),
            name: name.trim(),
            price: parseFloat(price),
            description: (description || '').trim(),
            created_at: getFormattedDateTime()
        });

        res.json({
            success: true,
            id: docRef.id,
            message: 'تم إضافة الخدمة للنظام بنجاح!'
        });
    } catch (e) {
        res.status(500).json({
            success: false,
            message: 'حدث خطأ في قاعدة البيانات.'
        });
    }
});

app.post('/api/admin/update-service', async (req, res) => {
    const { id, category, name, price, description } = req.body;

    if (!id || !category || !name || isNaN(parseFloat(price))) {
        return res.status(400).json({
            success: false,
            message: 'بيانات التعديل غير مكتملة.'
        });
    }

    try {
        await db.collection('services').doc(id).update({
            category: category.trim(),
            name: name.trim(),
            price: parseFloat(price),
            description: (description || '').trim()
        });

        res.json({
            success: true,
            message: 'تم تحديث الخدمة بنجاح!'
        });
    } catch (e) {
        res.status(500).json({
            success: false,
            message: 'حدث خطأ.'
        });
    }
});

app.post('/api/admin/delete-service', async (req, res) => {
    const { id } = req.body;

    if (!id) {
        return res.status(400).json({
            success: false,
            message: 'معرف الخدمة مفقود.'
        });
    }

    try {
        await db.collection('services').doc(id).delete();

        res.json({
            success: true,
            message: 'تم حذف الخدمة بنجاح.'
        });
    } catch (e) {
        res.status(500).json({
            success: false,
            message: 'حدث خطأ.'
        });
    }
});

app.get('/api/admin/data', async (req, res) => {
    try {
        const usersSnap = await db.collection('users').get();
        const ordersSnap = await db.collection('orders').get();

        let totalSales = 0;

        ordersSnap.forEach(doc => {
            totalSales += parseFloat(doc.data().charge || 0);
        });

        res.json({
            success: true,
            usersCount: usersSnap.size,
            totalSales
        });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// Users

app.post('/api/register', async (req, res) => {
    const { username, email, password } = req.body;

    try {
        const usersRef = db.collection('users');

        const snapshot = await usersRef
            .where('email', '==', email).get();

        if (!snapshot.empty) {
            return res.status(400).json({
                success: false,
                message: 'البريد مسجل مسبقاً.'
            });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        await usersRef.add({
            username,
            email,
            password: hashedPassword,
            balance: 0.00,
            role: 'user',
            created_at: getFormattedDateTime()
        });

        res.json({
            success: true,
            message: 'تم إنشاء الحساب بنجاح!',
            username,
            email,
            balance: 0.00
        });
    } catch (e) {
        res.status(500).json({
            success: false,
            message: 'خطأ في الخادم.'
        });
    }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        const snapshot = await db.collection('users')
            .where('email', '==', email).get();

        if (snapshot.empty) {
            return res.status(400).json({
                success: false,
                message: 'البريد غير صحيح.'
            });
        }

        const user = snapshot.docs[0].data();

        if (!await bcrypt.compare(password, user.password)) {
            return res.status(400).json({
                success: false,
                message: 'كلمة المرور خطأ.'
            });
        }

        res.json({
            success: true,
            message: 'تم تسجيل الدخول!',
            username: user.username,
            email: user.email,
            balance: user.balance
        });
    } catch (e) {
        res.status(500).json({
            success: false,
            message: 'خطأ في الخادم.'
        });
    }
});

app.get('/api/user/:email', async (req, res) => {
    try {
        const snapshot = await db.collection('users')
            .where('email', '==', req.params.email).get();

        if (snapshot.empty) {
            return res.status(404).json({ success: false });
        }

        res.json({
            success: true,
            user: snapshot.docs[0].data()
        });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// Deposit receipts

app.post(
    '/api/deposit/submit',
    upload.single('receiptImage'),
    async (req, res) => {
        const { email, gateway, amount } = req.body;
        const uploadedFile = req.file;

        if (!email || !gateway || !amount || !uploadedFile) {
            return res.status(400).json({
                success: false,
                message: 'الرجاء إكمال البيانات.'
            });
        }

        try {
            const pendingSnap = await db
                .collection('deposit_requests')
                .where('email', '==', email)
                .where('status', '==', 'معلق')
                .get();

            if (!pendingSnap.empty) {
                if (fs.existsSync(uploadedFile.path)) {
                    fs.unlinkSync(uploadedFile.path);
                }

                return res.status(400).json({
                    success: false,
                    message: 'لديك طلب شحن قيد المراجعة بالفعل.'
                });
            }

            const fileHash = await getFileHash(uploadedFile.path);

            const hashCheckSnap = await db
                .collection('deposit_requests')
                .where('image_hash', '==', fileHash)
                .get();

            if (!hashCheckSnap.empty) {
                if (fs.existsSync(uploadedFile.path)) {
                    fs.unlinkSync(uploadedFile.path);
                }

                return res.status(400).json({
                    success: false,
                    message: 'تم استخدام صورة هذا الإيصال مسبقاً.'
                });
            }

            const userSnap = await db.collection('users')
                .where('email', '==', email).get();

            if (userSnap.empty) {
                fs.unlinkSync(uploadedFile.path);

                return res.status(400).json({
                    success: false,
                    message: 'المستخدم غير موجود.'
                });
            }

            const username = userSnap.docs[0].data().username;
            const dateTime = getFormattedDateTime();

            const depRef = await db
                .collection('deposit_requests')
                .add({
                    username,
                    email,
                    gateway,
                    amount: parseFloat(amount),
                    receipt_image: uploadedFile.filename,
                    image_hash: fileHash,
                    status: 'معلق',
                    created_at: dateTime
                });

            const receiptUrl =
                `https://mtnajm.com/${uploadedFile.filename}`;

            const text = `📥 <b>طلب شحن رصيد جديد</b>

👤 <b>المستخدم:</b> ${username}
📧 <b>البريد:</b> ${email}
💰 <b>المبلغ:</b> $${amount}
💳 <b>البوابة:</b> ${gateway}
🕒 <b>التاريخ والوقت:</b> ${dateTime}

🔗 <a href="${receiptUrl}"><b>[ عرض صورة الإيصال ]</b></a>`;

            const replyMarkup = {
                inline_keyboard: [[
                    {
                        text: '✅ شحن الرصيد',
                        callback_data:
                            `dep_accept_${depRef.id}_${email}_${amount}`
                    },
                    {
                        text: '❌ رفض',
                        callback_data: `dep_reject_${depRef.id}`
                    }
                ]]
            };

            sendTelegramTextMessage(
                DEPOSIT_BOT_TOKEN,
                ADMIN_CHAT_ID,
                text,
                replyMarkup
            );

            res.json({
                success: true,
                message: 'تم إرسال طلب الشحن بنجاح.'
            });
        } catch (e) {
            if (
                uploadedFile &&
                fs.existsSync(uploadedFile.path)
            ) {
                fs.unlinkSync(uploadedFile.path);
            }

            res.status(500).json({
                success: false,
                message: 'خطأ في الخادم.'
            });
        }
    }
);

// Orders

app.post('/api/order', async (req, res) => {
    const { username, service, link, quantity, charge } = req.body;

    try {
        const userSnap = await db.collection('users')
            .where('username', '==', username).get();

        if (userSnap.empty) {
            return res.status(400).json({
                success: false,
                message: 'المستخدم غير موجود.'
            });
        }

        const userRef = userSnap.docs[0].ref;
        const numericCharge = Number(charge);

        if (!Number.isFinite(numericCharge) || numericCharge <= 0) {
            return res.status(400).json({
                success: false,
                message: 'قيمة الطلب غير صحيحة.'
            });
        }

        const dateTime = getFormattedDateTime();
        const newOrderRef = db.collection('orders').doc();

        let newBalance;

        await db.runTransaction(async transaction => {
            const userDoc = await transaction.get(userRef);
            const balance = Number(userDoc.data().balance || 0);

            if (balance < numericCharge) {
                throw new Error('رصيد غير كافٍ.');
            }

            newBalance = balance - numericCharge;

            transaction.update(userRef, {
                balance: newBalance
            });

            transaction.set(newOrderRef, {
                username,
                service,
                link,
                quantity,
                charge: numericCharge,
                status: 'قيد المعالجة',
                created_at: dateTime
            });
        });

        const orderId = newOrderRef.id;

        const text = `🚀 <b>طلب خدمة جديد</b>

🆔 <b>رقم الطلب:</b> #${orderId}
👤 <b>المستخدم:</b> ${username}
📌 <b>الخدمة:</b> ${service}
🔗 <b>الرابط:</b> ${link}
📦 <b>الكمية:</b> ${quantity}
💵 <b>السعر:</b> $${charge}
🕒 <b>التاريخ والوقت:</b> ${dateTime}

🔄 <b>الحالة: قيد المعالجة</b>`;

        const replyMarkup = {
            inline_keyboard: [[{
                text: '🔄 قيد التنفيذ',
                callback_data: `ord_progress_${orderId}`
            }]]
        };

        sendTelegramTextMessage(
            ORDERS_BOT_TOKEN,
            ADMIN_CHAT_ID,
            text,
            replyMarkup
        );

        res.json({
            success: true,
            newBalance,
            orderId
        });
    } catch (e) {
        res.status(400).json({
            success: false,
            message: e.message || 'تعذر تنفيذ الطلب.'
        });
    }
});

app.get('/api/orders/:username', async (req, res) => {
    try {
        const snapshot = await db.collection('orders')
            .where('username', '==', req.params.username).get();

        const orders = [];

        snapshot.forEach(doc => {
            orders.push({
                id: doc.id,
                ...doc.data()
            });
        });

        res.json({
            success: true,
            orders
        });
    } catch (e) {
        res.json({
            success: true,
            orders: []
        });
    }
});

app.get('/api/services', async (req, res) => {
    try {
        const snapshot = await db.collection('services').get();
        const services = [];

        snapshot.forEach(doc => {
            services.push({
                id: doc.id,
                ...doc.data()
            });
        });

        res.json({
            success: true,
            services
        });
    } catch (e) {
        res.json({
            success: true,
            services: []
        });
    }
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
