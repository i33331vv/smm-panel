
        let fetchedServices = [];

        // الهوية تعتمد على جلسة السيرفر، وليس بيانات localStorage.
        let currentUser = null;
        let balanceBusy = false;
        let ordersBusy = false;

        try {
            localStorage.removeItem('smm_session');
        } catch (_) {}

        function escapeHTML(value) {
            return String(value ?? '').replace(/[&<>"']/g, c => ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#39;'
            }[c]));
        }

        function safeInstagramURL(value) {
            try {
                const url = new URL(String(value));

                if (
                    !['https:', 'http:'].includes(url.protocol) ||
                    !['instagram.com', 'www.instagram.com']
                        .includes(url.hostname.toLowerCase()) ||
                    url.username ||
                    url.password ||
                    url.port
                ) {
                    return '#';
                }

                url.protocol = 'https:';
                return url.href;
            } catch (_) {
                return '#';
            }
        }

        function updateAdminVisibility() {
            const allowed = currentUser?.role === 'admin';
            const link = document.getElementById('adminNavLink');

            link.classList.toggle('hidden', !allowed);
            link.classList.toggle('flex', allowed);
        }

        function promptLogin(
            message = 'سجّل دخولك مرة واحدة لحفظ جلستك على هذا الجهاز.'
        ) {
            currentUser = null;
            hideAllSections();
            updateAdminVisibility();
            toggleView('landing-page');

            const box = document.getElementById('loginError');
            box.textContent = message;
            box.classList.remove('hidden');

            openModal('loginModal');
        }

        async function apiFetch(url, options = {}) {
            const target = new URL(url, window.location.origin);

            if (
                target.origin !== window.location.origin ||
                !target.pathname.startsWith('/api/')
            ) {
                throw new Error('عنوان الطلب غير مسموح.');
            }

            const response = await fetch(target.href, {
                ...options,
                credentials: 'same-origin',
                cache: 'no-store'
            });

            if (
                response.status === 401 &&
                !['/api/login', '/api/register']
                    .includes(target.pathname)
            ) {
                promptLogin();
            }

            return response;
        }

        async function restoreSession(showLogin = false) {
            try {
                const response = await apiFetch('/api/me');

                if (!response.ok) {
                    if (response.status !== 401) {
                        throw new Error(
                            'تعذر التحقق من الجلسة الآن. حاول تسجيل الدخول مجدداً.'
                        );
                    }

                    return false;
                }

                const data = await response.json();

                if (
                    !data.success ||
                    !data.user ||
                    typeof data.user.username !== 'string'
                ) {
                    throw new Error('تعذر التحقق من بيانات الحساب.');
                }

                currentUser = data.user;

                showDashboard(
                    currentUser.username,
                    currentUser.email,
                    currentUser.balance
                );

                return true;
            } catch (error) {
                // انقطاع الاتصال لا يمسح جلسة السيرفر.
                const box = document.getElementById('loginError');

                box.textContent =
                    'تعذر الاتصال بالخادم للتحقق من الجلسة. حدّث الصفحة أو حاول مجدداً.';

                box.classList.remove('hidden');

                if (showLogin || !currentUser) {
                    openModal('loginModal');
                }

                return false;
            }
        }

        function openModal(id) {
            document.getElementById(id).classList.add('active');
        }

        function closeModal(id) {
            document.getElementById(id).classList.remove('active');
        }

        function toggleView(id) {
            document.getElementById('landing-page')
                .classList.add('hidden');

            document.getElementById('dashboard-page')
                .classList.add('hidden');

            document.getElementById(id)
                .classList.remove('hidden');
        }

        function showDashboard(username, email, balance) {
            document.getElementById('displayUsernameText')
                .innerText = username;

            document.getElementById('displayUsernameIcon')
                .innerText = username.charAt(0).toUpperCase();

            document.getElementById('displayBalance')
                .innerText = '$' + parseFloat(balance).toFixed(2);

            updateAdminVisibility();

            closeModal('loginModal');
            closeModal('registerModal');

            toggleView('dashboard-page');
            showNewOrderPage();
        }

        async function refreshUserBalance() {
            if (!currentUser || balanceBusy) return;

            balanceBusy = true;

            try {
                const res = await apiFetch('/api/me');
                const data = await res.json();

                if (
                    res.ok &&
                    data.success &&
                    data.user &&
                    currentUser
                ) {
                    Object.assign(currentUser, data.user);

                    document.getElementById('displayBalance')
                        .innerText =
                            '$' + Number(currentUser.balance).toFixed(2);

                    updateAdminVisibility();
                }
            } catch (_) {
            } finally {
                balanceBusy = false;
            }
        }

        setInterval(() => {
            if (currentUser) {
                refreshUserBalance();
            }
        }, 15000);

        function hideAllSections() {
            document.getElementById('new-order-section')
                .classList.add('hidden');

            document.getElementById('orders-section')
                .classList.add('hidden');

            document.getElementById('deposit-section')
                .classList.add('hidden');

            document.getElementById('admin-section')
                .classList.add('hidden');

            document.getElementById('navNewOrder').className =
                'flex items-center px-4 py-3 text-gray-600 hover:bg-gray-50 hover:text-primary rounded-xl font-medium transition cursor-pointer';

            document.getElementById('navOrders').className =
                'flex items-center px-4 py-3 text-gray-600 hover:bg-gray-50 hover:text-primary rounded-xl font-medium transition cursor-pointer';

            document.getElementById('navDeposit').className =
                'flex items-center px-4 py-3 text-gray-600 hover:bg-gray-50 hover:text-primary rounded-xl font-medium transition cursor-pointer';
        }

        function showNewOrderPage() {
            hideAllSections();

            document.getElementById('new-order-section')
                .classList.remove('hidden');

            document.getElementById('pageTitle')
                .innerText = 'إنشاء طلب جديد';

            document.getElementById('navNewOrder').className =
                'flex items-center px-4 py-3 bg-[#fdf2f4] text-primary rounded-xl font-medium transition cursor-pointer';

            loadServicesForUser();
            refreshUserBalance();
        }

        async function loadServicesForUser() {
            try {
                const res = await apiFetch('/api/services');
                const data = await res.json();

                const categorySelect =
                    document.getElementById('categorySelect');

                categorySelect.innerHTML =
                    '<option value="">-- اختر القسم --</option>';

                if (data.success && data.services.length > 0) {
                    fetchedServices = data.services;

                    const categories = [
                        ...new Set(data.services.map(s => s.category))
                    ];

                    categories.forEach(cat => {
                        categorySelect.add(
                            new Option(String(cat), String(cat))
                        );
                    });
                } else {
                    fetchedServices = [];
                }

                document.getElementById('serviceSelectContainer')
                    .classList.add('hidden');

                document.getElementById('serviceDescriptionBox')
                    .classList.add('hidden');

                document.getElementById('orderDetailsContainer')
                    .classList.add('hidden');
            } catch (err) {}
        }

        function onCategoryChange() {
            const selectedCat =
                document.getElementById('categorySelect').value;

            const serviceContainer =
                document.getElementById('serviceSelectContainer');

            const serviceSelect =
                document.getElementById('serviceSelect');

            const descBox =
                document.getElementById('serviceDescriptionBox');

            const orderDetailsContainer =
                document.getElementById('orderDetailsContainer');

            if (!selectedCat) {
                serviceContainer.classList.add('hidden');
                descBox.classList.add('hidden');
                orderDetailsContainer.classList.add('hidden');

                document.getElementById('charge').value = '';
                return;
            }

            const filteredServices = fetchedServices.filter(
                s => s.category === selectedCat
            );

            serviceSelect.innerHTML =
                '<option value="">-- اختر الخدمة --</option>';

            filteredServices.forEach(serv => {
                const baseQ = serv.baseQuantity || 1000;

                serviceSelect.add(
                    new Option(
                        `${serv.name} — (${baseQ} بـ $${parseFloat(serv.price).toFixed(2)})`,
                        String(serv.id)
                    )
                );
            });

            serviceContainer.classList.remove('hidden');
            descBox.classList.add('hidden');
            orderDetailsContainer.classList.add('hidden');

            document.getElementById('charge').value = '';
        }

        function onServiceChange() {
            const servId =
                document.getElementById('serviceSelect').value;

            const descBox =
                document.getElementById('serviceDescriptionBox');

            const descText =
                document.getElementById('serviceDescText');

            const orderDetailsContainer =
                document.getElementById('orderDetailsContainer');

            const qtyInput =
                document.getElementById('quantity');

            const qtyLabel =
                document.getElementById('quantityLabel');

            document.getElementById('igPreviewBox')
                .classList.add('hidden');

            if (!servId) {
                descBox.classList.add('hidden');
                orderDetailsContainer.classList.add('hidden');

                document.getElementById('charge').value = '';
                return;
            }

            const targetServ = fetchedServices.find(
                s => s.id == servId
            );

            if (targetServ) {
                const minQ = targetServ.minQty || 100;
                const maxQ = targetServ.maxQty || null;

                qtyInput.min = minQ;
                qtyInput.value = targetServ.baseQuantity || minQ;

                if (maxQ) {
                    qtyInput.max = maxQ;
                    qtyLabel.innerText =
                        `الكمية (الحد الأدنى: ${minQ} | الحد الأقصى: ${maxQ})`;
                } else {
                    qtyInput.removeAttribute('max');
                    qtyLabel.innerText =
                        `الكمية (الحد الأدنى: ${minQ} | الحد الأقصى: مفتوح)`;
                }

                if (
                    targetServ.description &&
                    targetServ.description.trim() !== ''
                ) {
                    descText.innerText = targetServ.description;
                    descBox.classList.remove('hidden');
                } else {
                    descBox.classList.add('hidden');
                }
            }

            orderDetailsContainer.classList.remove('hidden');
            calculatePrice();
        }

        function calculatePrice() {
            const servId =
                document.getElementById('serviceSelect').value;

            const targetServ = fetchedServices.find(
                s => s.id == servId
            );

            const qty = parseInt(
                document.getElementById('quantity').value
            );

            const charge = document.getElementById('charge');

            if (targetServ && !isNaN(qty) && qty > 0) {
                const baseQ = targetServ.baseQuantity || 1000;

                charge.value = (
                    (qty / baseQ) * parseFloat(targetServ.price)
                ).toFixed(4);
            } else {
                charge.value = '';
            }
        }

        async function previewInstagramAccount() {
            const link =
                document.getElementById('orderLink').value.trim();

            const previewBox =
                document.getElementById('igPreviewBox');

            const checkBtn =
                document.getElementById('checkIgBtn');

            if (!link) {
                previewBox.className =
                    'mt-2 p-3 rounded-xl text-xs font-bold bg-red-50 text-red-700 border border-red-200';

                previewBox.innerText =
                    '⚠️ يرجى وضع رابط حسابك في انستقرام أولاً.';

                previewBox.classList.remove('hidden');
                return;
            }

            checkBtn.disabled = true;
            checkBtn.innerText = 'جاري الفحص...';
            previewBox.classList.add('hidden');

            try {
                const res = await apiFetch('/api/instagram/check', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ link })
                });

                const data = await res.json();

                previewBox.classList.remove('hidden');

                if (data.success) {
                    previewBox.className =
                        'mt-2 p-3 rounded-xl text-xs font-bold bg-green-50 text-green-700 border border-green-200';

                    previewBox.innerText =
                        `✅ الحساب (@${data.username}) عام وصحيح — عدد حسابك الحالي: ${data.followers} متابع.`;
                } else {
                    previewBox.className =
                        'mt-2 p-3 rounded-xl text-xs font-bold bg-red-50 text-red-700 border border-red-200';

                    previewBox.innerText =
                        data.message || '❌ الرابط خطأ.';
                }
            } catch (e) {
                previewBox.classList.remove('hidden');

                previewBox.className =
                    'mt-2 p-3 rounded-xl text-xs font-bold bg-red-50 text-red-700 border border-red-200';

                previewBox.innerText =
                    'حدث خطأ في الاتصال بالخادم أثناء الفحص.';
            } finally {
                checkBtn.disabled = false;
                checkBtn.innerText = 'فحص الرابط';
            }
        }

        async function showOrdersPage() {
            hideAllSections();

            document.getElementById('orders-section')
                .classList.remove('hidden');

            document.getElementById('pageTitle')
                .innerText = 'سجل الطلبات';

            document.getElementById('navOrders').className =
                'flex items-center px-4 py-3 bg-[#fdf2f4] text-primary rounded-xl font-medium transition cursor-pointer';

            refreshUserBalance();
            await fetchAndRenderOrders();
        }

        async function fetchAndRenderOrders() {
            if (!currentUser || ordersBusy) return;

            ordersBusy = true;
            const session = currentUser;

            try {
                const res = await apiFetch(
                    `/api/orders/${encodeURIComponent(session.username)}`
                );

                const data = await res.json();

                if (
                    !res.ok ||
                    !data.success ||
                    currentUser !== session
                ) {
                    return;
                }

                const tbody =
                    document.getElementById('ordersTableBody');

                tbody.innerHTML = '';

                if (data.success && data.orders.length > 0) {
                    data.orders.forEach(order => {
                        let statusColor =
                            'text-yellow-700 bg-yellow-50';

                        let statusText =
                            order.status || 'قيد المعالجة';

                        if (statusText.includes('مكتمل')) {
                            statusColor =
                                'text-green-700 bg-green-50';
                            statusText = 'مكتمل';
                        } else if (statusText.includes('ملغي')) {
                            statusColor =
                                'text-red-700 bg-red-50';
                            statusText = 'ملغي';
                        } else if (statusText.includes('التنفيذ')) {
                            statusColor =
                                'text-blue-700 bg-blue-50';
                        }

                        let counterCell =
                            '<span class="text-gray-400">-</span>';

                        if (
                            order.start_count !== null &&
                            order.start_count !== undefined
                        ) {
                            const curr =
                                order.current_count ?? order.start_count;

                            const targ = order.target_count ??
                                (
                                    Number(order.start_count) +
                                    Number(order.quantity)
                                );

                            if (statusText === 'مكتمل') {
                                counterCell = `
                                    <div class="font-mono font-bold text-green-700 text-xs" dir="ltr">
                                        ${escapeHTML(order.start_count)}/${escapeHTML(curr)}
                                    </div>
                                    <div class="text-[11px] font-bold text-green-600">
                                        العدد مكتمل ✓
                                    </div>
                                `;
                            } else if (order.account_private) {
                                counterCell = `
                                    <div class="font-mono font-bold text-red-600 text-xs" dir="ltr">
                                        ${escapeHTML(order.start_count)}/${escapeHTML(curr)}
                                    </div>
                                    <div class="text-[11px] font-bold text-red-600">
                                        ⚠️ حسابك خاص!
                                    </div>
                                `;
                            } else {
                                counterCell = `
                                    <div class="text-xs font-bold text-primary">
                                        عدد حسابك هو
                                        <span class="font-mono" dir="ltr">
                                            ${escapeHTML(order.start_count)}/${escapeHTML(curr)}
                                        </span>
                                    </div>
                                    <div class="text-[10px] text-gray-500">
                                        يكتمل عند: ${escapeHTML(targ)}
                                    </div>
                                `;
                            }
                        }

                        tbody.innerHTML += `
                            <tr class="border-b border-gray-100 hover:bg-gray-50 transition">
                                <td class="p-3 font-bold text-primary">
                                    #${escapeHTML(order.id.substring(0, 6))}
                                </td>
                                <td class="p-3 text-gray-700">
                                    ${escapeHTML(order.service)}
                                </td>
                                <td class="p-3 text-blue-600 truncate max-w-xs">
                                    <a href="${escapeHTML(safeInstagramURL(order.link))}"
                                       target="_blank"
                                       rel="noopener noreferrer"
                                       class="hover:underline"
                                       dir="ltr">${escapeHTML(order.link)}</a>
                                </td>
                                <td class="p-3 font-bold">
                                    ${escapeHTML(order.quantity)}
                                </td>
                                <td class="p-3">
                                    ${counterCell}
                                </td>
                                <td class="p-3 font-bold">
                                    $${parseFloat(order.charge || 0).toFixed(4)}
                                </td>
                                <td class="p-3">
                                    <span class="${statusColor} px-2.5 py-1 rounded-full text-xs font-bold whitespace-nowrap">
                                        ${escapeHTML(statusText)}
                                    </span>
                                </td>
                                <td class="p-3 text-gray-400 text-xs whitespace-nowrap" dir="ltr">
                                    ${escapeHTML(order.created_at || '-')}
                                </td>
                            </tr>
                        `;
                    });
                } else {
                    tbody.innerHTML = `
                        <tr>
                            <td colspan="8" class="text-center p-6 text-gray-400">
                                لا توجد طلبات سابقة.
                            </td>
                        </tr>
                    `;
                }
            } catch (err) {
            } finally {
                ordersBusy = false;
            }
        }

        setInterval(() => {
            const ordSec =
                document.getElementById('orders-section');

            if (
                ordSec &&
                !ordSec.classList.contains('hidden')
            ) {
                fetchAndRenderOrders();
            }
        }, 5000);

        function showDepositPage() {
            hideAllSections();

            document.getElementById('deposit-section')
                .classList.remove('hidden');

            document.getElementById('pageTitle')
                .innerText = 'شحن الرصيد';

            document.getElementById('navDeposit').className =
                'flex items-center px-4 py-3 bg-[#fdf2f4] text-primary rounded-xl font-medium transition cursor-pointer';

            if (document.getElementById('manualDepositForm')) {
                document.getElementById('manualDepositForm').reset();
            }

            resetAsiaFlow();

            document.getElementById('depositSuccessMsg')
                .classList.add('hidden');

            toggleDepositMode();
            refreshUserBalance();
        }

        function toggleDepositMode() {
            const gateway =
                document.getElementById('depositGateway').value;

            const asiaAutoBox =
                document.getElementById('asiaAutoBox');

            const manualForm =
                document.getElementById('manualDepositForm');

            if (gateway === 'AsiacellAuto') {
                asiaAutoBox.classList.remove('hidden');
                manualForm.classList.add('hidden');
            } else {
                asiaAutoBox.classList.add('hidden');
                manualForm.classList.remove('hidden');
                updateDepositInstructions();
            }
        }

        function updateDepositInstructions() {
            const gateway =
                document.getElementById('depositGateway').value;

            const infoBox =
                document.getElementById('depositInfoBox');

            if (gateway === 'ZainCash') {
                infoBox.innerHTML = `
                    قم بالتحويل عبر مسح الباركود التالي الخاص بزين كاش:
                    <br>
                    <img src="/ZAINCASH.jpeg"
                         alt="Zain Cash QR"
                         class="mt-3 mx-auto max-h-48 rounded-xl border border-gray-200 shadow-sm">
                `;
            } else if (gateway === 'Mastercard') {
                infoBox.innerHTML = `
                    قم بتحويل المبلغ إلى الرقم:
                    <br>
                    <span class="font-mono font-bold text-primary text-lg" dir="ltr">
                        7111053109
                    </span>
                `;
            } else if (gateway === 'Binance') {
                infoBox.innerHTML = `
                    قم بالتحويل إلى المعرف:
                    <span class="font-mono font-bold text-primary" dir="ltr">
                        1075470705
                    </span>
                    أو عبر مسح الباركود التالي:
                    <br>
                    <img src="/BINANCE.jpeg"
                         alt="Binance QR"
                         class="mt-3 mx-auto max-h-48 rounded-xl border border-gray-200 shadow-sm">
                `;
            }
        }

        function showAsiaMessage(text, type = 'info') {
            const msg = document.getElementById('asiaMsg');
            msg.classList.remove('hidden');

            if (type === 'success') {
                msg.className =
                    'text-xs p-3.5 rounded-xl font-bold text-center bg-green-50 text-green-700 border border-green-200 leading-relaxed';
            } else if (type === 'error') {
                msg.className =
                    'text-xs p-3.5 rounded-xl font-bold text-center bg-red-50 text-red-700 border border-red-200 leading-relaxed';
            } else {
                msg.className =
                    'text-xs p-3.5 rounded-xl font-bold text-center bg-blue-50 text-blue-700 border border-blue-200 leading-relaxed';
            }

            msg.innerText = text;
        }

        function resetAsiaFlow() {
            document.getElementById('asiaPhoneInput').value = '';
            document.getElementById('asiaLoginOtpInput').value = '';
            document.getElementById('selectedAsiaAmountUSD').value = '';
            document.getElementById('asiaTransferOtpInput').value = '';

            document.querySelectorAll('.amount-btn').forEach(btn => {
                btn.classList.remove('selected');
            });

            document.getElementById('asiaStep1')
                .classList.remove('hidden');

            document.getElementById('asiaStep2')
                .classList.add('hidden');

            document.getElementById('asiaStep3')
                .classList.add('hidden');

            document.getElementById('asiaStep4')
                .classList.add('hidden');

            document.getElementById('asiaMsg')
                .classList.add('hidden');
        }

        function backToStep3() {
            document.getElementById('asiaTransferOtpInput').value = '';

            document.getElementById('asiaStep4')
                .classList.add('hidden');

            document.getElementById('asiaStep3')
                .classList.remove('hidden');

            document.getElementById('asiaMsg')
                .classList.add('hidden');
        }

        function selectAsiaAmount(usd) {
            document.getElementById('selectedAsiaAmountUSD').value = usd;

            document.querySelectorAll('.amount-btn').forEach(btn => {
                btn.classList.remove('selected');
            });

            const targetBtn =
                document.getElementById('amtBtn_' + usd);

            if (targetBtn) {
                targetBtn.classList.add('selected');
            }

            showAsiaMessage(
                `تم اختيار شحن ${usd}$ (سيتم تحويل ${usd * 1000} دينار من رصيدك). اضغط "شحن الرصيد الآن" للمتابعة.`,
                'info'
            );
        }

        async function requestAsiaLoginOTP() {
            const phone =
                document.getElementById('asiaPhoneInput').value.trim();

            if (!/^077\d{8}$/.test(phone)) {
                return showAsiaMessage(
                    '⚠️ يرجى إدخال رقم هاتف آسياسيل صحيح مكون من 11 رقماً ويبدأ بـ 077',
                    'error'
                );
            }

            const btn =
                document.getElementById('sendLoginOtpBtn');

            btn.disabled = true;
            btn.innerText = 'جاري إرسال رمز تسجيل الدخول...';

            try {
                const res = await apiFetch('/api/asiacell/send-otp', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ phone })
                });

                const data = await res.json();

                if (data.success) {
                    showAsiaMessage(data.message, 'info');

                    document.getElementById('asiaStep1')
                        .classList.add('hidden');

                    document.getElementById('asiaStep2')
                        .classList.remove('hidden');
                } else {
                    showAsiaMessage(
                        data.message || 'تعذر إرسال رمز الدخول.',
                        'error'
                    );
                }
            } catch (e) {
                showAsiaMessage(
                    'حدث خطأ في الاتصال بالخادم.',
                    'error'
                );
            } finally {
                btn.disabled = false;
                btn.innerText = 'إرسال رمز تسجيل الدخول';
            }
        }

        async function verifyAsiaLoginOTP() {
            const phone =
                document.getElementById('asiaPhoneInput').value.trim();

            const otp =
                document.getElementById('asiaLoginOtpInput').value.trim();

            if (!otp || otp.length < 4) {
                return showAsiaMessage(
                    '⚠️ يرجى إدخال رمز تسجيل الدخول المرسل إلى هاتفك.',
                    'error'
                );
            }

            const btn =
                document.getElementById('verifyLoginOtpBtn');

            btn.disabled = true;
            btn.innerText = 'جاري التحقق من رمز الدخول...';

            try {
                const res = await apiFetch('/api/asiacell/verify-login', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ phone, otp })
                });

                const data = await res.json();

                if (data.success) {
                    showAsiaMessage(data.message, 'success');

                    document.getElementById('asiaStep2')
                        .classList.add('hidden');

                    document.getElementById('asiaStep3')
                        .classList.remove('hidden');
                } else {
                    showAsiaMessage(
                        data.message || 'رمز تسجيل الدخول غير صحيح.',
                        'error'
                    );
                }
            } catch (e) {
                showAsiaMessage(
                    'حدث خطأ أثناء التحقق من الرمز.',
                    'error'
                );
            } finally {
                btn.disabled = false;
                btn.innerText = 'تأكيد رمز الدخول والمتابعة';
            }
        }

        async function initiateAsiaTransfer() {
            const phone =
                document.getElementById('asiaPhoneInput').value.trim();

            const amountUSD = parseInt(
                document.getElementById('selectedAsiaAmountUSD').value
            );

            if (!amountUSD || amountUSD < 1 || amountUSD > 10) {
                return showAsiaMessage(
                    '⚠️ يرجى اختيار المبلغ الذي تريد شحنه أولاً (من 1$ إلى 10$).',
                    'error'
                );
            }

            const btn =
                document.getElementById('initiateTransferBtn');

            btn.disabled = true;
            btn.innerText =
                'جاري فحص الرصيد وطلب رمز تأكيد التحويل...';

            try {
                const res = await apiFetch(
                    '/api/asiacell/initiate-transfer',
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            phone,
                            amountUSD
                        })
                    }
                );

                const data = await res.json();

                if (data.success) {
                    showAsiaMessage(data.message, 'info');

                    document.getElementById('asiaStep3')
                        .classList.add('hidden');

                    document.getElementById('asiaStep4')
                        .classList.remove('hidden');
                } else {
                    showAsiaMessage(data.message, 'error');
                }
            } catch (e) {
                showAsiaMessage(
                    'حدث خطأ في الاتصال أثناء طلب التحويل.',
                    'error'
                );
            } finally {
                btn.disabled = false;
                btn.innerText = 'شحن الرصيد الآن';
            }
        }

        async function confirmAsiaFinalTransfer() {
            if (!currentUser) return promptLogin();

            const session = currentUser;

            const phone =
                document.getElementById('asiaPhoneInput').value.trim();

            const amount =
                document.getElementById('selectedAsiaAmountUSD').value;

            const transferOtp =
                document.getElementById('asiaTransferOtpInput').value.trim();

            if (!transferOtp || transferOtp.length < 4) {
                return showAsiaMessage(
                    '⚠️ يرجى إدخال رمز تأكيد التحويل المرسل من آسياسيل.',
                    'error'
                );
            }

            const btn =
                document.getElementById('confirmFinalOtpBtn');

            btn.disabled = true;
            btn.innerText = 'جاري تأكيد التحويل وإضافة الرصيد...';

            try {
                const res = await apiFetch(
                    '/api/asiacell/confirm-transfer',
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            email: session.email,
                            phone,
                            transferOtp,
                            amount
                        })
                    }
                );

                const data = await res.json();

                if (data.success) {
                    showAsiaMessage(data.message, 'success');

                    session.balance = data.newBalance;

                    document.getElementById('displayBalance')
                        .innerText =
                            '$' + parseFloat(data.newBalance).toFixed(2);

                    setTimeout(() => {
                        resetAsiaFlow();
                    }, 4000);
                } else {
                    showAsiaMessage(data.message, 'error');
                }
            } catch (e) {
                showAsiaMessage(
                    'حدث خطأ أثناء تأكيد التحويل النهائي.',
                    'error'
                );
            } finally {
                btn.disabled = false;
                btn.innerText =
                    'تأكيد التحويل وإضافة الرصيد لحسابي';
            }
        }

        async function handleDepositSubmit(e) {
            e.preventDefault();

            if (!currentUser) return promptLogin();

            const session = currentUser;

            const imageInput =
                document.getElementById('depImageInput');

            if (!imageInput.files[0]) {
                return alert('الرجاء رفع صورة الإيصال.');
            }

            const msgBox =
                document.getElementById('depositSuccessMsg');

            msgBox.className =
                'hidden mt-4 max-w-xl text-xs p-3 rounded-xl font-bold text-center';

            const formData = new FormData();

            formData.append('email', session.email);

            formData.append(
                'gateway',
                document.getElementById('depositGateway').value
            );

            formData.append(
                'amount',
                document.getElementById('depAmountInput').value
            );

            formData.append(
                'receiptImage',
                imageInput.files[0]
            );

            try {
                const res = await apiFetch('/api/deposit/submit', {
                    method: 'POST',
                    body: formData
                });

                const data = await res.json();

                if (data.success) {
                    msgBox.classList.remove('hidden');
                    msgBox.classList.add(
                        'bg-green-50',
                        'text-green-700'
                    );

                    msgBox.innerText =
                        'تم إرسال طلب الشحن بنجاح! بانتظار مراجعة الإدارة عبر التليجرام.';

                    document.getElementById('manualDepositForm')
                        .reset();

                    updateDepositInstructions();
                } else {
                    msgBox.classList.remove('hidden');

                    msgBox.classList.add(
                        'bg-red-50',
                        'text-red-700',
                        'border',
                        'border-red-200'
                    );

                    msgBox.textContent =
                        '⚠️ ' + (data.message || 'تعذر إرسال طلب الشحن.');
                }
            } catch (err) {
                alert('خطأ في الاتصال بالخادم');
            }
        }

        // لوحة المدير
        async function showAdminPanel() {
            if (!currentUser) return promptLogin();

            if (currentUser.role !== 'admin') {
                return alert('ليس لديك صلاحية الإدارة.');
            }

            hideAllSections();

            document.getElementById('admin-section')
                .classList.remove('hidden');

            document.getElementById('pageTitle')
                .innerText = 'لوحة تحكم المدير';

            document.getElementById('adminNavLink').className =
                'flex items-center px-4 py-3 bg-red-50 text-red-600 rounded-xl font-medium transition cursor-pointer';

            refreshUserBalance();

            try {
                const dataRes = await apiFetch('/api/admin/data');
                const data = await dataRes.json();

                const servRes = await apiFetch('/api/services');
                const servData = await servRes.json();

                if (data.success) {
                    document.getElementById('adminUsersCount')
                        .innerText = data.usersCount;

                    document.getElementById('adminTotalSales')
                        .innerText =
                            parseFloat(data.totalSales).toFixed(2);
                }

                if (servData.success) {
                    fetchedServices = servData.services;
                    renderAdminServicesTable(servData.services);
                }
            } catch (err) {}
        }

        function renderAdminServicesTable(services) {
            const servTbody =
                document.getElementById('adminServicesTableBody');

            servTbody.innerHTML = '';

            if (services && services.length > 0) {
                services.forEach(serv => {
                    const baseQ = serv.baseQuantity || 1000;
                    const minQ = serv.minQty || 100;
                    const maxLabel = serv.maxQty
                        ? serv.maxQty
                        : 'مفتوح ∞';

                    servTbody.innerHTML += `
                        <tr class="border-b hover:bg-gray-50">
                            <td class="p-3 font-bold text-primary">
                                ${escapeHTML(serv.category)}
                            </td>
                            <td class="p-3 font-bold text-dark">
                                ${escapeHTML(serv.name)}
                            </td>
                            <td class="p-3 font-bold">
                                ${escapeHTML(baseQ)}
                                مقابل $${parseFloat(serv.price).toFixed(2)}
                            </td>
                            <td class="p-3 text-xs font-bold text-gray-600">
                                أدنى: ${escapeHTML(minQ)}
                                | أقصى: ${escapeHTML(maxLabel)}
                            </td>
                            <td class="p-3 space-x-2 space-x-reverse">
                                <button type="button"
                                        data-service-action="edit"
                                        data-service-id="${escapeHTML(serv.id)}"
                                        class="bg-amber-500 hover:bg-amber-600 text-white px-3 py-1 rounded-lg text-xs font-bold transition">
                                    تعديل
                                </button>
                                <button type="button"
                                        data-service-action="delete"
                                        data-service-id="${escapeHTML(serv.id)}"
                                        class="bg-red-500 hover:bg-red-600 text-white px-3 py-1 rounded-lg text-xs font-bold transition">
                                    حذف
                                </button>
                            </td>
                        </tr>
                    `;
                });
            } else {
                servTbody.innerHTML = `
                    <tr>
                        <td colspan="5" class="text-center p-4 text-gray-400">
                            لا توجد خدمات مضافة بعد.
                        </td>
                    </tr>
                `;
            }
        }

        document.getElementById('adminServicesTableBody')
            .addEventListener('click', event => {
                const button = event.target.closest(
                    'button[data-service-action]'
                );

                if (
                    !button ||
                    currentUser?.role !== 'admin'
                ) {
                    return;
                }

                const id = button.dataset.serviceId;

                if (button.dataset.serviceAction === 'edit') {
                    editServiceById(id);
                }

                if (button.dataset.serviceAction === 'delete') {
                    deleteService(id);
                }
            });

        function editServiceById(id) {
            const serv = fetchedServices.find(s => s.id === id);

            if (!serv) return;

            document.getElementById('editServiceId').value = serv.id;
            document.getElementById('servCategory').value =
                serv.category || '';
            document.getElementById('servName').value =
                serv.name || '';
            document.getElementById('servBaseQty').value =
                serv.baseQuantity || 1000;
            document.getElementById('servPrice').value =
                serv.price || '';
            document.getElementById('servMinQty').value =
                serv.minQty || 100;
            document.getElementById('servMaxQty').value =
                serv.maxQty ? serv.maxQty : '';
            document.getElementById('servDescription').value =
                serv.description || '';

            document.getElementById('adminFormTitle').innerHTML = `
                <i class="fa-solid fa-pen-to-square text-amber-500 me-2"></i>
                تعديل الخدمة الحالية
            `;

            const saveBtn =
                document.getElementById('saveServiceBtn');

            saveBtn.innerText = 'حفظ التعديلات';

            saveBtn.className =
                'bg-amber-500 hover:bg-amber-600 text-white font-bold py-2.5 px-6 rounded-xl text-sm transition';

            document.getElementById('cancelEditBtn')
                .classList.remove('hidden');

            document.getElementById('addServiceForm')
                .scrollIntoView({ behavior: 'smooth' });
        }

        function resetServiceForm() {
            document.getElementById('addServiceForm').reset();

            document.getElementById('editServiceId').value = '';
            document.getElementById('servBaseQty').value = 1000;
            document.getElementById('servMinQty').value = 100;
            document.getElementById('servMaxQty').value = '';

            document.getElementById('adminFormTitle').innerHTML = `
                <i class="fa-solid fa-plus-circle text-primary me-2"></i>
                إضافة خدمة جديدة للنظام
            `;

            const saveBtn =
                document.getElementById('saveServiceBtn');

            saveBtn.innerText = 'إضافة الخدمة للنظام';

            saveBtn.className =
                'bg-primary hover:bg-[#531423] text-white font-bold py-2.5 px-6 rounded-xl text-sm transition';

            document.getElementById('cancelEditBtn')
                .classList.add('hidden');
        }

        async function deleteService(id) {
            if (!confirm('هل أنت متأكد من رغبتك في حذف هذه الخدمة؟')) {
                return;
            }

            try {
                const res = await apiFetch('/api/admin/delete-service', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ id })
                });

                const data = await res.json();

                if (data.success) {
                    showAdminPanel();
                } else {
                    alert(data.message || 'تعذر حذف الخدمة.');
                }
            } catch (err) {
                alert('خطأ في الاتصال بالخادم.');
            }
        }

        document.getElementById('addServiceForm')
            .addEventListener('submit', async function(e) {
                e.preventDefault();

                const editId =
                    document.getElementById('editServiceId').value;

                const saveBtn =
                    document.getElementById('saveServiceBtn');

                const msgBox =
                    document.getElementById('adminServiceMsg');

                msgBox.classList.add('hidden');

                const rawMax =
                    document.getElementById('servMaxQty').value.trim();

                const payload = {
                    category:
                        document.getElementById('servCategory').value.trim(),
                    name:
                        document.getElementById('servName').value.trim(),
                    baseQuantity:
                        parseInt(document.getElementById('servBaseQty').value) || 1000,
                    price:
                        parseFloat(document.getElementById('servPrice').value),
                    minQty:
                        parseInt(document.getElementById('servMinQty').value) || 100,
                    maxQty:
                        rawMax !== '' ? parseInt(rawMax) : null,
                    description:
                        document.getElementById('servDescription').value.trim()
                };

                if (editId) {
                    payload.id = editId;
                }

                const endpoint = editId
                    ? '/api/admin/update-service'
                    : '/api/admin/add-service';

                saveBtn.disabled = true;
                saveBtn.innerText = 'جاري الحفظ...';

                try {
                    const res = await apiFetch(endpoint, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(payload)
                    });

                    const data = await res.json();

                    if (data.success) {
                        resetServiceForm();

                        msgBox.classList.remove('hidden');

                        msgBox.className =
                            'text-xs p-3 rounded-xl font-bold text-center bg-green-50 text-green-700 border border-green-200';

                        msgBox.innerText =
                            data.message || 'تم حفظ الخدمة بنجاح!';

                        setTimeout(() => {
                            msgBox.classList.add('hidden');
                        }, 3000);

                        await showAdminPanel();
                    } else {
                        msgBox.classList.remove('hidden');

                        msgBox.className =
                            'text-xs p-3 rounded-xl font-bold text-center bg-red-50 text-red-700 border border-red-200';

                        msgBox.innerText =
                            data.message || 'حدث خطأ أثناء حفظ الخدمة.';
                    }
                } catch (err) {
                    alert('خطأ في الاتصال بالخادم أثناء حفظ الخدمة.');
                } finally {
                    saveBtn.disabled = false;

                    saveBtn.innerText =
                        document.getElementById('editServiceId').value
                            ? 'حفظ التعديلات'
                            : 'إضافة الخدمة للنظام';
                }
            });

        window.addEventListener('DOMContentLoaded', () => {
            restoreSession();
        });

        document.getElementById('orderForm')
            .addEventListener('submit', async function(e) {
                e.preventDefault();

                if (!currentUser) return promptLogin();

                const session = currentUser;

                const okMsg =
                    document.getElementById('successOrderMsg');

                const errMsg =
                    document.getElementById('errorOrderMsg');

                const submitBtn =
                    document.getElementById('submitOrderBtn');

                okMsg.classList.add('hidden');
                errMsg.classList.add('hidden');

                const targetServ = fetchedServices.find(
                    s => s.id ==
                        document.getElementById('serviceSelect').value
                );

                if (!targetServ) {
                    return alert('اختر الخدمة أولاً.');
                }

                const quantity = parseInt(
                    document.getElementById('quantity').value
                );

                const minQ = targetServ.minQty || 100;
                const maxQ = targetServ.maxQty || null;

                if (isNaN(quantity) || quantity < minQ) {
                    errMsg.innerText =
                        `⚠️ الحد الأدنى للطلب هو ${minQ}.`;

                    errMsg.classList.remove('hidden');
                    return;
                }

                if (maxQ !== null && quantity > maxQ) {
                    errMsg.innerText =
                        `⚠️ الحد الأقصى للطلب هو ${maxQ}.`;

                    errMsg.classList.remove('hidden');
                    return;
                }

                const link =
                    document.getElementById('orderLink').value.trim();

                const charge = parseFloat(
                    document.getElementById('charge').value
                );

                if (session.balance < charge) {
                    errMsg.innerText =
                        '⚠️ رصيدك غير كافٍ لإتمام هذا الطلب.';

                    errMsg.classList.remove('hidden');
                    return;
                }

                submitBtn.disabled = true;
                submitBtn.innerText =
                    'جاري فحص رابط انستقرام وإنشاء الطلب...';

                try {
                    const res = await apiFetch('/api/order', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            username: session.username,
                            serviceId: targetServ.id,
                            link,
                            quantity
                        })
                    });

                    const data = await res.json();

                    if (data.success) {
                        session.balance = data.newBalance;

                        document.getElementById('displayBalance')
                            .innerText =
                                '$' + data.newBalance.toFixed(2);

                        okMsg.innerText =
                            `✅ تم إنشاء الطلب #${data.orderId.substring(0, 6)} بنجاح! عدد حسابك هو ${data.startCount}/${data.currentCount} (يكتمل عند: ${data.targetCount})`;

                        okMsg.classList.remove('hidden');

                        this.reset();

                        document.getElementById('igPreviewBox')
                            .classList.add('hidden');

                        document.getElementById('serviceSelectContainer')
                            .classList.add('hidden');

                        document.getElementById('serviceDescriptionBox')
                            .classList.add('hidden');

                        document.getElementById('orderDetailsContainer')
                            .classList.add('hidden');

                        document.getElementById('charge').value = '';
                    } else {
                        errMsg.innerText =
                            data.message || 'تعذر إنشاء الطلب.';

                        errMsg.classList.remove('hidden');
                    }
                } catch (err) {
                    errMsg.innerText =
                        'حدث خطأ في الاتصال بالخادم.';

                    errMsg.classList.remove('hidden');
                } finally {
                    submitBtn.disabled = false;
                    submitBtn.innerText =
                        'فحص الحساب وتأكيد الطلب';
                }
            });

        document.getElementById('registerForm')
            .addEventListener('submit', async e => {
                e.preventDefault();

                const errorBox =
                    document.getElementById('registerError');

                errorBox.classList.add('hidden');

                try {
                    const res = await apiFetch('/api/register', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            username:
                                document.getElementById('regUsername').value,
                            email:
                                document.getElementById('regEmail').value,
                            password:
                                document.getElementById('regPassword').value
                        })
                    });

                    const data = await res.json();

                    if (data.success) {
                        if (!await restoreSession(true)) return;

                        document.getElementById('registerForm').reset();
                    } else {
                        errorBox.innerText = data.message;
                        errorBox.classList.remove('hidden');
                    }
                } catch (err) {
                    errorBox.textContent =
                        'تعذر الاتصال بالخادم. حاول مجدداً.';

                    errorBox.classList.remove('hidden');
                }
            });

        document.getElementById('loginForm')
            .addEventListener('submit', async e => {
                e.preventDefault();

                const errorBox =
                    document.getElementById('loginError');

                errorBox.classList.add('hidden');

                try {
                    const res = await apiFetch('/api/login', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            email:
                                document.getElementById('loginEmail').value,
                            password:
                                document.getElementById('loginPassword').value
                        })
                    });

                    const data = await res.json();

                    if (data.success) {
                        if (!await restoreSession(true)) return;

                        document.getElementById('loginForm').reset();
                    } else {
                        errorBox.innerText = data.message;
                        errorBox.classList.remove('hidden');
                    }
                } catch (err) {
                    errorBox.textContent =
                        'تعذر الاتصال بالخادم. حاول مجدداً.';

                    errorBox.classList.remove('hidden');
                }
            });
    

