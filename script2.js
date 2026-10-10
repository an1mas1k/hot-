
// Цвет аватарки без картинки зависит от первой буквы, чтобы не все были одинаковыми
(function () {
    var C = ['#6b5bd6', '#c2447e', '#3e8f7c', '#b8703c', '#4a82b8', '#8f5bc0', '#a8863a', '#5b8f45', '#b8504f', '#3f7fa6'];
    var SEL = '.chat-item-avatar:not(.system),.msg-avatar,.post-avatar,.person-avatar,.wall-composer-avatar,.sidebar-user-avatar,.avatar-edit-preview,.chat-header-avatar:not(.system),.info-panel-avatar,.community-avatar,#mobile-header-avatar';
    var queued = false;
    function paint() {
        queued = false;
        document.querySelectorAll(SEL).forEach(function (el) {
            if (el.querySelector('img')) { if (el.dataset.hc) { el.style.background = ''; delete el.dataset.hc; } return; }
            var t = (el.textContent || '').trim();
            if (!t || t.length > 2) return;
            var ch = t.toUpperCase().charCodeAt(0);
            if (el.dataset.hc === String(ch)) return;
            el.dataset.hc = String(ch);
            el.style.background = C[ch % C.length];
        });
    }
    new MutationObserver(function () { if (!queued) { queued = true; requestAnimationFrame(paint); } }).observe(document.body, { childList: true, subtree: true, characterData: true });
    paint();
})();
