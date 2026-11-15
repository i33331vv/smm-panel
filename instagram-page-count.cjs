'use strict';
function decode(text) {
    return String(text).replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n) => {
        const v = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1),16) : Number(n);
        return v > 0 && v <= 0x10ffff ? String.fromCodePoint(v) : '';
    }).replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&nbsp;|&amp;/g,' ')
        .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,'');
}
function compactCount(text) {
    const normalized = decode(text).replace(/[٠-٩]/g,c=>String(c.charCodeAt(0)-1632))
        .replace(/[۰-۹]/g,c=>String(c.charCodeAt(0)-1776)).replace(/٫/g,'.').replace(/٬/g,',');
    const match = normalized.match(/(?:^|[^\w.])([0-9][0-9.,]*)\s*(ألف|الف|آلاف|مليون|مليار|[kmb])?\s*(?:متابع(?:ين|ون)?|followers)\b/i);
    // Arabic words do not end at a JS ASCII word boundary.
    const ar = normalized.match(/(?:^|[^\w.])([0-9][0-9.,]*)\s*(ألف|الف|آلاف|مليون|مليار|[kmb])?\s*متابع(?:ين|ون)?(?=$|[\s،,.·<])/i);
    const m = match || ar;
    if (!m) return null;
    const unit = (m[2] || '').toLowerCase();
    let digits = m[1];
    if (unit && /^\d+,\d{1,2}$/.test(digits)) digits = digits.replace(',','.');
    else { if (digits.includes(',') && !/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(digits)) return null; digits = digits.replace(/,/g,''); }
    if (!/^\d+(\.\d+)?$/.test(digits)) return null;
    const multiplier = /^(k|ألف|الف|آلاف)$/.test(unit) ? 1000 : /^(m|مليون)$/.test(unit) ? 1000000 : /^(b|مليار)$/.test(unit) ? 1000000000 : 1;
    const value = Math.round(Number(digits) * multiplier);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function readPageCount(html, username) {
    html = String(html || '');
    const meta = new Map();
    for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
        const attributes = {};
        for (const a of m[0].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attributes[a[1].toLowerCase()] = decode(a[2] ?? a[3]);
        meta.set((attributes.property || attributes.name || '').toLowerCase(),attributes.content || '');
    }
    const expected = username.toLowerCase();
    let sameProfile = false;
    try {
        const url = new URL(meta.get('og:url'));
        sameProfile = ['instagram.com','www.instagram.com'].includes(url.hostname) && url.pathname.replace(/^\/|\/$/g,'').toLowerCase() === expected;
    } catch {}
    const title = meta.get('og:title') || decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
    const named = new RegExp('(?:^|[\\s(@])'+expected.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?=$|[\\s)])','i').test(title);
    if (!sameProfile && !named) return null;
    let count = compactCount(meta.get('og:description') || meta.get('description') || '');
    if (count === null) {
        // Read only the profile header, not captions, recommendations or script code.
        const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] || '';
        for (const h of main.matchAll(/<header\b[^>]*>([\s\S]*?)<\/header>/gi)) {
            const text = decode(h[1].replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<[^>]+>/g,' ')).replace(/\s+/g,' ').trim();
            if (!text.toLowerCase().includes(expected)) continue;
            count = compactCount(text.slice(0,1000));
            if (count !== null) break;
        }
    }
    if (count === null) return null;
    return {valid:true,username:expected,followers:count,isPrivate:null,approximate:true,source:'instagram-page-text'};
}
module.exports = {readPageCount,compactCount};
