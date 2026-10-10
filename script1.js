
        (function () {
        'use strict';

        var API = '';
        var STORAGE_SESSION = 'hot_session';
        var STORAGE_ACCOUNTS = 'hot_accounts';
        var MAX_AVATAR_SIZE = 10 * 1024 * 1024;
        var AVATAR_DIMENSION = 200;
        var MAX_POST_IMAGE_SIZE = 10 * 1024 * 1024;
        var POST_IMAGE_MAX_DIM = 1280;
        var ONLINE_THRESHOLD = 35000;
        var SYSTEM_USERNAME = 'HOT';

        var currentUser = null;
        var currentToken = null;
        var pendingAvatar = null;
        var pendingWallpaper = null;
        var wallViewingUsername = null;
        var currentTab = 'all';
        var dmPartner = null;
        var dmPollTimer = null;
        var dmLastMessageId = null;
        var dmBlocked = false;
        var dmBlockedByMe = false;
        var dmStatusInterval = null;
        var chatStatusInterval = null;
        var viewingUserForMenu = null;
        var heartbeatTimer = null;

        function getSession() { return localStorage.getItem(STORAGE_SESSION); }
        function setSession(token) {
            currentToken = token;
            if (token) localStorage.setItem(STORAGE_SESSION, token);
            else localStorage.removeItem(STORAGE_SESSION);
        }
        function clearSession() { currentToken = null; localStorage.removeItem(STORAGE_SESSION); }

        function getSavedAccounts() {
            try { return JSON.parse(localStorage.getItem(STORAGE_ACCOUNTS) || '[]'); }
            catch (e) { return []; }
        }
        function saveAccount(acc) {
            if (!acc || !acc.username || !acc.token) return;
            var list = getSavedAccounts();
            var idx = list.findIndex(function (x) { return x.username.toLowerCase() === acc.username.toLowerCase(); });
            var entry = { username: acc.username, avatar: acc.avatar || '', handle: acc.handle || '', token: acc.token };
            if (idx === -1) list.push(entry); else list[idx] = entry;
            if (list.length > 5) list = list.slice(-5);
            localStorage.setItem(STORAGE_ACCOUNTS, JSON.stringify(list));
        }
        function removeSavedAccount(username) {
            var list = getSavedAccounts().filter(function (x) { return x.username.toLowerCase() !== username.toLowerCase(); });
            localStorage.setItem(STORAGE_ACCOUNTS, JSON.stringify(list));
        }

        function apiHeaders() {
            var h = { 'Content-Type': 'application/json' };
            if (currentToken) h['Authorization'] = 'Bearer ' + currentToken;
            return h;
        }
        function apiGet(path) {
            return fetch(API + path, { headers: apiHeaders() }).then(function (res) {
                return res.json().then(function (json) {
                    if (!res.ok) throw new Error(json.error || 'Ошибка');
                    return json;
                });
            });
        }
        function apiPost(path, data) {
            return fetch(API + path, { method: 'POST', headers: apiHeaders(), body: JSON.stringify(data) })
                .then(function (res) { return res.json().then(function (json) { if (!res.ok) throw new Error(json.error || 'Ошибка'); return json; }); });
        }

        function getInitial(n) { return n ? n.charAt(0).toUpperCase() : '?'; }
        function escapeHtml(s) {
            return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
                return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
            });
        }
        function phoneIconSvg(size) {
            var n = size || 20;
            return '<svg class="phone-icon" width="' + n + '" height="' + n + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>';
        }
        function avatarHTML(u) {
            if (u && u.avatar) return '<img src="' + escapeHtml(u.avatar) + '" alt="">';
            return getInitial(u ? (u.username || u.name) : '');
        }
        function isSystemName(name) {
            if (!name) return false;
            return String(name).toUpperCase() === SYSTEM_USERNAME;
        }
        function formatTime(iso) {
            var d = new Date(iso);
            if (isNaN(d.getTime())) return '';
            var now = new Date();
            if (d.toDateString() === now.toDateString()) {
                return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
            }
            var yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
            if (d.toDateString() === yesterday.toDateString()) return 'вчера';
            return ('0' + d.getDate()).slice(-2) + '.' + ('0' + (d.getMonth() + 1)).slice(-2);
        }
        function formatLastSeen(iso) {
            if (!iso) return 'был(а) недавно';
            var d = new Date(iso);
            if (isNaN(d.getTime())) return 'был(а) недавно';
            var diff = Date.now() - d.getTime();
            if (diff < ONLINE_THRESHOLD) return 'в сети';
            var now = new Date();
            var timeStr = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
            if (d.toDateString() === now.toDateString()) return 'был(а) в ' + timeStr;
            var yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
            if (d.toDateString() === yesterday.toDateString()) return 'был(а) вчера в ' + timeStr;
            return 'был(а) ' + ('0' + d.getDate()).slice(-2) + '.' + ('0' + (d.getMonth() + 1)).slice(-2) + ' в ' + timeStr;
        }
        function isOnline(iso) {
            if (!iso) return false;
            return (Date.now() - new Date(iso).getTime()) < ONLINE_THRESHOLD;
        }

        var currentLang = localStorage.getItem('hot_lang') || 'ru';
        var I18N = {
            ru: { postPlaceholder:"Что нового?", addPic:"Добавить картинку", publish:"Опубликовать", send:"Отправить", deleteAction:"Удалить", noPosts:"Пока нет постов", noFriends:"Пока нет друзей", addFriend:"Добавить в друзья", removeFriend:"Удалить из друзей", reqSent:"Заявка отправлена", accept:"Принять", decline:"Отклонить", writeMsg:"Написать сообщение", noChats:"Пока нет сообщений", selectChat:"Выберите чат", selectChatDesc:"Начните общение, выбрав диалог слева" },
            en: { postPlaceholder:"What's new?", addPic:"Add photo", publish:"Publish", send:"Send", deleteAction:"Delete", noPosts:"No posts yet", noFriends:"No friends yet", addFriend:"Add Friend", removeFriend:"Remove Friend", reqSent:"Request Sent", accept:"Accept", decline:"Decline", writeMsg:"Message", noChats:"No messages yet", selectChat:"Select a chat", selectChatDesc:"Start a conversation by choosing a dialog on the left" }
        };
        function t(k) { return I18N[currentLang][k] || I18N.ru[k] || k; }

        var pageAuth = document.getElementById('page-auth');
        var appEl = document.getElementById('app');
        var contentEl = document.getElementById('content');
        var contentInner = document.getElementById('content-inner');
        var chatlistEl = document.getElementById('chatlist');
        var chatlistBody = document.getElementById('chatlist-body');
        var infoPanel = document.getElementById('info-panel');
        var mobileAppHeader = document.getElementById('mobile-app-header');
        var mobileBottomNav = document.getElementById('mobile-bottom-nav');
        var mobileSearchPanel = document.getElementById('mobile-search-panel');
        var mobileSearchInput = document.getElementById('mobile-search-input');
        var mobileSearchResults = document.getElementById('mobile-search-results');
        var mobileCreateSheet = document.getElementById('mobile-create-sheet');
        var sidebarUserAvatar = document.getElementById('sidebar-user-avatar');
        var sidebarUserName = document.getElementById('sidebar-user-name');

        var form = document.getElementById('register-form');
        var authTitle = document.getElementById('auth-title');
        var authDescription = document.getElementById('auth-description');
        var submitBtn = document.getElementById('submit-btn');
        var usernameInput = document.getElementById('username');
        var emailInput = document.getElementById('email');
        var passwordInput = document.getElementById('password');
        var password2Input = document.getElementById('password2');
        var password2Wrapper = document.getElementById('password2-wrapper');
        var errorEl = document.getElementById('error');
        var switchLine = document.getElementById('switch-line');
        var orDivider = document.getElementById('or-divider');
        var socialBlock = document.getElementById('social-block');
        var googleAuthBtn = document.getElementById('google-auth-btn');
        var GOOGLE_CLIENT_ID = '240353019911-kqidnu791scvkfq4f93sdoull23eonnk.apps.googleusercontent.com';
        var mode = 'register';

        var confirmDeleteModal = document.getElementById('confirm-delete-modal');
        var confirmDeleteText = document.getElementById('confirm-delete-text');
        var forwardModal = document.getElementById('forward-modal');
        var forwardModalClose = document.getElementById('forward-modal-close');
        var forwardPreview = document.getElementById('forward-preview');
        var forwardModalList = document.getElementById('forward-modal-list');
        var logoutConfirmModal = document.getElementById('logout-confirm-modal');
        var channelModal = document.getElementById('channel-modal');
        var chatModal = document.getElementById('chat-modal');
        var profileMenuModal = document.getElementById('profile-menu-modal');
        var accountsModal = document.getElementById('accounts-modal');
        var accountsList = document.getElementById('accounts-list');

        var pressedMessage = null;
        var pressTimer = null;
        var contextMenuEl = null;
        var longPressDuration = 500;
        var activeReplyTarget = null;
        var dmPinnedMessageId = null;

        function applyTheme(theme) {
            if (theme === 'light') document.body.classList.add('light');
            else document.body.classList.remove('light');
            localStorage.setItem('hot_theme', theme || 'dark');
        }
        (function initThemeEarly() {
            var saved = localStorage.getItem('hot_theme') || 'dark';
            if (saved === 'light') document.body.classList.add('light');
        })();

        function clearChatElements() {
            document.body.classList.remove('m-list', 'm-chat');
            var oldHeader = contentEl.querySelector('.chat-header');
            if (oldHeader) oldHeader.remove();
            var oldInput = contentEl.querySelector('.chat-input-area');
            if (oldInput) oldInput.remove();
            var oldBanner = document.getElementById('dm-blocked-banner');
            if (oldBanner) oldBanner.remove();
            var oldSystemNote = document.getElementById('dm-system-note');
            if (oldSystemNote) oldSystemNote.remove();
            var oldPicker = document.getElementById('emoji-picker');
            if (oldPicker) oldPicker.remove();
            if (chatStatusInterval) { clearInterval(chatStatusInterval); chatStatusInterval = null; }
            if (dmStatusInterval) { clearInterval(dmStatusInterval); dmStatusInterval = null; }
            stopDmPolling();
        }

        function setMode(m) {
            mode = m;
            errorEl.textContent = '';
            errorEl.classList.remove('visible');
            form.reset();
            var consentRowEl = document.getElementById('consent-row');
            if (consentRowEl) consentRowEl.style.display = (m === 'register') ? '' : 'none';
            if (m === 'register') {
                authTitle.textContent = 'Регистрация';
                authDescription.textContent = 'Создай аккаунт и начни общаться';
                submitBtn.textContent = 'Создать аккаунт →';
                usernameInput.style.display = '';
                emailInput.placeholder = 'Почта';
                password2Wrapper.style.display = '';
                orDivider.style.display = '';
                socialBlock.style.display = '';
                switchLine.innerHTML = 'Уже есть аккаунт? <a id="switch-mode">Войти</a>';
            } else {
                authTitle.textContent = 'Вход';
                authDescription.textContent = 'Войди в свой аккаунт';
                submitBtn.textContent = 'Войти →';
                usernameInput.style.display = 'none';
                emailInput.placeholder = 'Имя или почта';
                password2Wrapper.style.display = 'none';
                orDivider.style.display = 'none';
                socialBlock.style.display = 'none';
                switchLine.innerHTML = 'Нет аккаунта? <a id="switch-mode">Зарегистрироваться</a>';
            }
            var sw = document.getElementById('switch-mode');
            if (sw) sw.addEventListener('click', function () { setMode(mode === 'register' ? 'login' : 'register'); });
        }

        function showApp() {
            pageAuth.classList.remove('active');
            pageAuth.style.display = 'none';
            appEl.style.display = 'flex';
            appEl.classList.remove('hidden');
            if (window.innerWidth <= 900) {
                mobileAppHeader.classList.remove('hidden');
                mobileBottomNav.classList.remove('hidden');
            }
            startHeartbeat();
            refreshAdminNav();
        }
        function showAuth() {
            pageAuth.classList.add('active');
            pageAuth.style.display = 'flex';
            appEl.style.display = 'none';
            appEl.classList.add('hidden');
            mobileAppHeader.classList.add('hidden');
            mobileBottomNav.classList.add('hidden');
            stopHeartbeat();
        }
        function startHeartbeat() {
            stopHeartbeat();
            function beat() { if (!currentToken) return; apiPost('/api/user/heartbeat', {}).catch(function(){}); }
            beat();
            heartbeatTimer = setInterval(beat, 25000);
        }
        function stopHeartbeat() { if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; } }

        function updateSidebarUser(u) {
            if (!u) return;
            sidebarUserAvatar.innerHTML = avatarHTML(u);
            sidebarUserName.textContent = userDisplayName(u);
            var mha = document.getElementById('mobile-header-avatar');
            if (mha) mha.innerHTML = avatarHTML(u);
        }
        function updateBadges() {
            if (!currentUser) return;
            apiGet('/api/dm/unread-count').then(function (data) {
                var count = data.count || 0;
                var badges = [document.getElementById('nav-messages-badge'), document.getElementById('mobile-bottom-messages-badge')];
                badges.forEach(function(b) {
                    if (!b) return;
                    if (count > 0) { b.textContent = count > 99 ? '99+' : String(count); b.classList.remove('hidden'); }
                    else b.classList.add('hidden');
                });
            }).catch(function(){});
            apiGet('/api/friends').then(function (res) {
                var reqCount = (res.requests || []).length;
                window.__friendReqCount = reqCount;
                var mpb = document.getElementById('mobile-bottom-people-badge');
                if (mpb) { if (reqCount > 0) { mpb.textContent = reqCount > 99 ? '99+' : String(reqCount); mpb.classList.remove('hidden'); } else mpb.classList.add('hidden'); }
                var pfb = document.getElementById('people-friends-badge');
                if (pfb) { pfb.textContent = String(reqCount); pfb.classList.toggle('hidden', reqCount <= 0); }
                var mfb = document.getElementById('mobile-bottom-friends-badge');
                if (mfb) { if (reqCount > 0) { mfb.textContent = reqCount > 99 ? '99+' : String(reqCount); mfb.classList.remove('hidden'); } else mfb.classList.add('hidden'); }
                var badge = document.getElementById('nav-friends-badge');
                if (badge) {
                    if (reqCount > 0) { badge.textContent = reqCount > 99 ? '99+' : String(reqCount); badge.classList.remove('hidden'); }
                    else badge.classList.add('hidden');
                }
            }).catch(function(){});
        }

        function roleDisplayName(role,name){
            if(role==='founder') return '★ Основатель | '+name;
            if(role==='admin') return '🛡 Администратор | '+name;
            if(role==='moderator') return '🔨 Модератор | '+name;
            return name||'';
        }
        function userDisplayName(u) {
            if (!u) return '';
            var name = typeof u === 'string' ? u : (u.username || u.name || '');
            if(typeof u !== 'string' && u.displayName) return u.displayName;
            if (String(name).toLowerCase() === 'dev') return '★ Основатель | Dev';
            if(typeof u !== 'string' && u.adminRole) return roleDisplayName(u.adminRole,name);
            if(currentUser && String(currentUser.username||'').toLowerCase()===String(name).toLowerCase() && currentUser.adminRole) return roleDisplayName(currentUser.adminRole,name);
            return name;
        }
        function messageDisplayName(m){ return m&&m.fromDisplay ? m.fromDisplay : displayUserName(m&&m.from||''); }
        function displayUserName(name) {
            if(name && typeof name==='object') return userDisplayName(name);
            if (name && String(name).toLowerCase() === 'dev') return '★ Основатель | Dev';
            if(currentUser && String(currentUser.username||'').toLowerCase()===String(name||'').toLowerCase() && currentUser.adminRole) return roleDisplayName(currentUser.adminRole,name);
            return name || '';
        }
        function refreshAdminNav() {
            var n=document.getElementById('nav-admin');
            var role=currentUser&&currentUser.adminRole;
            if(n){
                n.classList.toggle('hidden', !role);
                var label=n.querySelector('.nav-label'); if(label) label.textContent=role==='founder'?'Админ меню':role==='admin'?'Админ меню':'Меню модератора';
                var icon=n.querySelector('.nav-icon'); if(icon) icon.textContent=role==='founder'?'👑':role==='admin'?'🛡️':'🔨';
            }
        }
        var adminUsersCache=[], adminSelectedUser=null, adminChannelsCache=[], adminChatsCache=[], adminSection='people', adminCommunityTab='channels', adminSelectedCommunity=null;
        function adminReload(){
            return apiGet('/api/admin/panel').then(function(d){
                adminUsersCache=d.users||[]; adminChannelsCache=d.channels||[]; adminChatsCache=d.chats||[]; renderAdmin();
            });
        }
        function openAdmin(){
            if(!currentUser || !currentUser.adminRole) return;
            setActiveNav('nav-admin'); clearChatElements();
            if(chatlistEl)chatlistEl.classList.add('hidden'); if(infoPanel)infoPanel.classList.remove('visible');
            contentEl.style.display='flex';
            contentInner.innerHTML='<div class="admin-page material-admin"><div class="admin-head"><div class="admin-title"><h1>'+ (currentUser.adminRole==='moderator'?'🔨 Меню модератора':currentUser.adminRole==='admin'?'🛡 Админ меню':'👑 Админ меню') +'</h1><p>Центр управления Hot</p></div><div class="admin-role">'+escapeHtml(roleDisplayName(currentUser.adminRole,currentUser.username))+'</div></div><div id="admin-body"><div class="admin-empty">Загрузка...</div></div></div>';
            adminSelectedUser=null; adminSelectedCommunity=null; adminSection='people'; adminCommunityTab='channels'; adminReload().catch(function(e){var b=document.getElementById('admin-body');if(b)b.innerHTML='<div class="admin-empty">'+escapeHtml(e.message)+'</div>';});
        }
        function renderAdmin(){
            var body=document.getElementById('admin-body'); if(!body)return;
            var html='<div class="admin-tabs"><button class="admin-tab '+(adminSection==='people'?'active':'')+'" data-admin-section="people">Люди</button><button class="admin-tab '+(adminSection==='communities'?'active':'')+'" data-admin-section="communities">Каналы / чаты</button></div>';
            if(adminSection==='people') html+=renderAdminPeople(); else html+=renderAdminCommunities();
            body.innerHTML=html;
            body.querySelectorAll('[data-admin-section]').forEach(function(x){x.addEventListener('click',function(){adminSection=x.getAttribute('data-admin-section');adminSelectedUser=null;adminSelectedCommunity=null;renderAdmin();});});
            body.querySelectorAll('[data-admin-user]').forEach(function(x){x.addEventListener('click',function(){adminSelectedUser=x.getAttribute('data-admin-user');renderAdmin();});});
            body.querySelectorAll('[data-admin-action]').forEach(function(x){x.addEventListener('click',function(e){e.stopPropagation();adminAction(x.getAttribute('data-admin-action'),x.getAttribute('data-admin-user')||'');});});
            body.querySelectorAll('[data-community-tab]').forEach(function(x){x.addEventListener('click',function(){adminCommunityTab=x.getAttribute('data-community-tab');adminSelectedCommunity=null;renderAdmin();});});
            body.querySelectorAll('[data-community-item]').forEach(function(x){x.addEventListener('click',function(){adminSelectedCommunity=x.getAttribute('data-community-item');renderAdmin();});});
            body.querySelectorAll('[data-community-action]').forEach(function(x){x.addEventListener('click',function(e){e.stopPropagation();adminCommunityAction(x.getAttribute('data-community-action'));});});
            var amc=document.getElementById('admin-message-close'); if(amc)amc.onclick=closeAdminMessageModal;
            var amb=document.getElementById('admin-message-cancel'); if(amb)amb.onclick=closeAdminMessageModal;
            var ams=document.getElementById('admin-message-send'); if(ams)ams.onclick=sendAdminMessage;
        }
        function renderAdminPeople(){
            var q=(document.getElementById('admin-search')||{}).value||'';
            var list=adminUsersCache.filter(function(u){return !q||String(u.username||'').toLowerCase().indexOf(q.toLowerCase())!==-1;});
            var role=currentUser&&currentUser.adminRole;
            var html='<div class="admin-stats"><div><span>Люди</span><b>'+adminUsersCache.length+'</b></div><div><span>Мут</span><b>'+adminUsersCache.filter(function(u){return u.muted;}).length+'</b></div><div><span>Бан</span><b>'+adminUsersCache.filter(function(u){return u.banned;}).length+'</b></div></div>';
            html+='<input class="input admin-search" id="admin-search" placeholder="Поиск человека" value="'+escapeHtml(q)+'"><div class="admin-users">';
            if(!list.length)html+='<div class="admin-empty">Люди не найдены</div>';
            list.forEach(function(u){var dev=String(u.username).toLowerCase()==='dev',name=dev?'★ Основатель | Dev':(u.displayName||u.username),av=u.avatar?'<img src="'+escapeHtml(u.avatar)+'">':escapeHtml(getInitial(u.username));html+='<div class="admin-user-row '+(adminSelectedUser===u.username?'selected':'')+'" data-admin-user="'+escapeHtml(u.username)+'"><div class="admin-user-avatar">'+av+'</div><div class="admin-user-info"><div class="admin-user-name">'+escapeHtml(name)+'</div><div class="admin-user-meta">'+escapeHtml(u.email||'')+(u.banned?' · бан':'')+(u.muted?' · мут':'')+'</div></div><div class="admin-chevron">›</div></div>';});
            html+='</div>';
            if(adminSelectedUser){var sel=adminUsersCache.find(function(u){return u.username.toLowerCase()===adminSelectedUser.toLowerCase();});if(sel){var dev=String(sel.username).toLowerCase()==='dev';html+='<div class="admin-detail"><div class="admin-detail-title">'+escapeHtml(sel.displayName||sel.username)+'</div><div class="admin-detail-sub">'+escapeHtml(sel.email||'')+'</div><div class="admin-actions">';if(!dev){if(role==='founder'||role==='admin'||role==='moderator')html+='<button class="admin-action" data-admin-action="mute" data-admin-user="'+escapeHtml(sel.username)+'">🔇 '+(sel.muted?'Снять мут':'Выдать мут')+'</button>';if(role==='founder')html+='<button class="admin-action" data-admin-action="kick" data-admin-user="'+escapeHtml(sel.username)+'">🚪 Кикнуть устройства</button><button class="admin-action" data-admin-action="ban" data-admin-user="'+escapeHtml(sel.username)+'">⛔ Забанить</button><button class="admin-action" data-admin-action="delete" data-admin-user="'+escapeHtml(sel.username)+'"><svg class="hot-ui-icon" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg> Удалить аккаунт</button><button class="admin-action" data-admin-action="role" data-admin-user="'+escapeHtml(sel.username)+'">👑 Выдать админку</button>';else if(role==='admin') html+='<button class="admin-action" disabled>🛡 Права администратора</button>';else html+='<button class="admin-action" disabled>🔨 Режим модератора</button>';}else html+='<button class="admin-action" disabled>👑 Аккаунт защищён</button>';if(sel.banned&&role==='founder'&&!dev)html+='<button class="admin-action" data-admin-action="unban" data-admin-user="'+escapeHtml(sel.username)+'">♻️ Разбанить</button>';html+='</div></div>';}}
            return html;
        }
        function renderAdminCommunities(){
            var items=adminCommunityTab==='channels'?adminChannelsCache:adminChatsCache;
            var role=currentUser&&currentUser.adminRole;
            var html='<div class="admin-community-tabs"><button class="admin-community-tab '+(adminCommunityTab==='channels'?'active':'')+'" data-community-tab="channels">Каналы</button><button class="admin-community-tab '+(adminCommunityTab==='chats'?'active':'')+'" data-community-tab="chats">Чаты</button></div>';
            html+='<div class="admin-stats"><div><span>'+(adminCommunityTab==='channels'?'Каналы':'Чаты')+'</span><b>'+items.length+'</b></div><div><span>Сообщений</span><b>'+items.reduce(function(a,x){return a+(x.messages||0);},0)+'</b></div><div><span>Участников</span><b>'+items.reduce(function(a,x){return a+(x.memberCount||x.members||0);},0)+'</b></div></div>';
            html+='<div class="admin-community-list">';
            if(!items.length)html+='<div class="admin-empty">Пока ничего нет</div>';
            items.forEach(function(c){var id=adminCommunityTab==='channels'?c.username:c.id;html+='<div class="admin-community-row '+(adminSelectedCommunity===id?'selected':'')+'" data-community-item="'+escapeHtml(id)+'"><div class="admin-community-icon">'+(adminCommunityTab==='channels'?hotIcon('channel',20):hotIcon('chat',20))+'</div><div class="admin-user-info"><div class="admin-user-name">'+escapeHtml(c.name||c.username)+'</div><div class="admin-user-meta">'+escapeHtml(displayUserName(c.owner||''))+' · '+(c.memberCount||c.members||0)+' участников · '+(c.messages||0)+' сообщений</div></div><div class="admin-chevron">›</div></div>';});
            html+='</div>';
            if(adminSelectedCommunity){var sel=items.find(function(c){return (adminCommunityTab==='channels'?c.username:c.id)===adminSelectedCommunity;});if(sel){html+='<div class="admin-detail"><div class="admin-detail-title">'+escapeHtml(sel.name||sel.username)+'</div><div class="admin-detail-sub">Владелец: '+escapeHtml(sel.owner||'—')+' · '+(sel.messages||0)+' сообщений · '+(sel.memberCount||sel.members||0)+' участников</div><div class="admin-member-monitor"><b>Участники</b><div>'+((sel.memberList||sel.members||[]).slice?((sel.memberList||sel.members||[]).slice(0,30).map(function(x){return '<span class="admin-member-chip">'+escapeHtml(displayUserName(x))+'</span>';}).join('')):'')+'</div></div><div class="admin-actions">';if(role==='founder'||role==='admin')html+='<button class="admin-action" data-community-action="send">✉️ Написать</button><button class="admin-action" data-community-action="send-as">👤 Написать от имени</button>';if(role==='founder')html+='<button class="admin-action danger" data-community-action="delete"><svg class="hot-ui-icon" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg> Удалить '+(adminCommunityTab==='channels'?'канал':'чат')+'</button>';if(role==='moderator')html+='<button class="admin-action" disabled>🔨 Только просмотр и контроль участников</button>';html+='</div></div>';}}
            return html;
        }
        function openFounderRoleModal(username){
            var u=adminUsersCache.find(function(x){return String(x.username||'').toLowerCase()===String(username||'').toLowerCase();});
            if(!u || String(u.username).toLowerCase()==='dev') return;
            var old=document.getElementById('founder-role-modal'); if(old)old.remove();
            var av=u.avatar?'<img src="'+escapeHtml(u.avatar)+'">':escapeHtml(getInitial(u.username));
            var current=u.adminRole||'user';
            var wrap=document.createElement('div'); wrap.id='founder-role-modal'; wrap.className='founder-role-modal-backdrop';
            wrap.innerHTML='<div class="founder-role-modal" role="dialog" aria-modal="true"><h3>👑 Выдать права</h3><p>Основатель может назначить этому человеку роль в Hot. Изменение применяется сразу.</p><div class="founder-role-target"><div class="founder-role-target-avatar">'+av+'</div><div><div class="founder-role-target-name">'+escapeHtml(u.username)+'</div><div style="font-size:12px;color:#a99572">'+escapeHtml(u.email||'')+'</div></div></div><select class="founder-role-select" id="founder-role-select"><option value="admin" '+(current==='admin'?'selected':'')+'>🛡 Администратор</option><option value="moderator" '+(current==='moderator'?'selected':'')+'>🔨 Модератор</option><option value="user" '+(current==='user'?'selected':'')+'>👤 Обычный пользователь</option></select><div class="founder-role-buttons"><button id="founder-role-cancel">Отмена</button><button class="primary" id="founder-role-save">Сохранить</button></div></div>';
            document.body.appendChild(wrap);
            document.getElementById('founder-role-cancel').onclick=function(){wrap.remove();};
            wrap.onclick=function(e){if(e.target===wrap)wrap.remove();};
            document.getElementById('founder-role-save').onclick=function(){
                var role=document.getElementById('founder-role-select').value; var btn=this; btn.disabled=true; btn.textContent='Сохраняем...';
                apiPost('/api/admin/action',{action:'set_role',username:u.username,role:role}).then(function(){wrap.remove();return adminReload();}).catch(function(e){btn.disabled=false;btn.textContent='Сохранить';alert(e.message);});
            };
        }

        function adminAction(action,username){
            if(!username)return;
            if(action==='role'){ openFounderRoleModal(username); return; }
            var text=action==='delete'?'Удалить аккаунт полностью?':action==='ban'?'Забанить аккаунт?':action==='kick'?'Кикнуть все устройства?':'';
            if(text&&!confirm(text))return;
            apiPost('/api/admin/action',{username:username,action:action}).then(adminReload).catch(function(e){alert(e.message);});
        }
        function getSelectedCommunity(){
            var arr=adminCommunityTab==='channels'?adminChannelsCache:adminChatsCache;
            return arr.find(function(c){return (adminCommunityTab==='channels'?c.username:c.id)===adminSelectedCommunity;});
        }
        function openAdminMessageModal(action){
            var c=getSelectedCommunity(); if(!c)return;
            var modal=document.getElementById('admin-message-modal');
            var ta=document.getElementById('admin-message-text');
            var title=document.getElementById('admin-message-title');
            var send=document.getElementById('admin-message-send');
            if(!modal||!ta)return;
            modal.dataset.action=action;
            title.textContent='Написать в '+(adminCommunityTab==='channels'?'канал':'чат');
            send.textContent='Отправить';
            var authorEl=document.getElementById('admin-message-author-name');
            if(authorEl){ authorEl.textContent=(currentUser&&currentUser.adminRole==='founder'?'👑 ★ Основатель | ':currentUser&&currentUser.adminRole==='admin'?'🛡 Администратор | ':currentUser&&currentUser.adminRole==='moderator'?'🔨 Модератор | ':'')+(currentUser&&currentUser.username||''); }
            ta.value=''; modal.classList.remove('hidden');
            setTimeout(function(){ta.focus();},50);
        }
        function closeAdminMessageModal(){
            var modal=document.getElementById('admin-message-modal'); if(modal)modal.classList.add('hidden');
        }
        function sendAdminMessage(){
            var modal=document.getElementById('admin-message-modal'); var ta=document.getElementById('admin-message-text');
            var c=getSelectedCommunity(); if(!modal||!ta||!c)return;
            var text=ta.value.trim(); if(!text){ta.focus();return;}
            var action=modal.dataset.action||'send';
            var asUser=(currentUser&&currentUser.username)?currentUser.username:'Dev'; if(action==='send-as'){ asUser=prompt('От имени какого пользователя отправить?', asUser); if(!asUser){return;} } var data={action:adminCommunityTab==='channels'?'send_channel':'send_chat',text:text,asUser:asUser};
            if(adminCommunityTab==='channels')data.channel=c.username; else data.chat=c.id;
            var btn=document.getElementById('admin-message-send'); if(btn){btn.disabled=true;btn.textContent='Отправка...';}
            apiPost('/api/admin/action',data).then(function(){closeAdminMessageModal();return adminReload();}).catch(function(e){alert(e.message);}).finally(function(){if(btn){btn.disabled=false;btn.textContent='Отправить';}});
        }
        function adminCommunityAction(action){
            var c=getSelectedCommunity();if(!c)return;
            if(action==='delete'){
                if(!confirm('Удалить '+(adminCommunityTab==='channels'?'канал':'чат')+' и его сообщения?'))return;
                apiPost('/api/admin/action',{action:adminCommunityTab==='channels'?'delete_channel':'delete_chat',channel:adminCommunityTab==='channels'?c.username:'',chat:adminCommunityTab==='chats'?c.id:''}).then(function(){adminSelectedCommunity=null;return adminReload();}).catch(function(e){alert(e.message);});return;
            }
            openAdminMessageModal(action);
        }


        function setActiveNav(id) {
            document.querySelectorAll('.nav-item').forEach(function (el) { el.classList.remove('active'); });
            var el = document.getElementById(id);
            if (el) el.classList.add('active');
            document.querySelectorAll('.mobile-bottom-item[data-nav]').forEach(function (el) { el.classList.toggle('active', el.getAttribute('data-nav') === id); });
        }

        function scrollChatToBottom(smooth) {
            var body = document.getElementById('chat-messages')
                    || document.getElementById('channel-chat-messages')
                    || document.getElementById('group-chat-messages');
            if (!body) return;
            requestAnimationFrame(function () {
                requestAnimationFrame(function () {
                    try {
                        body.scrollTo({ top: body.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
                    } catch (e) {
                        body.scrollTop = body.scrollHeight;
                    }
                });
            });
        }

        function renderSkeletons() {
            var html = '<div class="wall-header"><div><h1>Главная</h1><p class="wall-header-desc">Лента всех постов Hot</p></div></div>';
            html += '<div class="wall-posts">';
            for (var i = 0; i < 3; i++) {
                html += '<div class="skeleton-post"><div class="skeleton-avatar"></div><div class="skeleton-body"><div class="skeleton-line short"></div><div class="skeleton-line full"></div><div class="skeleton-line medium"></div></div></div>';
            }
            html += '</div>';
            return html;
        }

        function openFeed() {
            clearReplyTarget();
            if (!currentUser) return;
            setActiveNav('nav-home');
            clearChatElements();
            dmPartner = null;
            chatlistEl.classList.add('hidden');
            infoPanel.classList.remove('visible');
            contentEl.style.display = 'flex';
            contentInner.innerHTML = renderSkeletons();
            apiGet('/api/posts/feed').then(function (data) {
                renderFeedPage(data.posts || []);
            }).catch(function () {
                contentInner.innerHTML = '<div class="empty-state"><div class="empty-state-title">Ошибка загрузки</div></div>';
            });
        }

        function renderFeedPage(posts) {
            var html = '';
            html += '<div class="wall-header"><div><h1>Главная</h1><p class="wall-header-desc">Лента всех постов Hot</p></div></div>';
            html += '<div class="wall-composer">';
            html += '<div class="wall-composer-avatar">' + avatarHTML(currentUser) + '</div>';
            html += '<div class="wall-composer-body">';
            html += '<textarea class="wall-composer-input" id="composer-text" placeholder="' + t('postPlaceholder') + '" maxlength="3000"></textarea>';
            html += '<div class="wall-composer-actions"><div><label class="wall-composer-tool" for="composer-image"><svg class="hot-ui-icon" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="8.5" cy="9" r="1.5" fill="currentColor"/><path d="m4.5 17 4.5-4 3.5 3 2.5-2 4.5 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg> ' + t('addPic') + '</label><input type="file" id="composer-image" accept="image/*" style="display:none;"></div>';
            html += '<button type="button" class="wall-composer-submit" id="composer-submit">' + t('publish') + '</button></div>';
            html += '<div id="composer-preview" class="wall-image-preview" style="display:none;"></div>';
            html += '<p class="error-message" id="composer-error" style="color:var(--danger);font-size:13px;margin-top:6px;"></p>';
            html += '</div></div>';
            html += '<div class="wall-posts" id="feed-posts">';
            if (!posts.length) {
                html += '<div class="empty-state"><div class="empty-state-icon"><svg class="hot-ui-icon" width="28" height="28" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m4 20 4.2-1 9.8-9.8a2.8 2.8 0 0 0-4-4L4.2 15 4 20Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="m13 6 4 4" fill="none" stroke="currentColor" stroke-width="1.8"/></svg></div><div class="empty-state-title">Пока нет постов</div><div class="empty-state-text">Стань первым, кто что-то опубликует в Hot</div><button type="button" class="empty-state-btn" id="empty-state-create">Создать пост</button></div>';
            } else {
                posts.forEach(function (p) { html += renderPost(p); });
            }
            html += '</div>';
            contentInner.innerHTML = html;
            contentInner.querySelectorAll('.post').forEach(function(el,i){ if(posts[i]) el.__hotPostData=posts[i]; });
            bindFeedEvents();
            var emptyBtn = document.getElementById('empty-state-create');
            if (emptyBtn) emptyBtn.addEventListener('click', function () {
                var ta = document.getElementById('composer-text');
                if (ta) { ta.focus(); ta.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
            });
        }

        function bindFeedEvents() {
            var submitBtn = document.getElementById('composer-submit');
            var textArea = document.getElementById('composer-text');
            var imageInput = document.getElementById('composer-image');
            var preview = document.getElementById('composer-preview');
            var errEl = document.getElementById('composer-error');
            var img = '';
            if (textArea) {
                var counter = document.createElement('div');
                counter.className = 'composer-counter';
                counter.textContent = '0 / 3000';
                textArea.parentNode.insertBefore(counter, textArea.nextSibling);
                textArea.addEventListener('input', function () {
                    textArea.style.height = 'auto';
                    textArea.style.height = Math.min(textArea.scrollHeight, 300) + 'px';
                    var len = textArea.value.length;
                    counter.textContent = len + ' / 3000';
                    counter.classList.toggle('warn', len > 2400 && len <= 2800);
                    counter.classList.toggle('danger', len > 2800);
                });
            }
            if (imageInput) imageInput.addEventListener('change', function (e) {
                var file = e.target.files && e.target.files[0];
                if (!file) return;
                if (file.size > MAX_POST_IMAGE_SIZE) { errEl.textContent = 'Файл больше 10 МБ'; return; }
                resizeImageFit(file, POST_IMAGE_MAX_DIM, function (dataURL) {
                    if (!dataURL) return;
                    img = dataURL;
                    preview.innerHTML = '<img src="' + dataURL + '"><button type="button" class="wall-image-remove">✕</button>';
                    preview.style.display = 'inline-block';
                    preview.querySelector('.wall-image-remove').addEventListener('click', function () {
                        img = ''; preview.innerHTML = ''; preview.style.display = 'none'; imageInput.value = '';
                    });
                });
            });
            if (submitBtn) submitBtn.addEventListener('click', function () {
                var text = textArea.value.trim();
                if (!text && !img) { errEl.textContent = 'Добавь текст или картинку'; return; }
                submitBtn.disabled = true;
                apiPost('/api/posts', { text: text, image: img }).then(function () {
                    openFeed();
                }).catch(function (e) { errEl.textContent = e.message; })
                  .then(function () { submitBtn.disabled = false; });
            });
            bindPostEvents(contentInner);
        }

        function renderPost(p) {
            var date = p.createdAt ? new Date(p.createdAt).toLocaleString(currentLang === 'ru' ? 'ru-RU' : 'en-US') : '';
            var likes = Array.isArray(p.likes) ? p.likes : [];
            var comments = Array.isArray(p.comments) ? p.comments : [];
            var liked = currentUser && likes.some(function (u) { return u.toLowerCase() === currentUser.username.toLowerCase(); });
            var reposted = !!p.repostedByViewer;
            var repostId = p.repostOf && p.repostOf.id ? p.repostOf.id : p.id;
            var isMine = !!(currentUser && p.username && p.username.toLowerCase() === currentUser.username.toLowerCase());
            var html = '<div class="post" data-post-id="' + escapeHtml(p.id) + '">';
            if (p.repostOf) {
                html += '<div class="repost-label">🔁 Репост от <b>' + escapeHtml((p.displayName || displayUserName(p.username))) + '</b></div>';
                html += '<div class="repost-block"><div class="repost-block-head"><div class="repost-block-avatar">' + (p.repostOf.avatar ? '<img src="' + escapeHtml(p.repostOf.avatar) + '">' : getInitial(p.repostOf.username)) + '</div><div><div class="repost-block-author">' + escapeHtml(p.repostOf.username) + '</div><div class="repost-block-date">' + new Date(p.repostOf.createdAt).toLocaleString() + '</div></div></div>';
                if (p.repostOf.text) html += '<div class="repost-block-text">' + escapeHtml(p.repostOf.text) + '</div>';
                if (p.repostOf.image) html += '<div class="repost-block-image"><img src="' + escapeHtml(p.repostOf.image) + '"></div>';
                html += '</div>';
            } else {
                html += '<div class="post-head"><div class="post-avatar">' + avatarHTML(p) + '</div><div class="post-meta"><div class="post-author" data-username="' + escapeHtml((p.displayName || displayUserName(p.username))) + '">' + escapeHtml((p.displayName || displayUserName(p.username))) + '</div><div class="post-date">' + date + '</div></div></div>';
                if (p.text) html += '<div class="post-text">' + escapeHtml(p.text) + '</div>';
                if (p.image) html += '<div class="post-image"><img src="' + escapeHtml(p.image) + '"></div>';
            }
            html += '<div class="post-actions">';
            html += '<button class="post-action' + (liked ? ' liked' : '') + '" data-action="like" data-id="' + escapeHtml(p.id) + '">❤ <span>' + likes.length + '</span></button>';
            html += '<button class="post-action" data-action="comment" data-id="' + escapeHtml(p.id) + '">'+hotIcon('chat',17)+' <span>' + comments.length + '</span></button>';
            html += '<button class="post-action' + (reposted ? ' reposted' : '') + '" data-action="repost" data-id="' + escapeHtml(repostId) + '">'+hotIcon('chat',17)+' <span>' + (reposted ? 'Репостнуто' : 'Репост') + '</span></button>';
            if (isMine) html += '<button class="post-action danger" data-action="delete" data-id="' + escapeHtml(p.id) + '"><svg class="hot-ui-icon" width="17" height="17" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg> ' + t('deleteAction') + '</button>';
            html += '</div>';
            html += '<div class="post-comments" data-comments-for="' + escapeHtml(p.id) + '"></div>';
            html += '</div>';
            return html;
        }

        function bindPostEvents(container) {
            container.querySelectorAll('.post-action').forEach(function (btn) {
                btn.addEventListener('click', handlePostAction);
            });
            container.querySelectorAll('.post').forEach(function(postEl){
                var pid=postEl.getAttribute('data-post-id');
                var p=postEl.__hotPostData;
                if(!p) return;
                var own=currentUser && p.username && p.username.toLowerCase()===currentUser.username.toLowerCase();
                var msgData={id:p.id,text:p.text||((p.repostOf&&p.repostOf.text)||''),from:p.username||'',image:p.image||((p.repostOf&&p.repostOf.image)||''),source:'post'};
                var items=[{action:'forward',icon:'→',label:'Переслать',handler:function(){openForwardModal(msgData);}}];
                if(own) items.push({action:'delete',icon:hotIcon('trash',18),label:'Удалить',danger:true,handler:function(){confirmDelete('Удалить этот пост?',function(){apiPost('/api/posts/delete',{postId:pid}).then(function(){openFeed();}).catch(function(e){alert(e.message);});});}});
                items.push({action:'cancel',icon:'×',label:'Отмена',danger:true});
                attachLongPress(postEl,msgData,items);
            });
            container.querySelectorAll('.post-author').forEach(function (el) {
                el.addEventListener('click', function () { openWall(el.getAttribute('data-username')); });
            });
        }
        function handlePostAction(e) {
            var btn = e.currentTarget;
            var action = btn.getAttribute('data-action');
            var id = btn.getAttribute('data-id');
            if (!id) return;
            if (action === 'like') {
                btn.disabled = true;
                apiPost('/api/posts/like', { id: id }).then(function (data) {
                    var span = btn.querySelector('span');
                    if (span) span.textContent = data.likes.length;
                    btn.classList.toggle('liked', data.liked);
                }).catch(function(){}).then(function(){ btn.disabled = false; });
            } else if (action === 'comment') { toggleComments(id); }
            else if (action === 'repost') {
                btn.disabled = true;
                apiPost('/api/posts/repost', { id: id }).then(function (data) {
                    var span = btn.querySelector('span');
                    if (data.reposted) { btn.classList.add('reposted'); if (span) span.textContent = 'Репостнуто'; }
                    else { btn.classList.remove('reposted'); if (span) span.textContent = 'Репост'; }
                }).catch(function(e){ alert(e.message); }).then(function(){ btn.disabled = false; });
            } else if (action === 'delete') {
                confirmDelete('Удалить этот пост?', function () {
                    apiPost('/api/posts/delete', { postId: id }).then(function () {
                        var el = document.querySelector('.post[data-post-id="' + id + '"]');
                        if (el) el.remove();
                    }).catch(function(e){ alert(e.message); });
                });
            }
        }

        function toggleComments(postId) {
            var container = document.querySelector('.post-comments[data-comments-for="' + postId + '"]');
            if (!container) return;
            if (container.classList.contains('open')) { container.classList.remove('open'); return; }
            container.classList.add('open');
            container.innerHTML = '<div style="padding:8px;color:var(--text-3);">Загрузка...</div>';
            apiGet('/api/posts/comments?id=' + encodeURIComponent(postId)).then(function (data) {
                renderComments(container, postId, data.comments || []);
            });
        }

        function renderComments(container, postId, comments) {
            var html = '';
            if (!comments.length) html += '<div style="padding:8px;color:var(--text-3);font-size:13px;">Пока нет комментариев</div>';
            else comments.forEach(function (c) {
                var isMine = currentUser && c.username && c.username.toLowerCase() === currentUser.username.toLowerCase();
                html += '<div class="comment" data-comment-id="' + escapeHtml(c.id) + '"><div class="comment-avatar">' + (c.avatar ? '<img src="' + escapeHtml(c.avatar) + '">' : getInitial(c.username)) + '</div><div class="comment-body"><div class="comment-meta"><b data-username="' + escapeHtml(c.username) + '">' + escapeHtml(c.username) + '</b><span>' + formatTime(c.createdAt) + '</span>';
                if (!isMine) html += '<button type="button" class="comment-reply-btn" data-target="' + escapeHtml(c.username) + '">Ответить</button>';
                if (isMine && c.id) html += '<button type="button" class="comment-delete-btn" data-comment-id="' + escapeHtml(c.id) + '">×</button>';
                html += '</div><div class="comment-text">' + escapeHtml(c.text) + '</div></div></div>';
            });
            html += '<form class="comment-form" data-post-id="' + escapeHtml(postId) + '"><input type="text" placeholder="Написать комментарий..." maxlength="1000"><button type="submit">' + t('send') + '</button></form>';
            container.innerHTML = html;
            container.querySelectorAll('.comment-meta b').forEach(function (el) {
                el.addEventListener('click', function () { openWall(el.getAttribute('data-username')); });
            });
            container.querySelectorAll('.comment-reply-btn').forEach(function (btn) {
                btn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    var target = btn.getAttribute('data-target');
                    var form = container.querySelector('.comment-form');
                    if (!form) return;
                    var input = form.querySelector('input');
                    input.value = '@' + target + ', ';
                    input.focus();
                });
            });
            container.querySelectorAll('.comment-delete-btn').forEach(function (btn) {
                btn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    var cid = btn.getAttribute('data-comment-id');
                    if (!cid) return;
                    confirmDelete('Удалить этот комментарий?', function () {
                        apiPost('/api/posts/comment/delete', { postId: postId, commentId: cid }).then(function () {
                            apiGet('/api/posts/comments?id=' + encodeURIComponent(postId)).then(function (data) {
                                renderComments(container, postId, data.comments || []);
                            });
                        });
                    });
                });
            });
            var formEl = container.querySelector('.comment-form');
            if (formEl) formEl.addEventListener('submit', function (e) {
                e.preventDefault();
                var input = formEl.querySelector('input');
                var text = input.value.trim();
                if (!text) return;
                var btn = formEl.querySelector('button');
                btn.disabled = true;
                apiPost('/api/posts/comment', { id: postId, text: text }).then(function (data) {
                    input.value = '';
                    renderComments(container, postId, data.comments || []);
                }).catch(function(e){ alert(e.message); }).then(function(){ btn.disabled = false; });
            });
        }

        function openPeople() {
            setActiveNav('nav-people');
            clearChatElements();
            dmPartner = null;
            chatlistEl.classList.add('hidden');
            infoPanel.classList.remove('visible');
            contentInner.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-3);">Загрузка...</div>';
            apiGet('/api/users').then(function (data) {
                var users = (data.users || []).filter(function (u) { return u.username !== currentUser.username && !isSystemName(u.username); });
                var html = '<div class="wall-header"><div><h1>Люди</h1><p class="wall-header-desc">Найди друзей по имени или @юзернейму</p></div><button type="button" class="people-friends-link" id="people-friends-link">Мои друзья<span class="people-friends-badge hidden" id="people-friends-badge"></span></button></div>';
                html += '<div class="people-search"><input class="input" id="people-search-input" type="search" placeholder="Найти по @юзернейму или имени…" autocomplete="off"><button type="button" class="wall-composer-submit" id="people-search-btn">Найти</button></div>';
                html += '<div id="people-results"></div>';
                contentInner.innerHTML = html;
                (function () {
                    var pfl = document.getElementById('people-friends-link'), c = window.__friendReqCount || 0;
                    if (pfl) pfl.addEventListener('click', function () { openFriends(); });
                    var pb = document.getElementById('people-friends-badge');
                    if (pb && c > 0) { pb.textContent = String(c); pb.classList.remove('hidden'); }
                })();
                function renderPeople(q) {
                    q = (q || '').trim().toLowerCase().replace(/^@/, '');
                    var list = users.filter(function (u) { return !q || u.username.toLowerCase().indexOf(q) !== -1 || (u.handle || '').toLowerCase().indexOf(q) !== -1; });
                    var box = document.getElementById('people-results');
                    if (!box) return;
                    if (!list.length) { box.innerHTML = '<div class="empty-state"><div class="empty-state-icon"><svg class="hot-ui-icon" width="28" height="28" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M16 20v-1.4a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V20M9.5 10.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM17 11a3 3 0 1 0 0-6M21 20v-1.5a4 4 0 0 0-3-3.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></div><div class="empty-state-title">' + (users.length ? 'Никого не найдено' : 'Никого нет') + '</div></div>'; return; }
                    var h = '<div class="people-list people-directory">';
                    list.forEach(function (u) {
                        var online = isOnline(u.lastSeen);
                        var statusText = formatLastSeen(u.lastSeen);
                        h += '<div class="person-card" data-username="' + escapeHtml(u.username) + '"><div class="person-avatar">' + avatarHTML(u) + '</div><div class="person-info"><div class="person-name">' + escapeHtml((u.displayName || displayUserName(u.username))) + '</div><div class="person-status"><span class="person-status-dot' + (online ? ' online' : '') + '"></span><span>' + escapeHtml(statusText) + '</span></div></div><div class="person-actions"><button type="button" class="btn-upload people-add" data-target="' + escapeHtml(u.username) + '">' + t('addFriend') + '</button></div></div>';
                    });
                    h += '</div>';
                    box.innerHTML = h;
                    box.querySelectorAll('.person-card').forEach(function (el) {
                        el.addEventListener('click', function () { openWall(el.getAttribute('data-username')); });
                    });
                    box.querySelectorAll('.people-add').forEach(function (btn) {
                        btn.addEventListener('click', function (e) {
                            e.stopPropagation();
                            btn.disabled = true;
                            apiPost('/api/friends/action', { target: btn.getAttribute('data-target'), action: 'send' }).then(function () {
                                btn.textContent = t('reqSent');
                            }).catch(function (err) { btn.disabled = false; alert(err && err.message ? err.message : 'Ошибка'); });
                        });
                    });
                }
                renderPeople('');
                var psi = document.getElementById('people-search-input');
                psi.addEventListener('input', function () { renderPeople(psi.value); });
                document.getElementById('people-search-btn').addEventListener('click', function () { renderPeople(psi.value); });
            });
        }

        function openFriends() {
            setActiveNav('nav-friends');
            clearChatElements();
            dmPartner = null;
            chatlistEl.classList.add('hidden');
            infoPanel.classList.remove('visible');
            contentInner.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-3);">Загрузка...</div>';
            apiGet('/api/friends').then(function (res) {
                var friends = res.friends || [];
                var requests = res.requests || [];
                var html = '<div class="wall-header"><div><h1>Друзья</h1><p class="wall-header-desc">Список друзей и заявки</p></div></div>';
                if (requests.length) {
                    html += '<h3 style="margin-bottom:12px;color:var(--accent-1);font-size:14px;text-transform:uppercase;letter-spacing:0.5px;">Заявки в друзья</h3>';
                    html += '<div class="people-list friends-list" style="margin-bottom:22px;">';
                    requests.forEach(function (u) {
                        var online = isOnline(u.lastSeen);
                        var statusText = formatLastSeen(u.lastSeen);
                        html += '<div class="person-card friend-card request-card" data-username="' + escapeHtml(u.username) + '"><div class="person-avatar">' + avatarHTML(u) + '</div><div class="person-info"><div class="person-name">' + escapeHtml((u.displayName || displayUserName(u.username))) + '</div><div class="person-status"><span class="person-status-dot' + (online ? ' online' : '') + '"></span><span>' + escapeHtml(statusText) + '</span></div></div><div class="person-actions"><button class="btn-upload req-accept" data-target="' + escapeHtml(u.username) + '">' + t('accept') + '</button><button class="btn-remove req-decline" data-target="' + escapeHtml(u.username) + '">' + t('decline') + '</button></div></div>';
                    });
                    html += '</div>';
                }
                html += '<h3 style="margin-bottom:12px;color:var(--text-2);font-size:14px;text-transform:uppercase;letter-spacing:0.5px;">Мои друзья (' + friends.length + ')</h3>';
                if (!friends.length) {
                    html += '<div class="empty-state"><div class="empty-state-icon"><svg class="hot-ui-icon" width="28" height="28" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M16 20v-1.4a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V20M9.5 10.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM17 11a3 3 0 1 0 0-6M21 20v-1.5a4 4 0 0 0-3-3.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></div><div class="empty-state-title">' + t('noFriends') + '</div></div>';
                } else {
                    html += '<div class="people-list friends-list">';
                    friends.forEach(function (u) {
                        var online = isOnline(u.lastSeen);
                        var statusText = formatLastSeen(u.lastSeen);
                        html += '<div class="person-card friend-card" data-username="' + escapeHtml(u.username) + '"><div class="person-avatar">' + avatarHTML(u) + '</div><div class="person-info"><div class="person-name">' + escapeHtml((u.displayName || displayUserName(u.username))) + '</div><div class="person-status"><span class="person-status-dot' + (online ? ' online' : '') + '"></span><span>' + escapeHtml(statusText) + '</span></div></div><div class="person-actions"><button class="btn-upload friend-write" data-target="' + escapeHtml(u.username) + '">Написать</button><button class="btn-remove friend-remove" data-target="' + escapeHtml(u.username) + '">' + t('removeFriend') + '</button></div></div>';
                    });
                    html += '</div>';
                }
                contentInner.innerHTML = html;
                contentInner.querySelectorAll('.person-card').forEach(function (el) {
                    var name = el.getAttribute('data-username');
                    el.querySelectorAll('.person-avatar,.person-info,.person-name').forEach(function (sub) {
                        sub.addEventListener('click', function () { openWall(name); });
                    });
                });
                contentInner.querySelectorAll('.req-accept').forEach(function (b) {
                    b.addEventListener('click', function (e) {
                        e.stopPropagation();
                        apiPost('/api/friends/action', { target: b.getAttribute('data-target'), action: 'accept' }).then(function () { openFriends(); updateBadges(); });
                    });
                });
                contentInner.querySelectorAll('.req-decline').forEach(function (b) {
                    b.addEventListener('click', function (e) {
                        e.stopPropagation();
                        apiPost('/api/friends/action', { target: b.getAttribute('data-target'), action: 'decline' }).then(function () { openFriends(); updateBadges(); });
                    });
                });
                contentInner.querySelectorAll('.friend-write').forEach(function (b) {
                    b.addEventListener('click', function (e) {
                        e.stopPropagation();
                        var name = b.getAttribute('data-target');
                        var fu = friends.filter(function (x) { return x.username === name; })[0];
                        if (!fu) return;
                        setActiveNav('nav-messages');
                        loadChatList();
                        openDm(fu);
                    });
                });
                contentInner.querySelectorAll('.friend-remove').forEach(function (b) {
                    b.addEventListener('click', function (e) {
                        e.stopPropagation();
                        apiPost('/api/friends/action', { target: b.getAttribute('data-target'), action: 'remove' }).then(function () { openFriends(); updateBadges(); });
                    });
                });
            });
        }

        function openWall(username) {
            clearReplyTarget();
            if (!username) return;
            wallViewingUsername = username;
            setActiveNav('nav-wall');
            clearChatElements();
            dmPartner = null;
            chatlistEl.classList.add('hidden');
            infoPanel.classList.remove('visible');
            contentInner.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-3);">Загрузка...</div>';
            apiGet('/api/users').then(function (data) {
                var user = (data.users || []).find(function (u) { return u.username.toLowerCase() === username.toLowerCase(); });
                if (!user) { contentInner.innerHTML = '<div class="empty-state">Пользователь не найден</div>'; return; }
                var isOwn = user.username.toLowerCase() === currentUser.username.toLowerCase();
                var html = '<div class="profile-header"><div class="profile-header-avatar">' + avatarHTML(user) + '</div><div class="profile-header-info"><div class="profile-header-name">' + escapeHtml(displayUserName(user.username)) + '</div>' + (user.handle ? '<div class="profile-header-handle">@' + escapeHtml(user.handle) + '</div>' : '') + '<div class="profile-header-actions" id="wall-actions"></div></div></div>';
                html += '<div id="wall-posts-container"><div style="text-align:center;padding:20px;color:var(--text-3);">Загрузка постов...</div></div>';
                contentInner.innerHTML = html;
                var actions = document.getElementById('wall-actions');
                if (isOwn) {
                    actions.innerHTML = '<button class="btn-upload" id="wall-edit-btn">Редактировать профиль</button>';
                    document.getElementById('wall-edit-btn').addEventListener('click', openSettings);
                } else {
                    actions.innerHTML = '<button class="btn-upload" id="wall-msg-btn">' + t('writeMsg') + '</button><span id="wall-friend-btn-wrap"></span><button class="wall-menu-btn" id="wall-menu-btn">⋮</button>';
                    document.getElementById('wall-msg-btn').addEventListener('click', function () { openDm(user); });
                    Promise.all([
                        apiGet('/api/friends/status?target=' + encodeURIComponent(user.username)),
                        apiGet('/api/users/block-status?target=' + encodeURIComponent(user.username))
                    ]).then(function (r) {
                        var fr = r[0], bl = r[1];
                        var wrap = document.getElementById('wall-friend-btn-wrap');
                        if (bl.iBlocked || bl.heBlocked) return;
                        if (fr.status === 'friends') wrap.innerHTML = '<button class="btn-remove" id="wall-fr-btn">' + t('removeFriend') + '</button>';
                        else if (fr.status === 'sent') wrap.innerHTML = '<button class="btn-secondary" id="wall-fr-btn">' + t('reqSent') + '</button>';
                        else if (fr.status === 'received') wrap.innerHTML = '<button class="btn-upload" id="wall-accept-btn">' + t('accept') + '</button>';
                        else wrap.innerHTML = '<button class="btn-upload" id="wall-fr-btn">' + t('addFriend') + '</button>';
                        var frBtn = document.getElementById('wall-fr-btn');
                        if (frBtn) frBtn.addEventListener('click', function () {
                            var action = 'send';
                            if (fr.status === 'friends') action = 'remove';
                            else if (fr.status === 'sent') action = 'cancel';
                            apiPost('/api/friends/action', { target: user.username, action: action }).then(function () { openWall(user.username); updateBadges(); });
                        });
                        var accBtn = document.getElementById('wall-accept-btn');
                        if (accBtn) accBtn.addEventListener('click', function () {
                            apiPost('/api/friends/action', { target: user.username, action: 'accept' }).then(function () { openWall(user.username); updateBadges(); });
                        });
                    });
                    document.getElementById('wall-menu-btn').addEventListener('click', function () { openProfileMenu(user); });
                }
                apiGet('/api/posts?username=' + encodeURIComponent(user.username)).then(function (pd) {
                    var container = document.getElementById('wall-posts-container');
                    var posts = pd.posts || [];
                    var ph = '<div class="wall-posts">';
                    if (!posts.length) ph += '<div class="empty-state"><div class="empty-state-icon"><svg class="hot-ui-icon" width="28" height="28" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m4 20 4.2-1 9.8-9.8a2.8 2.8 0 0 0-4-4L4.2 15 4 20Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="m13 6 4 4" fill="none" stroke="currentColor" stroke-width="1.8"/></svg></div><div class="empty-state-title">Пока нет постов</div></div>';
                    else posts.forEach(function (p) { ph += renderPost(p); });
                    ph += '</div>';
                    container.innerHTML = ph;
                    container.querySelectorAll('.post').forEach(function(el,i){ if(posts[i]) el.__hotPostData=posts[i]; });
                    bindPostEvents(container);
                });
            });
        }

        var communitiesTab = 'channels';

        function openCommunities(tab) {
            if (!currentUser) return;
            communitiesTab = tab || 'channels';
            setActiveNav('nav-communities');
            clearChatElements();
            dmPartner = null;
            chatlistEl.classList.add('hidden');
            infoPanel.classList.remove('visible');
            contentEl.style.display = 'flex';
            renderCommunitiesPage();
        }

        function renderCommunitiesPage() {
            var html = '<div class="communities-page">';
            html += '<div class="communities-head"><div class="communities-title"><h1>Сообщества</h1><p>Каналы и групповые чаты</p></div>';
            html += '<div class="communities-create"><button type="button" class="communities-create-main" id="communities-create-btn">＋ Создать</button>';
            html += '<div class="communities-create-menu hidden" id="communities-create-menu">'
                + '<button type="button" id="communities-create-channel"><span style="width:20px;text-align:center;"><svg class="hot-ui-icon" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5h-7L6 20v-3H6.5A2.5 2.5 0 0 1 4 14.5Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8 9h8M8 12h5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></span><span><b>Канал</b><small>Публикации для подписчиков</small></span></button>'
                + '<button type="button" id="communities-create-chat"><span style="width:20px;text-align:center;"><svg class="hot-ui-icon" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 5h16v11H8l-4 4Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg></span><span><b>Групповой чат</b><small>Общение с друзьями</small></span></button>'
                + '</div></div></div>';
            html += '<div class="communities-tabs"><button type="button" class="communities-tab ' + (communitiesTab === 'channels' ? 'active' : '') + '" data-community-tab="channels">Каналы</button><button type="button" class="communities-tab ' + (communitiesTab === 'chats' ? 'active' : '') + '" data-community-tab="chats">Чаты</button></div>';
            html += '<input class="communities-search" id="communities-search" type="search" placeholder="' + (communitiesTab === 'channels' ? 'Поиск каналов' : 'Поиск чатов') + '" autocomplete="off">';
            html += '<div id="communities-list"></div></div>';
            contentInner.innerHTML = html;
            document.getElementById('communities-create-btn').addEventListener('click', function(e){ e.stopPropagation(); document.getElementById('communities-create-menu').classList.toggle('hidden'); });
            document.getElementById('communities-create-channel').addEventListener('click', function(){ document.getElementById('communities-create-menu').classList.add('hidden'); resetChannelModal(); channelModal.classList.remove('hidden'); });
            document.getElementById('communities-create-chat').addEventListener('click', function(){ document.getElementById('communities-create-menu').classList.add('hidden'); resetChatModal(); chatModal.classList.remove('hidden'); });
            document.querySelectorAll('[data-community-tab]').forEach(function(btn){ btn.addEventListener('click', function(){ openCommunities(btn.getAttribute('data-community-tab')); }); });
            document.getElementById('communities-search').addEventListener('input', function(){ loadCommunities(this.value.trim()); });
            document.addEventListener('click', closeCommunityMenuOnce, { once:true });
            loadCommunities('');
        }
        function closeCommunityMenuOnce(e){ var m=document.getElementById('communities-create-menu'); var b=document.getElementById('communities-create-btn'); if(m && b && !m.contains(e.target) && e.target!==b) m.classList.add('hidden'); }
        function loadCommunities(q) {
            var list = document.getElementById('communities-list');
            if (!list) return;
            list.innerHTML = '<div style="padding:25px;text-align:center;color:var(--text-3);font-size:13px;">Загрузка...</div>';
            if (communitiesTab === 'channels') {
                apiGet('/api/channels/search?q=' + encodeURIComponent(q || '')).then(function(r){
                    var items = r.channels || [];
                    if (q) { var ql = q.toLowerCase(); items = items.filter(function(c){ return c.name.toLowerCase().indexOf(ql) !== -1 || c.username.toLowerCase().indexOf(ql) !== -1; }); }
                    if (!items.length) { list.innerHTML = '<div class="community-empty">' + (q ? 'По такому запросу каналов нет' : 'Каналов пока нет. Можно создать свой, писать в него будешь только ты, а читать смогут все.') + '</div>'; return; }
                    list.innerHTML = items.map(function(c){
                        var initial = (c.name || c.username || '?').trim().charAt(0).toUpperCase();
                        return '<div class="community-row" data-community-channel="' + escapeHtml(c.username) + '">'
                            + '<div class="community-avatar">' + (c.avatar ? '<img src="' + escapeHtml(c.avatar) + '" alt="">' : escapeHtml(initial)) + '</div>'
                            + '<div class="community-info"><div class="community-name">' + escapeHtml(c.name) + '</div>'
                            + '<div class="community-meta">@' + escapeHtml(c.username) + ' · ' + pluralMembers(c.members) + '</div>'
                            + (c.description ? '<div class="community-desc">' + escapeHtml(c.description) + '</div>' : '')
                            + '</div>'
                            + '<button type="button" class="community-join-btn' + (c.isSubscribed ? ' joined' : '') + '" data-join="' + escapeHtml(c.username) + '">' + (c.isSubscribed ? 'Вы подписаны' : 'Подписаться') + '</button>'
                            + '</div>';
                    }).join('');
                    list.querySelectorAll('[data-community-channel]').forEach(function(el){ el.addEventListener('click', function(e){ if (e.target.closest('.community-join-btn')) return; openChannel(el.getAttribute('data-community-channel')); }); });
                    list.querySelectorAll('.community-join-btn').forEach(function(btn){
                        btn.addEventListener('click', function(e){
                            e.stopPropagation();
                            apiPost('/api/channels/subscribe', { channel: btn.getAttribute('data-join') }).then(function(){ loadCommunities((document.getElementById('communities-search') || {}).value || ''); });
                        });
                    });
                }).catch(function(){ list.innerHTML = '<div class="community-empty">Не удалось загрузить каналы</div>'; });
            } else {
                apiGet('/api/chats').then(function(r){
                    var items = r.chats || [];
                    if (q) { var ql = q.toLowerCase(); items = items.filter(function(c){ return c.name.toLowerCase().indexOf(ql) !== -1; }); }
                    if (!items.length) { list.innerHTML = '<div class="community-empty">' + (q ? 'По такому запросу чатов нет' : 'Групповых чатов пока нет. Собери друзей в один чат кнопкой «Создать».') + '</div>'; return; }
                    list.innerHTML = items.map(function(c){
                        var last = c.lastText ? escapeHtml(c.lastText) : 'Групповой чат';
                        var initial = (c.name || '?').trim().charAt(0).toUpperCase();
                        return '<div class="community-row" data-community-chat="' + escapeHtml(c.id) + '">'
                            + '<div class="community-avatar">' + escapeHtml(initial) + '</div>'
                            + '<div class="community-info"><div class="community-name">' + escapeHtml(c.name) + '</div>'
                            + '<div class="community-meta">' + pluralMembers(c.memberCount || (c.members || []).length) + '</div>'
                            + '<div class="community-desc">' + last + '</div>'
                            + '</div></div>';
                    }).join('');
                    list.querySelectorAll('[data-community-chat]').forEach(function(el){ el.addEventListener('click', function(){ openGroupChat(el.getAttribute('data-community-chat')); }); });
                }).catch(function(){ list.innerHTML = '<div class="community-empty">Не удалось загрузить чаты</div>'; });
            }
        }
        function pluralMembers(n) {
            n = Number(n) || 0;
            var mod100 = n % 100, mod10 = n % 10;
            if (mod100 >= 11 && mod100 <= 14) return n + ' участников';
            if (mod10 === 1) return n + ' участник';
            if (mod10 >= 2 && mod10 <= 4) return n + ' участника';
            return n + ' участников';
        }

        function resetChannelModal(){ ['channel-name-input','channel-username-input','channel-description-input'].forEach(function(id){ var e=document.getElementById(id); if(e)e.value=''; }); var e=document.getElementById('channel-create-error'); if(e){e.textContent='';e.classList.remove('visible');} }
        function resetChatModal(){ ['chat-name-input','chat-members-input'].forEach(function(id){ var e=document.getElementById(id); if(e)e.value=''; }); var e=document.getElementById('chat-create-error'); if(e){e.textContent='';e.classList.remove('visible');} }

        function canManageCommunityPin(owner){
            if(!currentUser || !owner) return false;
            var me=String(currentUser.username||'').trim().toLowerCase();
            if(String(owner).trim().toLowerCase()===me) return true;
            var role=String(currentUser.adminRole||'').toLowerCase();
            return role==='founder' || role==='admin';
        }

        async function openChannel(username) {
            clearReplyTarget();
            clearChatElements();
            chatlistEl.classList.add('hidden');
            infoPanel.classList.remove('visible');
            document.body.classList.add('m-chat');
            contentInner.innerHTML='<div style="text-align:center;padding:40px;color:var(--text-3);">Загрузка...</div>';

            Promise.all([
                apiGet('/api/channels?username='+encodeURIComponent(username)),
                apiGet('/api/channels/messages?username='+encodeURIComponent(username))
            ]).then(function(r){
                var c=r[0].channel;
                var messages=r[1].messages||[];
                var isOwner = !!(c && (c.isOwner === true || (currentUser && c.owner && String(c.owner).trim().toLowerCase() === String(currentUser.username).trim().toLowerCase())));

                var html='<div class="community-chat-page">';
                html+='<div class="chat-header">';
                html+='<button class="chat-back-btn" id="back-communities">←</button>';
                html+='<div class="chat-header-info"><div class="chat-header-avatar">'+(c.avatar?'<img src="'+escapeHtml(c.avatar)+'" alt="">':hotIcon('channel',28))+'</div>';
                html+='<div class="chat-header-meta"><div class="chat-header-name">'+escapeHtml(c.name)+'</div><div class="chat-header-status">@'+escapeHtml(c.username)+' · '+c.members+' подписчиков</div></div></div>';
                html+='<button class="btn-upload" id="channel-subscribe-btn">'+(c.isSubscribed?'Вы подписаны':'Подписаться')+'</button>';
                if(isOwner) html+='<button class="community-settings-gear" id="channel-settings-btn" title="Настройки">⚙️</button>';
                html+='</div>';
                var channelPinnedMsg = messages.find(function(x){ return x.pinned===true || String(x.id||'')===String(r.pinnedMessageId||''); });
                if(channelPinnedMsg){ html+=pinnedMessageBarHtml(channelPinnedMsg); }

                html+='<div class="community-chat-body" id="channel-chat-messages">';
                if(!messages.length) {
                    html+='<div class="community-chat-empty"><div><div style="font-size:15px;margin-bottom:6px;">В канале пока нет сообщений</div><div>Напишите первое сообщение</div></div></div>';
                } else {
                    messages.forEach(function(m){
                        var msgOwn=String(m.author||m.from||c.owner).toLowerCase()===String(currentUser.username).toLowerCase(); html+='<div class="community-msg '+(msgOwn?'own':'')+'" data-msg-id="'+escapeHtml(m.id||'')+'" data-msg-from="'+escapeHtml(m.author||m.from||c.owner)+'" data-msg-text="'+escapeHtml(m.text||'')+'" data-pinned="'+(m.id===r.pinnedMessageId?'1':'0')+'"><div class="msg-content">'+replyPreviewHtml(m,'community-reply-preview')+communityAttachmentHtml(m.file)+'<div class="msg-bubble"'+((m.text||'')?'':' style="display:none;"')+'>'+escapeHtml(m.text||'')+'</div><div class="msg-meta">'+escapeHtml((m.fromDisplay || displayUserName(m.from||c.name)))+' · '+formatTime(m.createdAt)+((m.pinned===true || m.id===r.pinnedMessageId)?' · '+hotIcon('pin',14):'')+'</div></div></div>';
                    });
                }
                html+='</div>';

                if(isOwner) {
                    html+='<div class="community-chat-composer"><div class="pending-media-preview" id="channel-media-preview" style="display:none;"></div><div class="chat-input-row">';
                    html+='<button class="chat-input-icon-btn" type="button" id="channel-attach-btn" title="Фото или видео"><svg class="hot-ui-icon" width="21" height="21" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M21.4 11.6l-8.9 8.9a6 6 0 0 1-8.5-8.5l9.4-9.4a4 4 0 0 1 5.7 5.7l-9.5 9.5a2 2 0 0 1-2.8-2.8l8.8-8.8" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg></button>';
                    html+='<input type="file" id="channel-file-input" accept="image/*,video/*" style="display:none;">';
                    html+='<input class="chat-input" id="channel-chat-input" autocomplete="off" placeholder="Написать сообщение...">';
                    html+='<button class="chat-send" id="channel-chat-send" type="button" aria-label="Отправить">➤</button>';
                    html+='</div></div>';
                }
                html+='</div>';

                contentInner.innerHTML=html;
                contentInner.querySelectorAll('#channel-chat-messages .community-msg').forEach(function(el){
                    var msgData={id:el.getAttribute('data-msg-id'),text:el.getAttribute('data-msg-text')||'',from:el.getAttribute('data-msg-from')||'',source:'channel',channel:c.username,file:null};
                    var own=msgData.from.toLowerCase()===String(currentUser.username).toLowerCase();
                    var pinned=el.getAttribute('data-pinned')==='1';
                    var items=[{action:'reply',icon:'↩',label:'Ответить',handler:function(){setReplyTarget(msgData);}},{action:'forward',icon:'→',label:'Переслать',handler:function(){openForwardModal(msgData);}}];
                    if(canManageCommunityPin(c.owner)) items.push({action:'pin',icon:hotIcon('pin',18),label:pinned?'Открепить':'Закрепить',handler:function(){apiPost('/api/channels/pin',{channel:c.username,messageId:msgData.id,pinned:!pinned}).then(function(){openChannel(c.username);}).catch(function(e){alert(e.message);});}});
                    if(own) items.push({action:'delete',icon:hotIcon('trash',18),label:'Удалить',danger:true,handler:function(){confirmDelete('Удалить это сообщение?',function(){apiPost('/api/channels/message/delete',{channel:c.username,messageId:msgData.id}).then(function(){openChannel(c.username);}).catch(function(e){alert(e.message);});});}});
                    items.push({action:'cancel',icon:'×',label:'Отмена',danger:true});
                    attachLongPress(el,msgData,items);
                });
                bindReplyPreviewClicks(contentInner);
                bindPinnedMessageBar(contentInner);
                var channelHeaderInfo=document.querySelector('#content-inner .chat-header-info');
                if(channelHeaderInfo){
                    channelHeaderInfo.classList.add('community-info-header-clickable');
                    channelHeaderInfo.title='Информация о канале';
                    channelHeaderInfo.onclick=function(e){
                        e.preventDefault();
                        e.stopPropagation();
                        openCommunityInfo(c,messages);
                    };
                }
                if(isOwner){
                    var sb=document.getElementById('channel-settings-btn');
                    if(sb){ sb.onclick=function(e){ e.preventDefault(); e.stopPropagation(); openCommunitySettings('channel',c); return false; }; }
                }

                document.getElementById('back-communities').addEventListener('click',function(){
                    document.body.classList.remove('m-chat');
                    openCommunities('channels');
                });

                document.getElementById('channel-subscribe-btn').addEventListener('click',function(){
                    apiPost('/api/channels/subscribe',{channel:c.username}).then(function(){openChannel(c.username);});
                });

                if(isOwner) {
                    var pendingChannelMedia=null;
                    var send=function(file){
                        if(!file && pendingChannelMedia) file=pendingChannelMedia;
                        var inp=document.getElementById('channel-chat-input');
                        if(!inp) return;
                        var text=(inp.value||'').trim();
                        if(!text && !file) return;
                        if(sendTooFast()) return;
                        var btn=document.getElementById('channel-chat-send');
                        if(btn) btn.disabled=true;
                        var payload={channel:c.username,text:text,replyTo:activeReplyTarget};
                        var request=Promise.resolve();
                        if(file) request=readFileAsDataUrl(file).then(function(data){ payload.file={name:file.name,data:data}; });
                        request.then(function(){ return apiPost('/api/channels/message',payload); }).then(function(){
                            var body = document.getElementById('channel-chat-messages');
                            var empty = body && body.querySelector('.community-chat-empty');
                            if (empty) empty.remove();
                            if (body && text) {
                                var now = new Date().toISOString();
                                var el = document.createElement('div');
                                el.className = 'community-msg own';
                                el.innerHTML = '<div class="msg-content"><div class="msg-bubble">' + escapeHtml(text) + '</div><div class="msg-meta">' + escapeHtml(userDisplayName(currentUser)) + ' · ' + formatTime(now) + '</div></div>';
                                body.appendChild(el);
                            }
                            if (inp) inp.value = '';
                            pendingChannelMedia=null;
                            showPendingMediaPreview('channel-media-preview', null);
                            var fi=document.getElementById('channel-file-input'); if(fi) fi.value='';
                            clearReplyTarget();
                            scrollChatToBottom(true);
                            if (btn) btn.disabled = false;
                            setTimeout(function(){ openChannel(c.username); }, 800);
                        }).catch(function(err){
                            if(btn) btn.disabled=false;
                            alert((err&&err.message)||'Не удалось отправить сообщение');
                        });
                    };
                    document.getElementById('channel-chat-send').addEventListener('click',function(){ send(null); });
                    document.getElementById('channel-attach-btn').addEventListener('click',function(){ document.getElementById('channel-file-input').click(); });
                    document.getElementById('channel-file-input').addEventListener('change',function(){
                        var file=this.files&&this.files[0];
                        if(!file) return;
                        if(file.size>20*1024*1024){ alert('Файл больше 20 МБ'); this.value=''; return; }
                        if((file.type||'').indexOf('image/')!==0 && (file.type||'').indexOf('video/')!==0){ alert('Можно выбрать только фото или видео'); this.value=''; return; }
                        pendingChannelMedia=file;
                        showPendingMediaPreview('channel-media-preview', pendingChannelMedia, function(){
                            pendingChannelMedia=null; var fi=document.getElementById('channel-file-input'); if(fi) fi.value=''; showPendingMediaPreview('channel-media-preview',null);
                        });
                    });
                    document.getElementById('channel-chat-input').addEventListener('keydown',function(e){
                        if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}
                    });
                    setTimeout(function(){
                        var body=document.getElementById('channel-chat-messages');
                        if(body) body.scrollTop=body.scrollHeight;
                        var inp=document.getElementById('channel-chat-input');
                        if(inp) inp.focus();
                    },0);
                } else {
                    setTimeout(function(){
                        var body=document.getElementById('channel-chat-messages');
                        if(body) body.scrollTop=body.scrollHeight;
                    },0);
                }
            }).catch(function(){
                contentInner.innerHTML='<div class="community-empty">Канал не найден</div>';
            });
        }

        function openGroupChat(chatId) {
            clearReplyTarget();
            clearChatElements();
            chatlistEl.classList.add('hidden');
            infoPanel.classList.remove('visible');
            document.body.classList.add('m-chat');
            contentInner.innerHTML='<div style="text-align:center;padding:40px;color:var(--text-3);">Загрузка...</div>';

            apiGet('/api/chats/messages?id='+encodeURIComponent(chatId)).then(function(r){
                var chat=r.chat;
                var msgs=r.messages||[];

                var html='<div class="community-chat-page">';
                html+='<div class="chat-header">';
                html+='<button class="chat-back-btn" id="back-communities-chat">←</button>';
                html+='<div class="chat-header-info"><div class="chat-header-avatar"><svg class="hot-ui-icon" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 5h16v11H8l-4 4Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg></div><div class="chat-header-meta"><div class="chat-header-name">'+escapeHtml(chat.name)+'</div><div class="chat-header-status">'+chat.memberCount+' участников</div></div></div>';
                
                if(currentUser && chat.owner && chat.owner.toLowerCase()===currentUser.username.toLowerCase()) html+='<button class="community-settings-gear" id="group-settings-btn" title="Настройки">⚙️</button>';
                html+='</div>';
                var chatPinnedMsg = msgs.find(function(x){ return x.pinned===true || String(x.id||'')===String(r.chat && r.chat.pinnedMessageId || r.pinnedMessageId || ''); });
                if(chatPinnedMsg){ html+=pinnedMessageBarHtml(chatPinnedMsg); }

                html+='<div class="community-chat-body" id="group-chat-messages">';
                if(!msgs.length) {
                    html+='<div class="community-chat-empty"><div><div style="font-size:15px;margin-bottom:6px;">В чате пока нет сообщений</div><div>Напишите первое сообщение</div></div></div>';
                } else {
                    msgs.forEach(function(m){
                        var own=m.from.toLowerCase()===currentUser.username.toLowerCase();
                        html+='<div class="community-msg '+(own?'own':'')+'" data-msg-id="'+escapeHtml(m.id||'')+'" data-msg-from="'+escapeHtml(m.from||'')+'" data-msg-text="'+escapeHtml(m.text||'')+'" data-pinned="'+(m.id===r.chat.pinnedMessageId?'1':'0')+'"><div class="msg-content">'+replyPreviewHtml(m,'community-reply-preview')+communityAttachmentHtml(m.file)+'<div class="msg-bubble"'+((m.text||'')?'':' style="display:none;"')+'>'+escapeHtml(m.text||'')+'</div><div class="msg-meta">'+escapeHtml(messageDisplayName(m))+' · '+formatTime(m.createdAt)+((m.pinned===true || m.id===r.chat.pinnedMessageId)?' · '+hotIcon('pin',14):'')+'</div></div></div>';
                    });
                }
                html+='</div>';

                html+='<div class="community-chat-composer"><div class="pending-media-preview" id="group-media-preview" style="display:none;"></div><div class="chat-input-row">';
                html+='<button class="chat-input-icon-btn" type="button" id="group-chat-attach-btn" title="Фото или видео"><svg class="hot-ui-icon" width="21" height="21" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M21.4 11.6l-8.9 8.9a6 6 0 0 1-8.5-8.5l9.4-9.4a4 4 0 0 1 5.7 5.7l-9.5 9.5a2 2 0 0 1-2.8-2.8l8.8-8.8" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg></button>';
                html+='<input type="file" id="group-chat-file-input" accept="image/*,video/*" style="display:none;">';
                html+='<input class="chat-input" id="group-chat-input" autocomplete="off" placeholder="Написать сообщение...">';
                html+='<button class="chat-send" id="group-chat-send" type="button" aria-label="Отправить">➤</button>';
                html+='</div></div>';
                html+='</div>';

                contentInner.innerHTML=html;
                contentInner.querySelectorAll('#group-chat-messages .community-msg').forEach(function(el){
                    var msgData={id:el.getAttribute('data-msg-id'),text:el.getAttribute('data-msg-text')||'',from:el.getAttribute('data-msg-from')||'',source:'chat',chatId:chatId};
                    var own=msgData.from.toLowerCase()===String(currentUser.username).toLowerCase();
                    var pinned=el.getAttribute('data-pinned')==='1';
                    var items=[{action:'reply',icon:'↩',label:'Ответить',handler:function(){setReplyTarget(msgData);}},{action:'forward',icon:'→',label:'Переслать',handler:function(){openForwardModal(msgData);}}];
                    if(canManageCommunityPin(chat.owner)) items.push({action:'pin',icon:hotIcon('pin',18),label:pinned?'Открепить':'Закрепить',handler:function(){apiPost('/api/chats/pin',{chatId:chatId,messageId:msgData.id,pinned:!pinned}).then(function(){openGroupChat(chatId);}).catch(function(e){alert(e.message);});}});
                    if(own) items.push({action:'delete',icon:hotIcon('trash',18),label:'Удалить',danger:true,handler:function(){confirmDelete('Удалить это сообщение?',function(){apiPost('/api/chats/message/delete',{chatId:chatId,messageId:msgData.id}).then(function(){openGroupChat(chatId);}).catch(function(e){alert(e.message);});});}});
                    items.push({action:'cancel',icon:'×',label:'Отмена',danger:true});
                    attachLongPress(el,msgData,items);
                });
                bindReplyPreviewClicks(contentInner);
                bindPinnedMessageBar(contentInner);
                if(currentUser && chat.owner && chat.owner.toLowerCase()===currentUser.username.toLowerCase()){
                    var gb=document.getElementById('group-settings-btn');
                    if(gb){ gb.onclick=function(e){ e.preventDefault(); e.stopPropagation(); openCommunitySettings('chat',chat); return false; }; }
                }

                document.getElementById('back-communities-chat').addEventListener('click',function(){
                    document.body.classList.remove('m-chat');
                    openCommunities('chats');
                });

                var pendingGroupMedia=null;
                var send=function(file){
                    if(!file && pendingGroupMedia) file=pendingGroupMedia;
                    var inp=document.getElementById('group-chat-input');
                    if(!inp) return;
                    var text=(inp.value||'').trim();
                    if(!text && !file) return;
                    if(sendTooFast()) return;
                    var btn=document.getElementById('group-chat-send');
                    if(btn) btn.disabled=true;
                    var payload={id:chatId,text:text,replyTo:activeReplyTarget};
                    var request=Promise.resolve();
                    if(file) request=readFileAsDataUrl(file).then(function(data){ payload.file={name:file.name,data:data}; });
                    request.then(function(){ return apiPost('/api/chats/message',payload); }).then(function(){
                        var body = document.getElementById('group-chat-messages');
                        var empty = body && body.querySelector('.community-chat-empty');
                        if (empty) empty.remove();
                        if (body && text) {
                            var now = new Date().toISOString();
                            var el = document.createElement('div');
                            el.className = 'community-msg own';
                            el.innerHTML = '<div class="msg-content"><div class="msg-bubble">' + escapeHtml(text) + '</div><div class="msg-meta">' + escapeHtml(userDisplayName(currentUser)) + ' · ' + formatTime(now) + '</div></div>';
                            body.appendChild(el);
                        }
                        if (inp) inp.value = '';
                        pendingGroupMedia=null;
                        showPendingMediaPreview('group-media-preview', null);
                        var fi=document.getElementById('group-chat-file-input'); if(fi) fi.value='';
                        clearReplyTarget();
                        scrollChatToBottom(true);
                        if (btn) btn.disabled = false;
                        setTimeout(function(){ openGroupChat(chatId); }, 800);
                    }).catch(function(err){
                        if(btn) btn.disabled=false;
                        alert((err&&err.message)||'Не удалось отправить сообщение');
                    });
                };
                document.getElementById('group-chat-send').addEventListener('click',function(){ send(null); });
                document.getElementById('group-chat-attach-btn').addEventListener('click',function(){ document.getElementById('group-chat-file-input').click(); });
                document.getElementById('group-chat-file-input').addEventListener('change',function(){
                    var file=this.files&&this.files[0];
                    if(!file) return;
                    if(file.size>20*1024*1024){ alert('Файл больше 20 МБ'); this.value=''; return; }
                    if((file.type||'').indexOf('image/')!==0 && (file.type||'').indexOf('video/')!==0){ alert('Можно выбрать только фото или видео'); this.value=''; return; }
                    pendingGroupMedia=file;
                    showPendingMediaPreview('group-media-preview', pendingGroupMedia, function(){
                        pendingGroupMedia=null; var fi=document.getElementById('group-chat-file-input'); if(fi) fi.value=''; showPendingMediaPreview('group-media-preview',null);
                    });
                });
                document.getElementById('group-chat-input').addEventListener('keydown',function(e){
                    if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}
                });
                setTimeout(function(){
                    var body=document.getElementById('group-chat-messages');
                    if(body) body.scrollTop=body.scrollHeight;
                    var inp=document.getElementById('group-chat-input');
                    if(inp) inp.focus();
                },0);
            }).catch(function(){
                contentInner.innerHTML='<div class="community-empty">Чат не найден</div>';
            });
        }

        function openMessages(tab) {
            currentTab = 'dm';
            setActiveNav('nav-messages');
            clearChatElements();
            document.body.classList.add('m-list');
            dmPartner = null;
            contentEl.style.display = 'flex';
            chatlistEl.classList.remove('hidden');
            infoPanel.classList.remove('visible');
            contentInner.innerHTML = '<div class="empty-state"><div class="empty-state-icon"><svg class="hot-ui-icon" width="28" height="28" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 5h16v11H8l-4 4Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg></div><div class="empty-state-title">' + t('selectChat') + '</div><div class="empty-state-text">' + t('selectChatDesc') + '</div></div>';
            document.querySelectorAll('.chatlist-tab').forEach(function (el) {
                el.classList.toggle('active', el.getAttribute('data-tab') === 'dm');
            });
            loadChatList();
        }
        function loadChatList() {
            chatlistBody.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-3);">Загрузка...</div>';
            apiGet('/api/dm/conversations').then(function (r) {
                var dms = r.conversations || [];
                var all = [];
                dms.forEach(function (c) {
                    all.push({ type:'dm', id:c.username, name:c.username, avatar:c.avatar, handle:c.handle, lastText:c.lastText, lastType:c.lastType, lastCallType:c.lastCallType, lastSystem: c.lastSystem, lastAt:c.lastAt, lastFrom:c.lastFrom, unread:c.unread, data:c });
                });
                all.sort(function (a, b) { return new Date(b.lastAt || 0) - new Date(a.lastAt || 0); });
                renderChatList(all);
            }).catch(function(){ chatlistBody.innerHTML='<div class="chatlist-empty">Не удалось загрузить сообщения</div>'; });
        }
        function renderChatList(items) {
            if (!items.length) {
                chatlistBody.innerHTML = '<div class="chatlist-empty">' + t('noChats') + '</div>';
                return;
            }
            var html = '';
            items.forEach(function (c) {
                var isUnread = c.unread > 0;
                var isSystem = isSystemName(c.name);
                var prefix = (c.lastFrom && currentUser && c.lastFrom.toLowerCase() === currentUser.username.toLowerCase()) ? 'Вы: ' : '';
                html += '<div class="chat-item' + (isUnread ? ' unread' : '') + '" data-chat-type="' + c.type + '" data-chat-id="' + escapeHtml(c.id) + '">';
                html += '<div class="chat-item-avatar' + (isSystem ? ' system' : '') + '">' + (isSystem ? '🛡' : avatarHTML(c)) + '</div>';
                html += '<div class="chat-item-body">';
                html += '<div class="chat-item-top"><div class="chat-item-name">' + escapeHtml(c.name) + (isSystem ? '<span class="system-badge">система</span>' : '') + '</div><div class="chat-item-time">' + formatTime(c.lastAt) + '</div></div>';
                if (c.lastSystem) {
                    html += '<div class="chat-item-preview">🛡 ' + escapeHtml(c.lastText || 'Системное сообщение') + '</div>';
                } else if (c.lastType === 'call') {
                    html += '<div class="chat-item-preview chat-call-preview">' + phoneIconSvg(15) + '<span>' + escapeHtml(c.lastText || 'Звонок') + '</span></div>';
                } else {
                    html += '<div class="chat-item-preview">' + escapeHtml(prefix + (c.lastText || '')) + '</div>';
                }
                html += '</div>';
                if (isUnread) html += '<div class="chat-item-unread">' + (c.unread > 99 ? '99+' : c.unread) + '</div>';
                html += '</div>';
            });
            chatlistBody.innerHTML = html;
            chatlistBody.querySelectorAll('.chat-item').forEach(function (el) {
                el.addEventListener('click', function () {
                    var type = el.getAttribute('data-chat-type');
                    var id = el.getAttribute('data-chat-id');
                    document.querySelectorAll('.chat-item').forEach(function (x) { x.classList.remove('active'); });
                    el.classList.add('active');
                    if (type === 'dm') {
                        var c = items.filter(function (x) { return x.id === id && x.type === 'dm'; })[0];
                        if (c) openDm(c.data);
                    }
                });
            });
        }

        function openDm(user) {
            clearReplyTarget();
            if (!user) return;
            clearChatElements();
            document.body.classList.add('m-chat');
            dmPartner = user;
            chatlistEl.classList.remove('hidden');
            contentEl.style.display = 'flex';
            infoPanel.classList.add('visible');
            renderInfoPanel(user);
            renderChatHeader(user);
            contentInner.innerHTML = '<div class="chat-body" id="chat-messages"><div style="text-align:center;padding:20px;color:var(--text-3);">Загрузка...</div></div>';
            var isSystemChat = isSystemName(user.username);
            if (!isSystemChat) {
                renderChatInput();
            } else {
                var note = document.createElement('div');
                note.className = 'dm-system-note';
                note.id = 'dm-system-note';
                note.textContent = '🛡 Это системный аккаунт Hot. Здесь публикуются уведомления о безопасности. Ответить нельзя.';
                var chatBody = document.getElementById('chat-messages');
                if (chatBody && chatBody.parentNode) chatBody.parentNode.insertBefore(note, chatBody);
            }
            if (!isSystemChat) {
                apiGet('/api/users/block-status?target=' + encodeURIComponent(user.username)).then(function (res) {
                    dmBlocked = !!(res.iBlocked || res.heBlocked);
                    dmBlockedByMe = !!res.iBlocked;
                    if (dmBlocked) renderBlockedBanner();
                });
            }
            startDmPolling();
            startChatStatusPolling();
        }
        function renderChatHeader(user) {
            var header = document.createElement('div');
            header.className = 'chat-header';
            var isChannel = user.isChannel;
            var isSystem = isSystemName(user.username);
            var nameHtml = escapeHtml(user.name || displayUserName(user.username)) + (isSystem ? ' <span class="system-badge" style="font-size:10px;padding:1px 6px;border-radius:6px;background:var(--accent-grad);color:#fff;font-weight:700;vertical-align:middle;">система</span>' : '');
            var statusHtml = isSystem ? 'Официальные уведомления Hot' : '...';
            var statusClass = isSystem ? 'chat-header-status system' : 'chat-header-status';
            header.innerHTML = '<div class="chat-header-info"><div class="chat-header-avatar' + (isSystem ? ' system' : '') + '" id="chat-header-avatar">' + (isSystem ? '🛡' : avatarHTML(user)) + '</div><div class="chat-header-meta"><div class="chat-header-name' + (isSystem || isChannel ? '' : ' clickable') + '">' + nameHtml + '</div><div class="' + statusClass + '" id="chat-header-status">' + statusHtml + '</div></div></div><div class="chat-header-actions">' + ((isChannel || isSystem) ? '' : '<button class="chat-header-btn" id="dm-call-btn" title="Позвонить">' + phoneIconSvg(20) + '</button>') + '</div>';
            contentEl.insertBefore(header, contentInner);
            var backBtn = document.createElement('button');
            backBtn.type = 'button'; backBtn.className = 'chat-back-btn'; backBtn.textContent = '←';
            backBtn.addEventListener('click', function () { openMessages(); });
            header.insertBefore(backBtn, header.firstChild);
            var nameBtn = header.querySelector('.chat-header-name.clickable');
            if (nameBtn) nameBtn.addEventListener('click', function () { openWall(user.username); });
            var callBtn = document.getElementById('dm-call-btn');
            if (callBtn) callBtn.addEventListener('click', startCall);
            if (!isSystem) updateChatHeaderStatus();
        }
        function updateChatHeaderStatus() {
            if (!dmPartner) return;
            if (isSystemName(dmPartner.username)) return;
            apiGet('/api/user/status?username=' + encodeURIComponent(dmPartner.username)).then(function (res) {
                var statusEl = document.getElementById('chat-header-status');
                var avatarEl = document.getElementById('chat-header-avatar');
                if (!statusEl) return;
                var txt = formatLastSeen(res.lastSeen);
                statusEl.textContent = txt;
                statusEl.classList.toggle('online', isOnline(res.lastSeen));
                if (avatarEl) avatarEl.classList.toggle('online', isOnline(res.lastSeen));
            }).catch(function(){});
        }
        function startChatStatusPolling() {
            if (chatStatusInterval) clearInterval(chatStatusInterval);
            chatStatusInterval = setInterval(updateChatHeaderStatus, 15000);
        }
        var SEND_COOLDOWN_MS = 600, lastSendAt = 0;
        function sendTooFast() {
            var now = Date.now();
            if (now - lastSendAt < SEND_COOLDOWN_MS) return true;
            lastSendAt = now;
            return false;
        }
        function renderChatInput() {
            var oldInput = contentEl.querySelector('.chat-input-area');
            if (oldInput) oldInput.remove();
            var inputArea = document.createElement('div');
            inputArea.className = 'chat-input-area';
            inputArea.innerHTML = '<div class="pending-media-preview" id="dm-media-preview" style="display:none;"></div><div class="chat-input-row"><input type="text" class="chat-input" id="chat-input-field" placeholder="Написать сообщение..." maxlength="2000"><label class="chat-input-icon-btn" for="dm-image-input" title="Фото или видео" style="cursor:pointer;"><svg class="hot-ui-icon" width="21" height="21" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M21.4 11.6l-8.9 8.9a6 6 0 0 1-8.5-8.5l9.4-9.4a4 4 0 0 1 5.7 5.7l-9.5 9.5a2 2 0 0 1-2.8-2.8l8.8-8.8" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg></label><input type="file" id="dm-image-input" accept="image/*,video/*" style="display:none;"><button class="chat-send" id="chat-send-btn" type="button" aria-label="Отправить"><svg class="hot-ui-icon" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" fill="currentColor"/></svg></button></div><div class="chat-error" id="chat-error"></div>';
            contentEl.appendChild(inputArea);
            var input = document.getElementById('chat-input-field');
            var sendBtn = document.getElementById('chat-send-btn');
            var emojiBtn = document.getElementById('emoji-btn');
            var imageInput = document.getElementById('dm-image-input');
            var pendingMediaFile = null;
            function sendText() {
                var text = input.value.trim();
                if ((!text && !pendingMediaFile) || !dmPartner) return;
                if (dmBlocked) { showChatError('Сообщение невозможно: блокировка'); return; }
                if (sendTooFast()) return;
                sendBtn.disabled = true;
                var payload = { to: dmPartner.username, text: text, replyTo: activeReplyTarget };
                var fileToSend = pendingMediaFile;
                var request = Promise.resolve();
                if(fileToSend){
                    if(fileToSend.size > 20*1024*1024){ showChatError('Файл больше 20 МБ'); sendBtn.disabled=false; return; }
                    request = readFileAsDataUrl(fileToSend).then(function(data){
                        if((fileToSend.type||'').indexOf('video/')===0) payload.video=data;
                        else payload.image=data;
                    });
                }
                request.then(function(){ return apiPost('/api/dm', payload); }).then(function () {
                    input.value = '';
                    pendingMediaFile = null;
                    showPendingMediaPreview('dm-media-preview', null);
                    imageInput.value = '';
                    clearReplyTarget();
                    loadDmMessages(true);
                    scrollChatToBottom(true);
                }).catch(function(e){ showChatError(e.message); })
                  .then(function(){ sendBtn.disabled = false; input.focus(); });
            }
            sendBtn.addEventListener('click', sendText);
            input.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); }
            });
            if (emojiBtn) emojiBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                showEmojiPicker(emojiBtn, function (emoji) { input.value += emoji; input.focus(); });
            });
            imageInput.addEventListener('change', function (e) {
                var file = e.target.files && e.target.files[0];
                if (!file || !dmPartner) return;
                if (dmBlocked) { showChatError('Отправка невозможна: блокировка'); imageInput.value=''; return; }
                if (file.size > 20*1024*1024) { showChatError('Файл больше 20 МБ'); imageInput.value=''; return; }
                if((file.type||'').indexOf('image/')!==0 && (file.type||'').indexOf('video/')!==0){
                    showChatError('Можно выбрать только фото или видео'); imageInput.value=''; return;
                }
                pendingMediaFile=file;
                showPendingMediaPreview('dm-media-preview', pendingMediaFile, function(){
                    pendingMediaFile=null; imageInput.value=''; showPendingMediaPreview('dm-media-preview',null);
                });
            });
        }
        function openPhotoSendModal(dataURL) {
            var modal = document.getElementById('photo-send-modal');
            var img = document.getElementById('photo-send-img');
            var caption = document.getElementById('photo-send-caption');
            var submitBtn = document.getElementById('photo-send-submit');
            var cancelBtn = document.getElementById('photo-send-cancel');
            var closeBtn = document.getElementById('photo-send-close');
            img.src = dataURL;
            caption.value = '';
            modal.classList.remove('hidden');
            setTimeout(function () { caption.focus(); }, 100);
            var newSubmit = submitBtn.cloneNode(true); submitBtn.parentNode.replaceChild(newSubmit, submitBtn);
            var newCancel = cancelBtn.cloneNode(true); cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);
            var newClose = closeBtn.cloneNode(true); closeBtn.parentNode.replaceChild(newClose, closeBtn);
            function closeModal() { modal.classList.add('hidden'); img.src = ''; caption.value = ''; }
            newSubmit.addEventListener('click', function () {
                if (!dmPartner) return;
                if (sendTooFast()) return;
                newSubmit.disabled = true;
                var text = caption.value.trim();
                apiPost('/api/dm', { to: dmPartner.username, text: text, image: dataURL, replyTo: activeReplyTarget }).then(function () {
                    closeModal();
                    clearReplyTarget();
                    loadDmMessages(true);
                    scrollChatToBottom(true);
                }).catch(function (e) { showChatError(e.message || 'Ошибка отправки'); })
                  .then(function () { newSubmit.disabled = false; });
            });
            newCancel.addEventListener('click', closeModal);
            newClose.addEventListener('click', closeModal);
            modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });
            caption.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); newSubmit.click(); }
            });
        }
        
