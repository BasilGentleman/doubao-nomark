(function() {
    'use strict';

    const URL_PATTERNS = Object.freeze({
        QIANWEN_SESSION_LIST: 'qianwen.com/api/v1/session/msg/list',
        QIANWEN_SHARE_INFO: 'qianwen.com/api/v1/share/info',
        QIANWEN_SNAP: 'qianwen.com/api/v1/chat/snap',
        DOUBAO_COMPLETION: '/chat/completion',
        DOUBAO_CHAIN: '/im/chain/single',
        DOUBAO_CANVAS_DOC_GET: '/creativity/canvas_workspace/doc/get'
    });
    const DOUBAO_HOSTS = Object.freeze(new Set(['www.doubao.com', 'www.dola.com']));
    const PLATFORM_CODE = window.location.hostname.includes('qianwen.com') ? 'Q' : 'D';
    const FALLBACK_API_PARAMS = Object.freeze({ codec_type: '8', logo_type: 'unwatermarked' });
    const FALLBACK_API_HOST_SUFFIXES = Object.freeze([
        '.snssdk.com', '.douyinvod.com', '.dola.com', '.byteintlapi.com'
    ]);
    const FALLBACK_REQUEST_EVENT = 'doubao-nomark-fallback-request';
    const FALLBACK_RESPONSE_EVENT = 'doubao-nomark-fallback-response';
    const DOWNLOAD_REQUEST_EVENT = 'doubao-nomark-download-request';
    const DOWNLOAD_RESPONSE_EVENT = 'doubao-nomark-download-response';
    const DOWNLOAD_FAILURE_EVENT = 'doubao-nomark-download-failure';
    const FALLBACK_REQUEST_TIMEOUT_MS = 20000;
    const DOWNLOAD_REQUEST_TIMEOUT_MS = 30000;
    const pendingFallbackRequests = new Map();
    const pendingDownloadRequests = new Map();
    let fallbackRequestSequence = 0;
    let downloadRequestSequence = 0;

    function isDoubaoHost() {
        return DOUBAO_HOSTS.has(window.location.hostname);
    }

    function getDoubaoOrigin() {
        return window.location.hostname === 'www.dola.com'
            ? window.location.origin
            : 'https://www.doubao.com';
    }

    function getRequestUrl(input) {
        if (typeof input === 'string') return input;
        if (input && typeof input.url === 'string') return input.url;
        return '';
    }

    function hasUrl(url, pattern) {
        return typeof url === 'string' && url.includes(pattern);
    }

    function isHttpUrl(value) {
        try {
            return ['http:', 'https:'].includes(new URL(value).protocol);
        } catch (_) {
            return false;
        }
    }

    function isTrustedFallbackApi(value) {
        try {
            const url = new URL(value);
            const hostname = url.hostname.toLowerCase();
            const trustedHost = FALLBACK_API_HOST_SUFFIXES.some(suffix =>
                hostname === suffix.slice(1) || hostname.endsWith(suffix)
            );
            return url.protocol === 'https:' && trustedHost && url.pathname.startsWith('/video/fplay/');
        } catch (_) {
            return false;
        }
    }

    function buildFallbackApiUrl(value) {
        if (!isTrustedFallbackApi(value)) return null;
        const url = new URL(value);
        Object.entries(FALLBACK_API_PARAMS).forEach(([key, item]) => url.searchParams.set(key, item));
        return url.href;
    }

    document.addEventListener(FALLBACK_RESPONSE_EVENT, event => {
        const detail = event.detail;
        const pending = detail && pendingFallbackRequests.get(detail.requestId);
        if (!pending) return;
        pendingFallbackRequests.delete(detail.requestId);
        clearTimeout(pending.timeoutId);
        if (detail.ok) pending.resolve(detail.payload);
        else pending.reject(new Error(detail.error || `HTTP ${detail.status || 0}`));
    });

    document.addEventListener(DOWNLOAD_RESPONSE_EVENT, event => {
        const detail = event.detail;
        const pending = detail && pendingDownloadRequests.get(detail.requestId);
        if (!pending) return;
        pendingDownloadRequests.delete(detail.requestId);
        clearTimeout(pending.timeoutId);
        if (detail.ok) pending.resolve();
        else pending.reject(new Error(detail.error || '后台下载失败'));
    });

    document.addEventListener(DOWNLOAD_FAILURE_EVENT, event => {
        const error = event.detail?.error || '浏览器未能创建下载任务';
        console.error('[无印豆包] 后台下载失败:', error);
        alert(`下载失败：${error}`);
    });

    async function requestFallbackJson(value) {
        const url = buildFallbackApiUrl(value);
        if (!url) throw new Error('fallback_api 地址不受信任');

        if (document.documentElement.dataset.doubaoNomarkBridge !== 'ready') {
            const response = await fetch(url, { headers: { Accept: 'application/json, text/plain, */*' } });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json();
        }

        const requestId = `${Date.now().toString(36)}-${(++fallbackRequestSequence).toString(36)}`;
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                pendingFallbackRequests.delete(requestId);
                reject(new Error('fallback_api 请求超时'));
            }, FALLBACK_REQUEST_TIMEOUT_MS);
            pendingFallbackRequests.set(requestId, { resolve, reject, timeoutId });
            document.dispatchEvent(new CustomEvent(FALLBACK_REQUEST_EVENT, {
                detail: { requestId, url }
            }));
        });
    }

    function requestExtensionDownload(url, filename) {
        const requestId = `${Date.now().toString(36)}-${(++downloadRequestSequence).toString(36)}`;
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                pendingDownloadRequests.delete(requestId);
                reject(new Error('后台下载请求超时'));
            }, DOWNLOAD_REQUEST_TIMEOUT_MS);
            pendingDownloadRequests.set(requestId, { resolve, reject, timeoutId });
            document.dispatchEvent(new CustomEvent(DOWNLOAD_REQUEST_EVENT, {
                detail: { requestId, url, filename }
            }));
        });
    }

    function extractFallbackApis(root = document) {
        const apis = new Set();
        const scripts = root.querySelectorAll(
            'script[data-script-src="modern-run-router-data-fn"], script[data-script-src="modern-run-window-fn"]'
        );
        scripts.forEach(script => {
            const rawArgs = script.getAttribute('data-fn-args');
            if (!rawArgs) return;
            try { collectFallbackApis(JSON.parse(rawArgs), apis); } catch (_) { /* Ignore unrelated page data. */ }
        });
        return [...apis];
    }

    function extractFallbackApisFromHtml(html) {
        const page = new DOMParser().parseFromString(html, 'text/html');
        return extractFallbackApis(page);
    }

    async function discoverShareFallbackApis() {
        const apis = new Set(extractFallbackApis());
        try {
            const response = await fetch(window.location.href, { credentials: 'include' });
            if (response.ok) {
                for (const api of extractFallbackApisFromHtml(await response.text())) apis.add(api);
            }
        } catch (_) {
            // Live page data can still be sufficient when refetching the share page fails.
        }
        return [...apis];
    }

    function numberValue(value) {
        const number = Number(value);
        return Number.isFinite(number) ? number : 0;
    }

    function decodeJsonEscapedFragment(value) {
        let text = String(value || '');
        for (let index = 0; index < 3; index++) {
            try {
                const decoded = JSON.parse(`"${text.replace(/"/g, '\\"')}"`);
                if (decoded === text) break;
                text = decoded;
            } catch (_) {
                break;
            }
        }
        return text.replace(/\\u0026/g, '&').replace(/\\\//g, '/');
    }

    function collectFallbackApis(value, apis, depth = 0) {
        if (depth > 30 || value == null) return;
        if (Array.isArray(value)) {
            value.forEach(item => collectFallbackApis(item, apis, depth + 1));
            return;
        }
        if (typeof value === 'string') {
            const text = value.trim();
            if (text.startsWith('{') || text.startsWith('[')) {
                try { collectFallbackApis(JSON.parse(text), apis, depth + 1); } catch (_) { /* Ignore plain text. */ }
            }
            return;
        }
        if (!value || typeof value !== 'object') return;
        Object.entries(value).forEach(([key, item]) => {
            if (key === 'fallback_api' && typeof item === 'string') {
                const api = decodeJsonEscapedFragment(item);
                if (isTrustedFallbackApi(api)) apis.add(api);
            }
            collectFallbackApis(item, apis, depth + 1);
        });
    }

    function findFallbackApis(json, rawBody = '') {
        const apis = new Set();
        collectFallbackApis(json, apis);
        for (const pattern of [/fallback_api\\":\\"(.*?)\\"/g, /"fallback_api"\s*:\s*"([^"]+)"/g]) {
            let match;
            while ((match = pattern.exec(rawBody))) {
                const api = decodeJsonEscapedFragment(match[1]);
                if (isTrustedFallbackApi(api)) apis.add(api);
            }
        }
        return [...apis];
    }

    function processFallbackVideos(json, rawBody = '') {
        for (const fallbackApi of findFallbackApis(json, rawBody)) {
            queueFallbackVideo(fallbackApi);
        }
    }

    function queueFallbackVideo(fallbackApi) {
        if (!isTrustedFallbackApi(fallbackApi) || processedFallbackApis.has(fallbackApi)) return;
        processedFallbackApis.add(fallbackApi);
        console.log('[无印豆包] 已缓存 fallback_api，主方法失败时使用:', fallbackApi);
    }

    async function startFallbackVideo(fallbackApi, label = 'fallback_api') {
        if (!isTrustedFallbackApi(fallbackApi) || requestedFallbackApis.has(fallbackApi)) return;
        const requestScope = getMediaScope();
        queueFallbackVideo(fallbackApi);
        requestedFallbackApis.add(fallbackApi);
        let succeeded = false;
        try {
            const info = await getDoubaoVideoInfoFallback('', fallbackApi);
            if (info && requestScope === getMediaScope()) {
                succeeded = true;
                console.log(`[无印豆包] ${label} 获取无水印视频成功:`, info.url);
                addChatVideo(info);
            }
        } catch (error) {
            console.warn(`[无印豆包] ${label} 视频解析失败:`, error);
        } finally {
            if (!succeeded) requestedFallbackApis.delete(fallbackApi);
        }
    }

    async function loadSharePageVideos() {
        const fallbackApis = await discoverShareFallbackApis();
        console.log('[无印豆包] 分享页 fallback_api 数量:', fallbackApis.length);
        await Promise.allSettled(
            fallbackApis.map(fallbackApi => startFallbackVideo(fallbackApi, '分享页'))
        );
    }

    async function getDoubaoVideoInfoFallback(vid, directFallbackApi = '') {
        let fallbackApis = directFallbackApi
            ? [directFallbackApi]
            : [...processedFallbackApis, ...await discoverShareFallbackApis()];
        fallbackApis = [...new Set(fallbackApis.filter(isTrustedFallbackApi))];
        console.log('[无印豆包] fallback_api 候选数量:', fallbackApis.length);
        let firstResult = null;
        for (const fallbackApi of fallbackApis) {
            try {
                const payload = await requestFallbackJson(fallbackApi);
                const videoInfo = payload?.video_info || payload?.data?.video_info || payload;
                const data = videoInfo?.data || videoInfo;
                if (!data || typeof data !== 'object') continue;
                const videoList = data.video_list;
                const entries = (videoList && typeof videoList === 'object')
                    ? (Array.isArray(videoList) ? videoList : Object.values(videoList))
                    : [data];
                const candidates = entries.filter(item => item && (item.main_url || item.play_url));
                if (!candidates.length) continue;
                const entry = candidates.sort((left, right) =>
                    (numberValue(right.vwidth || right.width) * numberValue(right.vheight || right.height)
                        + numberValue(right.bitrate || right.real_bitrate) / 1000000)
                    - (numberValue(left.vwidth || left.width) * numberValue(left.vheight || left.height)
                        + numberValue(left.bitrate || left.real_bitrate) / 1000000)
                )[0];
                const url = await window.DoubaoVideoCrypto?.decodeMainUrl(
                    entry.main_url || entry.play_url,
                    data.key_seed || videoInfo.key_seed || payload.key_seed
                );
                if (!url) continue;
                const result = {
                    vid: data.vid || data.video_id || entry.vid || entry.video_id || fallbackApi,
                    width: numberValue(entry.vwidth || entry.width || data.vwidth || data.width),
                    height: numberValue(entry.vheight || entry.height || data.vheight || data.height),
                    definition: entry.definition || data.definition || '',
                    duration: numberValue(entry.duration || data.duration || data.video_duration),
                    codec_type: entry.codec_type || data.codec_type || '',
                    poster_url: data.poster_url || data.poster || '',
                    url
                };
                if (!firstResult) firstResult = result;
                if (!vid || directFallbackApi || result.vid === vid) return result;
            } catch (error) {
                console.warn('[无印豆包] fallback_api 解析失败:', error.message);
            }
        }
        return vid ? null : firstResult;
    }

    function observeJson(response, handler) {
        return response.clone().json().then(handler).catch(() => {});
    }

    function observeResponseStream(response, onChunk, onComplete) {
        if (!response.body) return response;
        const reader = response.clone().body.getReader();
        const decoder = new TextDecoder();
        (async () => {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                onChunk(decoder.decode(value, { stream: true }));
            }
            const trailingChunk = decoder.decode();
            if (trailingChunk) onChunk(trailingChunk);
            onComplete?.();
        })().catch(error => {
            reader.cancel().catch(() => {});
            console.warn('[无印豆包] 旁路读取流失败:', error);
        });
        return response;
    }

    function getStableValue(value) {
        return value === undefined || value === null ? '' : String(value).trim();
    }

    function getUrlIdentity(url) {
        const value = getStableValue(url);
        if (!value) return '';
        const queryStart = value.search(/[?#]/);
        return queryStart === -1 ? value : value.slice(0, queryStart);
    }

    function isSameUrl(left, right) {
        const leftIdentity = getUrlIdentity(left);
        const rightIdentity = getUrlIdentity(right);
        return Boolean(leftIdentity && leftIdentity === rightIdentity);
    }

    function isSameImage(left, right) {
        const leftKey = getStableValue(left?.key);
        const rightKey = getStableValue(right?.key);
        if (leftKey || rightKey) return Boolean(leftKey && rightKey && leftKey === rightKey);
        return isSameUrl(left?.url, right?.url);
    }

    function isSameVideo(left, right) {
        const leftVid = getStableValue(left?.vid);
        const rightVid = getStableValue(right?.vid);
        if (leftVid || rightVid) {
            if (leftVid && rightVid) return leftVid === rightVid;
            return isSameUrl(left?.url, right?.url);
        }
        return isSameUrl(left?.url, right?.url);
    }

    // Signed image URLs can change between requests. Keep one item per image key
    // while refreshing its URL and metadata when the service returns a newer copy.
    function addUniqueImage(image, target = chatImages, prepend = false) {
        if (!image?.url) return false;
        const existing = target.find(item => isSameImage(item, image));
        if (!existing) {
            if (prepend) target.unshift(image);
            else target.push(image);
            return true;
        }

        const changed = Boolean(existing.url !== image.url
            || (!existing.key && image.key)
            || (image.width > 0 && existing.width !== image.width)
            || (image.height > 0 && existing.height !== image.height));
        if (changed) {
            existing.url = image.url;
            if (!existing.key && image.key) existing.key = image.key;
            if (image.width > 0) existing.width = image.width;
            if (image.height > 0) existing.height = image.height;
        }
        return changed;
    }

    function normalizeImageData(imageData, decodeAmp = false, stableKey = '') {
        if (typeof imageData === 'string') return { url: imageData, key: '', width: 0, height: 0 };
        if (!imageData || typeof imageData !== 'object' || !imageData.url) return null;
        const url = decodeAmp ? imageData.url.replace(/&amp;/g, '&') : imageData.url;
        return {
            url,
            key: getStableValue(stableKey || imageData.key),
            width: imageData.width || 0,
            height: imageData.height || 0
        };
    }

    function parseCanvasDocumentImages(data) {
        const items = data?.data?.snapshot?.doc?.items;
        if (!items || typeof items !== 'object' || Array.isArray(items)) return;

        resetMediaForScopeChange();
        let mediaChanged = false;
        for (const [itemId, item] of Object.entries(items)) {
            const imageInfo = item?.asset?.image_info;
            const rawValue = imageInfo?.image_ori_raw;
            const rawImages = Array.isArray(rawValue) ? rawValue : [rawValue];
            for (const rawImage of rawImages) {
                const image = normalizeImageData(
                    rawImage,
                    false,
                    imageInfo?.key || item?.asset?.asset_key || itemId
                );
                if (!addUniqueImage(image)) continue;
                mediaChanged = true;
                console.log('[无印豆包][画布] 获取到原始图片:', image.url, `${image.width} × ${image.height}`);
            }
        }
        if (mediaChanged) updateButtonCount();
    }

    console.log('%c[无印豆包] 脚本开始执行', 'color: #667eea; font-size: 14px; font-weight: bold');
    console.log('[无印豆包] 当前 URL:', window.location.href);

    let chatImages = [];
    let chatVideos = [];
    let floatingBtnElement = null;
    let panelMediaSync = null;
    let inlineDownloadObserver = null;
    let inlineDownloadSyncFrame = 0;
    let mediaScope = getMediaScope();
    const processedFallbackApis = new Set();
    const requestedFallbackApis = new Set();
    const pendingVideoInfo = new Map();
    const fallbackApiByVideoId = new Map();
    const INLINE_IMAGE_GRID_SELECTOR = '[data-testid="message_image_content"]';
    const INLINE_DOWNLOAD_HOST_ATTRIBUTE = 'data-doubao-nomark-inline-download';
    const INLINE_VIDEO_DOWNLOAD_ATTRIBUTE = 'data-doubao-nomark-video-download';

    function getMediaScope() {
        return `${window.location.hostname}${window.location.pathname}${window.location.search}${window.location.hash}`;
    }

    function resetMediaForScopeChange() {
        const nextScope = getMediaScope();
        if (nextScope === mediaScope) return false;
        mediaScope = nextScope;
        chatImages = [];
        chatVideos = [];
        pendingVideoInfo.clear();
        processedFallbackApis.clear();
        requestedFallbackApis.clear();
        fallbackApiByVideoId.clear();
        updateButtonCount();
        return true;
    }

    function notifyPanelMediaChanged() {
        panelMediaSync?.();
    }

    function updateButtonCount() {
        scheduleInlineDownloadSync();
        if (!floatingBtnElement) return;
        const countElement = floatingBtnElement.querySelector('.count');
        if (!countElement) return;
        countElement.textContent = chatImages.length + chatVideos.length;
        notifyPanelMediaChanged();
    }

    function safelyDecodeUrlPart(value) {
        try {
            return decodeURIComponent(String(value || ''));
        } catch (_) {
            return String(value || '');
        }
    }

    function getComparableUrlParts(value) {
        try {
            const url = new URL(value, window.location.href);
            const pathname = safelyDecodeUrlPart(url.pathname).toLowerCase();
            const basename = (pathname.split('/').pop() || '').replace(/~tplv-.+$/i, '');
            const tokens = new Set(
                pathname.match(/[a-z0-9][a-z0-9_-]{11,}/gi) || []
            );
            return {
                identity: getUrlIdentity(url.href).toLowerCase(),
                pathname,
                basename,
                tokens
            };
        } catch (_) {
            return null;
        }
    }

    function collectImageBlockUrls(item) {
        const urls = new Set();
        item.querySelectorAll('img, source').forEach(element => {
            for (const value of [element.currentSrc, element.src, element.getAttribute('src')]) {
                if (isHttpUrl(value)) urls.add(value);
            }
            const srcset = element.getAttribute('srcset') || '';
            srcset.split(',').forEach(candidate => {
                const value = candidate.trim().split(/\s+/)[0];
                if (isHttpUrl(value)) urls.add(value);
            });
        });
        return [...urls];
    }

    function scoreCachedImageForBlock(image, serializedItem, visibleParts) {
        if (!image?.url) return 0;
        const imageParts = getComparableUrlParts(image.url);
        if (!imageParts) return 0;

        let score = 0;
        const key = safelyDecodeUrlPart(image.key).toLowerCase();
        if (key.length >= 8 && serializedItem.includes(key)) score = Math.max(score, 1400 + key.length);

        for (const parts of visibleParts) {
            if (parts.identity === imageParts.identity) score = Math.max(score, 1300);
            if (parts.pathname === imageParts.pathname) score = Math.max(score, 1100);
            if (parts.basename.length >= 12 && parts.basename === imageParts.basename) {
                score = Math.max(score, 900 + parts.basename.length);
            }
            for (const token of parts.tokens) {
                if (imageParts.tokens.has(token)) score = Math.max(score, 500 + token.length);
                if (key.length >= 8 && (key.includes(token) || token.includes(key))) {
                    score = Math.max(score, 700 + Math.min(key.length, token.length));
                }
            }
        }
        return score;
    }

    function resolveImageForBlock(item) {
        const visibleUrls = collectImageBlockUrls(item);
        const visibleParts = visibleUrls.map(getComparableUrlParts).filter(Boolean);
        const serializedItem = safelyDecodeUrlPart(item.outerHTML).toLowerCase();
        let bestImage = null;
        let bestScore = 0;

        for (const image of chatImages) {
            const score = scoreCachedImageForBlock(image, serializedItem, visibleParts);
            if (score > bestScore) {
                bestImage = image;
                bestScore = score;
            }
        }
        if (bestImage && bestScore >= 500) return bestImage;

        const fallbackUrl = visibleUrls[0];
        if (!fallbackUrl) return null;
        const imageElement = item.querySelector('img');
        return {
            url: fallbackUrl,
            key: '',
            width: imageElement?.naturalWidth || 0,
            height: imageElement?.naturalHeight || 0
        };
    }

    function createInlineImageFilename(image) {
        const now = new Date();
        const pad = (value, length = 2) => String(value).padStart(length, '0');
        const timestamp = [
            now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate()), '_',
            pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds()), '_',
            pad(now.getMilliseconds(), 3)
        ].join('');
        const cachedIndex = chatImages.indexOf(image);
        const suffix = cachedIndex >= 0 ? `_${pad(cachedIndex + 1)}` : '';
        return `image_${PLATFORM_CODE}_${timestamp}${suffix}.png`;
    }

    function createInlineVideoFilename(video) {
        const now = new Date();
        const pad = (value, length = 2) => String(value).padStart(length, '0');
        const timestamp = [
            now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate()), '_',
            pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds()), '_',
            pad(now.getMilliseconds(), 3)
        ].join('');
        const cachedIndex = chatVideos.indexOf(video);
        const suffix = cachedIndex >= 0 ? `_${pad(cachedIndex + 1)}` : '';
        return `video_${PLATFORM_CODE}_${timestamp}${suffix}.mp4`;
    }

    function createInlineDownloadHost(item, image) {
        if (getComputedStyle(item).position === 'static') item.style.position = 'relative';
        item.dataset.doubaoNomarkImageItem = 'true';

        const host = document.createElement('span');
        host.setAttribute(INLINE_DOWNLOAD_HOST_ATTRIBUTE, '');
        const shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML = `
            <style>
                :host {
                    all: initial;
                    position: absolute;
                    right: 7px;
                    bottom: 7px;
                    z-index: 20;
                    display: block;
                    width: 28px;
                    height: 28px;
                    opacity: 0;
                    pointer-events: none;
                    transform: translateY(2px);
                    transition: opacity 140ms ease, transform 140ms ease;
                }
                :host-context([data-doubao-nomark-image-item]:hover),
                :host(:focus-within) {
                    opacity: 1;
                    pointer-events: auto;
                    transform: translateY(0);
                }
                button {
                    all: unset;
                    box-sizing: border-box;
                    width: 28px;
                    height: 28px;
                    display: grid;
                    place-items: center;
                    border: 0;
                    border-radius: 6px;
                    background: rgba(18, 18, 20, 0.18);
                    color: rgba(255, 255, 255, 0.96);
                    cursor: pointer;
                    line-height: 1;
                    transition: background-color 120ms ease, transform 120ms ease;
                }
                button:hover {
                    background: rgba(18, 18, 20, 0.4);
                    transform: translateY(-1px);
                }
                button:active { transform: translateY(0); }
                button:focus-visible {
                    background: rgba(18, 18, 20, 0.4);
                    outline: 1px solid rgba(255, 255, 255, 0.9);
                    outline-offset: 1px;
                }
                button:disabled { cursor: wait; opacity: 0.82; }
                .icon {
                    width: 18px;
                    height: 18px;
                    display: grid;
                    place-items: center;
                }
                .icon svg {
                    width: 18px;
                    height: 18px;
                    display: block;
                }
                button.is-loading .icon {
                    box-sizing: border-box;
                    width: 14px;
                    height: 14px;
                    border: 2px solid rgba(255, 255, 255, 0.45);
                    border-top-color: #fff;
                    border-radius: 50%;
                    animation: spin 650ms linear infinite;
                }
                button.is-loading .icon svg,
                button.is-success .icon svg { display: none; }
                button.is-success .icon::before {
                    content: '\\2713';
                    font: 600 16px/1 Arial, sans-serif;
                }
                @keyframes spin { to { transform: rotate(360deg); } }
                @media (hover: none) {
                    :host {
                        opacity: 1;
                        pointer-events: auto;
                        transform: translateY(0);
                    }
                }
                @media (prefers-reduced-motion: reduce) {
                    :host { transition: none; }
                }
            </style>
            <button type="button" title="下载无水印图片" aria-label="下载无水印图片">
                <span class="icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M12 3V15M12 15L7.5 10.5M12 15L16.5 10.5M5 17V19C5 20.1 5.9 21 7 21H17C18.1 21 19 20.1 19 19V17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                </span>
            </button>
        `;

        host.doubaoNomarkImage = image;
        const button = shadow.querySelector('button');
        button.addEventListener('click', async event => {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            if (button.disabled) return;

            const currentImage = host.doubaoNomarkImage;
            if (!currentImage?.url) return;
            button.disabled = true;
            button.classList.add('is-loading');
            button.setAttribute('aria-busy', 'true');
            const succeeded = await downloadImage(currentImage.url, createInlineImageFilename(currentImage));
            button.classList.remove('is-loading');
            button.classList.toggle('is-success', succeeded);
            button.removeAttribute('aria-busy');
            if (succeeded) await new Promise(resolve => setTimeout(resolve, 700));
            button.classList.remove('is-success');
            button.disabled = false;
        });
        item.appendChild(host);
        return host;
    }

    function getInlineImageItems() {
        const items = [];
        document.querySelectorAll(INLINE_IMAGE_GRID_SELECTOR).forEach(grid => {
            for (const child of grid.children) {
                if (child.querySelector('[data-testid="mdbox_image"], picture img[src]')) {
                    items.push(child);
                }
            }
        });
        return items;
    }

    function getInlineVideoItems() {
        const items = new Set();
        document.querySelectorAll('video[mediatype="video"], .xgplayer video').forEach(video => {
            const videoBlock = video.closest('[class*="block-video-"]');
            const item = video.closest('[class*="image-box-grid-item-"]') || videoBlock?.parentElement;
            if (item) items.add(item);
        });
        return [...items];
    }

    function collectVideoBlockMedia(item) {
        const sourceUrls = new Set();
        const posterUrls = new Set();
        const video = item.querySelector('video');
        if (video) {
            for (const value of [video.currentSrc, video.src, video.getAttribute('src')]) {
                if (isHttpUrl(value)) sourceUrls.add(value);
            }
            video.querySelectorAll('source').forEach(source => {
                for (const value of [source.src, source.getAttribute('src')]) {
                    if (isHttpUrl(value)) sourceUrls.add(value);
                }
            });
            if (isHttpUrl(video.poster)) posterUrls.add(video.poster);
        }
        item.querySelectorAll('img[src]').forEach(image => {
            const value = image.currentSrc || image.src;
            if (isHttpUrl(value)) posterUrls.add(value);
        });
        item.querySelectorAll('xg-poster[style]').forEach(poster => {
            const match = poster.getAttribute('style')?.match(/url\(["']?([^"')]+)["']?\)/i);
            if (match && isHttpUrl(match[1])) posterUrls.add(match[1]);
        });
        return { sourceUrls: [...sourceUrls], posterUrls: [...posterUrls] };
    }

    function getVideoPathTail(value) {
        const parts = getComparableUrlParts(value);
        if (!parts) return '';
        const videoPathStart = parts.pathname.indexOf('/video/');
        return videoPathStart >= 0 ? parts.pathname.slice(videoPathStart) : '';
    }

    function getLongUrlTokens(value) {
        try {
            const url = new URL(value, window.location.href);
            const decoded = safelyDecodeUrlPart(`${url.pathname} ${[...url.searchParams.values()].join(' ')}`)
                .toLowerCase();
            return new Set(decoded.match(/[a-z0-9][a-z0-9_-]{11,}/gi) || []);
        } catch (_) {
            return new Set();
        }
    }

    function scoreVideoUrlPair(cachedUrl, visibleUrl) {
        if (!isHttpUrl(cachedUrl) || !isHttpUrl(visibleUrl)) return 0;
        if (isSameUrl(cachedUrl, visibleUrl)) return 1300;

        const cachedParts = getComparableUrlParts(cachedUrl);
        const visibleParts = getComparableUrlParts(visibleUrl);
        if (cachedParts?.pathname === visibleParts?.pathname) return 1150;

        const cachedTail = getVideoPathTail(cachedUrl);
        const visibleTail = getVideoPathTail(visibleUrl);
        if (cachedTail.length >= 20 && cachedTail === visibleTail) return 1050;

        let score = 0;
        const cachedTokens = getLongUrlTokens(cachedUrl);
        for (const token of getLongUrlTokens(visibleUrl)) {
            if (cachedTokens.has(token)) score = Math.max(score, 500 + token.length);
        }
        return score;
    }

    function resolveVideoForBlock(item, videoItems) {
        const { sourceUrls, posterUrls } = collectVideoBlockMedia(item);
        const serializedItem = safelyDecodeUrlPart(item.outerHTML).toLowerCase();
        let bestVideo = null;
        let bestScore = 0;

        for (const video of chatVideos) {
            let score = 0;
            const vid = getStableValue(video.vid).toLowerCase();
            if (vid.length >= 8 && serializedItem.includes(vid)) score = 1500 + vid.length;
            for (const sourceUrl of sourceUrls) {
                score = Math.max(score, scoreVideoUrlPair(video.url, sourceUrl));
            }
            for (const posterUrl of posterUrls) {
                score = Math.max(score, scoreVideoUrlPair(video.poster_url, posterUrl));
            }
            if (score > bestScore) {
                bestVideo = video;
                bestScore = score;
            }
        }
        if (bestVideo && bestScore >= 500) return bestVideo;
        if (chatVideos.length === 1 && videoItems.length === 1) return chatVideos[0];
        return null;
    }

    function bindNativeVideoDownload(item, video) {
        const action = item.querySelector('[data-testid="edit_image_hover_tag_download_btn"]');
        if (!action || !video?.url) return;

        action.doubaoNomarkVideo = video;
        action.setAttribute('title', '下载无水印视频');
        action.setAttribute('aria-label', '下载无水印视频');
        if (action.hasAttribute(INLINE_VIDEO_DOWNLOAD_ATTRIBUTE)) return;
        action.setAttribute(INLINE_VIDEO_DOWNLOAD_ATTRIBUTE, '');

        action.addEventListener('click', async event => {
            const currentVideo = action.doubaoNomarkVideo;
            if (!currentVideo?.url || action.dataset.doubaoNomarkDownloading === 'true') return;
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();

            action.dataset.doubaoNomarkDownloading = 'true';
            action.setAttribute('aria-busy', 'true');
            const previousOpacity = action.style.opacity;
            action.style.opacity = '0.58';
            await downloadImage(currentVideo.url, createInlineVideoFilename(currentVideo));
            action.style.opacity = previousOpacity;
            action.removeAttribute('aria-busy');
            delete action.dataset.doubaoNomarkDownloading;
        }, true);
    }

    function syncInlineDownloadButtons() {
        inlineDownloadSyncFrame = 0;
        if (!document.body || !isDoubaoHost()) return;
        getInlineImageItems().forEach(item => {
            const image = resolveImageForBlock(item);
            let host = [...item.children].find(child =>
                child.hasAttribute?.(INLINE_DOWNLOAD_HOST_ATTRIBUTE)
            );
            if (!image) {
                host?.remove();
                return;
            }
            if (!host) host = createInlineDownloadHost(item, image);
            host.doubaoNomarkImage = image;
        });

        const videoItems = getInlineVideoItems();
        videoItems.forEach(item => {
            const video = resolveVideoForBlock(item, videoItems);
            if (video) bindNativeVideoDownload(item, video);
        });
    }

    function scheduleInlineDownloadSync() {
        if (inlineDownloadSyncFrame || !document.body || !isDoubaoHost()) return;
        inlineDownloadSyncFrame = requestAnimationFrame(syncInlineDownloadButtons);
    }

    function initInlineDownloadButtons() {
        if (inlineDownloadObserver || !document.body || !isDoubaoHost()) {
            scheduleInlineDownloadSync();
            return;
        }
        inlineDownloadObserver = new MutationObserver(scheduleInlineDownloadSync);
        inlineDownloadObserver.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['src', 'srcset']
        });
        scheduleInlineDownloadSync();
    }

    function addChatVideo(videoInfo) {
        if (!videoInfo || !videoInfo.url) return;
        const existing = chatVideos.find(video => isSameVideo(video, videoInfo));
        if (!existing) {
            chatVideos.push(videoInfo);
            console.log('[无印豆包] 获取到新视频:', videoInfo.vid, videoInfo.url);
            updateButtonCount();
            return true;
        }

        const changed = Boolean(existing.url !== videoInfo.url
            || (!existing.vid && videoInfo.vid)
            || (videoInfo.poster_url && existing.poster_url !== videoInfo.poster_url)
            || (videoInfo.width > 0 && existing.width !== videoInfo.width)
            || (videoInfo.height > 0 && existing.height !== videoInfo.height)
            || (videoInfo.duration > 0 && existing.duration !== videoInfo.duration)
            || (videoInfo.definition && existing.definition !== videoInfo.definition)
            || (videoInfo.codec_type && existing.codec_type !== videoInfo.codec_type));
        if (changed) {
            existing.url = videoInfo.url;
            if (!existing.vid && videoInfo.vid) existing.vid = videoInfo.vid;
            if (videoInfo.poster_url) existing.poster_url = videoInfo.poster_url;
            if (videoInfo.width > 0) existing.width = videoInfo.width;
            if (videoInfo.height > 0) existing.height = videoInfo.height;
            if (videoInfo.duration > 0) existing.duration = videoInfo.duration;
            if (videoInfo.definition) existing.definition = videoInfo.definition;
            if (videoInfo.codec_type) existing.codec_type = videoInfo.codec_type;
            console.log('[无印豆包] 更新视频地址:', videoInfo.vid, videoInfo.url);
            updateButtonCount();
        }
        return changed;
    }

    const xhrRequestUrl = Symbol('doubaoNomarkRequestUrl');
    const originalXHROpen = XMLHttpRequest.prototype.open;
    const originalXHRSend = XMLHttpRequest.prototype.send;
    
    XMLHttpRequest.prototype.open = function(method, url, ...args) {
        this[xhrRequestUrl] = getRequestUrl(url);
        return originalXHROpen.apply(this, [method, url, ...args]);
    };
    
    XMLHttpRequest.prototype.send = function(...args) {
        const url = this[xhrRequestUrl];
        this.addEventListener('load', function() {
            if (hasUrl(url, URL_PATTERNS.DOUBAO_CANVAS_DOC_GET)) {
                try {
                    const data = this.responseType === 'json' && this.response
                        ? this.response
                        : JSON.parse(this.responseText);
                    parseCanvasDocumentImages(data);
                } catch (error) {
                    console.warn('[无印豆包][画布] XHR 响应解析失败:', error);
                }
                return;
            }

            if (hasUrl(url, URL_PATTERNS.DOUBAO_CHAIN)) {
                try {
                    const data = JSON.parse(this.responseText);
                    processFallbackVideos(data, this.responseText);
                    
                    const messages = data?.downlink_body?.pull_singe_chain_downlink_body?.messages;
                    if (messages && Array.isArray(messages)) {
                        resetMediaForScopeChange();
                        console.log('[无印豆包] 开始解析 messages，数量:', messages.length);
                        parseChatHistoryImages(messages);
                    }
                } catch (e) {
                    console.error('[无印豆包] XHR 解析聊天数据失败:', e);
                }
            }
        }, { once: true });
        return originalXHRSend.apply(this, args);
    };
    
    console.log('[无印豆包] XHR 拦截已安装');

    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
        const url = getRequestUrl(args[0]);

        if (hasUrl(url, URL_PATTERNS.DOUBAO_CANVAS_DOC_GET)) {
            const response = await originalFetch.apply(this, args);
            observeJson(response, parseCanvasDocumentImages).catch(() => {});
            return response;
        }
        
        if (hasUrl(url, URL_PATTERNS.QIANWEN_SESSION_LIST)) {
            console.log('[无印豆包] 检测到千问 session msg list 请求:', url);
            const response = await originalFetch.apply(this, args);
            observeJson(response, data => {
                const chats = data.data?.list || [];
                for (const chat of chats) {
                    const messages = chat?.response_messages || [];
                    parseQianwenMessages(messages);
                }
            }).catch(() => {});
            return response;
        }

        if (hasUrl(url, URL_PATTERNS.QIANWEN_SHARE_INFO)) {
            console.log('[无印豆包] 检测到千问 share chat 请求:', url);
            const response = await originalFetch.apply(this, args);
            observeJson(response, data => {
                const chats = data.data.session?.record_list || [];
                for (const chat of chats) {
                    const messages = chat?.response_messages || [];
                    parseQianwenMessages(messages);
                }
            }).catch(() => {});
            return response;
        }

        if (hasUrl(url, URL_PATTERNS.QIANWEN_SNAP)) {
            console.log('[无印豆包] 检测到千问 EventStream 请求:', url);
            
            const response = await originalFetch.apply(this, args);
            let buffer = '';
            let waitingForData = false;
            return observeResponseStream(response, chunk => {
                buffer += chunk;
                const lines = buffer.split('\n');
                buffer = lines.pop();
                for (const line of lines) {
                    if (line.trimEnd() === 'event:complete') {
                        waitingForData = true;
                    } else if (waitingForData && line.startsWith('data:')) {
                        waitingForData = false;
                        try {
                            const data = JSON.parse(line.substring(5).trim());
                            parseQianwenMessages(data?.data?.messages, true);
                        } catch (error) {
                            console.warn('[无印豆包][千问] data 行解析失败:', error.message);
                        }
                    } else if (line.trim() === '') {
                        waitingForData = false;
                    }
                }
            });
        }
        
        if (hasUrl(url, URL_PATTERNS.DOUBAO_COMPLETION)) {
            console.log('[无印豆包] 检测到 EventStream 请求:', url);
            
            const response = await originalFetch.apply(this, args);
            let buffer = '';
            const processLine = line => {
                if (!line.startsWith('data: ')) return;
                try {
                    const jsonStr = line.substring(6);
                    if (!jsonStr.includes('image_ori') && !jsonStr.includes('fallback_api')) return;
                    const data = JSON.parse(jsonStr);
                    if (jsonStr.includes('fallback_api')) processFallbackVideos(data, jsonStr);
                    if (data.event_data || data.patch_op) parseStreamChunk(data);
                } catch (error) {
                    console.log('[无印豆包] 解析行失败:', error.message);
                    console.log('[无印豆包] 解析行失败:', line);
                }
            };
            return observeResponseStream(response, chunk => {
                buffer += chunk;
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                lines.forEach(processLine);
            }, () => {
                if (buffer) processLine(buffer);
            });
        }
        
        return originalFetch.apply(this, args);
    };
    
    console.log('[无印豆包] Fetch 拦截已安装');

    function parseQianwenMessages(messages, prepend = false) {
        if (!Array.isArray(messages)) {
            return;
        }
        for (const message of messages) {
            if (message?.mime_type !== 'multi_load/iframe') continue;
            const multiLoad = message?.meta_data?.multi_load;
            if (!Array.isArray(multiLoad)) {
                continue;
            }
            for (const item of multiLoad) {
                const displayList = item?.content?.display_list;
                if (!Array.isArray(displayList)) {
                    continue;
                }
                for (const display of displayList) {
                    const imageObj = display?.image?.[0];
                    if (!imageObj?.url) continue;
                    const image = {
                        url: imageObj.url,
                        key: getStableValue(imageObj.key),
                        width: imageObj.width === undefined ? 0 : imageObj.width,
                        height: imageObj.height === undefined ? 0 : imageObj.height
                    };
                    if (addUniqueImage(image, chatImages, prepend)) {
                        console.log('[无印豆包][千问] 获取到图片:', image.url, `${image.width} × ${image.height}`);
                        updateButtonCount();
                    }
                }
            }
        }
    }

    
    function getCreationsFromContent(content) {
        if (!content || typeof content !== 'object') return [];

        const creations = [];
        if (Array.isArray(content.creation_block?.creations)) {
            creations.push(...content.creation_block.creations);
        }

        const media = content.rich_media_layout_block?.media;
        if (Array.isArray(media)) {
            for (const item of media) {
                if (item?.creation) creations.push(item.creation);
            }
        }
        return creations;
    }

    function findCreationsInPatch(patchOps) {
        if (!Array.isArray(patchOps)) return [];

        const creations = [];
        for (const op of patchOps) {
            const blocks = op?.patch_value?.content_block;
            if (!Array.isArray(blocks)) continue;
            for (const block of blocks) {
                creations.push(...getCreationsFromContent(block?.content));
            }
        }
        if (creations.length > 0) return creations;

        const extPatch = patchOps.find(op => op?.patch_value?.ext?.creation_full_content);
        if (!extPatch) return [];
        try {
            const content = JSON.parse(extPatch.patch_value.ext.creation_full_content);
            if (!Array.isArray(content)) return [];
            for (const item of content) {
                creations.push(...getCreationsFromContent(item?.BlockInfo?.BlockContent?.content));
            }
        } catch (error) {
            console.warn('Failed to parse creation_full_content:', error);
        }
        return creations;
    }

    function findCreationsInEventData(rawEventData) {
        let eventData;
        try {
            eventData = JSON.parse(rawEventData);
        } catch (error) {
            console.log('[无印豆包] 解析 event_data 失败:', error);
            return [];
        }
        if (!eventData.message?.content) return [];
        try {
            const content = JSON.parse(eventData.message.content);
            return Array.isArray(content.creations) ? content.creations : [];
        } catch (error) {
            console.log('[无印豆包] 解析 message.content 失败:', error);
            return [];
        }
    }

    function parseStreamChunk(data) {
        try {
            resetMediaForScopeChange();
            processFallbackVideos(data);
            if (!data.event_data && !data.patch_op) {
                return;
            }

            const creations = data.patch_op
                ? findCreationsInPatch(data.patch_op)
                : findCreationsInEventData(data.event_data);
            for (const creation of creations) {
                if (creation?.video) {
                    const vid = creation.video.vid;
                    requestDoubaoVideoInfo(vid, creation.video.fallback_api).then(info => addChatVideo(info));
                }else{
                    const image = normalizeImageData(
                        creation.image?.image_ori_raw,
                        false,
                        creation.image?.key
                    );
                    if (addUniqueImage(image, chatImages, true)) {
                        console.log('[无印豆包] 获取到新图片:', image.url, `${image.width} × ${image.height}`);
                        updateButtonCount();
                    }
                }
            }
            
            console.log('[无印豆包][千问] 聊天界面，返回已缓存的', chatImages.length, '张图片');
        } catch (e) {
            console.error('[无印豆包] 解析 StreamChunk 失败:', e);
        }
    }

    // Resolve the creation node first, then request the original download asset.
    async function getDoubaoVideoInfo(vid, directFallbackApi = '') {
        if (!vid) return null;
        const cached = chatVideos.find(video => video?.vid === vid);
        if (cached) return cached;

        const doubaoOrigin = getDoubaoOrigin();
        const postAispace = async (path, body) => {
            const response = await fetch(`${doubaoOrigin}/samantha/aispace/${path}`, {
                method: 'POST',
                credentials: 'include',
                headers: {
                    Accept: 'application/json, text/plain, */*',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json();
        };

        try {
            const homepage = await postAispace('homepage', {});
            const creation = (homepage?.data?.children || []).find(item => item?.name === '我的创作');
            if (!creation?.id) throw new Error('未找到我的创作空间');

            const nodeInfo = await postAispace('node_info?aid=582478', { node_id: creation.id });
            const node = (nodeInfo?.data?.children || []).find(item => item?.key === vid);
            if (!node?.id) throw new Error(`未找到视频节点: ${vid}`);

            const downloadInfo = await postAispace('get_download_info?aid=582478', {
                requests: [{ node_id: node.id }],
            });
            const infos = downloadInfo?.data?.download_infos;
            const info = Array.isArray(infos) ? infos.find(item => item?.main_url) : null;
            if (!info) throw new Error('响应中没有无水印 main_url');

            const meta = info.meta || info.video_info || {};
            const videoInfo = {
                vid,
                width: meta.width || info.width || 0,
                height: meta.height || info.height || 0,
                definition: meta.definition || info.definition || '',
                duration: meta.duration || info.duration || 0,
                codec_type: meta.codec_type || info.codec_type || '',
                poster_url: info.poster_url || info.cover_url || '',
                url: info.main_url,
            };
            console.log('[无印豆包] 获取无水印视频成功:', vid, videoInfo.url);
            return videoInfo;
        } catch (e) {
            console.warn('[无印豆包] 主方法失败，尝试 fallback_api:', vid, e.message || e);
            const cachedAfterError = chatVideos.find(video => video?.vid === vid);
            if (cachedAfterError) return cachedAfterError;
            const fallbackInfo = await getDoubaoVideoInfoFallback(
                vid,
                directFallbackApi || fallbackApiByVideoId.get(vid) || ''
            );
            if (fallbackInfo) {
                console.log('[无印豆包] fallback_api 获取无水印视频成功:', vid, fallbackInfo.url);
                return fallbackInfo;
            }
            console.warn('[无印豆包] fallback_api 未获取到视频:', vid);
            return null;
        }
    }

    function requestDoubaoVideoInfo(vid, directFallbackApi = '') {
        if (!vid) return Promise.resolve(null);
        if (isTrustedFallbackApi(directFallbackApi)) fallbackApiByVideoId.set(vid, directFallbackApi);
        const cached = chatVideos.find(video => video?.vid === vid);
        if (cached) return Promise.resolve(cached);
        if (pendingVideoInfo.has(vid)) return pendingVideoInfo.get(vid);
        const requestScope = getMediaScope();
        const request = getDoubaoVideoInfo(vid, directFallbackApi)
            .then(info => requestScope === getMediaScope() ? info : null)
            .finally(() => pendingVideoInfo.delete(vid));
        pendingVideoInfo.set(vid, request);
        return request;
    }

    function parseChatHistoryImages(messages) {
        if (!Array.isArray(messages)) return;
        
        const newImages = [];

        try {
            for (const item of messages) {
                try {
                    for (const content of item.content_block) {
                        const creations = getCreationsFromContent(content?.content);
                        for (const creation of creations) {
                            if (creation?.video) {
                                const vid = creation.video.vid;
                                requestDoubaoVideoInfo(vid, creation.video.fallback_api).then(info => addChatVideo(info));
                            }else{
                                const image = normalizeImageData(
                                    creation.image?.image_ori_raw,
                                    false,
                                    creation.image?.key
                                );
                                if (addUniqueImage(image, newImages)) {
                                    console.log('[无印豆包] 找到图片:', image.url, `${image.width} × ${image.height}`);
                                }
                            }
                        }
                    }
                    
                } catch (e) {
                    console.log('[无印豆包] 解析消息失败:', e);
                    continue;
                }
            }
        } catch (e) {
            console.log('[无印豆包] 解析消息失败:', e);
        }
        
        let mediaChanged = false;
        for (const image of newImages) {
            if (addUniqueImage(image)) mediaChanged = true;
        }
        if (mediaChanged) {
            console.log('[无印豆包] 更新聊天图片，共', chatImages.length, '张');
            updateButtonCount();
        }
    }

    function collectSharePageMedia(value, imageList, depth = 0) {
        if (depth > 30 || value == null) return;
        if (Array.isArray(value)) {
            value.forEach(item => collectSharePageMedia(item, imageList, depth + 1));
            return;
        }
        if (typeof value === 'string') {
            const text = value.trim();
            if (text.startsWith('{') || text.startsWith('[')) {
                try {
                    collectSharePageMedia(JSON.parse(text), imageList, depth + 1);
                } catch (_) { /* Ignore non-JSON content strings. */ }
            }
            return;
        }
        if (typeof value !== 'object') return;

        const creations = getCreationsFromContent(value);
        if (creations.length > 0) {
            for (const creation of creations) {
                if (creation?.video) {
                    startFallbackVideo(creation.video.fallback_api, '分享页');
                    continue;
                }
                const image = normalizeImageData(
                    creation?.image?.image_ori_raw,
                    true,
                    creation?.image?.key
                );
                if (addUniqueImage(image, imageList)) {
                    console.log('[无印豆包] 找到图片:', image.url, `${image.width} × ${image.height}`);
                }
            }
        }
        Object.values(value).forEach(item => collectSharePageMedia(item, imageList, depth + 1));
    }

    function extractSharePageImages(root = document) {
        const imageList = [];
        const scripts = root.querySelectorAll(
            'script[data-script-src="modern-run-router-data-fn"], script[data-script-src="modern-run-window-fn"]'
        );
        for (const script of scripts) {
            const rawArgs = script.getAttribute('data-fn-args');
            if (!rawArgs) continue;
            try {
                collectSharePageMedia(JSON.parse(rawArgs), imageList);
            } catch (_) { /* Ignore unrelated route data. */ }
        }
        if (window._ROUTER_DATA && typeof window._ROUTER_DATA === 'object') {
            collectSharePageMedia(window._ROUTER_DATA, imageList);
        }
        console.log('[无印豆包] 分享页提取完成，共找到', imageList.length, '张图片');
        return imageList;
    }

    function extractImages() {
        resetMediaForScopeChange();
        if (isDoubaoHost() && (
            window.location.pathname.includes('/chat/')
            || window.location.pathname.includes('/creativity/canvas_workspace')
        )) {
            console.log('[无印豆包] 豆包聊天界面，返回已缓存的', chatImages.length, '张图片');
            return chatImages;
        } else if (window.location.hostname.includes('qianwen.com') && window.location.pathname.includes('/chat/')) {
            return chatImages;
        }else{
            const images = extractSharePageImages();
            chatImages = images;
            console.log('[无印豆包] 豆包分享界面，返回已缓存的', images.length, '张图片');
            return images;
        }
    }

    function extractVideos() {
        console.log('[无印豆包] 当前视频缓存数:', chatVideos.length);
        return chatVideos;
    }

    async function downloadImage(url, filename) {
        if (!isHttpUrl(url)) return false;
        try {
            console.log('[无印豆包] 开始下载:', url);

            if (document.documentElement.dataset.doubaoNomarkBridge === 'ready') {
                await requestExtensionDownload(url, filename || 'doubao_media');
                console.log('[无印豆包] 下载任务已提交:', filename);
                return true;
            }
            
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const blob = await response.blob();
            
            const blobUrl = URL.createObjectURL(blob);
            
            const a = document.createElement('a');
            a.href = blobUrl;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            
            setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
            
            console.log('[无印豆包] 下载完成:', filename);
            return true;
        } catch (error) {
            console.error('[无印豆包] 下载失败:', error);
            alert('下载失败，请重试');
            return false;
        }
    }

    function createFloatingButton() {
        if (document.getElementById('doubao-nomark-extension-root')) return;
        if (!document.body) {
            document.addEventListener('DOMContentLoaded', createFloatingButton, { once: true });
            return;
        }

        const panelUrl = document.documentElement.dataset.doubaoNomarkPanel || '';
        if (!panelUrl) {
            document.documentElement.addEventListener('doubao-nomark-assets-ready', createFloatingButton, { once: true });
            return;
        }
        const host = document.createElement('div');
        host.id = 'doubao-nomark-extension-root';
        host.style.all = 'initial';
        const shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML = `
            <style>
                :host { all: initial; }
                #doubao-nomark-btn {
                    position: fixed;
                    right: 24px;
                    bottom: 24px;
                    z-index: 9999;
                    width: 48px;
                    height: 48px;
                    background: #ffffff;
                    border: 1px solid #e0e0e0;
                    border-radius: 8px;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    padding: 0;
                    appearance: none;
                    font-size: 20px;
                    line-height: 1;
                    transition: all 0.2s ease;
                    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
                }
                #doubao-nomark-btn:hover {
                    border-color: #1f1f1f;
                    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
                }
                #doubao-nomark-btn .count {
                    position: absolute;
                    top: -6px;
                    right: -6px;
                    min-width: 20px;
                    height: 20px;
                    padding: 0 6px;
                    background: #1f1f1f;
                    color: #ffffff;
                    border-radius: 10px;
                    font-size: 11px;
                    font-weight: 600;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    line-height: 1;
                }
                #doubao-nomark-modal {
                    position: fixed;
                    inset: 0;
                    z-index: 10000;
                    display: none;
                    align-items: center;
                    justify-content: center;
                    background: rgba(0, 0, 0, 0.4);
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                }
                #doubao-nomark-modal.show { display: flex; }
                #doubao-nomark-panel-frame {
                    width: min(1180px, calc(100vw - 24px));
                    height: min(718px, calc(100vh - 24px));
                    border: 0;
                    border-radius: 22px;
                    background: transparent;
                }
                @media (max-width: 640px) {
                    #doubao-nomark-panel-frame {
                        width: calc(100vw - 12px);
                        height: calc(100vh - 12px);
                        border-radius: 16px;
                    }
                }
            </style>
            <button id="doubao-nomark-btn" type="button" title="提取无水印素材" aria-label="提取无水印素材">
                <span aria-hidden="true">📷</span>
                <span class="count">0</span>
            </button>
            <div id="doubao-nomark-modal" role="dialog" aria-modal="true" aria-label="无水印素材">
                <iframe id="doubao-nomark-panel-frame" title="无水印素材" allow="fullscreen"></iframe>
            </div>
        `;

        floatingBtnElement = shadow.getElementById('doubao-nomark-btn');
        const floatingBtn = floatingBtnElement;
        const modal = shadow.getElementById('doubao-nomark-modal');
        const frame = shadow.getElementById('doubao-nomark-panel-frame');
        const panelLocation = new URL(panelUrl);
        const panelOrigin = panelLocation.origin === 'null'
            ? `${panelLocation.protocol}//${panelLocation.host}`
            : panelLocation.origin;
        let frameReady = false;

        function sendMediaToPanel() {
            if (!frameReady || !frame.contentWindow) return;
            frame.contentWindow.postMessage({
                type: 'doubao-nomark-media',
                platform: PLATFORM_CODE,
                images: extractImages(),
                videos: extractVideos()
            }, panelOrigin);
        }

        floatingBtn.addEventListener('click', () => {
            updateButtonCount();
            modal.classList.add('show');
        });

        frame.addEventListener('load', () => {
            frameReady = true;
            sendMediaToPanel();
        }, { once: true });
        frame.src = panelUrl;

        modal.addEventListener('click', (event) => {
            if (event.target === modal) modal.classList.remove('show');
        });

        window.addEventListener('message', (event) => {
            if (event.source !== frame.contentWindow || event.origin !== panelOrigin || !event.data) return;
            const { type, url, filename } = event.data;
            if (type === 'doubao-nomark-panel-ready') {
                sendMediaToPanel();
            } else if (type === 'doubao-nomark-panel-close') {
                modal.classList.remove('show');
            } else if (type === 'doubao-nomark-download' && isHttpUrl(url)) {
                downloadImage(url, filename || 'doubao_media');
            } else if (type === 'doubao-nomark-copy' && isHttpUrl(url)) {
                navigator.clipboard?.writeText(url).catch(() => {});
            }
        });

        panelMediaSync = sendMediaToPanel;
        document.body.appendChild(host);
        updateButtonCount();
    }

    let initRetryCount = 0;
    const MAX_RETRY = 10;
    let routeRefreshTimer = null;

    function isDoubaoSharePage() {
        return isDoubaoHost() && (
            window.location.pathname.includes('/thread/')
            || window.location.pathname.includes('/share/')
        );
    }

    function scheduleRouteRefresh() {
        clearTimeout(routeRefreshTimer);
        routeRefreshTimer = setTimeout(() => {
            if (!resetMediaForScopeChange()) return;
            initRetryCount = 0;
            initScript();
        });
    }

    for (const method of ['pushState', 'replaceState']) {
        const original = history[method];
        history[method] = function(...args) {
            const result = original.apply(this, args);
            scheduleRouteRefresh();
            return result;
        };
    }
    window.addEventListener('popstate', scheduleRouteRefresh);

    function initScript() {
        console.log('[无印豆包] 脚本已加载');
        initInlineDownloadButtons();
        
        if (window.location.pathname.includes('/chat/')) {
            createFloatingButton();
            return;
        }
        
        const hasScriptData = !!document.querySelector('script[data-script-src="modern-run-router-data-fn"]');
        const hasRouterData = !!window._ROUTER_DATA;
        
        if (!hasScriptData && !hasRouterData) {
            initRetryCount++;
            if (initRetryCount < MAX_RETRY) {
                console.warn(`[无印豆包] 页面数据仍未加载，等待中... (${initRetryCount}/${MAX_RETRY})`);
                setTimeout(initScript, 500);
                return;
            } else {
                console.warn('[无印豆包] 页面数据加载超时，仍创建按钮（可能无法提取历史图片）');
            }
        }

        if (isDoubaoSharePage()) {
            chatImages = extractSharePageImages();
            loadSharePageVideos();
        }
        
        createFloatingButton();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initScript);
    } else if (document.readyState === 'interactive') {
        if (document.body) {
            initScript();
        } else {
            document.addEventListener('DOMContentLoaded', initScript);
        }
    } else {
        initScript();
    }

})();
