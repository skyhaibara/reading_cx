// ==UserScript==
// @name         reading_cx
// @namespace    https://github.com/
// @version      1.0
// @description  超星学习通阅读助手 - 自动滚动刷时长，支持后台运行/加载更多/下一页/下一章兜底，翻页后状态自动续传
// @match        https://mooc1.chaoxing.com/mooc-ans/ztnodedetailcontroller/visitnodedetail*
// @match        https://mooc1.chaoxing.com/mooc-ans/zt/portal/*
// @grant        GM_addStyle
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    /* =========================
       🌙 后台运行支持
       1) 伪装页面始终可见，绕过 visibilitychange 监听
       2) 用 Web Worker 发心跳，规避后台 setTimeout 节流到 1s
    ========================= */
    try {
        Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
        Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
        Object.defineProperty(document, 'webkitHidden', { get: () => false, configurable: true });
        Object.defineProperty(document, 'webkitVisibilityState', { get: () => 'visible', configurable: true });
        const blockVisEvt = (e) => { e.stopImmediatePropagation(); };
        window.addEventListener('visibilitychange', blockVisEvt, true);
        document.addEventListener('visibilitychange', blockVisEvt, true);
        window.addEventListener('webkitvisibilitychange', blockVisEvt, true);
        document.addEventListener('webkitvisibilitychange', blockVisEvt, true);
        // 同时屏蔽页面失焦事件，部分平台会用 blur 暂停计时
        window.addEventListener('blur', (e) => e.stopImmediatePropagation(), true);
    } catch (e) {
        console.warn('[CX-STABLE] visibility hook 失败', e);
    }

    // Worker 心跳：后台 tab 里 setTimeout 会被节流到 ≥1s，用 Worker 的 setInterval 触发主线程
    let bgTickHandlers = new Set();
    function onBgTick(fn) { bgTickHandlers.add(fn); }
    try {
        const workerSrc = `let id=null;self.onmessage=(e)=>{if(e.data==='start'){if(id)clearInterval(id);id=setInterval(()=>self.postMessage('tick'),500);}else if(e.data==='stop'){if(id)clearInterval(id);id=null;}};`;
        const blob = new Blob([workerSrc], { type: 'application/javascript' });
        const w = new Worker(URL.createObjectURL(blob));
        w.onmessage = () => { bgTickHandlers.forEach(fn => { try { fn(); } catch (e) {} }); };
        w.postMessage('start');
    } catch (e) {
        console.warn('[CX-STABLE] worker 心跳启动失败，将退回 setTimeout', e);
    }

    /* =========================
       🚫 单例锁
    ========================= */
    if (window.cxStableReader) {
        console.log('已存在实例，跳过');
        return;
    }
    window.cxStableReader = true;

    /* =========================
       全局状态
    ========================= */
    const PANEL_ID = 'cx-stable-panel';
    const LS_KEY = 'cx-stable-target-min';
    const STATE_KEY = 'cx-stable-state';
    const STATE_TTL = 30 * 60 * 1000; // 30 分钟内的存档才恢复，避免下次开页面意外自动跑

    let isRunning = false;            // 默认暂停，等用户设置时长后点开始
    let isFinished = false;           // 达到目标时长后置 true
    let currentPage = 1;
    let elapsedMs = 0;                // 已累计运行时长（ms），不含暂停
    let targetMin = Number(localStorage.getItem(LS_KEY)) || 30; // 默认 30 分钟
    let lastTickTs = 0;               // 上次循环时间戳，用于累加 elapsedMs

    /* =========================
       💾 状态持久化（应对翻页重载）
    ========================= */
    function saveState() {
        try {
            localStorage.setItem(STATE_KEY, JSON.stringify({
                isRunning, isFinished, elapsedMs, currentPage,
                savedAt: Date.now()
            }));
        } catch (e) {}
    }

    function loadState() {
        try {
            const raw = localStorage.getItem(STATE_KEY);
            if (!raw) return;
            const s = JSON.parse(raw);
            if (!s || Date.now() - (s.savedAt || 0) > STATE_TTL) {
                localStorage.removeItem(STATE_KEY);
                return;
            }
            isRunning = !!s.isRunning;
            isFinished = !!s.isFinished;
            elapsedMs = Number(s.elapsedMs) || 0;
            currentPage = Number(s.currentPage) || 1;
            log('恢复状态', { isRunning, elapsedMs, currentPage });
        } catch (e) { log('loadState err', e); }
    }

    function clearState() {
        try { localStorage.removeItem(STATE_KEY); } catch (e) {}
    }

    /* =========================
       工具函数
    ========================= */
    function rand(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    function log(...args) {
        console.log('[CX-STABLE]', ...args);
    }

    function fmtMs(ms) {
        const s = Math.floor(ms / 1000);
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const ss = s % 60;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
    }

    /* =========================
       📍 阅读上下文
       portal 页可能用 iframe 内嵌阅读器 或 自带 overflow:auto 容器
       这里自适应识别真正的"滚动主体"，避免 window.scrollBy 打空
    ========================= */
    function makeWinCtx(win, doc) {
        return {
            win, doc, kind: 'win',
            viewHeight: () => win.innerHeight || doc.documentElement.clientHeight || 600,
            scrollBy(delta) { try { win.scrollBy({ top: delta, behavior: 'auto' }); } catch (e) {} },
            scrollToTop() { try { win.scrollTo({ top: 0, behavior: 'auto' }); } catch (e) {} },
            isBottom() {
                const de = doc.documentElement, bd = doc.body;
                const st = win.scrollY || de.scrollTop || 0;
                const vh = win.innerHeight || de.clientHeight || 0;
                const full = Math.max((bd && bd.scrollHeight) || 0, de.scrollHeight || 0);
                return st + vh >= full - 120;
            }
        };
    }
    function makeElCtx(el, win, doc) {
        return {
            win, doc, scrollEl: el, kind: 'el',
            viewHeight: () => el.clientHeight || 600,
            scrollBy(delta) { try { el.scrollBy({ top: delta, behavior: 'auto' }); } catch (e) { el.scrollTop += delta; } },
            scrollToTop() { try { el.scrollTo({ top: 0, behavior: 'auto' }); } catch (e) { el.scrollTop = 0; } },
            isBottom() { return el.scrollTop + el.clientHeight >= el.scrollHeight - 120; }
        };
    }
    function findScrollableIn(doc, win) {
        const candidates = doc.querySelectorAll('div, section, main, article');
        let best = null, bestExtra = 0;
        for (const el of candidates) {
            try {
                const cs = win.getComputedStyle(el);
                const oy = cs.overflowY;
                if (oy !== 'auto' && oy !== 'scroll') continue;
                const extra = el.scrollHeight - el.clientHeight;
                if (extra > 40 && extra > bestExtra) { best = el; bestExtra = extra; }
            } catch (e) {}
        }
        return best;
    }
    function getReadCtx() {
        // 1) 优先：可访问的 iframe，内容比 viewport 大
        for (const f of document.querySelectorAll('iframe')) {
            try {
                const w = f.contentWindow, d = f.contentDocument;
                if (!w || !d || !d.documentElement) continue;
                const sh = Math.max(d.documentElement.scrollHeight || 0, (d.body && d.body.scrollHeight) || 0);
                const vh = w.innerHeight || d.documentElement.clientHeight || 0;
                if (sh > vh + 40) return makeWinCtx(w, d);
                // 若 iframe 自己 window 不滚，找 iframe 内的滚动容器
                const elIn = findScrollableIn(d, w);
                if (elIn) return makeElCtx(elIn, w, d);
            } catch (e) { /* cross-origin */ }
        }
        // 2) 主窗口能滚
        const de = document.documentElement;
        if ((de.scrollHeight || 0) > (window.innerHeight || 0) + 40) {
            return makeWinCtx(window, document);
        }
        // 3) 主文档里找滚动容器
        const el = findScrollableIn(document, window);
        if (el) return makeElCtx(el, window, document);
        // 4) 兜底
        return makeWinCtx(window, document);
    }

    // 跨主文档 + iframe 文档的查询
    function queryAcross(selector) {
        const out = Array.from(document.querySelectorAll(selector));
        for (const f of document.querySelectorAll('iframe')) {
            try {
                const d = f.contentDocument;
                if (!d) continue;
                out.push(...d.querySelectorAll(selector));
            } catch (e) {}
        }
        return out;
    }

    /* =========================
       📜 滚动（轻量拟人）
       后台 tab 里 smooth 滚动依赖 rAF 会被节流，统一用 auto（瞬时）保证后台仍生效
    ========================= */
    function doScroll() {
        const ctx = getReadCtx();
        const delta = ctx.viewHeight() * (0.5 + Math.random() * 0.5);
        ctx.scrollBy(delta);
    }

    /* =========================
       🖱️ 轻量鼠标事件
    ========================= */
    function fakeMouse() {
        document.dispatchEvent(new MouseEvent('mousemove', {
            clientX: rand(0, window.innerWidth),
            clientY: rand(0, window.innerHeight),
            bubbles: true
        }));
    }

    /* =========================
       📄 是否到底
    ========================= */
    function isBottom() {
        return getReadCtx().isBottom();
    }

    /* =========================
       ➕ "加载更多" 按钮
       例： <a id="loadbutton" onclick="loadMoreChapter(...)">加载更多</a>
    ========================= */
    function clickLoadMore() {
        // 主文档 + iframe 文档都看
        const direct = queryAcross('#loadbutton');
        for (const btn of direct) {
            if (btn.offsetParent !== null && btn.style.display !== 'none') {
                log('点击 加载更多');
                try { btn.click(); } catch (e) { log('loadMore click err', e); }
                return true;
            }
        }
        const candidates = queryAcross('a, button, div');
        for (const el of candidates) {
            if (el.offsetParent === null) continue;
            const text = (el.innerText || el.textContent || '').trim();
            if (text === '加载更多' || text === '展开更多' || text === '查看更多') {
                log('点击 加载更多 (text)');
                try { el.click(); } catch (e) {}
                return true;
            }
        }
        return false;
    }

    /* =========================
       👉 翻页 / 翻章
       顺序：a.nodeItem「下一页」→ 文字匹配「下一页/下一节/下一章/下一篇」→ 左侧目录下一项
    ========================= */
    let navLock = false;
    function clickNav(el, reason) {
        log('翻页 →', reason);
        navLock = true;
        try {
            el.scrollIntoView({ behavior: 'auto', block: 'center' });
        } catch (e) {}
        setTimeout(() => {
            // 先把 elapsedMs 累到当前时刻，再 +1 页，最后落盘 —— click 之后页面可能立刻跳转
            const now = Date.now();
            if (isRunning && !isFinished && lastTickTs) {
                elapsedMs += now - lastTickTs;
                lastTickTs = now;
            }
            currentPage++;
            saveState();

            try { el.click(); } catch (e) { log('click err', e); }
            // 若没真的导航（AJAX 翻页）就再滚一次
            setTimeout(() => {
                try { getReadCtx().scrollToTop(); } catch (e) {}
                navLock = false;
            }, 1500);
        }, rand(800, 1600));
    }

    function nextPage() {
        if (navLock) return false;

        // 1) 精准匹配：超星阅读页 <a class="... nodeItem ...">下一页</a>（含 iframe 内）
        for (const a of queryAcross('a.nodeItem')) {
            if (a.offsetParent === null) continue;
            const text = (a.innerText || a.textContent || '').trim();
            if (text.includes('下一页') || text.includes('下一节') || text.includes('下一章')) {
                clickNav(a, 'nodeItem ' + text.slice(0, 6));
                return true;
            }
        }

        // 2) 文字匹配兜底：下一页系 + portal 入口系
        const keywords = ['下一页', '下一节', '下一章', '下一篇', '开始阅读', '进入阅读', '开始学习', '继续阅读'];
        for (const el of queryAcross('a, button')) {
            if (el.offsetParent === null) continue;
            const text = (el.innerText || el.textContent || '').trim();
            if (!text || text.length > 10) continue;
            if (keywords.some(k => text.includes(k))) {
                clickNav(el, 'text ' + text.slice(0, 6));
                return true;
            }
        }

        // 3) 兜底：从左侧目录跳到下一节
        if (clickNextChapterInSidebar()) return true;

        // 4) 最终兜底：已是最后一章 → 循环回到第一章继续刷
        if (gotoFirstChapter('已到最后一章 → 循环回第一章')) return true;

        log('未找到下一页/下一章按钮');
        return false;
    }

    /* =========================
       📚 左侧目录兜底
       结构: <a class="wh wh" href=".../visitnodedetail?...&knowledgeId=XXX...">
       当前 URL 的 knowledgeId 对应当前节，点同列表的下一个 a.wh
    ========================= */
    function getKnowledgeIdFromHref(href) {
        if (!href) return null;
        const m = href.match(/knowledgeId=(\d+)/);
        return m ? m[1] : null;
    }

    function clickNextChapterInSidebar() {
        const items = Array.from(document.querySelectorAll('a.wh[href*="knowledgeId"]'))
            .filter(a => a.offsetParent !== null);
        if (!items.length) return false;

        const curId = getKnowledgeIdFromHref(location.href);
        let idx = -1;
        if (curId) {
            idx = items.findIndex(a => getKnowledgeIdFromHref(a.getAttribute('href')) === curId);
        }

        // 没找到当前项时，尝试根据 active class 推断
        if (idx === -1) {
            idx = items.findIndex(a =>
                /\b(on|active|cur|current|selected)\b/i.test(a.className) ||
                /\b(on|active|cur|current|selected)\b/i.test((a.parentElement || {}).className || '')
            );
        }

        if (idx === -1) {
            // 还找不到就点第一项后面的兄弟，太激进，放弃
            log('目录兜底：未识别当前章节');
            return false;
        }

        const next = items[idx + 1];
        if (!next) {
            log('目录兜底：已是最后一节');
            return false;
        }

        clickNav(next, '目录下一节');
        return true;
    }

    /* =========================
       🔁 循环：回到第一章 / Portal 兜底进入第一章
       1) 优先 a.wh[href*=knowledgeId]（章节目录）
       2) 次选 a[href*=visitnodedetail]（任意章节详情链接）
       3) 兜底 a[href*=knowledgeId]（任意带 knowledgeId 的链接）
    ========================= */
    function findFirstChapterLinks() {
        let items = queryAcross('a.wh[href*="knowledgeId"]').filter(a => a.offsetParent !== null);
        if (items.length) return items;
        items = queryAcross('a[href*="visitnodedetail"]').filter(a => a.offsetParent !== null);
        if (items.length) return items;
        items = queryAcross('a[href*="knowledgeId"]').filter(a => a.offsetParent !== null);
        return items;
    }

    function gotoFirstChapter(reason) {
        const items = findFirstChapterLinks();
        if (!items.length) {
            log('找不到任何章节链接');
            return false;
        }
        const first = items[0];
        const curId = getKnowledgeIdFromHref(location.href);
        const firstId = getKnowledgeIdFromHref(first.getAttribute('href'));
        if (curId && firstId && curId === firstId) {
            log('已在第一章，跳过');
            return false;
        }
        log('🔁 ' + (reason || '进入第一章'));
        clickNav(first, reason || '进入第一章');
        return true;
    }

    /* =========================
       🚪 Portal 兜底：在入口页直接跳到 1.1
       portal URL 不带 knowledgeId，scroll/next 那一套都打空
       开始运行后立刻找一个章节链接点进去
    ========================= */
    function isPortalPage() {
        return /\/mooc-ans\/zt\/portal\//.test(location.href);
    }

    function tryPortalBootstrap() {
        if (!isPortalPage() || navLock) return false;
        return gotoFirstChapter('Portal 兜底 → 进入 1.1');
    }

    /* =========================
       🎨 样式注入
    ========================= */
    function injectStyles() {
        if (document.getElementById('cx-styles')) return;
        const style = document.createElement('style');
        style.id = 'cx-styles';
        style.textContent = `
            #${PANEL_ID} {
                position: fixed;
                top: 80px;
                right: 20px;
                width: 240px;
                background: #ffffff;
                border-radius: 12px;
                box-shadow: 0 10px 30px rgba(15, 23, 42, 0.12), 0 2px 6px rgba(15, 23, 42, 0.06);
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
                font-size: 13px;
                color: #1f2937;
                z-index: 999999;
                overflow: hidden;
                transition: width 0.2s ease, box-shadow 0.2s ease;
            }
            #${PANEL_ID}.collapsed { width: 150px; }
            #${PANEL_ID}.collapsed .cx-body { display: none; }
            #${PANEL_ID}:hover {
                box-shadow: 0 14px 36px rgba(15, 23, 42, 0.16), 0 2px 8px rgba(15, 23, 42, 0.08);
            }

            .cx-header {
                background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
                color: #ffffff;
                padding: 10px 14px;
                display: flex;
                align-items: center;
                justify-content: space-between;
                user-select: none;
            }
            .cx-title-wrap { display: flex; align-items: baseline; gap: 6px; }
            .cx-title { font-weight: 600; font-size: 13px; letter-spacing: 0.4px; }
            .cx-version {
                font-size: 10px;
                opacity: 0.85;
                padding: 1px 6px;
                background: rgba(255, 255, 255, 0.18);
                border-radius: 8px;
            }
            .cx-min {
                cursor: pointer;
                width: 22px; height: 22px;
                display: flex; align-items: center; justify-content: center;
                border-radius: 6px;
                transition: background 0.15s;
                font-size: 14px;
                line-height: 1;
            }
            .cx-min:hover { background: rgba(255, 255, 255, 0.22); }

            .cx-body { padding: 14px; }

            .cx-field { margin-bottom: 12px; }
            .cx-label {
                font-size: 10px;
                color: #6b7280;
                margin-bottom: 5px;
                text-transform: uppercase;
                letter-spacing: 0.8px;
                font-weight: 600;
            }
            .cx-input-row { display: flex; align-items: center; gap: 8px; }
            .cx-input {
                width: 72px;
                padding: 6px 10px;
                border: 1px solid #e5e7eb;
                border-radius: 7px;
                font-size: 13px;
                outline: none;
                background: #fafafa;
                transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
                font-variant-numeric: tabular-nums;
            }
            .cx-input:focus {
                border-color: #6366f1;
                background: #ffffff;
                box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.14);
            }
            .cx-input-unit { color: #6b7280; font-size: 12px; }

            .cx-btn-row { display: flex; gap: 8px; margin: 4px 0 14px; }
            .cx-btn {
                flex: 1;
                padding: 8px 0;
                border: none;
                border-radius: 7px;
                font-size: 13px;
                font-weight: 500;
                cursor: pointer;
                transition: transform 0.05s, box-shadow 0.18s, background 0.18s;
                font-family: inherit;
            }
            .cx-btn:active { transform: translateY(1px); }
            .cx-btn-primary {
                background: linear-gradient(135deg, #6366f1, #8b5cf6);
                color: #ffffff;
                box-shadow: 0 2px 6px rgba(99, 102, 241, 0.32);
            }
            .cx-btn-primary:hover {
                background: linear-gradient(135deg, #4f46e5, #7c3aed);
                box-shadow: 0 4px 12px rgba(99, 102, 241, 0.42);
            }
            .cx-btn-secondary {
                background: #f3f4f6;
                color: #374151;
            }
            .cx-btn-secondary:hover { background: #e5e7eb; }

            .cx-status-row {
                display: flex; align-items: center; gap: 8px;
                margin-bottom: 10px;
            }
            .cx-dot {
                width: 8px; height: 8px; border-radius: 50%;
                background: #9ca3af;
                box-shadow: 0 0 0 3px rgba(156, 163, 175, 0.18);
                flex-shrink: 0;
            }
            .cx-dot.running {
                background: #10b981;
                box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.22);
                animation: cx-pulse 1.5s ease-in-out infinite;
            }
            .cx-dot.finished {
                background: #3b82f6;
                box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.22);
            }
            @keyframes cx-pulse {
                0%, 100% { box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.22); }
                50%      { box-shadow: 0 0 0 7px rgba(16, 185, 129, 0.06); }
            }
            .cx-status-text { font-size: 12px; font-weight: 500; color: #374151; }
            .cx-status-pct {
                margin-left: auto;
                font-size: 11px;
                color: #6b7280;
                font-variant-numeric: tabular-nums;
            }

            .cx-progress-track {
                height: 6px;
                background: #f3f4f6;
                border-radius: 999px;
                overflow: hidden;
                margin-bottom: 12px;
            }
            .cx-progress-fill {
                height: 100%;
                background: linear-gradient(90deg, #6366f1, #8b5cf6);
                border-radius: 999px;
                transition: width 0.4s ease;
                width: 0%;
            }

            .cx-stats { font-size: 12px; line-height: 1.7; }
            .cx-stat-row {
                display: flex; justify-content: space-between;
                padding: 2px 0;
            }
            .cx-stat-key { color: #6b7280; }
            .cx-stat-val {
                font-variant-numeric: tabular-nums;
                font-weight: 500;
                color: #1f2937;
            }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    /* =========================
       🧩 控制面板
    ========================= */
    function createPanel() {
        injectStyles();
        document.querySelectorAll('#' + PANEL_ID).forEach(el => el.remove());

        const panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.innerHTML = `
            <div class="cx-header">
                <div class="cx-title-wrap">
                    <span class="cx-title">📖 reading_cx</span>
                    <span class="cx-version">v1.0</span>
                </div>
                <div class="cx-min" id="cx-min" title="收起 / 展开">─</div>
            </div>
            <div class="cx-body">
                <div class="cx-field">
                    <div class="cx-label">目标时长</div>
                    <div class="cx-input-row">
                        <input id="cx-target" class="cx-input" type="number" min="1" value="${targetMin}" />
                        <span class="cx-input-unit">分钟</span>
                    </div>
                </div>
                <div class="cx-btn-row">
                    <button id="cx-toggle" class="cx-btn cx-btn-primary">开始</button>
                    <button id="cx-reset" class="cx-btn cx-btn-secondary">重置</button>
                </div>
                <div class="cx-status-row">
                    <div id="cx-dot" class="cx-dot"></div>
                    <div id="cx-status-text" class="cx-status-text">未开始</div>
                    <div id="cx-status-pct" class="cx-status-pct">0%</div>
                </div>
                <div class="cx-progress-track">
                    <div id="cx-progress" class="cx-progress-fill"></div>
                </div>
                <div class="cx-stats">
                    <div class="cx-stat-row"><span class="cx-stat-key">已用</span><span class="cx-stat-val" id="cx-stat-used">00:00:00</span></div>
                    <div class="cx-stat-row"><span class="cx-stat-key">剩余</span><span class="cx-stat-val" id="cx-stat-remain">00:00:00</span></div>
                    <div class="cx-stat-row"><span class="cx-stat-key">页数</span><span class="cx-stat-val" id="cx-stat-page">1</span></div>
                </div>
            </div>
        `;

        document.body.appendChild(panel);

        const targetInput = document.getElementById('cx-target');
        targetInput.onchange = () => {
            const v = Math.max(1, Number(targetInput.value) || 1);
            targetMin = v;
            targetInput.value = v;
            localStorage.setItem(LS_KEY, String(v));
        };

        document.getElementById('cx-toggle').onclick = () => {
            if (isFinished) {
                isFinished = false;
                elapsedMs = 0;
            }
            isRunning = !isRunning;
            if (isRunning) lastTickTs = Date.now();
            saveState();
            updateInfo();
        };

        document.getElementById('cx-reset').onclick = () => {
            elapsedMs = 0;
            isFinished = false;
            currentPage = 1;
            isRunning = false;
            lastTickTs = Date.now();
            clearState();
            updateInfo();
        };

        document.getElementById('cx-min').onclick = () => {
            panel.classList.toggle('collapsed');
        };
    }

    function updateInfo() {
        const dot = document.getElementById('cx-dot');
        const statusText = document.getElementById('cx-status-text');
        const statusPct = document.getElementById('cx-status-pct');
        const progress = document.getElementById('cx-progress');
        const used = document.getElementById('cx-stat-used');
        const remainEl = document.getElementById('cx-stat-remain');
        const pageEl = document.getElementById('cx-stat-page');
        const toggleBtn = document.getElementById('cx-toggle');
        if (!dot) return;

        const targetMs = Math.max(1, targetMin * 60 * 1000);
        const remain = Math.max(0, targetMs - elapsedMs);
        const pct = Math.min(100, Math.round((elapsedMs / targetMs) * 100));

        dot.className = 'cx-dot' + (isFinished ? ' finished' : (isRunning ? ' running' : ''));
        statusText.innerText = isFinished ? '已完成' : (isRunning ? '运行中' : '已暂停');
        statusPct.innerText = pct + '%';
        progress.style.width = pct + '%';
        used.innerText = fmtMs(elapsedMs);
        remainEl.innerText = fmtMs(remain);
        pageEl.innerText = String(currentPage);
        if (toggleBtn) toggleBtn.innerText = isFinished ? '重新开始' : (isRunning ? '暂停' : '开始');
    }

    /* =========================
       🔁 主循环（worker 心跳 + setInterval 兜底驱动）
    ========================= */
    let lastLoopRun = 0;
    let nextLoopDelay = 3000;

    function loopOnce() {
        if (!document.body) return;
        if (!isReadingPage()) return;       // 非阅读页：彻底不工作
        if (!document.getElementById(PANEL_ID)) {
            createPanel();
        }

        const now = Date.now();
        if (isRunning && !isFinished) {
            if (lastTickTs) elapsedMs += now - lastTickTs;
            lastTickTs = now;
        } else {
            lastTickTs = now;
        }

        // 达到目标 → 停止
        if (!isFinished && elapsedMs >= targetMin * 60 * 1000) {
            isFinished = true;
            isRunning = false;
            log(`已达到目标时长 ${targetMin} 分钟，自动停止`);
            updateInfo();
            saveState();
            return;
        }

        updateInfo();
        if (!isRunning || isFinished) return;

        // 周期落盘：每次循环都存一次，最大丢 ~3s 进度
        saveState();

        // 0) Portal 入口页 → 直接跳第一章，绕开滚动/翻页
        if (tryPortalBootstrap()) return;

        // 1) 先看是不是要点"加载更多"（接近底部时优先展开）
        if (isBottom() && clickLoadMore()) {
            return; // 让 DOM 加载，下一轮再判断
        }

        // 2) 滚动 + 拟人鼠标
        doScroll();
        if (Math.random() < 0.3) fakeMouse();

        // 3) 真到底 → 翻页/翻章
        if (isBottom() && !navLock) {
            setTimeout(nextPage, rand(1500, 3000));
        }
    }

    function tryTick() {
        const now = Date.now();
        if (now - lastLoopRun < nextLoopDelay) return;
        lastLoopRun = now;
        nextLoopDelay = isRunning ? rand(2500, 4500) : 1000;
        try { loopOnce(); } catch (e) { log('loop err', e); }
    }

    onBgTick(tryTick);
    setInterval(tryTick, 800); // 前台兜底，避免 worker 失败

    /* =========================
       🛡️ 运行时守卫：识别"阅读页"结构
       portal / visitnodedetail / 以后扩展的 @match 都共用同一份判定
       命中任意一个特征即视为阅读页，否则不显示面板
    ========================= */
    function isReadingPage() {
        return !!(
            queryAcross('a.nodeItem').length ||                     // 下一页按钮
            queryAcross('#loadbutton').length ||                    // 加载更多
            queryAcross('a.wh[href*="knowledgeId"]').length ||      // 左侧目录
            queryAcross('[class*="readContent"]').length ||         // 阅读容器
            document.querySelector('iframe')                        // 任何 iframe（portal 也算）
        );
    }

    /* =========================
       🚀 启动
    ========================= */
    function init() {
        log('reading_cx v1.0 启动');
        loadState();
        lastTickTs = Date.now();

        // DOM 还在动态注入，给最多 8 秒窗口轮询识别阅读结构
        const deadline = Date.now() + 8000;
        const probe = () => {
            if (isReadingPage()) {
                createPanel();
                updateInfo();
                log('识别为阅读页 → 面板已显示');
                return;
            }
            if (Date.now() < deadline) {
                setTimeout(probe, 500);
            } else {
                log('未检测到阅读结构，跳过面板（页面可能非阅读页）');
            }
        };
        probe();
    }

    function waitBodyAndInit() {
        if (document.body) {
            init();
        } else {
            new MutationObserver((_, obs) => {
                if (document.body) { obs.disconnect(); init(); }
            }).observe(document.documentElement, { childList: true });
        }
    }
    waitBodyAndInit();

})();