function hotIcon(name, size) {
 var s=size||20;
 var p={"paperclip": "<path d=\"M21.4 11.6l-8.9 8.9a6 6 0 0 1-8.5-8.5l9.4-9.4a4 4 0 0 1 5.7 5.7l-9.5 9.5a2 2 0 0 1-2.8-2.8l8.8-8.8\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.9\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>", "send": "<path d=\"M2.01 21L23 12 2.01 3 2 10l15 2-15 2z\" fill=\"currentColor\"/>", "bell": "<path d=\"M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>", "settings": "<path d=\"M12 8.3a3.7 3.7 0 1 0 0 7.4 3.7 3.7 0 0 0 0-7.4ZM19.4 13.5a7.7 7.7 0 0 0 .1-1.5 7.7 7.7 0 0 0-.1-1.5l2-1.5-2-3.4-2.4 1a8 8 0 0 0-2.6-1.5L14 2h-4l-.4 3.1A8 8 0 0 0 7 6.6l-2.4-1-2 3.4 2 1.5A7.7 7.7 0 0 0 4.5 12c0 .5 0 1 .1 1.5l-2 1.5 2 3.4 2.4-1a8 8 0 0 0 2.6 1.5L10 22h4l.4-3.1a8 8 0 0 0 2.6-1.5l2.4 1 2-3.4-2-1.5Z\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.55\" stroke-linejoin=\"round\"/>", "users": "<path d=\"M16 20v-1.4a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V20M9.5 10.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM17 11a3 3 0 1 0 0-6M21 20v-1.5a4 4 0 0 0-3-3.8\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\"/>", "image": "<rect x=\"3\" y=\"4\" width=\"18\" height=\"16\" rx=\"2\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\"/><circle cx=\"8.5\" cy=\"9\" r=\"1.5\" fill=\"currentColor\"/><path d=\"m4.5 17 4.5-4 3.5 3 2.5-2 4.5 4\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>", "trash": "<path d=\"M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>", "pin": "<path d=\"m15 4 5 5-3 3v4l-2 2-3-3-5 5-1-1 5-5-3-3 2-2h4Z\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linejoin=\"round\"/>", "shield": "<path d=\"M12 3 20 6v5c0 5-3.3 8.3-8 10-4.7-1.7-8-5-8-10V6l8-3Z\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linejoin=\"round\"/><path d=\"m9 12 2 2 4-4\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>", "camera": "<path d=\"M4 7h3l1.5-2h7L17 7h3v12H4Z\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linejoin=\"round\"/><circle cx=\"12\" cy=\"13\" r=\"3.2\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\"/>", "eye": "<path d=\"M2.5 12s3.5-5 9.5-5 9.5 5 9.5 5-3.5 5-9.5 5-9.5-5-9.5-5Z\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\"/><circle cx=\"12\" cy=\"12\" r=\"2.5\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\"/>", "block": "<circle cx=\"12\" cy=\"12\" r=\"9\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\"/><path d=\"m6 6 12 12\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\"/>", "edit": "<path d=\"m4 20 4.2-1 9.8-9.8a2.8 2.8 0 0 0-4-4L4.2 15 4 20Z\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linejoin=\"round\"/><path d=\"m13 6 4 4\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\"/>", "chat": "<path d=\"M4 5h16v11H8l-4 4Z\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linejoin=\"round\"/>", "channel": "<path d=\"M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5h-7L6 20v-3H6.5A2.5 2.5 0 0 1 4 14.5Z\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linejoin=\"round\"/><path d=\"M8 9h8M8 12h5\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\"/>"};
 return '<svg class="hot-ui-icon" width="'+s+'" height="'+s+'" viewBox="0 0 24 24" aria-hidden="true" focusable="false">'+(p[name]||p.chat)+'</svg>';
}