// CSP-compatible event bindings
document.querySelector('[data-csp-bind="csp-1"]').addEventListener('click', function(event) { openModal('loginModal'); });
document.querySelector('[data-csp-bind="csp-2"]').addEventListener('click', function(event) { openModal('registerModal'); });
document.querySelector('[data-csp-bind="csp-3"]').addEventListener('click', function(event) { openModal('registerModal'); });
document.querySelector('[data-csp-bind="csp-4"]').addEventListener('click', function(event) { showNewOrderPage(); });
document.querySelector('[data-csp-bind="csp-5"]').addEventListener('click', function(event) { showOrdersPage(); });
document.querySelector('[data-csp-bind="csp-6"]').addEventListener('click', function(event) { showDepositPage(); });
document.querySelector('[data-csp-bind="csp-7"]').addEventListener('click', function(event) { showAdminPanel(); });
document.querySelector('[data-csp-bind="csp-8"]').addEventListener('change', function(event) { onCategoryChange(); });
document.querySelector('[data-csp-bind="csp-9"]').addEventListener('change', function(event) { onServiceChange(); });
document.querySelector('[data-csp-bind="csp-10"]').addEventListener('click', function(event) { previewInstagramAccount(); });
document.querySelector('[data-csp-bind="csp-11"]').addEventListener('input', function(event) { calculatePrice(); });
document.querySelector('[data-csp-bind="csp-12"]').addEventListener('change', function(event) { toggleDepositMode(); });
document.querySelector('[data-csp-bind="csp-13"]').addEventListener('click', function(event) { requestAsiaLoginOTP(); });
document.querySelector('[data-csp-bind="csp-14"]').addEventListener('click', function(event) { verifyAsiaLoginOTP(); });
document.querySelector('[data-csp-bind="csp-15"]').addEventListener('click', function(event) { resetAsiaFlow(); });
document.querySelector('[data-csp-bind="csp-16"]').addEventListener('click', function(event) { selectAsiaAmount(1); });
document.querySelector('[data-csp-bind="csp-17"]').addEventListener('click', function(event) { selectAsiaAmount(2); });
document.querySelector('[data-csp-bind="csp-18"]').addEventListener('click', function(event) { selectAsiaAmount(3); });
document.querySelector('[data-csp-bind="csp-19"]').addEventListener('click', function(event) { selectAsiaAmount(4); });
document.querySelector('[data-csp-bind="csp-20"]').addEventListener('click', function(event) { selectAsiaAmount(5); });
document.querySelector('[data-csp-bind="csp-21"]').addEventListener('click', function(event) { selectAsiaAmount(6); });
document.querySelector('[data-csp-bind="csp-22"]').addEventListener('click', function(event) { selectAsiaAmount(7); });
document.querySelector('[data-csp-bind="csp-23"]').addEventListener('click', function(event) { selectAsiaAmount(8); });
document.querySelector('[data-csp-bind="csp-24"]').addEventListener('click', function(event) { selectAsiaAmount(9); });
document.querySelector('[data-csp-bind="csp-25"]').addEventListener('click', function(event) { selectAsiaAmount(10); });
document.querySelector('[data-csp-bind="csp-26"]').addEventListener('click', function(event) { initiateAsiaTransfer(); });
document.querySelector('[data-csp-bind="csp-27"]').addEventListener('click', function(event) { confirmAsiaFinalTransfer(); });
document.querySelector('[data-csp-bind="csp-28"]').addEventListener('click', function(event) { backToStep3(); });
document.querySelector('[data-csp-bind="csp-29"]').addEventListener('submit', function(event) { handleDepositSubmit(event); });
document.querySelector('[data-csp-bind="csp-30"]').addEventListener('click', function(event) { resetServiceForm(); });
document.querySelector('[data-csp-bind="csp-31"]').addEventListener('click', function(event) { closeModal('registerModal'); });
document.querySelector('[data-csp-bind="csp-32"]').addEventListener('click', function(event) { closeModal('loginModal'); });
