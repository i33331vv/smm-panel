const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database('./smm.db', (err) => {
    if (err) {
        console.error('خطأ في الاتصال بقاعدة البيانات:', err.message);
    } else {
        console.log('تم الاتصال بقاعدة البيانات بنجاح.');

        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            balance REAL DEFAULT 0.00,
            role TEXT DEFAULT 'user'
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            service TEXT NOT NULL,
            link TEXT NOT NULL,
            quantity INTEGER NOT NULL,
            charge REAL NOT NULL,
            status TEXT DEFAULT 'قيد التنفيذ',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS services (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            category TEXT NOT NULL,
            name TEXT NOT NULL,
            price REAL NOT NULL,
            description TEXT
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            gateway TEXT NOT NULL,
            amount REAL NOT NULL,
            reference_id TEXT,
            status TEXT DEFAULT 'مكتمل',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // جدول طلبات الشحن مع حقل البريد الإلكتروني وصورة الإيصال
        db.run(`CREATE TABLE IF NOT EXISTS deposit_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            email TEXT NOT NULL,
            gateway TEXT NOT NULL,
            amount REAL NOT NULL,
            reference_id TEXT NOT NULL,
            receipt_image TEXT,
            status TEXT DEFAULT 'معلق',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, (createErr) => {
            if (!createErr) {
                // احتياطياً: إذا كان الجدول موجوداً مسبقاً بدون عمود email، قم بإضافته برمجياً
                db.run(`ALTER TABLE deposit_requests ADD COLUMN email TEXT`, () => {});
            }
        });

        console.log('جميع الجداول والاتصالات جاهزة.');
    }
});

module.exports = db;