function showEmojiPicker(anchor, cb) {
            var old = document.getElementById('emoji-picker');
            if (old) { old.remove(); return; }
            var emojis = ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩','😘','😗','😚','😙','🥲','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🤐','🤨','😐','😑','😶','😏','😒','🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🥵','🥶','😵','🤯','🤠','🥳','😎','🤓','🧐','😕','😟','🙁','😮','😯','😲','😳','🥺','😦','😧','😨','😰','😥','😢','😭','😱','😖','😣','😞','😓','😩','😫','🥱','😤','😡','😠','🤬','😈','👿','💀','☠️','💩','🤡','👹','👺','👻','👽','👾','🤖','❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','👍','👎','👌','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','👇','☝️','✋','🤚','🖐','🖖','👋','🤝','🙏','💪','👀','💋'];
            var picker = document.createElement('div');
            picker.className = 'emoji-picker';
            picker.id = 'emoji-picker';
            picker.innerHTML = emojis.map(function (em) { return '<button type="button">' + em + '</button>'; }).join('');
            var inputArea = contentEl.querySelector('.chat-input-area');
            if (!inputArea) return;
            inputArea.appendChild(picker);
            picker.querySelectorAll('button').forEach(function (b) {
                b.addEventListener('click', function (e) { e.stopPropagation(); cb(b.textContent); });
            });
            setTimeout(function () {
                document.addEventListener('click', function closeP(e) {
                    if (!picker.contains(e.target) && e.target !== anchor) { picker.remove(); document.removeEventListener('click', closeP); }
                });
            }, 100);
        }
        function showChatError(msg) {
            var err = document.getElementById('chat-error');
            if (!err) return;
            err.textContent = msg;
            err.classList.add('visible');
            setTimeout(function () { err.classList.remove('visible'); }, 3000);
        }
        function renderBlockedBanner() {
            var old = document.getElementById('dm-blocked-banner');
            if (old) old.remove();
            var body = document.getElementById('chat-messages');
            if (!body) return;
            var banner = document.createElement('div');
            banner.id = 'dm-blocked-banner';
            banner.className = 'dm-blocked-banner';
            banner.textContent = dmBlockedByMe ? 'Вы заблокировали этого пользователя' : 'Пользователь заблокировал вас';
            body.parentNode.insertBefore(banner, body);
        }
        function loadDmMessages(forceScroll) {
            if (!dmPartner) return;
            var body = document.getElementById('chat-messages');
            if (!body) return;
            apiGet('/api/dm?with=' + encodeURIComponent(dmPartner.username)).then(function (data) {
                var msgs = data.messages || [];
                dmPinnedMessageId = data.pinnedMessageId || null;
                var newLast = msgs.length ? msgs[msgs.length - 1].id : null;
                if (!forceScroll && newLast === dmLastMessageId) return;
                var wasAtBottom = (body.scrollHeight - body.scrollTop - body.clientHeight) < 120;
                dmLastMessageId = newLast;
                renderDmPinnedBar(body, msgs);
                renderDmMessages(body, msgs);
                if (forceScroll || wasAtBottom) scrollChatToBottom(forceScroll);
            });
        }
        function renderDmMessages(body, msgs) {
            if (!msgs.length) { body.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-3);">Напиши первое сообщение</div>'; return; }
            var html = '';
            var lastDate = '';
            msgs.forEach(function (m) {
                var d = new Date(m.createdAt);
                var dayStr = d.toLocaleDateString(currentLang === 'ru' ? 'ru-RU' : 'en-US');
                if (dayStr !== lastDate) { lastDate = dayStr; html += '<div class="chat-date-sep"><span>' + dayStr + '</span></div>'; }
                var own = m.from && m.from.toLowerCase() === currentUser.username.toLowerCase();
                var isSystemMsg = m.system || isSystemName(m.from);
                if (isSystemMsg) {
                    html += '<div class="msg-system"><span class="msg-system-icon">🛡</span>' + escapeHtml(m.text || '').replace(/\{\{time:([^}]*)\}\}/g, function (_, iso) { var d = new Date(iso); return isNaN(d.getTime()) ? '' : d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }).replace(/\n/g, '<br>') + '</div>';
                    return;
                }
                if (m.type === 'call') {
                    var mine = currentUser && m.from && m.from.toLowerCase() === currentUser.username.toLowerCase();
                    var ct = m.callType || 'outgoing', lbl, cls = ct;
                    if (ct === 'outgoing') { lbl = mine ? 'Исходящий звонок' : 'Входящий звонок'; cls = 'ok'; }
                    else if (ct === 'missed') { lbl = mine ? 'Нет ответа' : 'Пропущенный звонок'; cls = mine ? 'ok' : 'missed'; }
                    else if (ct === 'cancelled') { lbl = mine ? 'Отменённый звонок' : 'Пропущенный звонок'; cls = mine ? 'ok' : 'missed'; }
                    else if (ct === 'declined') { lbl = mine ? 'Звонок отклонён' : 'Вы отклонили звонок'; cls = 'ok'; }
                    else lbl = 'Звонок';
                    var dur = '';
                    if (m.duration > 0) { var mm = Math.floor(m.duration / 60), ss = m.duration % 60; dur = ' · ' + (mm < 10 ? '0' : '') + mm + ':' + (ss < 10 ? '0' : '') + ss; }
                    html += '<div class="msg-call ' + cls + '"><span>' + phoneIconSvg(18) + '</span><span>' + lbl + dur + '</span></div>';
                    return;
                }
                var imageHtml = (m.image && m.image.length > 0) ? '<img class="msg-image" src="' + escapeHtml(m.image) + '" alt="">' : '';
                var forwarded = m.forwardedFrom ? '<div class="forwarded-label">↪ Переслано от ' + escapeHtml(m.forwardedFrom) + '</div>' : '';
                html += '<div class="msg' + (own ? ' own' : '') + '" data-msg-id="' + escapeHtml(m.id || '') + '" data-msg-from="' + escapeHtml(m.from) + '" data-msg-text="' + escapeHtml(m.text) + '">';
                if (!own) html += '<div class="msg-avatar">' + avatarHTML(dmPartner) + '</div>';
                html += '<div class="msg-content">';
                html += '<div class="msg-bubble" data-msg-text="' + escapeHtml(m.text) + '" data-msg-from="' + escapeHtml(m.from) + '" data-msg-id="' + escapeHtml(m.id || '') + '" data-pinned="' + (m.id===dmPinnedMessageId?'1':'0') + '">' + replyPreviewHtml(m) + forwarded + (m.text ? escapeHtml(m.text) : '') + imageHtml + '</div>';
                html += '<div class="msg-meta">' + formatTime(m.createdAt);
                if (own) html += '<span class="msg-meta-status ' + (m.read ? 'read' : 'delivered') + '">' + (m.read ? '✓✓' : '✓') + '</span>';
                html += '</div></div></div>';
            });
            body.innerHTML = html;
            body.scrollTop = body.scrollHeight;
            body.querySelectorAll('.msg-bubble').forEach(function (bubble) {
                var fullMsg = msgs.find(function(x){ return String(x.id||'')===String(bubble.getAttribute('data-msg-id')||''); }) || {};
                var msgData = { id: bubble.getAttribute('data-msg-id'), text: bubble.getAttribute('data-msg-text'), from: bubble.getAttribute('data-msg-from'), image:fullMsg.image||'', file:fullMsg.file||null, source:'dm' };
                var own = msgData.from && msgData.from.toLowerCase() === currentUser.username.toLowerCase();
                var items = [{ action:'reply', icon:'↩', label:'Ответить', handler:function(){ setReplyTarget(msgData); } }, { action: 'forward', icon: '↪', label: 'Переслать', handler: function () { openForwardModal(msgData); } }];
                items.push({ action:'pin', icon:hotIcon('pin',18), label: bubble.getAttribute('data-pinned')==='1'?'Открепить':'Закрепить', handler:function(){ apiPost('/api/dm/pin',{messageId:msgData.id,pinned:bubble.getAttribute('data-pinned')!=='1'}).then(function(){loadDmMessages(true);}).catch(function(e){alert(e.message);}); } });
                if (own && msgData.id) {
                    items.push({ action: 'delete', icon: hotIcon('trash',18), label: 'Удалить', danger: true, handler: function () {
                        confirmDelete('Удалить это сообщение?', function () {
                            apiPost('/api/dm/delete', { messageId: msgData.id }).then(function () { loadDmMessages(true); });
                        });
                    }});
                }
                items.push({ action: 'cancel', icon: '✕', label: 'Отмена', danger: true });
                attachLongPress(bubble, msgData, items);
            });
            bindReplyPreviewClicks(body);
        }
        function startDmPolling() { stopDmPolling(); dmLastMessageId = null; loadDmMessages(true); dmPollTimer = setInterval(function () { loadDmMessages(false); }, 2500); }
        function stopDmPolling() { if (dmPollTimer) { clearInterval(dmPollTimer); dmPollTimer = null; } }

        function renderInfoPanel(user) {
            var isChannel = user.isChannel;
            var isSystem = isSystemName(user.username);
            var html = '<div class="info-panel-header"><div class="info-panel-banner"></div><div class="info-panel-avatar" id="info-panel-avatar">' + (isSystem ? '🛡' : avatarHTML(user)) + '</div><div class="info-panel-name">' + escapeHtml(user.name || displayUserName(user.username)) + (isSystem ? ' <span class="system-badge" style="font-size:10px;padding:1px 6px;border-radius:6px;background:var(--accent-grad);color:#fff;font-weight:700;vertical-align:middle;">система</span>' : '') + '</div><div class="info-panel-status" id="info-panel-status">' + (isSystem ? 'Официальный аккаунт Hot' : '...') + '</div>';
            html += '</div>';
            html += '<div class="info-panel-section"><div class="info-panel-section-title">Информация</div>';
            html += '<div class="info-panel-info-row"><span class="info-panel-info-label">Юзернейм</span><span class="info-panel-info-value">@' + escapeHtml(user.username || '') + '</span></div>';
            html += '<div class="info-panel-info-row"><span class="info-panel-info-label">Имя</span><span class="info-panel-info-value">' + escapeHtml(user.username || '') + '</span></div>';
            html += '</div>';
            if (!isSystem) {
                html += '<div class="info-panel-section"><div class="info-panel-section-title">Настройки чата</div>';
                html += '<div class="info-panel-toggle"><span class="info-panel-toggle-label">Уведомления</span><span class="info-panel-toggle-switch active"></span></div>';
                html += '<div class="info-panel-toggle"><span class="info-panel-toggle-label">Звук сообщений</span><span class="info-panel-toggle-switch active"></span></div>';
                html += '<div class="info-panel-toggle"><span class="info-panel-toggle-label">Сохранение в галерею</span><span class="info-panel-toggle-switch"></span></div>';
                html += '<div class="info-panel-danger" id="info-block"><svg class="hot-ui-icon" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m6 6 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg> Чёрный список</div>';
                html += '</div>';
            }
            infoPanel.innerHTML = html;
            infoPanel.querySelectorAll('.info-panel-toggle').forEach(function (el) {
                el.addEventListener('click', function () {
                    var sw = el.querySelector('.info-panel-toggle-switch');
                    if (sw) sw.classList.toggle('active');
                });
            });
            var blockBtn = document.getElementById('info-block');
            if (blockBtn) blockBtn.addEventListener('click', function () { openProfileMenu(user); });
            if (!isSystem) {
                updateInfoPanelStatus();
                if (dmStatusInterval) clearInterval(dmStatusInterval);
                dmStatusInterval = setInterval(updateInfoPanelStatus, 15000);
            }
        }
        function updateInfoPanelStatus() {
            if (!dmPartner) return;
            if (isSystemName(dmPartner.username)) return;
            apiGet('/api/user/status?username=' + encodeURIComponent(dmPartner.username)).then(function (res) {
                var statusEl = document.getElementById('info-panel-status');
                var avEl = document.getElementById('info-panel-avatar');
                if (!statusEl) return;
                statusEl.textContent = formatLastSeen(res.lastSeen);
                statusEl.classList.toggle('online', isOnline(res.lastSeen));
                if (avEl) avEl.classList.toggle('online', isOnline(res.lastSeen));
            }).catch(function(){});
        }

        function pinnedMessageBarHtml(m){
            if(!m) return '';
            var txt=(m.text||'').trim();
            if(!txt && m.file) txt='Файл: '+(m.file.name||'Файл');
            if(!txt) txt='Сообщение';
            return '<div class="pinned-message-bar" data-pinned-id="'+escapeHtml(m.id||'')+'"><span class="pinned-icon"><svg class="hot-ui-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m15 4 5 5-3 3v4l-2 2-3-3-5 5-1-1 5-5-3-3 2-2h4Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg></span><span class="pinned-text"><span class="pinned-label">Закреплённое сообщение</span><span class="pinned-preview">'+escapeHtml(txt.slice(0,180))+'</span></span><span>›</span></div>';
        }
        function scrollToMessage(root,id){
            if(!root || !id) return;
            var target=null;
            try { target=root.querySelector('[data-msg-id="'+CSS.escape(String(id))+'"]'); } catch(e) {
                target=root.querySelector('[data-msg-id="'+String(id).replace(/"/g,'\\"')+'"]');
            }
            if(!target) return;
            var scroller=target.closest('.chat-body,.community-chat-body');
            if(scroller){
                var sr=scroller.getBoundingClientRect();
                var tr=target.getBoundingClientRect();
                var nextTop=scroller.scrollTop+(tr.top-sr.top)-Math.max(0,(scroller.clientHeight-tr.height)/2);
                scroller.scrollTo({top:Math.max(0,nextTop),behavior:'smooth'});
            }else{
                target.scrollIntoView({behavior:'smooth',block:'center'});
            }
        }
        function bindPinnedMessageBar(root){
            if(!root) return;
            root.querySelectorAll('.pinned-message-bar').forEach(function(bar){
                bar.addEventListener('click',function(){var id=bar.getAttribute('data-pinned-id'); requestAnimationFrame(function(){scrollToMessage(root,id);});});
            });
        }
        function bindReplyPreviewClicks(root){
            if(!root) return;
            root.querySelectorAll('.msg-reply-preview,.community-reply-preview').forEach(function(preview){
                var wrapper=preview.closest('[data-msg-id]');
                var replyId='';
                if(wrapper){
                    var fullId=wrapper.getAttribute('data-msg-id');
                    try{ var found=wrapper.querySelector('[data-reply-id]'); if(found) replyId=found.getAttribute('data-reply-id')||''; }catch(e){}
                }
                var msgId=preview.getAttribute('data-reply-id')||replyId;
                if(!msgId){
                    var parentData=preview.closest('.msg,.community-msg');
                    var source=parentData&&parentData.__hotReplyTargetId;
                    if(source) msgId=source;
                }
                if(msgId){
                    preview.classList.add('reply-preview-clickable');
                    preview.setAttribute('data-reply-id',msgId);
                    preview.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();scrollToMessage(root,msgId);});
                }
            });
        }
        function renderDmPinnedBar(body,msgs){
            if(!body || !body.parentNode) return;
            var old=body.parentNode.querySelector('.pinned-message-bar'); if(old) old.remove();
            var m=(msgs||[]).find(function(x){return String(x.id||'')===String(dmPinnedMessageId||'');});
            if(m){ body.parentNode.insertBefore(document.createRange().createContextualFragment(pinnedMessageBarHtml(m)),body); bindPinnedMessageBar(body.parentNode); }
        }
        function replyPreviewHtml(m, cls){
            if(!m || !m.replyTo) return '';
            var r=m.replyTo;
            return '<div class="'+(cls||'msg-reply-preview')+'" data-reply-id="'+escapeHtml(r.id||'')+'">↩ '+escapeHtml((r.from||'')+' · '+(r.text||'').slice(0,180))+'</div>';
        }
        function setReplyTarget(msgData){
            activeReplyTarget={id:msgData.id||'',from:msgData.from||'',text:msgData.text||''};
            var areas=document.querySelectorAll('.chat-input-area,.community-chat-composer');
            areas.forEach(function(area){
                var old=area.querySelector('.replying-to-bar'); if(old) old.remove();
                var bar=document.createElement('div'); bar.className='replying-to-bar';
                bar.innerHTML='<span>↩</span><span class="replying-text">Ответ на '+escapeHtml((activeReplyTarget.from||'сообщение')+' · '+(activeReplyTarget.text||'вложение'))+'</span><button type="button" class="replying-close">×</button>';
                area.insertBefore(bar, area.firstChild);
                bar.querySelector('.replying-close').addEventListener('click',function(){clearReplyTarget();});
            });
        }
        function clearReplyTarget(){
            activeReplyTarget=null;
            document.querySelectorAll('.replying-to-bar').forEach(function(x){x.remove();});
        }

        function closeContextMenu() {
            if (contextMenuEl && contextMenuEl.parentNode) contextMenuEl.parentNode.removeChild(contextMenuEl);
            contextMenuEl = null;
            document.querySelectorAll('.msg.msg-pressing').forEach(function (el) { el.classList.remove('msg-pressing'); });
        }
        function showContextMenu(x, y, msgData, items) {
            closeContextMenu();
            pressedMessage = msgData;
            var menu = document.createElement('div');
            menu.className = 'message-context-menu';
            var html = '';
            (items || []).forEach(function (it) {
                html += '<div class="message-context-item' + (it.danger ? ' danger' : '') + '" data-action="' + it.action + '"><span class="message-context-icon">' + (it.icon || '') + '</span>' + it.label + '</div>';
            });
            menu.innerHTML = html;
            document.body.appendChild(menu);
            contextMenuEl = menu;
            var mw = menu.offsetWidth, mh = menu.offsetHeight;
            var vw = window.innerWidth, vh = window.innerHeight;
            if (x + mw > vw - 10) x = vw - mw - 10;
            if (y + mh > vh - 10) y = vh - mh - 10;
            if (x < 10) x = 10;
            if (y < 10) y = 10;
            menu.style.left = x + 'px';
            menu.style.top = y + 'px';
            menu.querySelectorAll('.message-context-item').forEach(function (item) {
                item.addEventListener('click', function (e) {
                    e.stopPropagation();
                    var action = item.getAttribute('data-action');
                    var cb = (items || []).filter(function (i) { return i.action === action; })[0];
                    if (cb && cb.handler) cb.handler();
                    closeContextMenu();
                });
            });
        }
        function attachLongPress(el, msgData, items) {
            // Store the data directly on the message element so the desktop
            // right-click handler can reliably find it even when the user
            // right-clicks on a nested child (text, image, etc.).
            el.__hotContextMenu = { msgData: msgData, items: items || [] };

            var startX = 0, startY = 0, moved = false;
            function startPress(e) {
                var touch = e.touches ? e.touches[0] : e;
                startX = touch.clientX; startY = touch.clientY; moved = false;
                if (!e.touches) return; // desktop uses native right-click below
                if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
                pressTimer = setTimeout(function () {
                    if (!moved) {
                        var rect = el.getBoundingClientRect();
                        showContextMenu(
                            Math.max(10, Math.min(rect.left, window.innerWidth - 190)),
                            Math.max(10, Math.min(rect.top, window.innerHeight - 120)),
                            msgData,
                            items
                        );
                    }
                    pressTimer = null;
                }, longPressDuration);
            }
            function movePress(e) {
                var touch = e.touches ? e.touches[0] : e;
                if (Math.abs(touch.clientX - startX) > 8 || Math.abs(touch.clientY - startY) > 8) {
                    moved = true;
                    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
                }
            }
            function endPress() {
                if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
            }

            el.addEventListener('touchstart', startPress, { passive: true });
            el.addEventListener('touchmove', movePress, { passive: true });
            el.addEventListener('touchend', endPress, { passive: true });
            el.addEventListener('touchcancel', endPress, { passive: true });

            // Desktop right-click: bind directly to the message element.
            // This guarantees the full action list (reply/forward/pin/delete)
            // is restored even when the user right-clicks on text, media,
            // or another nested element inside the message.
            el.addEventListener('contextmenu', function (e) {
                e.preventDefault();
                e.stopPropagation();
                showContextMenu(
                    typeof e.clientX === 'number' ? e.clientX : 20,
                    typeof e.clientY === 'number' ? e.clientY : 20,
                    msgData,
                    items
                );
            });
        }

        // Desktop fallback for messages rendered by older/other code paths.
        // This is more reliable than per-element listeners and prevents the
        // browser menu from replacing our Hot message menu.
        document.addEventListener('contextmenu', function (e) {
            var target = e.target && e.target.closest
                ? e.target.closest('.msg-bubble, .community-msg, .post')
                : null;
            if (!target || !target.__hotContextMenu) return;

            e.preventDefault();
            e.stopPropagation();

            var x = typeof e.clientX === 'number' ? e.clientX : 20;
            var y = typeof e.clientY === 'number' ? e.clientY : 20;
            showContextMenu(
                x,
                y,
                target.__hotContextMenu.msgData,
                target.__hotContextMenu.items
            );
        }, true);

        document.addEventListener('click', function (e) { if (contextMenuEl && !contextMenuEl.contains(e.target)) closeContextMenu(); });
        document.addEventListener('scroll', function () { closeContextMenu(); }, true);

        function confirmDelete(text, onYes) {
            confirmDeleteText.textContent = text || 'Удалить?';
            confirmDeleteModal.classList.remove('hidden');
            var yesBtn = document.getElementById('confirm-delete-yes');
            var noBtn = document.getElementById('confirm-delete-no');
            var newYes = yesBtn.cloneNode(true); yesBtn.parentNode.replaceChild(newYes, yesBtn);
            var newNo = noBtn.cloneNode(true); noBtn.parentNode.replaceChild(newNo, noBtn);
            newYes.addEventListener('click', function () { confirmDeleteModal.classList.add('hidden'); if (onYes) onYes(); });
            newNo.addEventListener('click', function () { confirmDeleteModal.classList.add('hidden'); });
        }

        function openForwardModal(msgData) {
            forwardPreview.textContent = (msgData.text || (msgData.file ? 'Файл: '+(msgData.file.name||'Файл') : msgData.image ? 'Фото' : 'Сообщение')).slice(0,200);
            forwardModal.classList.remove('hidden');
            forwardModalList.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-3);">Загрузка...</div>';
            apiGet('/api/dm/conversations').then(function (data) {
                var list = (data.conversations || []).filter(function(c){ return !isSystemName(c.username); });
                if (!list.length) { forwardModalList.innerHTML = '<div class="forward-no-contacts">Нет диалогов</div>'; return; }
                var html = '';
                list.forEach(function (c) {
                    html += '<div class="chat-item" data-username="' + escapeHtml(c.username) + '"><div class="chat-item-avatar">' + avatarHTML(c) + '</div><div class="chat-item-body"><div class="chat-item-top"><div class="chat-item-name">' + escapeHtml(c.username) + '</div></div></div></div>';
                });
                forwardModalList.innerHTML = html;
                forwardModalList.querySelectorAll('.chat-item').forEach(function (row) {
                    row.addEventListener('click', function () {
                        var toUser = row.getAttribute('data-username');
                        apiPost('/api/dm/forward', { to: toUser, text: msgData.text || '', image: msgData.image || '', file: msgData.file || null, originalFrom: msgData.from || '' }).then(function () {
                            forwardModal.classList.add('hidden');
                            if (dmPartner && dmPartner.username.toLowerCase() === toUser.toLowerCase()) loadDmMessages(true);
                        }).catch(function (e) { alert((e && e.message) || 'Не удалось переслать'); });
                    });
                });
            });
        }
        forwardModalClose.addEventListener('click', function () { forwardModal.classList.add('hidden'); });
        forwardModal.addEventListener('click', function (e) { if (e.target === forwardModal) forwardModal.classList.add('hidden'); });

        function openSettings() {
            setActiveNav('nav-settings');
            clearChatElements();
            dmPartner = null;
            chatlistEl.classList.add('hidden');
            infoPanel.classList.remove('visible');
            var u = currentUser;
            var html = '<div class="settings-page"><h1>Настройки профиля</h1><p class="desc">Измени свои данные</p>';
            html += '<div class="settings-section">';
            html += '<div class="avatar-edit-section"><div class="avatar-edit-preview" id="settings-avatar">' + avatarHTML(u) + '</div><div class="avatar-edit-controls"><label class="btn-upload" for="settings-avatar-input">Загрузить аватар</label><input type="file" id="settings-avatar-input" accept="image/*" style="display:none;"><button class="btn-remove" id="settings-avatar-remove">Удалить аватар</button></div></div>';
            html += '<div class="field-group"><label class="field-label">Ник</label><input class="input" id="settings-username" type="text" value="' + escapeHtml(u.username) + '" minlength="3" maxlength="20"><div class="field-hint">От 3 до 20 символов</div></div>';
            html += '<div class="field-group"><label class="field-label">Юзернейм (для поиска)</label><input class="input" id="settings-handle" type="text" value="' + escapeHtml(u.handle || '') + '" maxlength="20" placeholder="username"><div class="field-hint">Латиница, цифры и _, от 3 до 20 символов. Необязательно.</div></div>';
            html += '<div class="field-group"><label class="field-label">Email</label><input class="input" type="email" value="' + escapeHtml(u.email) + '" disabled><div class="field-hint">Email изменить нельзя</div></div>';
            html += '<div class="field-group"><label class="field-label">Дата рождения</label><input class="input" id="settings-birthday" type="date" value="' + escapeHtml(u.birthday || '') + '"><div class="field-hint">Друзья увидят напоминание в твой день рождения. Необязательно.</div></div>';
            html += '<div class="field-group"><label class="field-label">Тема оформления</label><div class="theme-buttons"><button class="theme-btn" id="theme-dark-btn">🌙 Тёмная</button><button class="theme-btn" id="theme-light-btn">☀️ Светлая</button></div></div>';
            html += '<div class="field-group"><label class="field-label">Обои для чатов</label><div style="display:flex;gap:10px;flex-wrap:wrap;"><label class="btn-upload" for="settings-wallpaper-input"><svg class="hot-ui-icon" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="8.5" cy="9" r="1.5" fill="currentColor"/><path d="m4.5 17 4.5-4 3.5 3 2.5-2 4.5 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg> Загрузить обои</label><input type="file" id="settings-wallpaper-input" accept="image/*" style="display:none;"><button type="button" class="btn-remove" id="settings-wallpaper-remove">Удалить обои</button></div><div id="settings-wallpaper-preview" class="wallpaper-preview"></div><div class="field-hint" style="margin-top:8px;">Обои применятся к чатам личных сообщений</div></div>';
            html += '<div class="field-group"><label class="field-label">Заблокированные пользователи</label><div id="settings-blocked-list" style="margin-top:6px;"><div class="blocked-empty">Загрузка...</div></div></div>';
            html += '<p class="error-message" id="settings-error"></p><p class="success-message" id="settings-success"></p>';
            html += '<button class="register-button" id="settings-save">Сохранить изменения</button>';
            html += '</div>';
            html += '<button class="btn-secondary" id="settings-logout" style="margin-top:20px;width:100%;">Выйти из аккаунта</button>';
            html += '</div>';
            contentInner.innerHTML = html;
            var avInput = document.getElementById('settings-avatar-input');
            var avPreview = document.getElementById('settings-avatar');
            avInput.addEventListener('change', function (e) {
                var file = e.target.files[0]; if (!file) return;
                if (file.size > MAX_AVATAR_SIZE) { showSettingsError('Файл больше 10 МБ'); return; }
                resizeImage(file, function (dataURL) { if (!dataURL) return; pendingAvatar = dataURL; avPreview.innerHTML = '<img src="' + dataURL + '">'; });
            });
            document.getElementById('settings-avatar-remove').addEventListener('click', function () { pendingAvatar = ''; avPreview.innerHTML = getInitial(u.username); });
            highlightThemeBtns();
            document.getElementById('theme-dark-btn').addEventListener('click', function () { applyTheme('dark'); highlightThemeBtns(); });
            document.getElementById('theme-light-btn').addEventListener('click', function () { applyTheme('light'); highlightThemeBtns(); });
            var wallpaperPreview = document.getElementById('settings-wallpaper-preview');
            if (u.wallpaper) { wallpaperPreview.style.backgroundImage = /^\/uploads\/[a-f0-9]{32}\.(?:png|jpg|webp|gif)$/i.test(u.wallpaper || '') ? 'url("' + u.wallpaper + '")' : ''; wallpaperPreview.classList.add('has-image'); }
            var wpInput = document.getElementById('settings-wallpaper-input');
            wpInput.addEventListener('change', function (e) {
                var file = e.target.files[0]; if (!file) return;
                if (file.size > MAX_POST_IMAGE_SIZE) { showSettingsError('Файл больше 10 МБ'); return; }
                resizeImageFit(file, POST_IMAGE_MAX_DIM, function (dataURL) {
                    if (!dataURL) return;
                    pendingWallpaper = dataURL;
                    wallpaperPreview.style.backgroundImage = 'url("' + dataURL.replace(/["\\]/g, '') + '")';
                    wallpaperPreview.classList.add('has-image');
                });
            });
            document.getElementById('settings-wallpaper-remove').addEventListener('click', function () {
                pendingWallpaper = '';
                wallpaperPreview.style.backgroundImage = '';
                wallpaperPreview.classList.remove('has-image');
                wpInput.value = '';
            });
            loadBlockedListSettings();
            document.getElementById('settings-save').addEventListener('click', function () {
                var newUsername = document.getElementById('settings-username').value.trim();
                var newHandle = document.getElementById('settings-handle').value.trim().replace(/^@+/, '');
                var newBirthday = document.getElementById('settings-birthday').value;
                if (newUsername.length < 3 || newUsername.length > 20) { showSettingsError('Ник от 3 до 20 символов'); return; }
                if (isSystemName(newUsername)) { showSettingsError('Это имя зарезервировано'); return; }
                if (newHandle && !/^[a-zA-Z0-9_]{3,20}$/.test(newHandle)) { showSettingsError('Юзернейм: 3-20 символов, латиница, цифры и _'); return; }
                if (newBirthday) {
                    var bd = new Date(newBirthday + 'T00:00:00');
                    if (isNaN(bd.getTime()) || bd.getTime() > Date.now()) { showSettingsError('Некорректная дата рождения'); return; }
                }
                var payload = { newUsername: newUsername, handle: newHandle, theme: localStorage.getItem('hot_theme') || 'dark', birthday: newBirthday };
                if (pendingAvatar !== null) payload.avatar = pendingAvatar;
                if (pendingWallpaper !== null) payload.wallpaper = pendingWallpaper;
                apiPost('/api/update-profile', payload).then(function (res) {
                    currentUser = res.user; updateSidebarUser(res.user);
                    saveAccount({ username: res.user.username, avatar: res.user.avatar, handle: res.user.handle, token: currentToken });
                    pendingAvatar = null; pendingWallpaper = null;
                    showSettingsSuccess('Профиль сохранён!');
                }).catch(function (e) { showSettingsError(e.message); });
            });
            document.getElementById('settings-logout').addEventListener('click', function () { logoutConfirmModal.classList.remove('hidden'); });
        }
        function showSettingsError(msg) {
            var err = document.getElementById('settings-error');
            var ok = document.getElementById('settings-success');
            if (!err) return;
            if (ok) ok.classList.remove('visible');
            err.textContent = msg;
            err.classList.add('visible');
            setTimeout(function () { err.classList.remove('visible'); }, 4000);
        }
        function showSettingsSuccess(msg) {
            var ok = document.getElementById('settings-success');
            var err = document.getElementById('settings-error');
            if (!ok) return;
            if (err) err.classList.remove('visible');
            ok.textContent = msg;
            ok.classList.add('visible');
            setTimeout(function () { ok.classList.remove('visible'); }, 2500);
        }
        function loadBlockedListSettings() {
            var container = document.getElementById('settings-blocked-list');
            if (!container) return;
            container.innerHTML = '<div class="blocked-empty">Загрузка...</div>';
            apiGet('/api/users/blocked').then(function (data) {
                var list = data.blocked || [];
                if (!list.length) { container.innerHTML = '<div class="blocked-empty">Пока никого не заблокировали</div>'; return; }
                var html = '';
                list.forEach(function (u) {
                    html += '<div class="blocked-item" data-username="' + escapeHtml(u.username) + '"><div class="blocked-item-avatar">' + avatarHTML(u) + '</div><div class="blocked-item-name">' + escapeHtml((u.displayName || displayUserName(u.username))) + '</div><button type="button" class="btn-remove blocked-unblock-btn" data-target="' + escapeHtml(u.username) + '">Разблокировать</button></div>';
                });
                container.innerHTML = html;
                container.querySelectorAll('.blocked-unblock-btn').forEach(function (btn) {
                    btn.addEventListener('click', function () {
                        apiPost('/api/users/block', { target: btn.getAttribute('data-target') }).then(function () { loadBlockedListSettings(); });
                    });
                });
            }).catch(function () { container.innerHTML = '<div class="blocked-empty">Ошибка загрузки</div>'; });
        }
        function highlightThemeBtns() {
            var theme = localStorage.getItem('hot_theme') || 'dark';
            var d = document.getElementById('theme-dark-btn');
            var l = document.getElementById('theme-light-btn');
            if (!d || !l) return;
            d.classList.toggle('active', theme === 'dark');
            l.classList.toggle('active', theme === 'light');
        }

        function openProfileMenu(user) {
            viewingUserForMenu = user;
            document.getElementById('profile-menu-title').textContent = displayUserName(user.username);
            var btn = document.getElementById('profile-menu-block');
            apiGet('/api/users/block-status?target=' + encodeURIComponent(user.username)).then(function (res) {
                btn.innerHTML = res.iBlocked ? '✓ Разблокировать' : '<svg class="hot-ui-icon" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m6 6 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'+' Заблокировать';
                btn.style.background = res.iBlocked ? 'linear-gradient(135deg,#22c55e,#16a34a)' : '';
                profileMenuModal.classList.remove('hidden');
            });
        }
        document.getElementById('profile-menu-block').addEventListener('click', function () {
            if (!viewingUserForMenu) return;
            apiPost('/api/users/block', { target: viewingUserForMenu.username }).then(function () {
                profileMenuModal.classList.add('hidden');
                if (wallViewingUsername) openWall(wallViewingUsername);
            });
        });
        document.getElementById('profile-menu-cancel').addEventListener('click', function () { profileMenuModal.classList.add('hidden'); });

        var CALL_ICE = { iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443', 'turn:openrelay.metered.ca:443?transport=tcp'], username: 'openrelayproject', credential: 'openrelayproject' }
        ] };
        var callState = null;
        var callUIBuilt = false;
        var CALL_RING_MS = 45000;

        function cEl(id) { return document.getElementById(id); }
        function buildCallUI() {
            if (callUIBuilt) return;
            callUIBuilt = true;
            var wrap = document.createElement('div');
            wrap.id = 'call-overlay';
            wrap.className = 'call-overlay hidden';
            wrap.innerHTML = '<div class="call-box"><div class="call-avatar" id="call-avatar"></div><div class="call-name" id="call-name"></div><div class="call-status" id="call-status"></div>'
                + '<div class="call-actions"><button type="button" class="call-btn mute" id="call-mute" title="Микрофон">🎤</button>'
                + '<button type="button" class="call-btn accept" id="call-accept" title="Принять">' + phoneIconSvg(26) + '</button>'
                + '<button type="button" class="call-btn hang" id="call-hang" title="Завершить">' + phoneIconSvg(26) + '</button></div></div>'
                + '<audio id="call-audio" autoplay playsinline></audio>';
            document.body.appendChild(wrap);
            cEl('call-accept').addEventListener('click', acceptCall);
            cEl('call-hang').addEventListener('click', hangupCall);
            cEl('call-mute').addEventListener('click', function () {
                if (!callState || !callState.stream) return;
                callState.muted = !callState.muted;
                callState.stream.getAudioTracks().forEach(function (t) { t.enabled = !callState.muted; });
                cEl('call-mute').classList.toggle('off', callState.muted);
                cEl('call-mute').textContent = callState.muted ? '🔇' : '🎤';
            });
        }
        function setCallUI(mode, text) {
            buildCallUI();
            var o = cEl('call-overlay');
            o.classList.remove('hidden');
            o.setAttribute('data-mode', mode);
            cEl('call-name').textContent = callState.peer;
            cEl('call-avatar').innerHTML = avatarHTML(callState.user || { username: callState.peer });
            cEl('call-status').textContent = text || '';
            cEl('call-accept').style.display = (mode === 'incoming') ? 'flex' : 'none';
            cEl('call-mute').style.display = (mode === 'active') ? 'flex' : 'none';
        }
        function callStatus(text) { if (cEl('call-status')) cEl('call-status').textContent = text; }
        function sendCallSignal(to, type, extra) {
            return apiPost('/api/call/signal', Object.assign({ to: to, type: type }, extra || {})).catch(function () {});
        }
        function logCall(peer, type, duration) {
            apiPost('/api/call/log', { to: peer, type: type, duration: duration || 0 }).then(function () {
                if (dmPartner && dmPartner.username.toLowerCase() === peer.toLowerCase()) loadDmMessages(true);
            }).catch(function () {});
        }
        function getMic() {
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof RTCPeerConnection === 'undefined') {
                alert('Звонки работают только по https-ссылке и в современном браузере.');
                return Promise.reject(new Error('no-media'));
            }
            return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }).catch(function (e) {
                alert('Нет доступа к микрофону. Разреши микрофон в настройках приложения/браузера.');
                throw e;
            });
        }
        function createPeer(stream) {
            var pc = new RTCPeerConnection(CALL_ICE);
            stream.getTracks().forEach(function (t) { pc.addTrack(t, stream); });
            pc.onicecandidate = function (e) {
                if (e.candidate && callState) sendCallSignal(callState.peer, 'candidate', { candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate });
            };
            pc.ontrack = function (e) {
                var au = cEl('call-audio');
                if (au) { au.srcObject = e.streams[0]; var p = au.play(); if (p && p.catch) p.catch(function () {}); }
            };
            pc.onconnectionstatechange = function () {
                if (!callState || callState.pc !== pc) return;
                if (pc.connectionState === 'connected') onCallConnected();
                else if (pc.connectionState === 'failed') finishCall({ status: 'Соединение потеряно', log: callState.dir === 'out' ? (callState.connected ? 'outgoing' : 'missed') : null });
            };
            return pc;
        }
        function onCallConnected() {
            if (!callState || callState.connected) return;
            callState.connected = true;
            callState.startedAt = Date.now();
            if (callState.ringTimer) { clearTimeout(callState.ringTimer); callState.ringTimer = null; }
            setCallUI('active', '00:00');
            callState.tick = setInterval(function () {
                if (!callState || !callState.startedAt) return;
                var sec = Math.floor((Date.now() - callState.startedAt) / 1000);
                var mm = Math.floor(sec / 60), ss = sec % 60;
                callStatus((mm < 10 ? '0' : '') + mm + ':' + (ss < 10 ? '0' : '') + ss);
            }, 1000);
        }
        function flushCandidates() {
            if (!callState || !callState.pc) return;
            var list = callState.pending || [];
            callState.pending = [];
            list.forEach(function (c) { callState.pc.addIceCandidate(c).catch(function () {}); });
        }
        function callDuration() { return callState && callState.startedAt ? Math.round((Date.now() - callState.startedAt) / 1000) : 0; }
        function finishCall(opts) {
            opts = opts || {};
            if (!callState) return;
            var st = callState;
            callState = null;
            if (st.ringTimer) clearTimeout(st.ringTimer);
            if (st.tick) clearInterval(st.tick);
            try { if (st.stream) st.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
            try { if (st.pc) st.pc.close(); } catch (e) {}
            var au = cEl('call-audio'); if (au) au.srcObject = null;
            if (navigator.vibrate) navigator.vibrate(0);
            if (opts.log && st.dir === 'out') logCall(st.peer, opts.log, st.startedAt ? Math.round((Date.now() - st.startedAt) / 1000) : 0);
            var o = cEl('call-overlay');
            if (o && opts.status) {
                o.classList.remove('hidden');
                o.setAttribute('data-mode', 'ended');
                cEl('call-status').textContent = opts.status;
                cEl('call-accept').style.display = 'none';
                cEl('call-mute').style.display = 'none';
                setTimeout(function () { if (!callState) o.classList.add('hidden'); }, 1400);
            } else if (o) { o.classList.add('hidden'); }
        }
        function startCall() {
            if (!dmPartner || dmBlocked || dmPartner.isChannel) return;
            if (isSystemName(dmPartner.username)) return;
            if (callState) return;
            var peer = dmPartner.username;
            getMic().then(function (stream) {
                callState = { peer: peer, user: dmPartner, dir: 'out', stream: stream, pending: [], connected: false, muted: false };
                setCallUI('calling', 'Вызов…');
                var pc = createPeer(stream);
                callState.pc = pc;
                return pc.createOffer().then(function (offer) {
                    return pc.setLocalDescription(offer).then(function () {
                        return sendCallSignal(peer, 'offer', { sdp: offer.sdp });
                    });
                }).then(function () {
                    if (!callState) return;
                    callState.ringTimer = setTimeout(function () {
                        if (!callState || callState.connected) return;
                        sendCallSignal(callState.peer, 'hangup');
                        finishCall({ status: 'Нет ответа', log: 'missed' });
                    }, CALL_RING_MS);
                });
            }).catch(function () {
                if (callState) finishCall({ status: 'Не удалось позвонить' });
            });
        }
        function acceptCall() {
            if (!callState || callState.dir !== 'in' || callState.pc) return;
            var st = callState;
            getMic().then(function (stream) {
                if (callState !== st) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
                st.stream = stream;
                var pc = createPeer(stream);
                st.pc = pc;
                if (st.ringTimer) { clearTimeout(st.ringTimer); st.ringTimer = null; }
                if (navigator.vibrate) navigator.vibrate(0);
                setCallUI('active', 'Соединение…');
                return pc.setRemoteDescription({ type: 'offer', sdp: st.offerSdp }).then(function () {
                    flushCandidates();
                    return pc.createAnswer();
                }).then(function (answer) {
                    return pc.setLocalDescription(answer).then(function () {
                        return sendCallSignal(st.peer, 'answer', { sdp: answer.sdp });
                    });
                });
            }).catch(function () {
                if (callState === st) { sendCallSignal(st.peer, 'decline'); finishCall({ status: 'Не удалось ответить' }); }
            });
        }
        function hangupCall() {
            if (!callState) return;
            var st = callState;
            if (st.dir === 'in') {
                sendCallSignal(st.peer, st.connected ? 'hangup' : 'decline');
                finishCall({});
            } else {
                sendCallSignal(st.peer, 'hangup');
                finishCall({ log: st.connected ? 'outgoing' : 'cancelled' });
            }
        }
        function handleCallSignal(sig) {
            if (!sig || !sig.from || !currentUser) return;
            var from = sig.from;
            if (sig.type === 'offer') {
                if (callState) { sendCallSignal(from, 'busy'); return; }
                callState = { peer: from, dir: 'in', offerSdp: sig.sdp, pending: [], connected: false, muted: false };
                setCallUI('incoming', 'Входящий звонок…');
                if (navigator.vibrate) navigator.vibrate([400, 250, 400, 250, 400, 250, 400]);
                callState.ringTimer = setTimeout(function () { if (callState && !callState.connected && !callState.pc) finishCall({ status: 'Пропущенный звонок' }); }, CALL_RING_MS + 5000);
                return;
            }
            if (!callState || callState.peer.toLowerCase() !== String(from).toLowerCase()) return;
            if (sig.type === 'candidate' && sig.candidate) {
                if (callState.pc && callState.pc.remoteDescription) callState.pc.addIceCandidate(sig.candidate).catch(function () {});
                else callState.pending.push(sig.candidate);
            } else if (sig.type === 'answer' && callState.pc && sig.sdp) {
                callState.pc.setRemoteDescription({ type: 'answer', sdp: sig.sdp }).then(flushCandidates).catch(function () {});
                callStatus('Соединение…');
            } else if (sig.type === 'hangup') {
                if (callState.dir === 'out') finishCall({ status: 'Звонок завершён', log: callState.connected ? 'outgoing' : 'cancelled' });
                else finishCall({ status: callState.connected ? 'Звонок завершён' : 'Пропущенный звонок' });
            } else if (sig.type === 'decline' && callState.dir === 'out') {
                finishCall({ status: 'Вызов отклонён', log: 'declined' });
            } else if (sig.type === 'busy' && callState.dir === 'out') {
                finishCall({ status: 'Занято', log: 'missed' });
            }
        }
        var callPolling = false;
        setInterval(function () {
            if (!currentUser || callPolling) return;
            callPolling = true;
            apiGet('/api/call/poll').then(function (res) {
                (res.signals || []).forEach(handleCallSignal);
            }).catch(function () {}).then(function () { callPolling = false; });
        }, 1200);

        function readFileAsDataUrl(file) {
            return new Promise(function(resolve, reject){
                var reader=new FileReader();
                reader.onload=function(){ resolve(reader.result); };
                reader.onerror=function(){ reject(new Error('Не удалось прочитать файл')); };
                reader.readAsDataURL(file);
            });
        }

        function showPendingMediaPreview(containerId, file, onRemove) {
            var box=document.getElementById(containerId);
            if(!box) return;
            box.innerHTML='';
            if(!file){ box.style.display='none'; return; }
            box.style.display='flex';
            var item=document.createElement('div');
            item.className='pending-media-item';
            var url=URL.createObjectURL(file);
            var node;
            if((file.type||'').indexOf('video/')===0){
                node=document.createElement('video');
                node.muted=true; node.playsInline=true; node.preload='metadata';
            } else {
                node=document.createElement('img');
            }
            node.src=url;
            item.appendChild(node);
            var rm=document.createElement('button');
            rm.type='button'; rm.className='pending-media-remove'; rm.textContent='×';
            rm.title='Убрать вложение';
            rm.onclick=function(e){e.preventDefault();e.stopPropagation();if(onRemove)onRemove();};
            item.appendChild(rm);
            box.appendChild(item);
            var name=document.createElement('span');
            name.className='pending-media-name';
            name.textContent=file.name||'Вложение';
            box.appendChild(name);
        }
        function communityAttachmentHtml(file) {
            if (!file || !file.url) return '';
            var name=escapeHtml(file.name || 'Файл');
            var url=escapeHtml(file.url);
            var ext=((file.name||'').split('.').pop()||'').toLowerCase();
            if(['png','jpg','jpeg','webp','gif'].indexOf(ext)!==-1) {
                return '<a class="community-file-image" href="'+url+'" target="_blank" rel="noopener"><img src="'+url+'" alt="'+name+'"></a>';
            }
            if(['mp4','webm','mov','m4v','ogv'].indexOf(ext)!==-1) {
                return '<div class="community-file-video"><video src="'+url+'" controls preload="metadata"></video></div>';
            }
            return '<a class="community-file" href="'+url+'" target="_blank" rel="noopener">'+hotIcon('paperclip',16)+' <span>'+name+'</span><small>'+formatFileSize(file.size||0)+'</small></a>';
        }
        function formatFileSize(size) {
            size=Number(size)||0;
            if(size<1024) return size+' Б';
            if(size<1024*1024) return Math.round(size/1024)+' КБ';
            return (size/(1024*1024)).toFixed(1)+' МБ';
        }

        function resizeImage(file, cb) {
            var r = new FileReader();
            r.onload = function (e) {
                var img = new Image();
                img.onload = function () {
                    var c = document.createElement('canvas');
                    c.width = AVATAR_DIMENSION; c.height = AVATAR_DIMENSION;
                    var ctx = c.getContext('2d');
                    var min = Math.min(img.width, img.height);
                    ctx.drawImage(img, (img.width - min) / 2, (img.height - min) / 2, min, min, 0, 0, AVATAR_DIMENSION, AVATAR_DIMENSION);
                    cb(c.toDataURL('image/jpeg', 0.85));
                };
                img.onerror = function () { cb(null); };
                img.src = e.target.result;
            };
            r.onerror = function () { cb(null); };
            r.readAsDataURL(file);
        }
        function resizeImageFit(file, maxDim, cb) {
            var r = new FileReader();
            r.onload = function (e) {
                var img = new Image();
                img.onload = function () {
                    var w = img.width, h = img.height;
                    var scale = Math.min(1, maxDim / Math.max(w, h));
                    var cw = Math.max(1, Math.round(w * scale));
                    var ch = Math.max(1, Math.round(h * scale));
                    var c = document.createElement('canvas');
                    c.width = cw; c.height = ch;
                    c.getContext('2d').drawImage(img, 0, 0, cw, ch);
                    cb(c.toDataURL('image/jpeg', 0.85));
                };
                img.onerror = function () { cb(null); };
                img.src = e.target.result;
            };
            r.onerror = function () { cb(null); };
            r.readAsDataURL(file);
        }

        function renderAccountsList() {
            var list = getSavedAccounts();
            var html = '';
            if (!list.length) {
                html = '<div class="blocked-empty">Нет сохранённых аккаунтов</div>';
            } else {
                list.forEach(function (acc) {
                    var isCurrent = currentUser && currentUser.username.toLowerCase() === acc.username.toLowerCase();
                    html += '<div class="blocked-item">'
                        + '<div class="blocked-item-avatar">' + (acc.avatar ? '<img src="' + escapeHtml(acc.avatar) + '">' : getInitial(acc.username)) + '</div>'
                        + '<div class="blocked-item-name">' + escapeHtml(acc.username) + (isCurrent ? ' <span style="color:var(--success);font-size:11px;">(текущий)</span>' : '') + '</div>'
                        + (isCurrent ? '' : '<button type="button" class="btn-upload acc-switch-btn" data-target="' + escapeHtml(acc.username) + '">Войти</button>')
                        + '<button type="button" class="btn-remove acc-remove-btn" data-target="' + escapeHtml(acc.username) + '" style="margin-left:6px;">✕</button>'
                        + '</div>';
                });
            }
            accountsList.innerHTML = html;
            accountsList.querySelectorAll('.acc-switch-btn').forEach(function (btn) {
                btn.addEventListener('click', function () { switchAccount(btn.getAttribute('data-target')); });
            });
            accountsList.querySelectorAll('.acc-remove-btn').forEach(function (btn) {
                btn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    var target = btn.getAttribute('data-target');
                    if (currentUser && currentUser.username.toLowerCase() === target.toLowerCase()) { alert('Нельзя удалить текущий аккаунт'); return; }
                    removeSavedAccount(target);
                    renderAccountsList();
                });
            });
        }
        function switchAccount(username) {
            var list = getSavedAccounts();
            var acc = list.find(function (x) { return x.username.toLowerCase() === username.toLowerCase(); });
            if (!acc || !acc.token) { alert('Токен не найден, войди заново'); return; }
            fetch(API + '/api/auth/session', { headers: { 'Authorization': 'Bearer ' + acc.token } })
                .then(function (res) { return res.json().then(function (j) { return { ok: res.ok, data: j }; }); })
                .then(function (r) {
                    if (!r.ok) { alert('Сессия истекла, войди заново'); removeSavedAccount(username); renderAccountsList(); return; }
                    accountsModal.classList.add('hidden');
                    clearChatElements();
                    setSession(acc.token);
                    currentUser = r.data.user;
                    updateSidebarUser(r.data.user);
                    updateBadges();
                    showApp();
                    openFeed();
                })
                .catch(function () { alert('Ошибка сети'); });
        }
        document.getElementById('sidebar-user-switch').addEventListener('click', function (e) {
            e.stopPropagation();
            renderAccountsList();
            accountsModal.classList.remove('hidden');
        });
        document.getElementById('accounts-cancel').addEventListener('click', function () { accountsModal.classList.add('hidden'); });
        accountsModal.addEventListener('click', function (e) { if (e.target === accountsModal) accountsModal.classList.add('hidden'); });
        document.getElementById('accounts-add').addEventListener('click', function () {
            accountsModal.classList.add('hidden');
            clearSession(); currentUser = null; dmPartner = null; clearChatElements();
            showAuth(); setMode('login');
        });

        var privacyModal = document.getElementById('privacy-modal');
        document.querySelectorAll('.privacy-link').forEach(function (a) {
            a.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); privacyModal.classList.remove('hidden'); });
        });
        document.getElementById('privacy-close').addEventListener('click', function () { privacyModal.classList.add('hidden'); });
        privacyModal.addEventListener('click', function (e) { if (e.target === privacyModal) privacyModal.classList.add('hidden'); });
        document.addEventListener('keydown', function (e) { if (e.key === 'Escape') privacyModal.classList.add('hidden'); });

        form.addEventListener('submit', function (e) {
            e.preventDefault();
            errorEl.textContent = '';
            errorEl.classList.remove('visible');
            var email = emailInput.value.trim().replace(/[\s\u00A0\u200B\uFEFF]/g, '');
            var password = passwordInput.value;
            if (mode === 'register') {
                var username = usernameInput.value.trim();
                var password2 = password2Input.value;
                if (username.length < 3) { errorEl.textContent = 'Имя — минимум 3 символа'; errorEl.classList.add('visible'); return; }
                if (isSystemName(username)) { errorEl.textContent = 'Это имя зарезервировано'; errorEl.classList.add('visible'); return; }
                if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { errorEl.textContent = 'Некорректный email'; errorEl.classList.add('visible'); return; }
                if (password.length < 6) { errorEl.textContent = 'Пароль — минимум 6 символов'; errorEl.classList.add('visible'); return; }
                if (password !== password2) { errorEl.textContent = 'Пароли не совпадают'; errorEl.classList.add('visible'); return; }
                var consentEl = document.getElementById('consent-check');
                if (!consentEl || !consentEl.checked) {
                    errorEl.textContent = 'Нужно принять политику конфиденциальности';
                    errorEl.classList.add('visible');
                    var cr = document.getElementById('consent-row');
                    if (cr) { cr.classList.remove('shake'); void cr.offsetWidth; cr.classList.add('shake'); }
                    return;
                }
                submitBtn.disabled = true;
                apiPost('/api/register', { username: username, email: email, password: password, acceptedPrivacy: true }).then(function (res) {
                    setSession(res.token);
                    currentUser = res.user;
                    saveAccount({ username: res.user.username, avatar: res.user.avatar, handle: res.user.handle, token: res.token });
                    updateSidebarUser(res.user); updateBadges(); showApp(); openFeed();
                }).catch(function (e) { errorEl.textContent = e.message; errorEl.classList.add('visible'); })
                  .then(function () { submitBtn.disabled = false; });
            } else {
                if (!email) { errorEl.textContent = 'Введите имя или почту'; errorEl.classList.add('visible'); return; }
                if (!password) { errorEl.textContent = 'Введите пароль'; errorEl.classList.add('visible'); return; }
                submitBtn.disabled = true;
                apiPost('/api/login', { login: email, password: password }).then(function (res) {
                    setSession(res.token);
                    currentUser = res.user;
                    saveAccount({ username: res.user.username, avatar: res.user.avatar, handle: res.user.handle, token: res.token });
                    updateSidebarUser(res.user); updateBadges(); showApp(); openFeed();
                }).catch(function (e) { errorEl.textContent = e.message; errorEl.classList.add('visible'); })
                  .then(function () { submitBtn.disabled = false; });
            }
        });

        var communitySettingsState = { type:null, object:null, avatar:null };

        var communityInfoState = { object:null, messages:[], tab:'media' };

        function communityInfoBlockedKey(c){
            return 'hot-community-blocked-channel-'+String(c && (c.username || c.id) || '').toLowerCase();
        }
        function communityInfoNotifyKey(c){
            return 'hot-community-notify-channel-'+String(c && (c.username || c.id) || '').toLowerCase();
        }
        function communityInfoIsBlocked(c){
            try { return localStorage.getItem(communityInfoBlockedKey(c)) === '1'; } catch(e){ return false; }
        }
        function communityInfoNotificationsOn(c){
            try { return localStorage.getItem(communityInfoNotifyKey(c)) !== '0'; } catch(e){ return true; }
        }
        function communityInfoSetNotifications(c,on){
            try { localStorage.setItem(communityInfoNotifyKey(c), on ? '1' : '0'); } catch(e){}
        }
        function communityInfoSetBlocked(c,on){
            try { localStorage.setItem(communityInfoBlockedKey(c), on ? '1' : '0'); } catch(e){}
        }
        function communityInfoCollectLinks(messages){
            var links=[];
            (messages||[]).forEach(function(m){
                var text=String(m && m.text || '');
                var found=text.match(/https?:\/\/[^\s<>"']+/g)||[];
                found.forEach(function(url){
                    url=url.replace(/[),.!?]+$/,'');
                    if(url && links.indexOf(url)===-1) links.push(url);
                });
            });
            return links.slice(0,50);
        }
        function communityInfoCollectMedia(messages){
            var media=[];
            (messages||[]).forEach(function(m){
                var f=m && m.file;
                if(!f || !f.url) return;
                var name=String(f.name||'').toLowerCase();
                if(/\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(name)){
                    media.push({url:f.url,name:f.name||'Изображение'});
                }
            });
            return media.slice(-30).reverse();
        }
        function renderCommunityInfoPanel(){
            var panel=document.getElementById('community-info-panel');
            if(!panel) return;
            if(communityInfoState.tab==='links'){
                var links=communityInfoCollectLinks(communityInfoState.messages);
                if(!links.length){
                    panel.innerHTML='<div class="community-info-empty">В канале пока нет ссылок</div>';
                    return;
                }
                panel.innerHTML='<div class="community-info-links">'+links.map(function(url){
                    return '<a class="community-info-link" href="'+escapeHtml(url)+'" target="_blank" rel="noopener noreferrer">'+escapeHtml(url)+'</a>';
                }).join('')+'</div>';
                return;
            }
            var media=communityInfoCollectMedia(communityInfoState.messages);
            if(!media.length){
                panel.innerHTML='<div class="community-info-empty">В канале пока нет медиа</div>';
                return;
            }
            panel.innerHTML='<div class="community-info-media-grid">'+media.map(function(item){
                return '<a class="community-info-media-item" href="'+escapeHtml(item.url)+'" target="_blank" rel="noopener noreferrer"><img src="'+escapeHtml(item.url)+'" alt="'+escapeHtml(item.name)+'"></a>';
            }).join('')+'</div>';
        }
        function updateCommunityInfoNotifyUI(){
            var c=communityInfoState.object;
            if(!c) return;
            var on=communityInfoNotificationsOn(c);
            var state=document.getElementById('community-info-notify-state');
            var label=document.getElementById('community-info-notify-label');
            var menu=document.getElementById('community-info-notify');
            if(state) state.textContent=on?'Вкл.':'Выкл.';
            if(label) label.textContent='Уведомления';
            if(menu) menu.textContent=(on?'Выключить уведомления':'Включить уведомления');
        }
        function updateCommunityInfoBlockUI(){
            var c=communityInfoState.object;
            if(!c) return;
            var blocked=communityInfoIsBlocked(c);
            var b=document.getElementById('community-info-block');
            if(b) b.textContent=blocked?'✓ Разблокировать':'⊘ Заблокировать';
        }
        function closeChannelSubscribers(){
            var m=document.getElementById('channel-subs-modal');
            if(m){m.classList.remove('open');m.style.display='none';}
        }
        function openChannelSubscribers(c){
            if(!c) return;
            var modal=document.getElementById('channel-subs-modal');
            var list=document.getElementById('channel-subs-list');
            if(!modal||!list) return;
            var names=Array.isArray(c.memberNames)?c.memberNames.slice():[];
            var owner=String(c.owner||'').toLowerCase();
            if(!names.length){list.innerHTML='<div class="channel-subs-empty">Пока нет подписчиков</div>';}
            else {
                list.innerHTML=names.map(function(username){
                    var name=String(username||'').trim();
                    if(!name) return '';
                    var initial=escapeHtml(name.charAt(0).toUpperCase());
                    var role=String(name).toLowerCase()===owner?'Создатель канала':'Подписчик';
                    return '<div class="channel-subs-row">'+
                        '<div class="channel-subs-avatar">'+initial+'</div>'+
                        '<div><div class="channel-subs-name">'+escapeHtml(name)+'</div><div class="channel-subs-role">'+role+'</div></div>'+
                        '</div>';
                }).join('');
            }
            modal.classList.add('open');modal.style.display='flex';
        }
        function openCommunityInfo(c,messages){
            var modal=document.getElementById('community-info-modal');
            if(!modal || !c) return;
            communityInfoState={object:c,messages:Array.isArray(messages)?messages:[],tab:'media'};
            var avatar=document.getElementById('community-info-avatar');
            if(avatar) avatar.innerHTML=c.avatar?'<img src="'+escapeHtml(c.avatar)+'" alt="">':hotIcon('channel',28);
            var name=document.getElementById('community-info-name');
            var handle=document.getElementById('community-info-handle');
            var count=document.getElementById('community-info-count');
            var desc=document.getElementById('community-info-description');
            var members=document.getElementById('community-info-members-state');
            if(name) name.textContent=c.name||'Канал';
            if(handle) handle.textContent='@'+(c.username||'');
            if(count) count.textContent=(Number(c.members)||0)+' подписчиков';
            if(members) members.textContent=String(Number(c.members)||0);
            if(desc) desc.textContent=c.description||'Нет описания';
            var settings=document.getElementById('community-info-settings');
            var leave=document.getElementById('community-info-leave');
            var leaveLabel=document.getElementById('community-info-leave-label');
            var isOwner=!!(c.isOwner===true || (currentUser && c.owner && String(c.owner).trim().toLowerCase()===String(currentUser.username).trim().toLowerCase()));
            if(settings) settings.style.display=isOwner?'block':'none';
            if(leave){
                leave.style.display='block';
            }
            if(leaveLabel) leaveLabel.textContent=c.isSubscribed?'Покинуть канал':'Подписаться на канал';
            var tabs=modal.querySelectorAll('.community-info-tab');
            Array.prototype.forEach.call(tabs,function(t){t.classList.toggle('active',t.getAttribute('data-info-tab')==='media');});
            updateCommunityInfoNotifyUI();
            updateCommunityInfoBlockUI();
            renderCommunityInfoPanel();
            var menu=document.getElementById('community-info-menu');
            if(menu) menu.classList.remove('open');
            modal.classList.add('open');
            modal.style.display='flex';
        }
        function closeCommunityInfo(){
            var modal=document.getElementById('community-info-modal');
            if(modal){ modal.classList.remove('open'); modal.style.display='none'; }
            var menu=document.getElementById('community-info-menu');
            if(menu) menu.classList.remove('open');
            communityInfoState={object:null,messages:[],tab:'media'};
        }
        (function initCommunityInfoHandlers(){
            document.addEventListener('click',function(e){
                var t=e.target;
                if(t && t.closest){
                    var tab=t.closest('.community-info-tab');
                    if(tab){
                        communityInfoState.tab=tab.getAttribute('data-info-tab')||'media';
                        document.querySelectorAll('.community-info-tab').forEach(function(x){x.classList.toggle('active',x===tab);});
                        renderCommunityInfoPanel();
                        return;
                    }
                }
            });
            var close=document.getElementById('community-info-close');
            if(close) close.onclick=function(){closeCommunityInfo();};
            var subsBtn=document.getElementById('community-info-members-btn');
            if(subsBtn) subsBtn.onclick=function(){ openChannelSubscribers(communityInfoState.object); };
            var subsClose=document.getElementById('channel-subs-close');
            if(subsClose) subsClose.onclick=function(){ closeChannelSubscribers(); };
            var subsModal=document.getElementById('channel-subs-modal');
            if(subsModal) subsModal.addEventListener('click',function(e){if(e.target===subsModal) closeChannelSubscribers();});
            var more=document.getElementById('community-info-more');
            if(more) more.onclick=function(e){
                e.preventDefault(); e.stopPropagation();
                var menu=document.getElementById('community-info-menu');
                if(menu) menu.classList.toggle('open');
            };
            var notifyMain=document.getElementById('community-info-notify-main');
            if(notifyMain) notifyMain.onclick=function(){
                var c=communityInfoState.object; if(!c) return;
                communityInfoSetNotifications(c,!communityInfoNotificationsOn(c));
                updateCommunityInfoNotifyUI();
            };
            var notify=document.getElementById('community-info-notify');
            if(notify) notify.onclick=function(){
                var c=communityInfoState.object; if(!c) return;
                communityInfoSetNotifications(c,!communityInfoNotificationsOn(c));
                updateCommunityInfoNotifyUI();
                var menu=document.getElementById('community-info-menu'); if(menu) menu.classList.remove('open');
            };
            var block=document.getElementById('community-info-block');
            if(block) block.onclick=function(){
                var c=communityInfoState.object; if(!c) return;
                var blocked=communityInfoIsBlocked(c);
                communityInfoSetBlocked(c,!blocked);
                updateCommunityInfoBlockUI();
                var menu=document.getElementById('community-info-menu'); if(menu) menu.classList.remove('open');
            };
            var settings=document.getElementById('community-info-settings');
            if(settings) settings.onclick=function(){
                var c=communityInfoState.object;
                if(!c || !c.isOwner) return;
                closeCommunityInfo();
                openCommunitySettings('channel',c);
            };
            var leave=document.getElementById('community-info-leave');
            if(leave) leave.onclick=function(){
                var c=communityInfoState.object; if(!c) return;
                if(c.isSubscribed){
                    if(!confirm('Покинуть канал «'+(c.name||'')+'»?')) return;
                    apiPost('/api/channels/subscribe',{channel:c.username}).then(function(){
                        closeCommunityInfo();
                        openChannel(c.username);
                    }).catch(function(e){alert(e.message||'Не удалось покинуть канал');});
                } else {
                    apiPost('/api/channels/subscribe',{channel:c.username}).then(function(){
                        c.isSubscribed=true;
                        c.members=(Number(c.members)||0)+1;
                        openCommunityInfo(c,communityInfoState.messages);
                    }).catch(function(e){alert(e.message||'Не удалось подписаться');});
                }
            };
            var modal=document.getElementById('community-info-modal');
            if(modal) modal.addEventListener('click',function(e){if(e.target===modal) closeCommunityInfo();});
        })();

        function openCommunitySettings(type, obj) {
            var modal=document.getElementById('community-settings-modal');
            if(!modal || !obj) return;
            communitySettingsState={type:type,object:obj,avatar:(obj.avatar||'')};
            document.getElementById('community-settings-kind').textContent=type==='channel'?'канала':'чата';
            document.getElementById('community-settings-name').value=obj.name||'';
            document.getElementById('community-settings-username').value=obj.username||'';
            document.getElementById('community-settings-description').value=obj.description||'';
            document.getElementById('community-settings-members').value=(obj.memberNames||obj.members||[]).join(', ');
            document.getElementById('community-settings-notify').checked=localStorage.getItem('hot-community-notify-'+type+'-'+(obj.id||obj.username))!=='0';
            document.getElementById('community-settings-invites').checked=obj.allowInvites!==false;
            document.getElementById('community-settings-write').checked=type==='channel'?(obj.writeMode==='members'):(obj.allowMembersWrite!==false);
            document.getElementById('community-settings-username-wrap').style.display=type==='channel'?'block':'none';
            document.getElementById('community-settings-write-wrap').style.display='flex';
            var prev=document.getElementById('community-settings-avatar-preview');
            prev.innerHTML=obj.avatar?'<img src="'+escapeHtml(obj.avatar)+'" alt="">':hotIcon('camera',28);
            modal.classList.add('open');
            modal.style.display='flex';
        }
        function closeCommunitySettings(){ var m=document.getElementById('community-settings-modal'); if(m){ m.classList.remove('open'); m.style.display='none'; } }
        function bindCommunitySettings(){
            var m=document.getElementById('community-settings-modal'); if(!m) return;
            document.getElementById('community-settings-cancel').addEventListener('click',closeCommunitySettings);
            document.getElementById('community-settings-avatar-btn').addEventListener('click',function(){document.getElementById('community-settings-avatar-input').click();});
            document.getElementById('community-settings-avatar-remove').addEventListener('click',function(){communitySettingsState.avatar='';document.getElementById('community-settings-avatar-preview').innerHTML=hotIcon('camera',28);});
            document.getElementById('community-settings-avatar-input').addEventListener('change',function(){
                var f=this.files&&this.files[0]; if(!f)return; if(f.size>5*1024*1024){alert('Аватар больше 5 МБ');this.value='';return;}
                var rd=new FileReader(); rd.onload=function(){communitySettingsState.avatar=rd.result;document.getElementById('community-settings-avatar-preview').innerHTML='<img src="'+escapeHtml(rd.result)+'" alt="">';}; rd.readAsDataURL(f); this.value='';
            });
            m.addEventListener('click',function(e){if(e.target===m)closeCommunitySettings();});
            document.getElementById('community-settings-save').addEventListener('click',function(){
                var o=communitySettingsState.object,t=communitySettingsState.type;if(!o)return;
                var data={name:document.getElementById('community-settings-name').value.trim(),description:document.getElementById('community-settings-description').value.trim(),avatar:communitySettingsState.avatar,allowInvites:document.getElementById('community-settings-invites').checked}; if(t==='channel'){data.originalUsername=o.username;}
                if(t==='channel'){data.username=document.getElementById('community-settings-username').value.trim().replace(/^@+/,'');data.writeMode=document.getElementById('community-settings-write').checked?'members':'owner';}
                else {data.id=o.id;data.allowMembersWrite=document.getElementById('community-settings-write').checked;}
                if(!data.name){alert('Введите название');return;}
                var ep=t==='channel'?'/api/channels/update':'/api/chats/update';
                apiPost(ep,data).then(function(r){
                    localStorage.setItem('hot-community-notify-'+t+'-'+(o.id||o.username),document.getElementById('community-settings-notify').checked?'1':'0');
                    closeCommunitySettings();
                    if(t==='channel') openChannel((r.channel&&r.channel.username)||data.username); else openGroupChat((r.chat&&r.chat.id)||o.id);
                }).catch(function(e){alert(e.message||'Не удалось сохранить настройки');});
            });
            document.getElementById('community-settings-delete').addEventListener('click',function(){
                var o=communitySettingsState.object,t=communitySettingsState.type;if(!o)return;
                if(!confirm('Удалить '+(t==='channel'?'канал':'чат')+' без возможности восстановления?'))return;
                var ep=t==='channel'?'/api/channels/delete':'/api/chats/delete';var data=t==='channel'?{username:o.username}:{id:o.id};
                apiPost(ep,data).then(function(){closeCommunitySettings();openCommunities('channels');}).catch(function(e){alert(e.message||'Не удалось удалить');});
            });
        }

        function logout() {
            apiPost('/api/logout', {}).catch(function(){});
            if (currentUser) removeSavedAccount(currentUser.username);
            clearChatElements();
            clearSession(); currentUser = null; dmPartner = null;
            showAuth(); setMode('register');
        }
        document.getElementById('logout-confirm-no').addEventListener('click', function () { logoutConfirmModal.classList.add('hidden'); });
        document.getElementById('logout-confirm-yes').addEventListener('click', function () { logoutConfirmModal.classList.add('hidden'); logout(); });

        document.getElementById('nav-home').addEventListener('click', openFeed);
        document.getElementById('nav-people').addEventListener('click', openPeople);
        document.getElementById('nav-friends').addEventListener('click', openFriends);
        document.getElementById('nav-messages').addEventListener('click', function () { openMessages(); });
        document.getElementById('nav-communities').addEventListener('click', function () { openCommunities('channels'); });
        document.getElementById('nav-wall').addEventListener('click', function () { openWall(currentUser.username); });
        document.getElementById('nav-settings').addEventListener('click', openSettings);
        document.getElementById('nav-admin').addEventListener('click', openAdmin);
        document.getElementById('sidebar-logo').addEventListener('click', openFeed);
        document.getElementById('sidebar-user').addEventListener('click', function (e) {
            if (e.target.closest('#sidebar-user-switch') || e.target.closest('#sidebar-user-settings')) return;
            openWall(currentUser.username);
        });
        document.getElementById('sidebar-user-settings').addEventListener('click', function (e) { e.stopPropagation(); openSettings(); });

        document.querySelectorAll('.chatlist-tab').forEach(function (el) {
            el.addEventListener('click', function () {
                currentTab = el.getAttribute('data-tab');
                document.querySelectorAll('.chatlist-tab').forEach(function (x) { x.classList.toggle('active', x === el); });
                loadChatList();
            });
        });

        document.getElementById('mobile-bottom-home').addEventListener('click', openFeed);
        document.getElementById('mobile-bottom-people').addEventListener('click', openPeople);
        document.getElementById('mobile-bottom-friends').addEventListener('click', openFriends);
        document.getElementById('mobile-bottom-messages').addEventListener('click', function () { openMessages(); });
        document.getElementById('mobile-bottom-communities').addEventListener('click', function () { openCommunities('channels'); });
        document.getElementById('mobile-bottom-profile').addEventListener('click', function () { openWall(currentUser.username); });
        document.getElementById('mobile-bottom-settings').addEventListener('click', openSettings);
        document.getElementById('mobile-bottom-create').addEventListener('click', function (e) { e.stopPropagation(); mobileCreateSheet.classList.toggle('hidden'); });
        document.getElementById('mobile-sheet-post').addEventListener('click', function () {
            mobileCreateSheet.classList.add('hidden');
            openFeed();
            setTimeout(function () { var c = document.getElementById('composer-text'); if (c) c.focus(); }, 100);
        });
        document.getElementById('mobile-sheet-channel').addEventListener('click', function () {
            mobileCreateSheet.classList.add('hidden');
            channelModal.classList.remove('hidden');
        });
        document.getElementById('mobile-sheet-chat').addEventListener('click', function () {
            mobileCreateSheet.classList.add('hidden');
            chatModal.classList.remove('hidden');
        });
        document.getElementById('channel-cancel-btn').addEventListener('click', function(){ channelModal.classList.add('hidden'); });
        document.getElementById('chat-cancel-btn').addEventListener('click', function(){ chatModal.classList.add('hidden'); });
        document.getElementById('channel-save-btn').addEventListener('click', function(){
            var name=document.getElementById('channel-name-input').value.trim();
            var username=document.getElementById('channel-username-input').value.trim().replace(/^@+/,'');
            var description=document.getElementById('channel-description-input').value.trim();
            var err=document.getElementById('channel-create-error');
            apiPost('/api/channels',{name:name,username:username,description:description}).then(function(){ channelModal.classList.add('hidden'); openCommunities('channels'); }).catch(function(e){ err.textContent=e.message||'Не удалось создать канал'; err.classList.add('visible'); });
        });
        document.getElementById('chat-save-btn').addEventListener('click', function(){
            var name=document.getElementById('chat-name-input').value.trim();
            var raw=document.getElementById('chat-members-input').value.split(',').map(function(x){return x.trim();}).filter(Boolean);
            var err=document.getElementById('chat-create-error');
            if(!name){ err.textContent='Введите название чата'; err.classList.add('visible'); return; }
            apiPost('/api/chats',{name:name,members:raw}).then(function(){ chatModal.classList.add('hidden'); openCommunities('chats'); }).catch(function(e){ err.textContent=e.message||'Не удалось создать чат'; err.classList.add('visible'); });
        });
        document.addEventListener('click', function (e) {
            if (!mobileCreateSheet.classList.contains('hidden')) {
                var btn = document.getElementById('mobile-bottom-create');
                if (!mobileCreateSheet.contains(e.target) && e.target !== btn && !btn.contains(e.target)) mobileCreateSheet.classList.add('hidden');
            }
        });
        document.getElementById('mobile-search-btn').addEventListener('click', function () {
            mobileSearchPanel.classList.toggle('hidden');
            if (!mobileSearchPanel.classList.contains('hidden')) mobileSearchInput.focus();
        });
        document.getElementById('mobile-search-close').addEventListener('click', function () { mobileSearchPanel.classList.add('hidden'); });
        document.getElementById('mobile-search-input').addEventListener('input', function () {
            var q = mobileSearchInput.value.trim().toLowerCase();
            if (!q) { mobileSearchResults.innerHTML = ''; return; }
            Promise.all([apiGet('/api/users/search?q=' + encodeURIComponent(q)), apiGet('/api/channels/search?q=' + encodeURIComponent(q))]).then(function (r) {
                var html = '';
                (r[0].users || []).slice(0, 5).forEach(function (u) {
                    if (isSystemName(u.username)) return;
                    html += '<div class="mobile-search-item" data-type="user" data-id="' + escapeHtml(u.username) + '"><div class="mobile-search-avatar">' + avatarHTML(u) + '</div><div><div class="mobile-search-name">' + escapeHtml((u.displayName || displayUserName(u.username))) + '</div></div></div>';
                });
                (r[1].channels || []).slice(0, 5).forEach(function (c) {
                    html += '<div class="mobile-search-item" data-type="channel" data-id="' + escapeHtml(c.username) + '"><div class="mobile-search-avatar"><svg class="hot-ui-icon" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5h-7L6 20v-3H6.5A2.5 2.5 0 0 1 4 14.5Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8 9h8M8 12h5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></div><div><div class="mobile-search-name">' + escapeHtml(c.name) + '</div></div></div>';
                });
                mobileSearchResults.innerHTML = html || '<div style="padding:20px;text-align:center;color:var(--text-3);">Ничего не найдено</div>';
                mobileSearchResults.querySelectorAll('.mobile-search-item').forEach(function (el) {
                    el.addEventListener('click', function () {
                        mobileSearchPanel.classList.add('hidden');
                        openWall(el.getAttribute('data-id'));
                    });
                });
            });
        });
        document.getElementById('mobile-brand-home').addEventListener('click', openFeed);
        document.getElementById('mobile-header-avatar').addEventListener('click', function () { renderAccountsList(); accountsModal.classList.remove('hidden'); });

        document.querySelectorAll('.eye').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var inp = document.getElementById(btn.dataset.target);
                if (!inp) return;
                inp.type = inp.type === 'password' ? 'text' : 'password';
            });
        });

        document.getElementById('global-search-input').addEventListener('input', function (e) {
            var q = e.target.value.trim().toLowerCase();
            if (!q) { loadChatList(); return; }
            var items = chatlistBody.querySelectorAll('.chat-item');
            items.forEach(function (el) {
                var name = el.querySelector('.chat-item-name').textContent.toLowerCase();
                el.style.display = name.includes(q) ? '' : 'none';
            });
        });

        function finishSocialLogin(res) {
            setSession(res.token);
            currentUser = res.user;
            saveAccount({ username: res.user.username, avatar: res.user.avatar, handle: res.user.handle, token: res.token });
            updateSidebarUser(res.user);
            updateBadges();
            showApp();
            openFeed();
        }

        var googleAuthInitialized = false;

        function handleGoogleCredential(response) {
            errorEl.textContent = '';
            errorEl.classList.remove('visible');
            if (!response || !response.credential) {
                errorEl.textContent = 'Google не вернул данные авторизации';
                errorEl.classList.add('visible');
                return;
            }
            apiPost('/api/auth/google', { credential: response.credential })
                .then(finishSocialLogin)
                .catch(function (err) {
                    errorEl.textContent = err && err.message ? err.message : 'Ошибка входа через Google';
                    errorEl.classList.add('visible');
                });
        }

        function initGoogleButton() {
            if (googleAuthInitialized) return true;
            if (!GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID.indexOf('PASTE_') === 0) return false;
            if (!window.google || !google.accounts || !google.accounts.id || !googleAuthBtn) return false;

            google.accounts.id.initialize({
                client_id: GOOGLE_CLIENT_ID,
                callback: handleGoogleCredential,
                auto_select: false,
                cancel_on_tap_outside: true
            });

            var visibleButton = googleAuthBtn.querySelector('.google-visible-button');
            googleAuthBtn.innerHTML = '';
            if (visibleButton) googleAuthBtn.appendChild(visibleButton);
            var realButton = document.createElement('div');
            realButton.className = 'google-real-button';
            googleAuthBtn.appendChild(realButton);
            google.accounts.id.renderButton(realButton, {
                type: 'standard',
                theme: 'outline',
                size: 'large',
                text: 'signin_with',
                shape: 'rectangular',
                width: 220,
                logo_alignment: 'left'
            });
            googleAuthInitialized = true;
            return true;
        }

        function startGoogleAuth() {
            errorEl.textContent = '';
            errorEl.classList.remove('visible');
            if (!initGoogleButton()) {
                errorEl.textContent = 'Google ещё загружается. Подождите секунду и нажмите кнопку ещё раз.';
                errorEl.classList.add('visible');
            }
        }

        function waitForGoogleButton() {
            if (!initGoogleButton()) {
                setTimeout(waitForGoogleButton, 300);
            }
        }

        if (googleAuthBtn) {
            googleAuthBtn.addEventListener('click', startGoogleAuth);
            waitForGoogleButton();
        }

        function init() {
            var savedTheme = localStorage.getItem('hot_theme') || 'dark';
            applyTheme(savedTheme);
            setMode('register');
            var token = getSession();
            if (token) {
                currentToken = token;
                fetch(API + '/api/auth/session', { headers: apiHeaders() })
                    .then(function (res) { return res.json().then(function (j) { return { ok: res.ok, data: j }; }); })
                    .then(function (r) {
                        if (!r.ok) { clearSession(); showAuth(); setMode('register'); return; }
                        currentUser = r.data.user;
                        saveAccount({ username: r.data.user.username, avatar: r.data.user.avatar, handle: r.data.user.handle, token: token });
                        updateSidebarUser(r.data.user);
                        updateBadges();
                        showApp();
                        openFeed();
                    })
                    .catch(function () { clearSession(); showAuth(); setMode('register'); });
            } else {
                showAuth();
                setMode('register');
            }
            setInterval(updateBadges, 10000);
        }
        init();

        bindCommunitySettings();
        })();
        