'use strict';

// Three attempts, shared per-profile cache, and no invented privacy/count values.
function createInstagramProvider({ axios, token, now = Date.now, logger = console }) {
    const cache = new Map(), pending = new Map(), cooldown = new Map();
    let active = 0;
    const unavailable = () => ({valid:false, unreachable:true,
        message:'تعذر التحقق آلياً من الحساب. يمكن إرسال الطلب دون عداد متابعين بعد التأكد من أن الحساب عام.'});
    function normalized(user, username, source, apify = false) {
        if (!user || user.error || typeof user.username !== 'string' || user.username.toLowerCase() !== username) return null;
        const privacy = apify ? user.private : user.is_private;
        const count = apify ? user.followersCount : (user.edge_followed_by?.count ?? user.follower_count);
        if (typeof privacy !== 'boolean') return null;
        if (!privacy && (!Number.isSafeInteger(count) || count < 0)) return null;
        return {valid:true, username, isPrivate:privacy,
            followers:Number.isSafeInteger(count) && count >= 0 ? count : null,
            checkedAt:now(), source};
    }
    function pageProfile(html, username) {
        // Only a matching profile object with explicit fields counts as evidence.
        // Login/challenge HTML and abbreviated meta counts are not verification.
        const scripts = String(html || '').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi);
        for (const match of scripts) {
            let root;
            try { root = JSON.parse(match[1]); } catch { continue; }
            const stack = [root]; let visited = 0;
            while (stack.length && visited++ < 20000) {
                const obj = stack.pop();
                if (!obj || typeof obj !== 'object') continue;
                const result = normalized(obj, username, 'instagram-page');
                if (result) return result;
                for (const value of Object.values(obj)) if (value && typeof value === 'object') stack.push(value);
            }
        }
        return null;
    }
    async function attempt(source, ms, request, parse) {
        if ((cooldown.get(source) || 0) > now()) return null;
        try {
            const response = await request({timeout:ms, signal:AbortSignal.timeout(ms),
                maxRedirects:0, maxContentLength:3 * 1024 * 1024});
            if (response.status && response.status !== 200 && response.status !== 201) throw {response};
            const value = parse(response.data);
            if (!value) cooldown.set(source, now() + 30000);
            return value;
        } catch (error) {
            const status = Number(error.response?.status) || 0;
            const retry = Number(error.response?.headers?.['retry-after']);
            const pause = [401,402,403,429].includes(status)
                ? (Number.isFinite(retry) && retry > 0 ? Math.min(retry * 1000,3600000) : 300000)
                : 60000;
            cooldown.set(source, now() + pause);
            if (source.startsWith('instagram') && status === 429) {
                cooldown.set('instagram-web', now() + pause);
                cooldown.set('instagram-page', now() + pause);
            }
            logger.warn('Instagram check attempt unavailable', {source,status});
            return null;
        }
    }
    return async function check(username) {
        username = String(username || '').toLowerCase();
        if (!/^[a-z0-9._]{1,30}$/.test(username)) return {valid:false,message:'صيغة اسم الحساب غير صحيحة.'};
        const hit = cache.get(username);
        if (hit && hit.until > now()) return {...hit.value};
        if (pending.has(username)) return {...await pending.get(username)};
        if (active >= 2) return unavailable();
        const work = (async () => {
            active++;
            try {
                let value = null;
                if (token) value = await attempt('apify',7000, config => axios.post(
                    'https://api.apify.com/v2/acts/apify~instagram-profile-scraper/run-sync-get-dataset-items',
                    {usernames:[username], includeAboutSection:false},
                    {...config, params:{timeout:10,clean:true},
                        headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'}}),
                    items => Array.isArray(items) ? items.map(x => normalized(x,username,'apify',true)).find(Boolean) : null);
                const headers = {'User-Agent':'Mozilla/5.0','Accept-Language':'en-US,en;q=0.9'};
                if (!value) value = await attempt('instagram-web',3000, config => axios.get(
                    `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
                    {...config,headers:{...headers,'x-ig-app-id':'936619743392459'}}),
                    data => normalized(data?.data?.user,username,'instagram-web'));
                if (!value) value = await attempt('instagram-page',3000, config => axios.get(
                    `https://www.instagram.com/${encodeURIComponent(username)}/`,{...config,headers}),
                    data => pageProfile(data,username));
                value ||= unavailable();
                if (cache.size >= 2000) cache.delete(cache.keys().next().value);
                cache.set(username,{value,until:now() + (value.valid ? 600000 : 120000)});
                return value;
            } finally { active--; }
        })();
        pending.set(username,work);
        try { return {...await work}; } finally { pending.delete(username); }
    };
}
module.exports = {createInstagramProvider};
