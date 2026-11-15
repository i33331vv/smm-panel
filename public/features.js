'use strict';
(() => {
    const moneyIQD = n => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits:1 }) + ' د.ع';
    const pending = new Map();
    const operation = key => {
        if (!pending.has(key)) pending.set(key, crypto.randomUUID());
        return pending.get(key);
    };
    let previousFocus;
    const host = document.createElement('div');
    host.innerHTML = `
    <dialog id="featuresDialog" class="feature-dialog" aria-labelledby="featureTitle">
      <header><h2 id="featureTitle"></h2><button type="button" id="closeFeature" aria-label="إغلاق">×</button></header>
      <div id="featureContent"></div><p id="featureMessage" role="status"></p>
    </dialog>`;
    document.body.append(host);
    const dialog = document.getElementById('featuresDialog');
    const content = document.getElementById('featureContent');
    const message = document.getElementById('featureMessage');
    const close = () => { dialog.close(); previousFocus?.focus(); };
    document.getElementById('closeFeature').addEventListener('click', close);
    dialog.addEventListener('click', e => { if (e.target === dialog) close(); });
    function open(title) {
        previousFocus = document.activeElement;
        document.getElementById('featureTitle').textContent = title;
        content.replaceChildren(); message.textContent = '';
        if (!dialog.open) dialog.showModal();
    }
    async function request(url, payload, method='POST') {
        const options = method==='GET' ? {} : payload instanceof FormData ? {method,body:payload} : {method,headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)};
        const response = await apiFetch(url,options);
        const data = await response.json();
        if (!response.ok || !data.success) {
            if (response.status === 401) dialog.close();
            throw new Error(data.message || 'تعذر إكمال الطلب.');
        }
        return data;
    }
    async function run(button, job) {
        if(button.disabled)return;
        button.disabled=true; message.textContent='جاري التنفيذ…';
        try { await job(); } catch(e) { message.textContent=e.message; }
        finally { button.disabled=false; }
    }
    document.getElementById('openAbout').addEventListener('click',()=>{
        open('من نحن');
        content.innerHTML=`<div class="about-copy"><h3>ام تي نجم — mtnajm</h3>
        <p>منصة عراقية لخدمات الدعم الرقمي، نجمع لك الخدمات في مكان واحد لتختار ما يناسب حسابك، وتتابع طلباتك ورصيدك بسهولة.</p>
        <p>نؤمن أن الثقة تبدأ بالوضوح: اطّلع على وصف الخدمة وحدودها قبل الطلب، وتواصل معنا إذا احتجت توضيحاً أو مساعدة. فريق الدعم متاح عبر واتساب وتليكرام لمتابعة استفساراتك.</p>
        <p>هدفنا تقديم تجربة مرتّبة وواضحة، من اختيار الخدمة إلى متابعة تنفيذها.</p>
        <a class="feature-button" href="https://www.instagram.com/i3_1v/" target="_blank" rel="noopener noreferrer">قم بمتابعة حسابنا على إنستغرام</a></div>`;
    });
    document.getElementById('openProfits').addEventListener('click',async()=>{
        if(!currentUser)return promptLogin();
        open('الأرباح ودعم المستخدمين');
        try {await profits();}catch(e){message.textContent=e.message;}
    });
    async function profits() {
        const data=await request('/api/profits',null,'GET');
        content.innerHTML=`<div class="feature-balance">رصيد الأرباح: <strong>${moneyIQD(data.profitIQD)}</strong></div>
        <p>لك 500 دينار عن كل 10,000 دينار كاملة يشحنها مستخدم اختار دعمك، بعد تأكيد شحنه. الأرباح لصاحب الكود ولا تُخصم من رصيد الشاحن. لا تُجمع كسور العمليات ولا تُحسب تحويلات الأرباح أو إضافات المدير.</p>
        ${data.code ? `<label>كودك الخاص<input id="myReferral" dir="ltr" readonly value="${escapeHTML(data.code)}"></label><button type="button" id="copyReferral" class="feature-button">نسخ الكود</button>` : '<button type="button" id="activateReferral" class="feature-button">تفعيل كود الأرباح</button>'}
        <hr><h3>دعم مستخدم</h3>
        ${data.supporterCode ? `<p>أنت تدعم الكود <b dir="ltr">${escapeHTML(data.supporterCode)}</b> بشكل دائم. لا يمكن تغيير المستخدم.</p>` : `<form id="supportUser"><label>كود الشخص الذي تريد دعمه<input name="code" maxlength="12" pattern="[A-Fa-f0-9]{12}" required dir="ltr" ${data.code?'':'disabled'}></label><p>يمكنك دعم شخص واحد فقط. الاختيار نهائي.</p><button class="feature-button" ${data.code?'':'disabled'}>تأكيد دعم المستخدم نهائياً</button></form>`}
        <hr><h3>تحويل إلى رصيد الخدمات</h3><form id="convertProfits"><label>المبلغ بالدينار<input name="amountIQD" type="number" min="1" step="1" max="${data.profitIQD}" required></label><button class="feature-button">تحويل الأرباح إلى رصيد الخدمات</button></form>
        <hr><h3>سحب الأرباح</h3><p>الحد الأدنى 10,000 دينار. يُخصم المبلغ عند إرسال الطلب ويُعاد إذا ألغته الإدارة.</p>
        <form id="withdrawProfits"><label>مبلغ السحب بالدينار<input name="amountIQD" type="number" min="10000" step="1" max="${data.profitIQD}" required></label>
        <label>رقم الماستر كارد / رقم الاستلام<input name="card" inputmode="numeric" dir="ltr" pattern="[0-9 -]{8,23}" maxlength="23" required autocomplete="off"></label>
        <p>لا تدخل رمز CVV أو الرقم السري أو رمز OTP؛ نحتاج رقم الاستلام والباركود فقط.</p>
        <label>صورة الباركود<input name="barcode" type="file" accept="image/png,image/jpeg,image/webp" required></label>
        <button class="feature-button" ${data.profitIQD>=10000?'':'disabled'}>طلب سحب الأرباح</button></form>
        <hr><h3>طلبات السحب</h3><button type="button" id="refreshProfits" class="feature-button">تحديث الرصيد وحالة السحب</button><div>${data.withdrawals.length?data.withdrawals.map(w=>`<article class="withdrawal-row"><b>${moneyIQD(w.amountIQD)}</b><span>${escapeHTML(w.status)}</span><small>${new Date(w.created_ms).toLocaleString('ar-IQ')}</small></article>`).join(''):'لا توجد طلبات سحب.'}</div>`;
        document.getElementById('refreshProfits').addEventListener('click', e => run(e.currentTarget, async () => { await profits(); await refreshUserBalance(); message.textContent='تم تحديث البيانات.'; }));
        document.getElementById('activateReferral')?.addEventListener('click',e=>run(e.currentTarget,async()=>{await request('/api/profits/activate',{});await profits();message.textContent='تم تفعيل كودك.';}));
        document.getElementById('copyReferral')?.addEventListener('click',e=>run(e.currentTarget,async()=>{
            try {await navigator.clipboard.writeText(data.code);message.textContent='تم نسخ الكود.';}catch{document.getElementById('myReferral').select();message.textContent='اضغط مطولاً على الكود واختر نسخ.';}
        }));
        document.getElementById('supportUser')?.addEventListener('submit',e=>{
            e.preventDefault();
            const code=new FormData(e.currentTarget).get('code');
            if(!confirm('تأكيد دعم الكود '+code+'؟ لا يمكنك تغييره لاحقاً.'))return;
            run(e.submitter,async()=>{await request('/api/profits/support',{code});await profits();message.textContent='تم تثبيت اختيارك.';});
        });
        document.getElementById('convertProfits').addEventListener('submit',e=>{
            e.preventDefault();const amount=Number(new FormData(e.currentTarget).get('amountIQD'));
            if(!confirm('تحويل '+moneyIQD(amount)+' إلى رصيد الخدمات؟'))return;
            const key='convert:'+amount;
            run(e.submitter,async()=>{await request('/api/profits/convert',{amountIQD:amount,requestId:operation(key)});pending.delete(key);await refreshUserBalance();await profits();message.textContent='تم تحويل الأرباح إلى رصيد الخدمات.';});
        });
        document.getElementById('withdrawProfits').addEventListener('submit',e=>{
            e.preventDefault();const form=new FormData(e.currentTarget);
            if(!confirm('إرسال طلب السحب وخصم '+moneyIQD(form.get('amountIQD'))+' من أرباحك؟'))return;
            const key='withdraw:'+form.get('amountIQD')+':'+form.get('card');
            form.set('requestId',operation(key));
            run(e.submitter,async()=>{await request('/api/profits/withdraw',form);pending.delete(key);await refreshUserBalance();await profits();message.textContent='تم تسجيل طلب السحب وخصم المبلغ. يمكنك متابعة الحالة أعلاه.';});
        });
    }
    let page=0,query='';
    document.getElementById('openUserManager').addEventListener('click',async()=>{
        if(currentUser?.role!=='admin')return;
        page=0;query='';open('إدارة المستخدمين');
        try{await userList();}catch(e){message.textContent=e.message;}
    });
    async function userList() {
        const data=await request('/api/admin/users?q='+encodeURIComponent(query)+'&page='+page,null,'GET');
        content.innerHTML=`<form id="userSearch" class="user-search"><label>البحث بالبريد أو اسم المستخدم الكامل<input name="query" value="${escapeHTML(query)}" placeholder="البريد أو اسم المستخدم"></label><button class="feature-button">بحث</button></form>
        <div class="user-table-wrap"><table class="user-table"><thead><tr><th>المستخدم</th><th>البريد</th><th>الرصيد</th><th>المصروف</th><th>الأرباح</th><th>الحالة</th><th>الإجراءات</th></tr></thead><tbody>
        ${data.users.map(u=>`<tr><td>${escapeHTML(u.username)}</td><td>${escapeHTML(u.email)}</td><td>${moneyIQD(u.balanceIQD)}</td><td>${moneyIQD(u.spentIQD)}</td><td>${moneyIQD(u.profitIQD)}</td><td>${u.disabled?'محظور':'نشط'}</td><td><button data-uid="${escapeHTML(u.id)}" data-action="add">إضافة رصيد</button><button data-uid="${escapeHTML(u.id)}" data-action="subtract">خصم رصيد</button>${u.role!=='admin'?`<button data-uid="${escapeHTML(u.id)}" data-action="${u.disabled?'unban':'ban'}">${u.disabled?'إلغاء الحظر':'حظر'}</button>`:''}</td></tr>`).join('')}
        </tbody></table></div><p>${data.users.length?'':'لا يوجد مستخدم مطابق.'}</p><div class="user-pagination"><button id="usersPrev" ${page===0?'disabled':''}>السابق</button><span>صفحة ${page+1}</span><button id="usersNext" ${data.more?'':'disabled'}>التالي</button></div>`;
        document.getElementById('userSearch').addEventListener('submit',e=>{e.preventDefault();query=new FormData(e.currentTarget).get('query').trim();page=0;run(e.submitter,async()=>{await userList();message.textContent='';});});
        document.getElementById('usersPrev').addEventListener('click',e=>run(e.currentTarget,async()=>{page--;await userList();message.textContent='';}));
        document.getElementById('usersNext').addEventListener('click',e=>run(e.currentTarget,async()=>{page++;await userList();message.textContent='';}));
        content.querySelectorAll('[data-uid]').forEach(button=>button.addEventListener('click',()=>{
            const {uid,action}=button.dataset;
            let amount=0;
            if(['add','subtract'].includes(action)){
                const raw=prompt('أدخل المبلغ بالدينار العراقي:');if(raw===null)return;
                amount=Number(raw);if(!Number.isSafeInteger(amount)||amount<=0){message.textContent='أدخل مبلغاً صحيحاً موجباً.';return;}
            }
            if(!confirm('تأكيد '+button.textContent+(amount?' بمبلغ '+moneyIQD(amount):'')+' لهذا المستخدم؟'))return;
            const key='admin:'+uid+':'+action+':'+amount;
            run(button,async()=>{await request('/api/admin/users/'+encodeURIComponent(uid)+'/action',{action,amountIQD:amount,requestId:operation(key)});pending.delete(key);await userList();await refreshUserBalance();message.textContent='تم تنفيذ العملية.';});
        }));
    }
})();
