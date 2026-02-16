// ==UserScript==
// @name         Chapterizer
// @namespace    https://github.com/SysAdminDoc
// @version      3.0.0
// @description  Auto-generates chapters, detects filler words & skips pauses on YouTube. Works instantly - no setup, no servers, no API keys.
// @author       SysAdminDoc
// @match        https://www.youtube.com/*
// @match        https://music.youtube.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_info
// @grant        unsafeWindow
// @connect      www.youtube.com
// @run-at       document-start
// @icon         https://www.google.com/s2/favicons?sz=64&domain=youtube.com
// ==/UserScript==

(function() {
    'use strict';

    const SCRIPT_VERSION = '3.0.0';
    const SETTINGS_KEY = 'chapterizer_settings';

    // ══════════════════════════════════════════════════════════════
    //  CORE UTILITIES
    // ══════════════════════════════════════════════════════════════

    const _rw = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

    const TrustedHTML = (() => {
        let policy = null;
        if (typeof window.trustedTypes !== 'undefined' && window.trustedTypes.createPolicy) {
            try {
                policy = window.trustedTypes.createPolicy('chapterizer-policy', {
                    createHTML: (string) => string
                });
            } catch (e) {}
        }
        return {
            setHTML(element, html) {
                if (policy) {
                    element.innerHTML = policy.createHTML(html);
                } else {
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(`<template>${html}</template>`, 'text/html');
                    const template = doc.querySelector('template');
                    element.innerHTML = '';
                    if (template && template.content) {
                        element.appendChild(template.content.cloneNode(true));
                    }
                }
            },
            create(html) {
                return policy ? policy.createHTML(html) : html;
            }
        };
    })();

    function showToast(message, color = '#22c55e', options = {}) {
        document.querySelector('.cf-global-toast')?.remove();
        const toast = document.createElement('div');
        toast.className = 'cf-global-toast';
        toast.style.cssText = `
            position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%);
            background: ${color}; color: white; padding: 12px 24px; border-radius: 8px;
            font-family: "Roboto", Arial, sans-serif; font-size: 14px; font-weight: 500;
            z-index: 999999; box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            display: flex; align-items: center; gap: 12px;
            animation: cf-toast-fade ${options.duration || 2.5}s ease-out forwards;
        `;
        const textSpan = document.createElement('span');
        textSpan.textContent = message;
        toast.appendChild(textSpan);
        if (options.action) {
            const actionBtn = document.createElement('button');
            actionBtn.textContent = options.action.text || 'Undo';
            actionBtn.style.cssText = `background:rgba(255,255,255,0.2);border:1px solid rgba(255,255,255,0.3);color:white;padding:4px 12px;border-radius:4px;font-size:12px;font-weight:600;cursor:pointer;`;
            actionBtn.onclick = (e) => { e.stopPropagation(); toast.remove(); options.action.onClick?.(); };
            toast.appendChild(actionBtn);
        }
        if (!document.getElementById('cf-toast-animation')) {
            const style = document.createElement('style');
            style.id = 'cf-toast-animation';
            style.textContent = `@keyframes cf-toast-fade { 0%{opacity:0;transform:translateX(-50%) translateY(20px)} 10%{opacity:1;transform:translateX(-50%) translateY(0)} 80%{opacity:1;transform:translateX(-50%) translateY(0)} 100%{opacity:0;transform:translateX(-50%) translateY(-20px)} }`;
            document.head.appendChild(style);
        }
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), (options.duration || 2.5) * 1000);
        return toast;
    }

    // ══════════════════════════════════════════════════════════════
    //  SETTINGS MANAGER
    // ══════════════════════════════════════════════════════════════

    const DEFAULTS = {
        chapterForge: true,
        cfMode: 'auto',
        cfMaxAutoDuration: 9999,
        cfShowPlayerButton: true,
        cfDebugLog: false,
        cfShowChapterHUD: true,
        cfPoiColor: '#ff6b6b',
        cfShowChapters: true,
        cfShowPOIs: true,
        cfChapterOpacity: 0.35,
        cfHudPosition: 'top-left',
        cfFillerDetect: true,
        cfFillerWordsEnabled: { 'um': true, 'umm': true },
        cfAutoSkipMode: 'normal',
        cfShowFillerMarkers: true,
    };

    // All available filler words organized by category
    const FILLER_CATALOG = {
        'Common': ['um', 'umm', 'uh', 'uhh', 'hmm', 'hm', 'er', 'erm', 'ah', 'mhm'],
        'Phrases': ['you know', 'I mean', 'sort of', 'kind of', 'okay so', 'so yeah', 'yeah so', 'like'],
        'Extended': ['basically', 'literally', 'actually', 'right', 'anyway', 'whatever', 'I guess', 'you see'],
    };
    const ALL_FILLER_WORDS = Object.values(FILLER_CATALOG).flat();

    const settingsManager = {
        load() {
            try {
                const saved = GM_getValue(SETTINGS_KEY, null);
                if (saved) {
                    const merged = { ...DEFAULTS, ...saved };
                    // Migrate old cfFillerWords string to new cfFillerWordsEnabled object
                    if (saved.cfFillerWords && !saved.cfFillerWordsEnabled) {
                        const words = saved.cfFillerWords.split(',').map(w => w.trim().toLowerCase()).filter(w => w.length > 0);
                        merged.cfFillerWordsEnabled = {};
                        words.forEach(w => { if (ALL_FILLER_WORDS.includes(w)) merged.cfFillerWordsEnabled[w] = true; });
                        delete merged.cfFillerWords;
                    }
                    return merged;
                }
            } catch(e) {}
            return { ...DEFAULTS };
        },
        save(settings) { try { GM_setValue(SETTINGS_KEY, settings); } catch(e) {} }
    };

    let appState = { settings: settingsManager.load() };

    // ══════════════════════════════════════════════════════════════
    //  TRANSCRIPT SERVICE - Multi-Method Extraction with Failover
    // ══════════════════════════════════════════════════════════════
    const TranscriptService = {
        config: {
            preferredLanguages: ['en', 'en-US', 'en-GB'],
            preferManualCaptions: true,
            includeTimestamps: true,
            debug: false
        },

        // Main entry point - downloads transcript with automatic failover
        async downloadTranscript(options = {}) {
            const videoId = new URLSearchParams(window.location.search).get('v');
            if (!videoId) {
                showToast('No video ID found', '#ef4444');
                return { success: false, error: 'No video ID' };
            }

            showToast('Fetching transcript...', '#3b82f6');
            this._log('Starting transcript fetch for:', videoId);

            try {
                const trackData = await this._getCaptionTracks(videoId);

                if (!trackData || !trackData.tracks || trackData.tracks.length === 0) {
                    showToast('No transcript available for this video', '#ef4444');
                    return { success: false, error: 'No captions available' };
                }

                const selectedTrack = this._selectBestTrack(trackData.tracks);
                this._log('Selected track:', selectedTrack.languageCode, selectedTrack.kind);

                const segments = await this._fetchTranscriptContent(selectedTrack.baseUrl);

                if (!segments || segments.length === 0) {
                    showToast('Failed to parse transcript content', '#ef4444');
                    return { success: false, error: 'Parse failed' };
                }

                const videoTitle = this._sanitizeFilename(trackData.videoTitle || videoId);
                const content = this._formatTranscript(segments);

                this._downloadFile(content, `${videoTitle}_transcript.txt`);

                showToast(`Transcript downloaded! (${segments.length} segments)`, '#22c55e');
                return { success: true, segments: segments.length, language: selectedTrack.languageCode };

            } catch (error) {
                console.error('[Chapterizer TranscriptService] Error:', error);
                showToast('Failed to download transcript', '#ef4444');
                return { success: false, error: error.message };
            }
        },

        // Multi-method caption track retrieval with automatic failover
        async _getCaptionTracks(videoId) {
            const methods = [
                { name: 'ytInitialPlayerResponse', fn: () => this._method1_WindowVariable(videoId) },
                { name: 'Innertube API', fn: () => this._method2_InnertubeAPI(videoId) },
                { name: 'HTML Page Fetch', fn: () => this._method3_HTMLPageFetch(videoId) },
                { name: 'captionTracks Regex', fn: () => this._method4_CaptionTracksRegex(videoId) },
                { name: 'DOM Panel Scrape', fn: () => this._method5_DOMPanelScrape(videoId) }
            ];

            for (const method of methods) {
                try {
                    this._log(`Trying method: ${method.name}`);
                    const result = await method.fn();

                    if (result && result.tracks && result.tracks.length > 0) {
                        this._log(`Success with method: ${method.name}`, result.tracks.length, 'tracks found');
                        return result;
                    }
                } catch (error) {
                    this._log(`Method ${method.name} failed:`, error.message);
                }
            }

            return null;
        },

        // Method 1: window.ytInitialPlayerResponse (fastest for fresh page loads)
        _method1_WindowVariable(videoId) {
            const playerResponse = window.ytInitialPlayerResponse;

            if (!playerResponse?.videoDetails?.videoId) {
                throw new Error('ytInitialPlayerResponse not available');
            }

            if (playerResponse.videoDetails.videoId !== videoId) {
                throw new Error('ytInitialPlayerResponse is stale (different video)');
            }

            return this._extractFromPlayerResponse(playerResponse);
        },

        // Method 2: Innertube API (most reliable for SPA navigation)
        async _method2_InnertubeAPI(videoId) {
            const apiKey = this._getInnertubeApiKey() || 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
            const clientVersion = this._getClientVersion() || '2.20250120.00.00';

            const response = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${apiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    context: {
                        client: {
                            clientName: 'WEB',
                            clientVersion: clientVersion
                        }
                    },
                    videoId: videoId
                })
            });

            if (!response.ok) throw new Error(`Innertube API returned ${response.status}`);

            const data = await response.json();
            return this._extractFromPlayerResponse(data);
        },

        // Method 3: Fetch HTML and extract ytInitialPlayerResponse
        async _method3_HTMLPageFetch(videoId) {
            const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`);
            if (!response.ok) throw new Error(`Page fetch returned ${response.status}`);

            const html = await response.text();

            const patterns = [
                /ytInitialPlayerResponse\s*=\s*({.+?});\s*(?:var\s|const\s|let\s|<\/script>)/s,
                /ytInitialPlayerResponse\s*=\s*({.+?});/s,
                /var\s+ytInitialPlayerResponse\s*=\s*({.+?});/s
            ];

            for (const pattern of patterns) {
                const match = html.match(pattern);
                if (match && match[1]) {
                    try {
                        const playerResponse = JSON.parse(match[1]);
                        return this._extractFromPlayerResponse(playerResponse);
                    } catch (parseError) {
                        this._log('JSON parse failed for pattern, trying next');
                    }
                }
            }

            throw new Error('Could not extract ytInitialPlayerResponse from HTML');
        },

        // Method 4: Direct captionTracks regex extraction
        async _method4_CaptionTracksRegex(videoId) {
            const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`);
            if (!response.ok) throw new Error(`Page fetch returned ${response.status}`);

            const html = await response.text();

            const captionMatch = html.match(/"captionTracks":(\[.*?\])(?:,|\})/);
            if (!captionMatch || !captionMatch[1]) {
                throw new Error('captionTracks not found in page');
            }

            const captionJson = captionMatch[1].replace(/\\u0026/g, '&');
            const tracks = JSON.parse(captionJson);

            let videoTitle = videoId;
            const titleMatch = html.match(/"title":"([^"]+)"/);
            if (titleMatch && titleMatch[1]) {
                videoTitle = titleMatch[1].replace(/\\u0026/g, '&').replace(/\\"/g, '"');
            }

            return {
                tracks: tracks.map(t => ({
                    baseUrl: t.baseUrl?.replace(/\\u0026/g, '&'),
                    languageCode: t.languageCode,
                    name: t.name?.simpleText || t.name?.runs?.[0]?.text || t.languageCode,
                    kind: t.kind || (t.vssId?.startsWith('a.') ? 'asr' : 'manual'),
                    vssId: t.vssId
                })),
                videoTitle: videoTitle
            };
        },

        // Method 5: DOM panel scraping (final fallback)
        async _method5_DOMPanelScrape(videoId) {
            const transcriptRenderer = document.querySelector('ytd-transcript-renderer');
            if (!transcriptRenderer) throw new Error('Transcript panel not found in DOM');

            const data = transcriptRenderer.__data?.data || transcriptRenderer.data;
            if (!data) throw new Error('No data in transcript renderer');

            const footer = data.content?.transcriptSearchPanelRenderer?.footer?.transcriptFooterRenderer;
            const languageMenu = footer?.languageMenu?.sortFilterSubMenuRenderer?.subMenuItems;

            if (!languageMenu || languageMenu.length === 0) {
                throw new Error('No language menu found in panel data');
            }

            const tracks = languageMenu.map(item => ({
                baseUrl: item.continuation?.reloadContinuationData?.continuation,
                languageCode: item.languageCode || 'unknown',
                name: item.title || 'Unknown',
                kind: item.title?.toLowerCase().includes('auto') ? 'asr' : 'manual'
            }));

            const videoTitle = document.querySelector('h1.ytd-watch-metadata yt-formatted-string')?.textContent || videoId;

            return { tracks, videoTitle };
        },

        // Extract track info from player response object
        _extractFromPlayerResponse(playerResponse) {
            if (!playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks) {
                throw new Error('No caption tracks in player response');
            }

            const captionTracks = playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks;
            const videoTitle = playerResponse.videoDetails?.title || '';

            return {
                tracks: captionTracks.map(t => ({
                    baseUrl: t.baseUrl,
                    languageCode: t.languageCode,
                    name: t.name?.simpleText || t.name?.runs?.[0]?.text || t.languageCode,
                    kind: t.kind || (t.vssId?.startsWith('a.') ? 'asr' : 'manual'),
                    vssId: t.vssId
                })),
                videoTitle: videoTitle
            };
        },

        // Select best track based on language and type preferences
        _selectBestTrack(tracks) {
            if (tracks.length === 1) return tracks[0];

            const { preferredLanguages, preferManualCaptions } = this.config;

            const scored = tracks.map(track => {
                let score = 0;

                const langIndex = preferredLanguages.findIndex(lang =>
                    track.languageCode?.toLowerCase().startsWith(lang.toLowerCase())
                );
                if (langIndex !== -1) {
                    score += (preferredLanguages.length - langIndex) * 10;
                }

                if (preferManualCaptions && track.kind !== 'asr') {
                    score += 5;
                } else if (!preferManualCaptions && track.kind === 'asr') {
                    score += 5;
                }

                return { track, score };
            });

            scored.sort((a, b) => b.score - a.score);
            return scored[0].track;
        },

        // Fetch and parse transcript content from baseUrl
        async _fetchTranscriptContent(baseUrl) {
            if (!baseUrl) throw new Error('No baseUrl provided for transcript');

            const formats = ['json3', 'xml'];

            for (const fmt of formats) {
                try {
                    const url = fmt === 'xml' ? baseUrl : `${baseUrl}&fmt=${fmt}`;
                    const response = await fetch(url);

                    if (!response.ok) continue;

                    const content = await response.text();

                    if (fmt === 'json3') {
                        return this._parseJSON3(content);
                    } else {
                        return this._parseXML(content);
                    }
                } catch (e) {
                    this._log(`Format ${fmt} failed:`, e.message);
                }
            }

            throw new Error('Failed to fetch transcript in any format');
        },

        // Parse JSON3 format (word-level timing)
        _parseJSON3(content) {
            const data = JSON.parse(content);
            const segments = [];

            if (!data.events) throw new Error('No events in JSON3 response');

            for (const event of data.events) {
                if (!event.segs) continue;

                const text = event.segs
                    .map(seg => seg.utf8 || '')
                    .join('')
                    .replace(/\n/g, ' ')
                    .trim();

                if (text) {
                    const seg = {
                        startMs: event.tStartMs || 0,
                        endMs: (event.tStartMs || 0) + (event.dDurationMs || 0),
                        text: text
                    };
                    // Preserve word-level timing from tOffsetMs
                    if (event.segs.length > 1 && event.segs.some(s => s.tOffsetMs !== undefined)) {
                        const evtStart = (event.tStartMs || 0) / 1000;
                        const evtEnd = ((event.tStartMs || 0) + (event.dDurationMs || 0)) / 1000;
                        seg.words = [];
                        for (let i = 0; i < event.segs.length; i++) {
                            const w = (event.segs[i].utf8 || '').replace(/\n/g, ' ').trim();
                            if (!w) continue;
                            const wStart = evtStart + (event.segs[i].tOffsetMs || 0) / 1000;
                            const nextOffset = (i < event.segs.length - 1 && event.segs[i+1].tOffsetMs !== undefined)
                                ? evtStart + event.segs[i+1].tOffsetMs / 1000 : evtEnd;
                            seg.words.push({ text: w, start: wStart, end: nextOffset });
                        }
                    }
                    segments.push(seg);
                }
            }

            return segments;
        },

        // Parse XML format (fallback)
        _parseXML(content) {
            const segments = [];
            const textRegex = /<text[^>]*start="([^"]*)"[^>]*(?:dur="([^"]*)")?[^>]*>([\s\S]*?)<\/text>/g;

            let match;
            while ((match = textRegex.exec(content)) !== null) {
                const startSeconds = parseFloat(match[1]) || 0;
                const duration = parseFloat(match[2]) || 0;
                const text = this._decodeHTMLEntities(match[3])
                    .replace(/<[^>]*>/g, '')
                    .trim();

                if (text) {
                    segments.push({
                        startMs: Math.round(startSeconds * 1000),
                        endMs: Math.round((startSeconds + duration) * 1000),
                        text: text
                    });
                }
            }

            return segments;
        },

        // Format segments into transcript text
        _formatTranscript(segments) {
            return segments.map(s => {
                if (this.config.includeTimestamps) {
                    const timestamp = this._formatTimestamp(s.startMs);
                    return `[${timestamp}] ${s.text}`;
                }
                return s.text;
            }).join('\n');
        },

        _formatTimestamp(ms) {
            const totalSeconds = Math.floor(ms / 1000);
            const hours = Math.floor(totalSeconds / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const seconds = totalSeconds % 60;

            if (hours > 0) {
                return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
            }
            return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        },

        _getInnertubeApiKey() {
            const match = document.body?.innerHTML?.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
            return match ? match[1] : null;
        },

        _getClientVersion() {
            if (typeof window.ytcfg !== 'undefined' && window.ytcfg.get) {
                return window.ytcfg.get('INNERTUBE_CLIENT_VERSION');
            }
            return null;
        },

        _decodeHTMLEntities(text) {
            return text
                .replace(/&#39;/g, "'")
                .replace(/&apos;/g, "'")
                .replace(/&quot;/g, '"')
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(num))
                .replace(/&#x([a-fA-F0-9]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
        },

        _sanitizeFilename(name) {
            return name
                .replace(/[<>:"/\\|?*]/g, '')
                .replace(/[^\x00-\x7F]/g, '')
                .replace(/\s+/g, '_')
                .toLowerCase()
                .substring(0, 50);
        },

        _downloadFile(content, filename) {
            const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        },

        _log(...args) {
            if (this.config.debug) {
                console.log('[Chapterizer TranscriptService]', ...args);
            }
        }
    };

    // ══════════════════════════════════════════════════════════════
    //  CHAPTERFORGE ENGINE
    // ══════════════════════════════════════════════════════════════

    const Chapterizer = {
            // ── Internal state ──
            _isGenerating: false,
            _currentVideoId: null,
            _currentDuration: 0,
            _chapterData: null,
            _lastTranscriptSegments: null,
            _panelEl: null,
            _activeTab: 'chapters',
            _styleElement: null,
            _resizeObserver: null,
            _clickHandler: null,
            _navHandler: null,
            _barObsHandler: null,
            _chapterHUDEl: null,
            _chapterTrackingRAF: null,
            _lastActiveChapterIdx: -1,
            _fillerData: null,             // [{time, duration, word, segStart, segEnd}] detected filler words
            _pauseData: null,              // [{start, end, duration}] detected pauses
            _autoSkipRAF: null,            // single RAF handle for unified skip loop
            _autoSkipActive: false,        // whether autoskip is currently running
            _autoSkipSavedRate: null,      // saved playback rate before silence speedup
            _paceData: null,               // [{start, end, wpm}] speech pace per segment
            _keywordsPerChapter: null,     // [[keyword,...], ...] per chapter

            _CF_CACHE_PREFIX: 'cf_cache_',
            _CF_TRANSCRIPT_PREFIX: 'cf_tx_',
            // Distinct, high-contrast chapter colors — each clearly identifiable
            _CF_COLORS: ['#7c3aed', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#06b6d4'],
            // Readable foreground for each color
            _CF_COLORS_FG: ['#e0d4fc', '#cceeff', '#c6f7e2', '#fef3c7', '#fecaca', '#fce7f3', '#ddd6fe', '#cffafe'],

            // ── Debug logging ──
    
            _log(...args) {
                if (appState.settings?.cfDebugLog) console.log('[Chapterizer]', ...args);
            },
            _warn(...args) {
                console.warn('[Chapterizer]', ...args);
            },
            _esc(str) {
                if (!str) return '';
                return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            },
    
            // ── Helpers ──
            _getVideoId() { return new URLSearchParams(window.location.search).get('v'); },
            _formatTime(seconds) {
                const s = Math.floor(seconds); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const sec = s % 60;
                if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
                return `${m}:${String(sec).padStart(2,'0')}`;
            },
            _seekTo(seconds) { const v = document.querySelector('video.html5-main-video'); if (v) v.currentTime = seconds; },
            _getVideoDuration() { const v = document.querySelector('video.html5-main-video'); return v ? v.duration : 0; },
            _getCachedData(videoId) { try { const raw = localStorage.getItem(this._CF_CACHE_PREFIX + videoId); return raw ? JSON.parse(raw) : null; } catch { return null; } },
            _setCachedData(videoId, data) {
                try { localStorage.setItem(this._CF_CACHE_PREFIX + videoId, JSON.stringify(data)); } catch(e) {
                    const keys = []; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith(this._CF_CACHE_PREFIX)) keys.push(k); }
                    if (keys.length > 20) { keys.slice(0, 5).forEach(k => localStorage.removeItem(k)); try { localStorage.setItem(this._CF_CACHE_PREFIX + videoId, JSON.stringify(data)); } catch(e2) {} }
                }
            },
            _countCache() { let c = 0; for (let i = 0; i < localStorage.length; i++) { if (localStorage.key(i).startsWith(this._CF_CACHE_PREFIX)) c++; } return c; },
            _clearCache() { const keys = []; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith(this._CF_CACHE_PREFIX)) keys.push(k); } keys.forEach(k => localStorage.removeItem(k)); },
    

            // ═══ EXPORT CHAPTERS ═══
            _exportChaptersYouTube() {
                if (!this._chapterData?.chapters?.length) return;
                const lines = this._chapterData.chapters.map(c => `${this._formatTime(c.start)} ${c.title}`);
                navigator.clipboard.writeText(lines.join('\n'));
                showToast('Chapters copied to clipboard', '#10b981');
            },

            // ═══════════════════════════════════════════
            //  TRANSCRIPT FETCHER
            // ═══════════════════════════════════════════
            async _fetchTranscript(videoId, onStatus) {
                this._log('=== Fetching transcript for:', videoId, ' ===');
                onStatus?.('Fetching transcript...', 'loading', 5);
    
                // ── PRIMARY: Use TranscriptService ──
                try {
                    onStatus?.('Trying TranscriptService...', 'loading', 8);
                    this._log('Method 1: TranscriptService._getCaptionTracks');
                    const trackData = await TranscriptService._getCaptionTracks(videoId);
                    if (trackData?.tracks?.length) {
                        this._log('TranscriptService found', trackData.tracks.length, 'tracks:', trackData.tracks.map(t => `${t.languageCode}(${t.kind})`).join(', '));
                        const selectedTrack = TranscriptService._selectBestTrack(trackData.tracks);
                        this._log('Selected track:', selectedTrack.languageCode, selectedTrack.kind);
    
                        if (selectedTrack.baseUrl) {
                            try {
                                const tsSegments = await TranscriptService._fetchTranscriptContent(selectedTrack.baseUrl);
                                if (tsSegments?.length) {
                                    this._log('TranscriptService delivered', tsSegments.length, 'segments');
                                    return tsSegments.map(s => ({
                                        start: (s.startMs || 0) / 1000,
                                        dur: ((s.endMs || 0) - (s.startMs || 0)) / 1000,
                                        text: s.text,
                                        ...(s.words ? { words: s.words } : {})
                                    }));
                                }
                            } catch(e) {
                                this._log('TranscriptService._fetchTranscriptContent failed:', e.message);
                            }
    
                            this._log('Trying GM-backed caption download as fallback...');
                            onStatus?.('Trying GM caption fetch...', 'loading', 15);
                            const gmSegments = await this._gmDownloadCaptions(selectedTrack, videoId);
                            if (gmSegments?.length) {
                                this._log('GM caption download got', gmSegments.length, 'segments');
                                return gmSegments;
                            }
                        }
                    } else {
                        this._log('TranscriptService found no tracks');
                    }
                } catch(e) {
                    this._log('TranscriptService failed:', e.message);
                }
    
                // ── FALLBACK 2: Direct page-level variable access via unsafeWindow ──
                try {
                    onStatus?.('Trying page context access...', 'loading', 20);
                    this._log('Method 2: unsafeWindow.ytInitialPlayerResponse');
                    const pw = _rw;
                    const pr = pw.ytInitialPlayerResponse;
                    if (pr?.videoDetails?.videoId === videoId) {
                        const ct = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
                        if (ct?.length) {
                            this._log('Found', ct.length, 'tracks via unsafeWindow');
                            const segments = await this._gmDownloadCaptions(ct[0], videoId, ct);
                            if (segments?.length) return segments;
                        } else {
                            this._log('unsafeWindow PR exists but no captionTracks (captions:', !!pr?.captions, ')');
                        }
                    } else {
                        this._log('unsafeWindow PR missing or stale (prVid:', pr?.videoDetails?.videoId, 'wanted:', videoId, ')');
                    }
                } catch(e) {
                    this._log('unsafeWindow access failed:', e.message);
                }
    
                // ── FALLBACK 3: Polymer element data ──
                try {
                    onStatus?.('Trying Polymer element data...', 'loading', 25);
                    this._log('Method 3: ytd-watch-flexy Polymer data');
                    const wf = document.querySelector('ytd-watch-flexy');
                    if (wf) {
                        for (const path of ['playerData_', '__data', 'data']) {
                            let pr = wf[path]; if (pr?.playerResponse) pr = pr.playerResponse;
                            if (!pr?.videoDetails || pr.videoDetails.videoId !== videoId) continue;
                            const ct = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
                            if (ct?.length) {
                                this._log('Found', ct.length, 'tracks via flexy.' + path);
                                const segments = await this._gmDownloadCaptions(ct[0], videoId, ct);
                                if (segments?.length) return segments;
                            }
                        }
                    }
                    this._log('Polymer element: no tracks found');
                } catch(e) {
                    this._log('Polymer access failed:', e.message);
                }
    
                // ── FALLBACK 4: GM-backed fresh page fetch ──
                try {
                    onStatus?.('Fetching fresh page via GM...', 'loading', 30);
                    this._log('Method 4: GM page fetch');
                    const html = await this._gmGet(`https://www.youtube.com/watch?v=${videoId}`);
                    this._log('Got', html.length, 'chars, captionTracks:', html.includes('captionTracks'), 'timedtext:', html.includes('timedtext'));
    
                    // 4A: ytInitialPlayerResponse
                    const prMatch = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;\s*(?:var\s+(?:meta|head)|<\/script|\n)/s);
                    if (prMatch) {
                        try {
                            const pr = JSON.parse(prMatch[1]);
                            const ct = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
                            if (ct?.length) {
                                this._log('4A: found', ct.length, 'tracks from page PR');
                                const segments = await this._gmDownloadCaptions(ct[0], videoId, ct);
                                if (segments?.length) return segments;
                            }
                        } catch(e) { this._log('4A: JSON parse failed:', e.message?.slice(0,80)); }
                    }
    
                    // 4B: captionTracks regex
                    if (html.includes('captionTracks')) {
                        for (const pat of [/"captionTracks":\s*(\[.*?\])(?=\s*,\s*")/s, /"captionTracks":\s*(\[(?:[^\[\]]|\[(?:[^\[\]]|\[[^\[\]]*\])*\])*\])/]) {
                            const m = html.match(pat);
                            if (m) {
                                try {
                                    const parsed = JSON.parse(m[1]);
                                    if (parsed?.length) {
                                        this._log('4B: regex found', parsed.length, 'tracks');
                                        const segments = await this._gmDownloadCaptions(parsed[0], videoId, parsed);
                                        if (segments?.length) return segments;
                                    }
                                } catch(e) {}
                            }
                        }
                    }
    
                    // 4C: timedtext URL
                    if (html.includes('timedtext')) {
                        const urlMatch = html.match(/(https?:\\\/\\\/[^"]*timedtext[^"]*)/);
                        if (urlMatch) {
                            const cleanUrl = urlMatch[1].replace(/\\\//g, '/').replace(/\\u0026/g, '&');
                            this._log('4C: extracted timedtext URL');
                            const segments = await this._gmDownloadCaptions({ baseUrl: cleanUrl, languageCode: 'en' }, videoId);
                            if (segments?.length) return segments;
                        }
                    }
                } catch(e) {
                    this._log('GM page fetch failed:', e.message);
                }
    
                // ── FALLBACK 5: Innertube player API via GM ──
                try {
                    onStatus?.('Trying Innertube player API...', 'loading', 40);
                    this._log('Method 5: Innertube player API');
                    const pw = _rw;
                    let apiKey; try { apiKey = pw.ytcfg?.get?.('INNERTUBE_API_KEY'); } catch(e) {}
                    if (!apiKey) apiKey = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
                    let clientVersion; try { clientVersion = pw.ytcfg?.get?.('INNERTUBE_CLIENT_VERSION'); } catch(e) {}
                    if (!clientVersion) clientVersion = '2.20250210.01.00';
    
                    const body = { context: { client: { clientName: 'WEB', clientVersion, hl: 'en', gl: 'US' } }, videoId };
                    const authHeaders = await this._buildSapisidAuth() || {};
                    const data = await this._gmPostJson(`https://www.youtube.com/youtubei/v1/player?key=${apiKey}&prettyPrint=false`, body, authHeaders);
                    const ct = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
                    if (ct?.length) {
                        this._log('M5: found', ct.length, 'tracks');
                        const segments = await this._gmDownloadCaptions(ct[0], videoId, ct);
                        if (segments?.length) return segments;
                    } else {
                        this._log('M5: status:', data?.playabilityStatus?.status, 'reason:', data?.playabilityStatus?.reason?.slice(0,80) || 'none');
                    }
                } catch(e) {
                    this._log('Innertube player API failed:', e.message);
                }
    
                // ── FALLBACK 6: Innertube get_transcript ──
                try {
                    onStatus?.('Trying Innertube get_transcript...', 'loading', 50);
                    this._log('Method 6: Innertube get_transcript');
                    const segments = await this._fetchTranscriptViaInnertube(videoId, 'en');
                    if (segments?.length) {
                        this._log('get_transcript delivered', segments.length, 'segments');
                        return segments;
                    }
                } catch(e) {
                    this._log('get_transcript failed:', e.message);
                }
    
                // ── FALLBACK 7: DOM scrape ──
                try {
                    onStatus?.('Trying DOM transcript scrape...', 'loading', 55);
                    this._log('Method 7: DOM scrape');
                    const segments = await this._scrapeTranscriptFromDOM();
                    if (segments?.length) {
                        this._log('DOM scrape got', segments.length, 'segments');
                        return segments;
                    }
                } catch(e) {
                    this._log('DOM scrape failed:', e.message);
                }
    
                this._warn('ALL transcript methods failed for video:', videoId);
                return null;
            },
    
            // GM-backed caption download with SAPISIDHASH auth and multi-format fallback
            async _gmDownloadCaptions(trackOrFirst, videoId, allTracks) {
                let track = trackOrFirst;
                if (allTracks?.length) {
                    track = allTracks.find(t => t.languageCode === 'en' && t.kind !== 'asr')
                         || allTracks.find(t => t.languageCode === 'en')
                         || allTracks.find(t => t.languageCode?.startsWith('en'))
                         || allTracks[0];
                }
                if (!track?.baseUrl) { this._log('No baseUrl in track:', JSON.stringify(track)?.slice(0,200)); return null; }
    
                let baseUrl = track.baseUrl;
                if (baseUrl.includes('\\u0026')) baseUrl = baseUrl.replace(/\\u0026/g, '&');
                if (baseUrl.includes('\\u002F')) baseUrl = baseUrl.replace(/\\u002F/g, '/');
                if (track.languageCode && !baseUrl.includes('&lang=')) baseUrl += '&lang=' + encodeURIComponent(track.languageCode);
                if (track.kind && !baseUrl.includes('&kind=')) baseUrl += '&kind=' + encodeURIComponent(track.kind);
                if (typeof track.name === 'string' && !baseUrl.includes('&name=')) baseUrl += '&name=' + encodeURIComponent(track.name);
    
                this._log('Downloading captions for track:', track.languageCode, track.kind || 'manual');
    
                const authHeaders = await this._buildSapisidAuth() || {};
                for (const fmt of ['json3', null, 'srv3']) {
                    try {
                        const url = fmt ? baseUrl + '&fmt=' + fmt : baseUrl;
                        this._log('A(GM): fmt=' + (fmt || 'xml'));
                        const text = await this._gmGet(url, authHeaders);
                        if (!text.length) continue;
                        const segments = this._parseCaptionResponse(text, fmt);
                        if (segments?.length) { this._log('A(GM): got', segments.length, 'segments via fmt=' + (fmt || 'xml')); return segments; }
                    } catch(e) { this._log('A(GM): fmt=' + (fmt || 'xml'), 'error:', e.message); }
                }
    
                for (const fmt of ['json3', null, 'srv3']) {
                    try {
                        const url = fmt ? baseUrl + '&fmt=' + fmt : baseUrl;
                        this._log('B(fetch): fmt=' + (fmt || 'xml'));
                        const resp = await fetch(url, { credentials: 'include' });
                        const text = await resp.text();
                        if (!text.length) continue;
                        const segments = this._parseCaptionResponse(text, fmt);
                        if (segments?.length) { this._log('B(fetch): got', segments.length, 'segments via fmt=' + (fmt || 'xml')); return segments; }
                    } catch(e) { this._log('B(fetch): fmt=' + (fmt || 'xml'), 'error:', e.message); }
                }
    
                this._log('All caption download methods failed for track:', track.languageCode);
                return null;
            },
    
            _parseCaptionResponse(text, fmt) {
                if (fmt === 'json3') {
                    try {
                        const data = JSON.parse(text); if (!data.events?.length) return null;
                        const segments = [];
                        for (const evt of data.events) {
                            if (!evt.segs) continue;
                            const t = evt.segs.map(s => s.utf8 || '').join('').trim();
                            if (!t || t === '\n') continue;
                            const seg = { start: (evt.tStartMs || 0) / 1000, dur: (evt.dDurationMs || 0) / 1000, text: t.replace(/\n/g, ' ').trim() };
                            // Preserve word-level timing from tOffsetMs
                            if (evt.segs.length > 1 && evt.segs.some(s => s.tOffsetMs !== undefined)) {
                                const evtStart = seg.start, evtEnd = seg.start + seg.dur;
                                seg.words = [];
                                for (let i = 0; i < evt.segs.length; i++) {
                                    const w = (evt.segs[i].utf8 || '').replace(/\n/g, ' ').trim();
                                    if (!w) continue;
                                    const wStart = evtStart + (evt.segs[i].tOffsetMs || 0) / 1000;
                                    const nextOffset = (i < evt.segs.length - 1 && evt.segs[i+1].tOffsetMs !== undefined)
                                        ? evtStart + evt.segs[i+1].tOffsetMs / 1000 : evtEnd;
                                    seg.words.push({ text: w, start: wStart, end: nextOffset });
                                }
                            }
                            segments.push(seg);
                        }
                        return segments.length ? segments : null;
                    } catch(e) { return null; }
                }
                if (fmt === 'srv3') {
                    const segments = []; const re = /<p\s+t="(\d+)"(?:\s+d="(\d+)")?[^>]*>([\s\S]*?)<\/p>/g; let m;
                    while ((m = re.exec(text)) !== null) { const raw = (m[3] || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n/g, ' ').trim(); if (raw) segments.push({ start: parseInt(m[1]||'0')/1000, dur: parseInt(m[2]||'0')/1000, text: raw }); }
                    return segments.length ? segments : null;
                }
                const segments = []; const re = /<text\s+start="([^"]*)"(?:\s+dur="([^"]*)")?[^>]*>([\s\S]*?)<\/text>/g; let m;
                while ((m = re.exec(text)) !== null) { const raw = (m[3] || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/\n/g, ' ').trim(); if (raw) segments.push({ start: parseFloat(m[1]||'0'), dur: parseFloat(m[2]||'0'), text: raw }); }
                return segments.length ? segments : null;
            },
    
            async _fetchTranscriptViaInnertube(videoId, lang) {
                const pw = _rw;
                const vidBytes = [...new TextEncoder().encode(videoId)]; const langBytes = [...new TextEncoder().encode(lang || 'en')];
                function varint(val) { const b = []; while (val > 0x7f) { b.push((val & 0x7f) | 0x80); val >>>= 7; } b.push(val & 0x7f); return b; }
                function lenField(fieldNum, data) { const tag = varint((fieldNum << 3) | 2); return [...tag, ...varint(data.length), ...data]; }
                const f1 = lenField(1, vidBytes); const f2 = lenField(2, [...lenField(1, langBytes), ...lenField(3, [])]);
                const params = btoa(String.fromCharCode(...f1, ...f2));
                let apiKey; try { apiKey = pw.ytcfg?.get?.('INNERTUBE_API_KEY'); } catch(e) {}
                if (!apiKey) apiKey = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
                let clientVersion; try { clientVersion = pw.ytcfg?.get?.('INNERTUBE_CLIENT_VERSION'); } catch(e) {}
                if (!clientVersion) clientVersion = '2.20250210.01.00';
                const body = { context: { client: { clientName: 'WEB', clientVersion, hl: lang || 'en', gl: 'US' } }, params };
                try { const si = pw.ytcfg?.get?.('SESSION_INDEX'); if (si !== undefined) body.context.request = { sessionIndex: String(si) }; } catch(e) {}
                const authHeaders = await this._buildSapisidAuth() || {};
                const data = await this._gmPostJson(`https://www.youtube.com/youtubei/v1/get_transcript?key=${apiKey}&prettyPrint=false`, body, authHeaders);
                if (data.error) { this._log('get_transcript error:', data.error.code, data.error.message); return null; }
                const paths = [data?.actions?.[0]?.updateEngagementPanelAction?.content?.transcriptRenderer?.body?.transcriptBodyRenderer?.transcriptSegmentListRenderer?.initialSegments, data?.actions?.[0]?.updateEngagementPanelAction?.content?.transcriptRenderer?.content?.transcriptSearchPanelRenderer?.body?.transcriptSegmentListRenderer?.initialSegments];
                for (const segs of paths) { if (segs?.length) return this._parseTranscriptSegments(segs); }
                this._log('get_transcript: no segments in response');
                return null;
            },
    
            _parseTranscriptSegments(segments) {
                const result = [];
                for (const seg of segments) { const r = seg.transcriptSegmentRenderer; if (!r) continue; const text = r.snippet?.runs?.map(x => x.text || '').join('').trim(); if (!text) continue; result.push({ start: parseInt(r.startMs||'0')/1000, dur: (parseInt(r.endMs||'0')-parseInt(r.startMs||'0'))/1000, text: text.replace(/\n/g,' ').trim() }); }
                return result.length ? result : null;
            },
    
            async _scrapeTranscriptFromDOM() {
                const existing = document.querySelectorAll('ytd-transcript-segment-renderer');
                if (existing.length) return this._extractTranscriptFromDOM(existing);
    
                const descExpand = document.querySelector('tp-yt-paper-button#expand, #expand.button, #description-inline-expander #expand');
                if (descExpand) descExpand.click();
                await new Promise(r => setTimeout(r, 500));
    
                const btnSelectors = ['button', 'ytd-button-renderer', 'yt-button-shape button'];
                for (const sel of btnSelectors) {
                    for (const btn of document.querySelectorAll(sel)) {
                        const text = btn.textContent?.trim().toLowerCase() || '';
                        if (text.includes('show transcript') || text.includes('transcript')) {
                            this._log('DOM scrape: clicking transcript button:', text);
                            btn.click();
                            break;
                        }
                    }
                }
    
                for (let i = 0; i < 20; i++) {
                    await new Promise(r => setTimeout(r, 300));
                    const segs = document.querySelectorAll('ytd-transcript-segment-renderer');
                    if (segs.length) return this._extractTranscriptFromDOM(segs);
                }
                return null;
            },
            _extractTranscriptFromDOM(segElements) {
                const result = [];
                for (const seg of segElements) {
                    const timeEl = seg.querySelector('.segment-timestamp, [class*="timestamp"]');
                    const textEl = seg.querySelector('.segment-text, [class*="text"], yt-formatted-string');
                    if (!textEl?.textContent?.trim()) continue;
                    const timeStr = timeEl?.textContent?.trim() || '0:00';
                    const parts = timeStr.split(':').map(Number);
                    let secs = 0;
                    if (parts.length === 3) secs = parts[0]*3600 + parts[1]*60 + parts[2];
                    else if (parts.length === 2) secs = parts[0]*60 + parts[1];
                    else secs = parts[0] || 0;
                    result.push({ start: secs, dur: 5, text: textEl.textContent.trim().replace(/\n/g, ' ') });
                }
                return result.length ? result : null;
            },
    
            _buildTranscriptText(segments, maxChars = 30000) {
                // Build 30-second blocks from segments
                const blocks = []; let currentBlock = { start: 0, texts: [] }; let lastBlockStart = 0;
                for (const seg of segments) {
                    if (seg.start - lastBlockStart >= 30 || blocks.length === 0) {
                        if (currentBlock.texts.length) blocks.push(currentBlock);
                        currentBlock = { start: seg.start, texts: [] }; lastBlockStart = seg.start;
                    }
                    currentBlock.texts.push(seg.text);
                }
                if (currentBlock.texts.length) blocks.push(currentBlock);
                if (!blocks.length) return '';

                const formatBlock = b => `[${this._formatTime(b.start)}] ${b.texts.join(' ')}\n`;

                // If it all fits, return everything
                const fullText = blocks.map(formatBlock).join('');
                if (fullText.length <= maxChars) return fullText;

                // Smart truncation: keep intro (25%) + conclusion (15%) + evenly sampled middle (60%)
                const introCount = Math.max(2, Math.ceil(blocks.length * 0.25));
                const outroCount = Math.max(1, Math.ceil(blocks.length * 0.15));
                const introBlocks = blocks.slice(0, introCount);
                const outroBlocks = blocks.slice(-outroCount);
                const middleBlocks = blocks.slice(introCount, blocks.length - outroCount);

                let result = '';
                // Add intro
                for (const b of introBlocks) {
                    const line = formatBlock(b);
                    if (result.length + line.length > maxChars * 0.3) break;
                    result += line;
                }

                // Evenly sample middle to fill ~55% of budget
                if (middleBlocks.length > 0) {
                    const midBudget = maxChars * 0.55;
                    const step = Math.max(1, Math.floor(middleBlocks.length / Math.ceil(midBudget / 120)));
                    let midText = '';
                    for (let i = 0; i < middleBlocks.length; i += step) {
                        const line = formatBlock(middleBlocks[i]);
                        if (midText.length + line.length > midBudget) break;
                        midText += line;
                    }
                    if (midText && result.length > 0) result += '[...]\n';
                    result += midText;
                }

                // Add conclusion
                if (outroBlocks.length > 0) {
                    const outroBudget = maxChars - result.length - 10;
                    let outroText = '';
                    for (const b of outroBlocks) {
                        const line = formatBlock(b);
                        if (outroText.length + line.length > outroBudget) break;
                        outroText += line;
                    }
                    if (outroText) {
                        result += '[...]\n' + outroText;
                    }
                }
                return result;
            },
    
            // ═══ NLP ENGINE (zero dependencies) ═══

            // Stopwords for English — filter these from keyword extraction
            _NLP_STOPS: new Set(['the','and','that','this','with','for','are','was','were','been','have','has','had','not','but','what','all','can','her','his','from','they','will','one','its','also','just','more','about','would','there','their','which','could','other','than','then','these','some','them','into','only','your','when','very','most','over','such','after','know','like','going','right','think','really','want','well','here','look','make','come','how','did','get','got','say','said','because','way','still','being','those','where','back','does','take','much','many','through','before','should','each','between','must','same','thing','things','even','every','doing','something','anything','nothing','everything','need','let','see','yeah','yes','okay','actually','gonna','kind','sort','mean','basically','literally','stuff','pretty','little','whole','sure','probably','maybe','guess','though','enough','around','might','quite','able','always','never','already','again','another','talking','talk','people','called','start','started','going','really','actually','point','work','working','time','way','lot','part']),

            // Tokenize text into clean lowercase word array
            _nlpTokenize(text) {
                return text.toLowerCase().replace(/[^\w\s'-]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !/^\d+$/.test(w));
            },

            // Extract meaningful bigrams (two-word phrases)
            _nlpBigrams(tokens) {
                const bigrams = [];
                for (let i = 0; i < tokens.length - 1; i++) {
                    const a = tokens[i], b = tokens[i + 1];
                    if (!this._NLP_STOPS.has(a) && !this._NLP_STOPS.has(b) && a.length > 2 && b.length > 2) {
                        bigrams.push(a + ' ' + b);
                    }
                }
                return bigrams;
            },

            // Compute TF-IDF vectors for an array of documents (each doc is a string)
            _nlpTFIDF(docs) {
                const N = docs.length;
                const docTokens = docs.map(d => this._nlpTokenize(d));
                const docBigrams = docTokens.map(t => this._nlpBigrams(t));

                // Document frequency for each term
                const df = {};
                for (let i = 0; i < N; i++) {
                    const seen = new Set();
                    for (const t of docTokens[i]) { if (!this._NLP_STOPS.has(t)) seen.add(t); }
                    for (const b of docBigrams[i]) seen.add(b);
                    for (const term of seen) df[term] = (df[term] || 0) + 1;
                }

                // Compute TF-IDF vectors
                const vectors = [];
                for (let i = 0; i < N; i++) {
                    const tf = {};
                    const allTerms = [...docTokens[i].filter(t => !this._NLP_STOPS.has(t)), ...docBigrams[i]];
                    const total = allTerms.length || 1;
                    for (const t of allTerms) tf[t] = (tf[t] || 0) + 1;
                    const vec = {};
                    for (const [term, count] of Object.entries(tf)) {
                        const idf = Math.log(N / (df[term] || 1));
                        if (idf > 0.1) vec[term] = (count / total) * idf;
                    }
                    vectors.push(vec);
                }
                return vectors;
            },

            // Cosine similarity between two sparse TF-IDF vectors
            _nlpCosine(a, b) {
                let dot = 0, normA = 0, normB = 0;
                for (const [k, v] of Object.entries(a)) {
                    normA += v * v;
                    if (b[k]) dot += v * b[k];
                }
                for (const v of Object.values(b)) normB += v * v;
                const denom = Math.sqrt(normA) * Math.sqrt(normB);
                return denom > 0 ? dot / denom : 0;
            },

            // Extract top-N key phrases from a TF-IDF vector, preferring bigrams
            _nlpKeyPhrases(vec, n = 5) {
                return Object.entries(vec)
                    .map(([term, score]) => ({ term, score: score * (term.includes(' ') ? 1.5 : 1) }))
                    .sort((a, b) => b.score - a.score)
                    .slice(0, n)
                    .map(e => e.term);
            },

            // Title-case a phrase
            _nlpTitleCase(phrase) {
                const minor = new Set(['a','an','the','and','or','but','in','on','at','to','for','of','by','with','vs']);
                return phrase.split(' ').map((w, i) => {
                    if (i > 0 && minor.has(w)) return w;
                    return w.charAt(0).toUpperCase() + w.slice(1);
                }).join(' ');
            },

            // TextRank-lite: score sentences by importance using graph-based ranking
            _nlpTextRank(sentences, topN = 5) {
                if (sentences.length <= topN) return sentences.map((s, i) => ({ text: s, idx: i, score: 1 }));

                const tokenized = sentences.map(s => new Set(this._nlpTokenize(s).filter(t => !this._NLP_STOPS.has(t))));

                // Build similarity matrix and compute scores (simplified PageRank)
                const scores = new Float64Array(sentences.length).fill(1);
                const dampening = 0.85;

                for (let iter = 0; iter < 15; iter++) {
                    const newScores = new Float64Array(sentences.length).fill(1 - dampening);
                    for (let i = 0; i < sentences.length; i++) {
                        let totalSim = 0;
                        const sims = new Float64Array(sentences.length);
                        for (let j = 0; j < sentences.length; j++) {
                            if (i === j) continue;
                            const intersection = [...tokenized[i]].filter(t => tokenized[j].has(t)).length;
                            const union = new Set([...tokenized[i], ...tokenized[j]]).size;
                            sims[j] = union > 0 ? intersection / union : 0;
                            totalSim += sims[j];
                        }
                        if (totalSim > 0) {
                            for (let j = 0; j < sentences.length; j++) {
                                newScores[j] += dampening * (sims[j] / totalSim) * scores[i];
                            }
                        }
                    }
                    for (let i = 0; i < sentences.length; i++) scores[i] = newScores[i];
                }

                // Position bias: first and last sentences get a boost
                const posBoost = (idx) => {
                    if (idx <= 1) return 1.3;
                    if (idx >= sentences.length - 2) return 1.15;
                    return 1.0;
                };

                return Array.from(scores)
                    .map((score, idx) => ({ text: sentences[idx], idx, score: score * posBoost(idx) }))
                    .sort((a, b) => b.score - a.score)
                    .slice(0, topN)
                    .sort((a, b) => a.idx - b.idx); // restore document order
            },

            // ═══ BUILT-IN HEURISTIC CHAPTER GENERATOR (TF-IDF + Cosine Similarity) ═══
            _generateChaptersHeuristic(segments, duration) {
                this._log('NLP heuristic generator:', segments.length, 'segments');
                const totalSecs = duration || segments[segments.length - 1]?.start + 30 || 300;

                // ── Step 1: Build time-windowed documents (30-second windows) ──
                const windowSize = 30;
                const windows = [];
                for (const seg of segments) {
                    const idx = Math.floor(seg.start / windowSize);
                    while (windows.length <= idx) windows.push({ start: windows.length * windowSize, texts: [] });
                    windows[idx].texts.push(seg.text);
                }

                // ── Step 2: Merge into fixed ~60-second analysis groups ──
                // Keep groups small regardless of video length so TF-IDF vectors stay distinctive.
                // Previous approach scaled groups with video length, making them 3-4 min for long videos,
                // which caused vectors to converge and chapters to stop being detected past ~10 min.
                const groupWindowCount = 2; // 2 × 30s = 60s per group — consistent resolution
                const groups = [];
                for (let i = 0; i < windows.length; i += groupWindowCount) {
                    const slice = windows.slice(i, i + groupWindowCount);
                    const text = slice.map(w => w.texts.join(' ')).join(' ');
                    if (text.trim()) groups.push({ start: slice[0]?.start || 0, text });
                }
                if (groups.length < 2) {
                    return { chapters: [{ start: 0, title: 'Full Video', end: totalSecs }], pois: [] };
                }

                // ── Step 3: Compute TF-IDF vectors for each group ──
                const groupDocs = groups.map(g => g.text);
                const vectors = this._nlpTFIDF(groupDocs);

                // ── Step 4: Find topic boundaries via cosine similarity drops ──
                const similarities = [];
                for (let i = 1; i < groups.length; i++) {
                    similarities.push({ idx: i, sim: this._nlpCosine(vectors[i - 1], vectors[i]) });
                }

                // Adaptive threshold: use percentile-based approach for long videos
                const sims = similarities.map(s => s.sim);
                const sortedSims = [...sims].sort((a, b) => a - b);
                const meanSim = sims.reduce((a, b) => a + b, 0) / sims.length;
                const stdSim = Math.sqrt(sims.reduce((a, b) => a + (b - meanSim) ** 2, 0) / sims.length);
                // Use lower of: mean - 0.5*std OR 25th percentile — whichever finds more boundaries
                const statThreshold = meanSim - 0.5 * stdSim;
                const pctThreshold = sortedSims[Math.floor(sortedSims.length * 0.25)] || 0;
                const threshold = Math.max(0.05, Math.min(statThreshold, pctThreshold + 0.05));
                this._log('Cosine threshold:', threshold.toFixed(3), 'mean:', meanSim.toFixed(3), 'std:', stdSim.toFixed(3), 'p25:', pctThreshold.toFixed(3));

                // Minimum gap between boundaries is time-based (90 seconds), not group-count-based
                const minGapSeconds = 90;
                const boundaries = [0];
                for (const { idx, sim } of similarities) {
                    if (sim < threshold) {
                        const lastBoundaryTime = groups[boundaries[boundaries.length - 1]].start;
                        const thisTime = groups[idx].start;
                        if (thisTime - lastBoundaryTime >= minGapSeconds) {
                            boundaries.push(idx);
                        }
                    }
                }

                // Target chapter count based on video length: ~1 per 3-5 minutes
                const targetMin = Math.max(3, Math.floor(totalSecs / 300)); // 1 per 5 min, min 3
                const targetMax = Math.max(6, Math.ceil(totalSecs / 180));  // 1 per 3 min
                const targetCap = Math.min(targetMax, 15); // hard cap

                // Trim excess: remove boundaries with smallest similarity drops
                while (boundaries.length > targetCap) {
                    let bestMerge = 1, bestSim = -1;
                    for (let i = 1; i < boundaries.length; i++) {
                        // Find the boundary with highest similarity (weakest topic change)
                        const s = similarities.find(s => s.idx === boundaries[i])?.sim ?? 1;
                        if (s > bestSim) { bestSim = s; bestMerge = i; }
                    }
                    boundaries.splice(bestMerge, 1);
                }

                // Add boundaries if too few: split largest chapters at biggest similarity drops
                if (boundaries.length < targetMin && groups.length >= 4) {
                    // Find low-similarity points not yet used as boundaries
                    const unusedDrops = similarities
                        .filter(s => !boundaries.includes(s.idx) && s.sim < meanSim)
                        .sort((a, b) => a.sim - b.sim);
                    for (const drop of unusedDrops) {
                        if (boundaries.length >= targetMin) break;
                        // Check time gap from nearest existing boundary
                        const dropTime = groups[drop.idx].start;
                        const tooClose = boundaries.some(bIdx => Math.abs(groups[bIdx].start - dropTime) < 60);
                        if (!tooClose) {
                            boundaries.push(drop.idx);
                            boundaries.sort((a, b) => a - b);
                        }
                    }
                }

                // ── Step 5: Generate descriptive titles using key phrases ──
                const chapters = boundaries.map((bIdx, i) => {
                    const endIdx = i < boundaries.length - 1 ? boundaries[i + 1] : groups.length;
                    const mergedVec = {};
                    for (let g = bIdx; g < endIdx; g++) {
                        for (const [term, score] of Object.entries(vectors[g])) {
                            mergedVec[term] = (mergedVec[term] || 0) + score;
                        }
                    }
                    const keyPhrases = this._nlpKeyPhrases(mergedVec, 4);

                    let title;
                    if (keyPhrases.length >= 2) {
                        if (keyPhrases[0].includes(' ')) {
                            title = this._nlpTitleCase(keyPhrases[0]);
                        } else if (keyPhrases[1].includes(' ')) {
                            title = this._nlpTitleCase(keyPhrases[1]);
                        } else {
                            title = this._nlpTitleCase(keyPhrases[0] + ' ' + keyPhrases[1]);
                        }
                        if (title.length < 10 && keyPhrases.length >= 3) {
                            const extra = keyPhrases[2].includes(' ') ? keyPhrases[2].split(' ')[0] : keyPhrases[2];
                            title += ' ' + this._nlpTitleCase(extra);
                        }
                    } else if (keyPhrases.length === 1) {
                        title = this._nlpTitleCase(keyPhrases[0]);
                    } else {
                        title = `Section ${i + 1}`;
                    }

                    return { start: Math.round(groups[bIdx].start), title: title.slice(0, 50) };
                });

                if (chapters.length && chapters[0].start > 5) chapters[0].start = 0;
                for (let i = 0; i < chapters.length; i++) {
                    chapters[i].end = i < chapters.length - 1 ? chapters[i + 1].start : totalSecs;
                }

                // ── Step 6: POI detection (multi-signal scoring) ──
                const pois = this._detectPOIs(segments, chapters, totalSecs);

                this._log('NLP result:', chapters.length, 'chapters,', pois.length, 'POIs from', groups.length, 'groups');
                return { chapters, pois };
            },

            // ═══ POI DETECTION (multi-signal scoring) ═══
            _detectPOIs(segments, chapters, totalSecs) {
                const candidates = [];
                const emphasisRe = /\b(important|key point|remember|crucial|breaking|announce|reveal|surprise|incredible|amazing|game.?changer|mind.?blow|breakthrough|discover|secret|tip|trick|hack|milestone|highlight|takeaway|essential|critical|warning|danger|careful|watch out|pay attention)\b/i;
                const enumerationRe = /\b(first(ly)?|second(ly)?|third(ly)?|step one|step two|number one|number two|finally|in conclusion|to summarize|the main|the biggest|the most|in summary|bottom line|key takeaway|most importantly)\b/i;

                for (let i = 0; i < segments.length; i++) {
                    const seg = segments[i];
                    let score = 0;

                    if (emphasisRe.test(seg.text)) score += 4;
                    if (enumerationRe.test(seg.text)) score += 3;

                    // Question cluster
                    const nearbyQ = segments.filter(s => Math.abs(s.start - seg.start) < 60 && s.text.includes('?')).length;
                    if (nearbyQ >= 3) score += 2;

                    // Time gap (pause = emphasis)
                    if (i > 0 && seg.start - segments[i - 1].start > 8) score += 2;

                    // Substantive length
                    if (seg.text.length > 100) score += 1;
                    if (seg.text.includes('!')) score += 1;

                    // Named entities (capitalized words mid-sentence)
                    const caps = seg.text.match(/\b[A-Z][a-z]{2,}/g);
                    if (caps && caps.length >= 2) score += 1;

                    if (score >= 3) {
                        let label = seg.text.trim();
                        const sents = label.split(/[.!?]+/).filter(s => s.trim().length > 10);
                        if (sents.length > 1) {
                            label = (sents.find(s => emphasisRe.test(s) || enumerationRe.test(s)) || sents[0]).trim();
                        }
                        if (label.length > 70) label = label.slice(0, 67) + '...';
                        candidates.push({ time: Math.round(seg.start), label, score });
                    }
                }

                candidates.sort((a, b) => b.score - a.score);
                const pois = [];
                for (const p of candidates) {
                    if (pois.length >= 6) break;
                    if (pois.some(e => Math.abs(e.time - p.time) < 90)) continue;
                    if (chapters.some(c => Math.abs(c.start - p.time) < 10)) continue;
                    pois.push(p);
                }
                pois.sort((a, b) => a.time - b.time);
                return pois;
            },

    

            // ═══ CHAPTER GENERATION (builtin NLP only) ═══
            async _generateChapters(videoId, onStatus) {
                if (this._isGenerating) return null;
                this._isGenerating = true;
                try {
                    const segments = await this._fetchTranscript(videoId, onStatus);
                    if (!segments?.length) {
                        onStatus?.('No transcript available', 'error', 0);
                        this._isGenerating = false; return null;
                    }
                    this._lastTranscriptSegments = segments;
                    const duration = this._getVideoDuration();
                    onStatus?.('Analyzing transcript...', 'loading', 60);
                    const data = this._generateChaptersHeuristic(segments, duration);
                    if (data?.chapters?.length) {
                        this._setCachedData(videoId, data);
                        onStatus?.(`Generated ${data.chapters.length} chapters, ${data.pois.length} POIs`, 'ready', 100);
                        this._isGenerating = false; return data;
                    } else {
                        onStatus?.('Generation produced no chapters', 'error', 0);
                        this._isGenerating = false; return null;
                    }
                } catch(e) {
                    this._warn('Generation error:', e);
                    onStatus?.(e.message || 'Generation failed', 'error', 0);
                    this._isGenerating = false; return null;
                }
            },

            // ═══════════════════════════════════════════════════════
            //  OpenCut-inspired Analysis Engine (browser-native)
            // ═══════════════════════════════════════════════════════

            // Filler word detection — user-editable via cfFillerWordsEnabled setting
            _getFillerSets() {
                const enabled = appState.settings.cfFillerWordsEnabled || {};
                const words = ALL_FILLER_WORDS.filter(w => enabled[w]);
                const simple = new Set();
                const multi = [];
                for (const w of words) {
                    if (w.includes(' ')) {
                        const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        multi.push({ pattern: new RegExp(`\\b(${escaped})\\b`, 'gi'), word: w });
                    } else {
                        simple.add(w);
                    }
                }
                // "like" with comma is a special case (filler "like," vs normal "like")
                if (simple.has('like')) {
                    simple.delete('like');
                    multi.push({ pattern: /\b(like)\s*[,]/gi, word: 'like' });
                }
                return { simple, multi };
            },

            _detectFillers(segments) {
                if (!segments?.length) return [];
                const { simple, multi } = this._getFillerSets();
                if (simple.size === 0 && multi.length === 0) return [];
                const fillers = [];
                let wordTimingUsed = 0;
                for (const seg of segments) {
                    const text = seg.text || '';
                    const segDur = seg.dur || seg.duration || 3;
                    const segEnd = seg.start + segDur;

                    // ── Word-level timing path (precise, from json3 tOffsetMs) ──
                    if (seg.words?.length) {
                        for (const w of seg.words) {
                            const clean = w.text.replace(/[^a-zA-Z\s]/g, '').toLowerCase().trim();
                            if (simple.has(clean)) {
                                fillers.push({ time: w.start, end: w.end, duration: w.end - w.start, word: clean, segStart: seg.start, segEnd, precise: true });
                                wordTimingUsed++;
                            }
                        }
                        // Multi-word filler check against full segment text with word timing
                        for (const { pattern, word } of multi) {
                            pattern.lastIndex = 0;
                            let m;
                            while ((m = pattern.exec(text)) !== null) {
                                const matched = m[0].toLowerCase().trim();
                                if (simple.has(matched)) continue;
                                // Find the word(s) that correspond to this match position
                                const matchWords = matched.split(/\s+/);
                                const firstWord = matchWords[0];
                                const hit = seg.words.find(w => w.text.toLowerCase().replace(/[^a-z]/g, '') === firstWord && w.start >= seg.start);
                                if (hit) {
                                    const lastWord = matchWords.length > 1
                                        ? seg.words.find(w => w.start >= hit.start && w.text.toLowerCase().replace(/[^a-z]/g, '') === matchWords[matchWords.length - 1])
                                        : hit;
                                    const end = lastWord ? lastWord.end : hit.end;
                                    fillers.push({ time: hit.start, end, duration: end - hit.start, word: matched, segStart: seg.start, segEnd, precise: true });
                                    wordTimingUsed++;
                                }
                            }
                        }
                        continue;
                    }

                    // ── Fallback: interpolated timing (less precise) ──
                    const words = text.split(/\s+/);
                    for (let wi = 0; wi < words.length; wi++) {
                        const clean = words[wi].replace(/[^a-zA-Z\s]/g, '').toLowerCase().trim();
                        if (simple.has(clean)) {
                            const offset = (wi / Math.max(words.length, 1)) * segDur;
                            fillers.push({ time: seg.start + offset, duration: 0.8, word: clean, segStart: seg.start, segEnd, precise: false });
                        }
                    }
                    for (const { pattern, word } of multi) {
                        pattern.lastIndex = 0;
                        let m;
                        while ((m = pattern.exec(text)) !== null) {
                            const matched = m[0].toLowerCase().trim();
                            if (simple.has(matched)) continue;
                            const charPos = m.index / Math.max(text.length, 1);
                            fillers.push({ time: seg.start + charPos * segDur, duration: 1.0, word: matched, segStart: seg.start, segEnd, precise: false });
                        }
                    }
                }
                fillers.sort((a, b) => a.time - b.time);
                const deduped = []; let lastT = -2;
                for (const f of fillers) { if (f.time - lastT > 1.0) { deduped.push(f); lastT = f.time; } }
                this._log('Filler detection:', deduped.length, 'fillers in', segments.length, 'segments (' + wordTimingUsed + ' word-level precise)');
                return deduped;
            },

            // ═══════════════════════════════════════════════════════
            //  AutoSkip Engine (unified pause + filler skip)
            //  Inspired by AutoCut aggression presets
            // ═══════════════════════════════════════════════════════

            // AutoSkip mode presets — controls pause threshold, filler skip, and silence speedup
            _AUTOSKIP_PRESETS: {
                gentle:     { pauseThreshold: 3.0, skipFillers: false, silenceSpeed: null, label: 'Gentle',     desc: 'Skip long pauses (>3s)' },
                normal:     { pauseThreshold: 1.5, skipFillers: true,  silenceSpeed: null, label: 'Normal',     desc: 'Skip pauses >1.5s + fillers' },
                aggressive: { pauseThreshold: 0.5, skipFillers: true,  silenceSpeed: 2.0,  label: 'Aggressive', desc: 'Skip all gaps, speed silence' },
            },

            _getAutoSkipPreset() {
                const mode = appState.settings.cfAutoSkipMode || 'off';
                return this._AUTOSKIP_PRESETS[mode] || null;
            },

            // Pause detection — recomputed per aggression level
            _detectPauses(segments, threshold) {
                if (!segments?.length || segments.length < 2) return [];
                const pauses = [];
                for (let i = 0; i < segments.length - 1; i++) {
                    const segEnd = segments[i].start + (segments[i].dur || segments[i].duration || 3);
                    const nextStart = segments[i + 1].start;
                    const gap = nextStart - segEnd;
                    if (gap >= threshold) {
                        pauses.push({ start: segEnd, end: nextStart, duration: Math.round(gap * 10) / 10 });
                    }
                }
                this._log('Pause detection:', pauses.length, 'pauses >', threshold + 's in', segments.length, 'segments');
                return pauses;
            },

            // Recompute pauses for current preset and store
            _recomputePauses() {
                if (!this._lastTranscriptSegments?.length) return;
                const preset = this._getAutoSkipPreset();
                const threshold = preset ? preset.pauseThreshold : 1.5;
                this._pauseData = this._detectPauses(this._lastTranscriptSegments, threshold);
            },

            // Unified skip loop — one RAF handles both pause and filler skipping
            _startAutoSkip() {
                if (this._autoSkipRAF) return;
                const preset = this._getAutoSkipPreset();
                if (!preset) return;
                this._autoSkipActive = true;

                // Recompute pauses for this aggression level
                this._recomputePauses();

                // Build a sorted skip list: [{start, end, type}]
                // This lets us binary-search instead of scanning every filler/pause per frame
                const skipZones = [];
                if (this._pauseData?.length) {
                    for (const p of this._pauseData) {
                        skipZones.push({ start: p.start, end: p.end, type: 'pause' });
                    }
                }
                if (preset.skipFillers && this._fillerData?.length) {
                    // Nasal fillers like "um"/"uh" have a longer onset — need more pre-buffer
                    const preBuffer = { um: 0.35, uh: 0.35, umm: 0.35, uhh: 0.35, hmm: 0.3 };
                    const defaultBuffer = 0.15;
                    for (const f of this._fillerData) {
                        if (f.precise && f.end) {
                            const buf = preBuffer[f.word] || defaultBuffer;
                            skipZones.push({ start: Math.max(f.time - buf, 0), end: f.end, type: 'filler' });
                        } else {
                            // Interpolated fallback: use wider window
                            const windowStart = Math.max(f.time - 1.0, f.segStart);
                            const windowEnd = Math.min(f.time + f.duration + 0.5, f.segEnd);
                            skipZones.push({ start: windowStart, end: windowEnd, type: 'filler' });
                        }
                    }
                }
                skipZones.sort((a, b) => a.start - b.start);

                // Merge overlapping zones
                const merged = [];
                for (const z of skipZones) {
                    const last = merged[merged.length - 1];
                    if (last && z.start <= last.end + 0.2) {
                        last.end = Math.max(last.end, z.end);
                        if (z.type === 'pause') last.type = 'pause'; // pause takes priority for speedup
                    } else {
                        merged.push({ ...z });
                    }
                }

                this._log('AutoSkip started:', merged.length, 'skip zones (mode:', appState.settings.cfAutoSkipMode + ')');
                this._autoSkipZones = merged;

                let zoneIdx = 0; // cursor for binary-search optimization
                const silenceSpeed = preset.silenceSpeed;
                const self = this;

                const tick = () => {
                    if (!self._autoSkipActive) return;
                    const video = document.querySelector('video.html5-main-video');
                    if (!video || video.paused) {
                        self._autoSkipRAF = requestAnimationFrame(tick);
                        return;
                    }

                    const ct = video.currentTime;

                    // Reset cursor if we seeked backwards
                    if (zoneIdx > 0 && merged[zoneIdx - 1]?.end > ct + 1) zoneIdx = 0;

                    // Advance cursor to current position
                    while (zoneIdx < merged.length && merged[zoneIdx].end <= ct) zoneIdx++;

                    // Check if we're inside a skip zone
                    if (zoneIdx < merged.length) {
                        const zone = merged[zoneIdx];
                        if (ct >= zone.start && ct < zone.end) {
                            if (zone.type === 'pause' && silenceSpeed) {
                                // Aggressive mode: speed through silence instead of hard skip
                                if (self._autoSkipSavedRate === null) {
                                    self._autoSkipSavedRate = video.playbackRate;
                                    video.playbackRate = silenceSpeed;
                                }
                            } else {
                                // Hard skip past the zone
                                video.currentTime = zone.end + 0.05;
                                zoneIdx++;
                            }
                            self._autoSkipRAF = requestAnimationFrame(tick);
                            return;
                        }
                    }

                    // Not in a skip zone — restore normal speed if we were speeding through silence
                    if (self._autoSkipSavedRate !== null) {
                        video.playbackRate = self._autoSkipSavedRate;
                        self._autoSkipSavedRate = null;
                    }

                    self._autoSkipRAF = requestAnimationFrame(tick);
                };

                this._autoSkipRAF = requestAnimationFrame(tick);
            },

            _stopAutoSkip() {
                this._autoSkipActive = false;
                if (this._autoSkipRAF) { cancelAnimationFrame(this._autoSkipRAF); this._autoSkipRAF = null; }
                // Restore playback rate if we were speeding through silence
                if (this._autoSkipSavedRate !== null) {
                    const video = document.querySelector('video.html5-main-video');
                    if (video) video.playbackRate = this._autoSkipSavedRate;
                    this._autoSkipSavedRate = null;
                }
                this._autoSkipZones = null;
            },

            // Speech pace analysis — from OpenCut audio analysis
            _analyzePace(segments) {
                if (!segments?.length) return [];
                const pace = [];
                for (const seg of segments) {
                    const words = (seg.text || '').split(/\s+/).filter(w => w.length > 0).length;
                    const dur = seg.duration || 3;
                    pace.push({ start: seg.start, end: seg.start + dur, wpm: Math.round((words / dur) * 60), words });
                }
                return pace;
            },
            _getPaceStats(paceData) {
                if (!paceData?.length) return null;
                const wpms = paceData.map(p => p.wpm).filter(w => w > 0);
                if (!wpms.length) return null;
                const avg = Math.round(wpms.reduce((a, b) => a + b, 0) / wpms.length);
                return { avg, max: Math.max(...wpms), min: Math.min(...wpms), fast: paceData.filter(p => p.wpm > avg * 1.4).length, slow: paceData.filter(p => p.wpm > 0 && p.wpm < avg * 0.6).length, total: wpms.length };
            },

            // Keyword extraction per chapter — from OpenCut NLP + scene detection
            _extractKeywords(segments, chapters) {
                if (!segments?.length || !chapters?.length) return [];
                const result = [];
                for (const ch of chapters) {
                    const chSegs = segments.filter(s => s.start >= ch.start && s.start < (ch.end || Infinity));
                    const text = chSegs.map(s => s.text).join(' ').toLowerCase();
                    const words = text.split(/[^a-z0-9']+/).filter(w => w.length > 3 && !this._NLP_STOPS.has(w));
                    const freq = {};
                    for (const w of words) freq[w] = (freq[w] || 0) + 1;
                    result.push(Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 5).map(e => e[0]));
                }
                return result;
            },

            _runAnalysis(segments) {
                if (!segments?.length) return;
                if (appState.settings.cfFillerDetect) this._fillerData = this._detectFillers(segments);
                // Detect pauses at finest granularity (0.5s) — AutoSkip filters by mode at runtime
                this._pauseData = this._detectPauses(segments, 0.5);
                this._paceData = this._analyzePace(segments);
                if (this._chapterData?.chapters?.length) this._keywordsPerChapter = this._extractKeywords(segments, this._chapterData.chapters);
            },

    
            // ═══════════════════════════════════════════════════════════
            //  UI: Progress Bar Overlay (FIXED — no z-index conflicts)
            // ═══════════════════════════════════════════════════════════
            _renderProgressBarOverlay() {
                // Clean up all previous overlays
                document.querySelectorAll('.cf-bar-overlay,.cf-chapter-markers,.cf-chapter-label-row,.cf-filler-markers').forEach(el => el.remove());
                document.getElementById('cf-transcript-tip')?.remove();
                if (!this._chapterData) return;
                const progressBar = document.querySelector('.ytp-progress-bar');
                if (!progressBar) return;
                const duration = this._getVideoDuration();
                if (!duration) return;
                if (getComputedStyle(progressBar).position === 'static') progressBar.style.position = 'relative';
                const s = appState.settings;
                const poiColor = s.cfPoiColor || '#ff6b6b';
    
                // ── Chapter segments on the progress bar ──
                if (s.cfShowChapters && this._chapterData.chapters.length > 1) {
                    const markerContainer = document.createElement('div');
                    markerContainer.className = 'cf-chapter-markers';
    
                    // Label row above the progress bar — shows chapter names
                    const labelRow = document.createElement('div');
                    labelRow.className = 'cf-chapter-label-row';
    
                    this._chapterData.chapters.forEach((ch, i) => {
                        const left = (ch.start / duration) * 100;
                        const width = ((ch.end - ch.start) / duration) * 100;
                        const color = this._CF_COLORS[i % this._CF_COLORS.length];
                        const fg = this._CF_COLORS_FG[i % this._CF_COLORS_FG.length];
    
                        // Chapter segment (colored bar)
                        const seg = document.createElement('div');
                        seg.className = 'cf-chapter-seg';
                        seg.style.cssText = `left:${left}%;width:${width}%;--cf-seg-color:${color};--cf-seg-opacity:${s.cfChapterOpacity || 0.35}`;
                        seg.dataset.cfChapterIdx = i;
                        seg.addEventListener('click', (e) => { e.stopPropagation(); this._seekTo(ch.start); });
    
                        // Tooltip on hover (positioned well above bar)
                        const tip = document.createElement('div');
                        tip.className = 'cf-bar-tooltip cf-chapter-tip';
                        TrustedHTML.setHTML(tip, `<span class="cf-tip-time">${this._formatTime(ch.start)}</span><span class="cf-tip-title">${ch.title}</span>`);
                        seg.appendChild(tip);
                        seg.addEventListener('mouseenter', () => tip.style.opacity = '1');
                        seg.addEventListener('mouseleave', () => tip.style.opacity = '0');
    
                        // Gap divider between chapters
                        if (i > 0) {
                            const gap = document.createElement('div');
                            gap.className = 'cf-chapter-gap';
                            gap.style.left = `${left}%`;
                            markerContainer.appendChild(gap);
                        }
    
                        markerContainer.appendChild(seg);
    
                        // Chapter label (name inside the colored segment area, above bar)
                        const label = document.createElement('div');
                        label.className = 'cf-chapter-label';
                        label.style.cssText = `left:${left}%;width:${width}%;--cf-label-color:${color};--cf-label-fg:${fg}`;
                        label.textContent = ch.title;
                        label.addEventListener('click', (e) => { e.stopPropagation(); this._seekTo(ch.start); });
                        labelRow.appendChild(label);
                    });
    
                    progressBar.appendChild(markerContainer);
                    // Append label row to progress bar itself — purely absolute, no layout impact
                    progressBar.appendChild(labelRow);
                }
    
                // ── POI markers ──
                const overlay = document.createElement('div'); overlay.className = 'cf-bar-overlay';
    
                if (s.cfShowPOIs && this._chapterData.pois.length) {
                    this._chapterData.pois.forEach(p => {
                        const left = (p.time / duration) * 100;
                        const hitbox = document.createElement('div');
                        hitbox.className = 'cf-poi-hitbox';
                        hitbox.style.left = `${left}%`;
                        hitbox.addEventListener('click', (e) => { e.stopPropagation(); this._seekTo(p.time); });
    
                        const diamond = document.createElement('div');
                        diamond.className = 'cf-poi-diamond';
                        diamond.style.background = poiColor;
                        hitbox.appendChild(diamond);
    
                        const tip = document.createElement('div');
                        tip.className = 'cf-bar-tooltip cf-poi-tip';
                        TrustedHTML.setHTML(tip, `<span class="cf-tip-poi-icon">&#9733;</span><span class="cf-tip-time">${this._formatTime(p.time)}</span><span class="cf-tip-label">${p.label}</span>`);
                        hitbox.appendChild(tip);
                        hitbox.addEventListener('mouseenter', () => { tip.style.opacity = '1'; diamond.classList.add('cf-poi-hover'); });
                        hitbox.addEventListener('mouseleave', () => { tip.style.opacity = '0'; diamond.classList.remove('cf-poi-hover'); });
                        overlay.appendChild(hitbox);
                    });
                }
    
                // ── Enhanced transcript hover ──
                if (this._lastTranscriptSegments?.length) {
                    const transcriptTip = document.createElement('div');
                    transcriptTip.id = 'cf-transcript-tip';
                    transcriptTip.className = 'cf-transcript-tip';
                    const chapters = this._chapterData?.chapters || [];
    
                    overlay.addEventListener('mousemove', (e) => {
                        const rect = progressBar.getBoundingClientRect();
                        const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                        const hoverTime = percent * duration;
    
                        let bestIdx = -1;
                        for (let si = 0; si < this._lastTranscriptSegments.length; si++) {
                            const seg = this._lastTranscriptSegments[si];
                            if (seg.start <= hoverTime && hoverTime <= seg.start + (seg.dur || 5)) { bestIdx = si; break; }
                            if (seg.start > hoverTime) break;
                            bestIdx = si;
                        }
    
                        if (bestIdx >= 0) {
                            const segs = this._lastTranscriptSegments;
                            const lines = [];
                            if (bestIdx > 0) lines.push({ time: segs[bestIdx - 1].start, text: segs[bestIdx - 1].text, dim: true });
                            lines.push({ time: segs[bestIdx].start, text: segs[bestIdx].text, dim: false });
                            if (bestIdx < segs.length - 1) lines.push({ time: segs[bestIdx + 1].start, text: segs[bestIdx + 1].text, dim: true });
    
                            let chapterName = '';
                            for (let ci = chapters.length - 1; ci >= 0; ci--) {
                                if (hoverTime >= chapters[ci].start) { chapterName = chapters[ci].title; break; }
                            }
    
                            let html = '';
                            if (chapterName) html += `<div class="cf-tx-chapter">${chapterName}</div>`;
                            for (const ln of lines) {
                                const txt = ln.text.length > 80 ? ln.text.slice(0, 77) + '...' : ln.text;
                                html += `<div class="cf-tx-line${ln.dim ? ' cf-tx-dim' : ''}"><span class="cf-tx-ts">${this._formatTime(ln.time)}</span> ${txt}</div>`;
                            }
    
                            TrustedHTML.setHTML(transcriptTip, html);
                            transcriptTip.style.opacity = '1';
                            const tipWidth = 300;
                            const xPos = Math.max(5, Math.min(rect.width - tipWidth - 5, e.clientX - rect.left - tipWidth / 2));
                            transcriptTip.style.left = xPos + 'px';
                        } else {
                            transcriptTip.style.opacity = '0';
                        }
                    });
                    overlay.addEventListener('mouseleave', () => { transcriptTip.style.opacity = '0'; });
                    overlay.appendChild(transcriptTip);
                }
    
                progressBar.appendChild(overlay);

                // ── Filler word markers (OpenCut: filler detection) ──
                if (s.cfShowFillerMarkers && this._fillerData?.length) {
                    const fillerContainer = document.createElement('div');
                    fillerContainer.className = 'cf-filler-markers';
                    this._fillerData.forEach(f => {
                        const left = (f.time / duration) * 100;
                        const marker = document.createElement('div');
                        marker.className = 'cf-filler-marker';
                        marker.style.left = `${left}%`;
                        marker.title = f.word;
                        const tip = document.createElement('div');
                        tip.className = 'cf-bar-tooltip cf-filler-tip';
                        tip.textContent = `"${f.word}" @ ${this._formatTime(f.time)}`;
                        marker.appendChild(tip);
                        marker.addEventListener('mouseenter', () => tip.style.opacity = '1');
                        marker.addEventListener('mouseleave', () => tip.style.opacity = '0');
                        marker.addEventListener('click', (e) => { e.stopPropagation(); this._seekTo(f.time); });
                        fillerContainer.appendChild(marker);
                    });
                    progressBar.appendChild(fillerContainer);
                }
    
                // Start chapter HUD tracking
                this._startChapterTracking();
            },
    
            // ═══ CHAPTER HUD — Floating current chapter indicator on video ═══
            _startChapterTracking() {
                this._stopChapterTracking();
                if (!appState.settings.cfShowChapterHUD || !this._chapterData?.chapters?.length) return;
    
                const track = () => {
                    const video = document.querySelector('video.html5-main-video');
                    if (!video || !this._chapterData?.chapters?.length) {
                        this._chapterTrackingRAF = requestAnimationFrame(track);
                        return;
                    }
                    const ct = video.currentTime;
                    const chapters = this._chapterData.chapters;
                    let idx = -1;
                    for (let i = chapters.length - 1; i >= 0; i--) {
                        if (ct >= chapters[i].start) { idx = i; break; }
                    }
                    if (idx !== this._lastActiveChapterIdx) {
                        this._lastActiveChapterIdx = idx;
                        this._updateChapterHUD(idx);
                        // Highlight active segment on progress bar
                        document.querySelectorAll('.cf-chapter-seg').forEach((seg, si) => {
                            seg.classList.toggle('cf-seg-active', si === idx);
                        });
                        document.querySelectorAll('.cf-chapter-label').forEach((lbl, li) => {
                            lbl.classList.toggle('cf-label-active', li === idx);
                        });
                    }
                    this._chapterTrackingRAF = requestAnimationFrame(track);
                };
                this._chapterTrackingRAF = requestAnimationFrame(track);
            },
    
            _stopChapterTracking() {
                if (this._chapterTrackingRAF) {
                    cancelAnimationFrame(this._chapterTrackingRAF);
                    this._chapterTrackingRAF = null;
                }
                this._lastActiveChapterIdx = -1;
            },
    
            _updateChapterHUD(chapterIdx) {
                if (!appState.settings.cfShowChapterHUD) {
                    this._chapterHUDEl?.remove();
                    this._chapterHUDEl = null;
                    return;
                }
                const player = document.getElementById('movie_player');
                if (!player) return;
    
                if (!this._chapterHUDEl) {
                    this._chapterHUDEl = document.createElement('div');
                    this._chapterHUDEl.className = 'cf-chapter-hud';
                    player.appendChild(this._chapterHUDEl);
                }

                // Apply position
                const pos = appState.settings.cfHudPosition || 'top-left';
                this._chapterHUDEl.setAttribute('data-cf-pos', pos);
    
                if (chapterIdx < 0 || !this._chapterData?.chapters?.[chapterIdx]) {
                    this._chapterHUDEl.style.opacity = '0';
                    return;
                }
    
                const chapters = this._chapterData.chapters;
                const ch = chapters[chapterIdx];
                const color = this._CF_COLORS[chapterIdx % this._CF_COLORS.length];
                const hasPrev = chapterIdx > 0;
                const hasNext = chapterIdx < chapters.length - 1;
                const counter = `${chapterIdx + 1}/${chapters.length}`;
    
                let html = `<button class="cf-hud-nav ${hasPrev ? '' : 'cf-hud-disabled'}" data-cf-nav="prev" title="Previous chapter"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg></button>`;
                html += `<span class="cf-hud-dot" style="background:${color}"></span>`;
                html += `<span class="cf-hud-title">${this._esc(ch.title)}</span>`;
                html += `<span class="cf-hud-counter">${counter}</span>`;
                html += `<button class="cf-hud-nav ${hasNext ? '' : 'cf-hud-disabled'}" data-cf-nav="next" title="Next chapter"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg></button>`;
    
                TrustedHTML.setHTML(this._chapterHUDEl, html);
                this._chapterHUDEl.style.opacity = '1';
                this._chapterHUDEl.style.setProperty('--cf-hud-accent', color);

                // Wire nav buttons
                this._chapterHUDEl.querySelectorAll('.cf-hud-nav').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const dir = btn.dataset.cfNav;
                        const video = document.querySelector('video.html5-main-video');
                        if (!video) return;
                        const targetIdx = dir === 'prev' ? chapterIdx - 1 : chapterIdx + 1;
                        if (targetIdx >= 0 && targetIdx < chapters.length) {
                            video.currentTime = chapters[targetIdx].start + 0.5;
                        }
                    });
                });
            },
    

            // ═══ UI: Panel ═══
            _createPanel() {
                if (this._panelEl) return this._panelEl;
                this._panelEl = document.createElement('div'); this._panelEl.id = 'cf-panel'; this._panelEl.className = 'cf-panel';
                this._panelEl.addEventListener('click', (e) => e.stopPropagation());
                document.body.appendChild(this._panelEl); this._renderPanel(); return this._panelEl;
            },
            _togglePanel() { const p = this._createPanel(); if (p.classList.contains('cf-visible')) { p.classList.remove('cf-visible'); } else { p.classList.add('cf-visible'); this._renderPanel(); } },

            _renderPanel() {
                if (!this._panelEl) return;
                this._lastRenderTime = Date.now();
                const hasData = !!this._chapterData?.chapters?.length;
                const s = appState.settings;
                let tabHTML = '';

                if (this._activeTab === 'chapters') {
                    if (hasData) {
                        tabHTML = `<div class="cf-section-label">Chapters (${this._chapterData.chapters.length})</div><ul class="cf-chapter-list">`;
                        this._chapterData.chapters.forEach((c, i) => {
                            const color = this._CF_COLORS[i % this._CF_COLORS.length];
                            tabHTML += `<li class="cf-chapter-item" data-cf-seek="${c.start}"><span class="cf-chapter-dot" style="background:${color}"></span><span class="cf-chapter-time">${this._formatTime(c.start)}</span><span class="cf-chapter-title">${this._esc(c.title)}</span></li>`;
                        });
                        tabHTML += `</ul>`;
                        if (this._chapterData.pois?.length) {
                            tabHTML += `<div class="cf-section-label">Points of Interest</div><ul class="cf-chapter-list">`;
                            this._chapterData.pois.forEach(p => {
                                tabHTML += `<li class="cf-chapter-item" data-cf-seek="${p.time}"><span class="cf-chapter-dot" style="background:${s.cfPoiColor || '#ff6b6b'}"></span><span class="cf-chapter-time">${this._formatTime(p.time)}</span><span class="cf-chapter-title">${this._esc(p.label)}<span class="cf-poi-badge">POI</span></span></li>`;
                            });
                            tabHTML += `</ul>`;
                        }
                        tabHTML += `<div style="margin-top:8px"><button class="cf-action-btn" id="cf-export-yt">Copy Chapters</button></div>`;
                    } else {
                        tabHTML = `<div class="cf-empty"><svg viewBox="0 0 24 24" style="width:40px;height:40px;fill:rgba(255,255,255,0.08);margin-bottom:12px"><path d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z"/></svg><div>No chapters generated yet</div><div style="margin-top:4px;font-size:11px;color:rgba(255,255,255,0.15)">Click Generate to analyze this video</div></div>`;
                    }
                } else if (this._activeTab === 'analysis') {
                    const preset = this._getAutoSkipPreset();
                    const mode = s.cfAutoSkipMode || 'off';
                    tabHTML = `<div class="cf-section-label">AutoSkip</div>`;
                    tabHTML += `<div class="cf-settings-row"><span class="cf-settings-label">Mode</span><select class="cf-select" id="cf-autoskip-mode"><option value="off" ${mode==='off'?'selected':''}>Off</option><option value="gentle" ${mode==='gentle'?'selected':''}>Gentle — long pauses</option><option value="normal" ${mode==='normal'?'selected':''}>Normal — pauses + fillers</option><option value="aggressive" ${mode==='aggressive'?'selected':''}>Aggressive — all gaps</option></select></div>`;
                    if (preset && !this._lastTranscriptSegments?.length) {
                        tabHTML += `<div class="cf-muted">Generate chapters first to enable AutoSkip.</div>`;
                    } else if (preset) {
                        tabHTML += `<div style="font-size:10px;color:rgba(255,255,255,0.25);margin:2px 0 6px">${this._esc(preset.desc)}${preset.silenceSpeed ? '. Speeds silence to ' + preset.silenceSpeed + 'x' : ''}</div>`;
                        tabHTML += `<button class="cf-action-btn" id="cf-autoskip-toggle" style="margin-bottom:8px">${this._autoSkipActive ? 'Stop AutoSkip' : 'Start AutoSkip'}</button>`;
                        if (this._autoSkipActive && this._autoSkipZones?.length) tabHTML += `<div class="cf-muted" style="font-size:10px">${this._autoSkipZones.length} skip zones active</div>`;
                    }

                    tabHTML += `<div class="cf-section-label">Silence / Pauses</div>`;
                    if (this._pauseData?.length) {
                        const threshold = preset ? preset.pauseThreshold : 1.5;
                        const relevant = this._pauseData.filter(p => p.duration >= threshold);
                        const totalPause = relevant.reduce((sum, p) => sum + p.duration, 0);
                        const dur = this._getVideoDuration() || 1;
                        tabHTML += `<div class="cf-analysis-box"><div class="cf-pace-grid"><div class="cf-analysis-stat"><span class="cf-stat-value">${relevant.length}</span><span class="cf-stat-label">pauses >${threshold}s</span></div><div class="cf-analysis-stat"><span class="cf-stat-value">${Math.round(totalPause)}s</span><span class="cf-stat-label">total silence (${Math.round((totalPause / dur) * 100)}%)</span></div></div></div>`;
                    } else {
                        tabHTML += `<div class="cf-muted">${this._lastTranscriptSegments?.length ? 'No significant pauses detected.' : 'Generate chapters first.'}</div>`;
                    }

                    tabHTML += `<div class="cf-section-label">Filler Words</div>`;
                    if (this._fillerData?.length) {
                        const fillerCounts = {};
                        this._fillerData.forEach(f => { fillerCounts[f.word] = (fillerCounts[f.word] || 0) + 1; });
                        const sorted = Object.entries(fillerCounts).sort((a, b) => b[1] - a[1]);
                        tabHTML += `<div class="cf-analysis-box"><div class="cf-analysis-stat"><span class="cf-stat-value">${this._fillerData.length}</span><span class="cf-stat-label">total fillers</span></div><div class="cf-filler-breakdown">`;
                        sorted.forEach(([word, count]) => {
                            tabHTML += `<div class="cf-filler-row"><span class="cf-filler-word">"${this._esc(word)}"</span><div class="cf-filler-bar-bg"><div class="cf-filler-bar-fill" style="width:${Math.round((count / this._fillerData.length) * 100)}%"></div></div><span class="cf-filler-count">${count}</span></div>`;
                        });
                        tabHTML += `</div></div>`;
                    } else {
                        tabHTML += `<div class="cf-muted">${this._lastTranscriptSegments?.length ? 'No fillers detected.' : 'Generate chapters first.'}</div>`;
                    }

                    tabHTML += `<div class="cf-section-label">Speech Pace</div>`;
                    const paceStats = this._getPaceStats(this._paceData);
                    if (paceStats) {
                        let paceClass = 'cf-pace-normal', paceLabel = 'Normal';
                        if (paceStats.avg > 180) { paceClass = 'cf-pace-fast'; paceLabel = 'Fast'; }
                        else if (paceStats.avg < 120) { paceClass = 'cf-pace-slow'; paceLabel = 'Slow'; }
                        tabHTML += `<div class="cf-analysis-box cf-pace-box"><div class="cf-pace-grid"><div class="cf-analysis-stat ${paceClass}"><span class="cf-stat-value">${paceStats.avg}</span><span class="cf-stat-label">avg WPM (${paceLabel})</span></div><div class="cf-analysis-stat"><span class="cf-stat-value">${paceStats.min}-${paceStats.max}</span><span class="cf-stat-label">range WPM</span></div></div></div>`;
                    } else {
                        tabHTML += `<div class="cf-muted">Generate chapters first.</div>`;
                    }

                    if (this._keywordsPerChapter?.length && this._chapterData?.chapters?.length) {
                        tabHTML += `<div class="cf-section-label">Keywords by Chapter</div><div class="cf-keywords-box">`;
                        this._chapterData.chapters.forEach((ch, i) => {
                            const kws = this._keywordsPerChapter[i];
                            if (kws?.length) tabHTML += `<div class="cf-kw-row"><span class="cf-kw-chapter">${this._esc(ch.title)}</span><span class="cf-kw-tags">${kws.map(k => `<span class="cf-kw-tag">${this._esc(k)}</span>`).join('')}</span></div>`;
                        });
                        tabHTML += `</div>`;
                    }

                } else if (this._activeTab === 'settings') {
                    const skipModes = { 'off': 'Off', 'gentle': 'Gentle (pauses >3s)', 'normal': 'Normal (pauses + fillers)', 'aggressive': 'Aggressive (all gaps)' };
                    const skipOptions = Object.entries(skipModes).map(([k,v]) => `<option value="${k}" ${s.cfAutoSkipMode === k ? 'selected' : ''}>${v}</option>`).join('');
                    const procModes = { 'auto': 'Auto (All Videos)', 'manual': 'Manual (Button Only)' };
                    const procOptions = Object.entries(procModes).map(([k,v]) => `<option value="${k}" ${s.cfMode === k ? 'selected' : ''}>${v}</option>`).join('');
                    const durOptions = [15,30,45,60,90,120,180,9999].map(d => `<option value="${d}" ${(s.cfMaxAutoDuration||9999)==d?'selected':''}>${d >= 9999 ? 'Unlimited' : d + ' min'}</option>`).join('');
                    const hudPositions = { 'top-left': 'Top Left', 'top-right': 'Top Right', 'bottom-left': 'Bottom Left', 'bottom-right': 'Bottom Right' };
                    const hudPosOptions = Object.entries(hudPositions).map(([k,v]) => `<option value="${k}" ${s.cfHudPosition === k ? 'selected' : ''}>${v}</option>`).join('');
                    const _toggle = (key) => `<div class="cf-toggle-track ${s[key] ? 'active' : ''}" id="cf-toggle-${key}"><div class="cf-toggle-knob"></div></div>`;

                    // Build filler word chip grid
                    const enabled = s.cfFillerWordsEnabled || {};
                    const enabledCount = ALL_FILLER_WORDS.filter(w => enabled[w]).length;
                    let fillerChipsHTML = `<div class="cf-section-label" style="display:flex;align-items:center;justify-content:space-between"><span>Filler Words <span style="font-weight:400;color:rgba(255,255,255,0.25);text-transform:none;letter-spacing:0">(${enabledCount} of ${ALL_FILLER_WORDS.length} active)</span></span><span style="display:flex;gap:4px"><button class="cf-chip-action" id="cf-filler-all">All</button><button class="cf-chip-action" id="cf-filler-none">None</button></span></div>`;
                    fillerChipsHTML += `<div style="font-size:10px;color:rgba(255,255,255,0.2);margin:-4px 0 8px">Select which filler words to detect and skip</div>`;
                    for (const [category, words] of Object.entries(FILLER_CATALOG)) {
                        fillerChipsHTML += `<div class="cf-chip-category">${category}</div><div class="cf-chip-grid">`;
                        for (const word of words) {
                            const isOn = !!enabled[word];
                            fillerChipsHTML += `<button class="cf-filler-chip ${isOn ? 'cf-chip-on' : ''}" data-cf-filler="${this._esc(word)}">${this._esc(word)}</button>`;
                        }
                        fillerChipsHTML += `</div>`;
                    }

                    tabHTML = `
                        ${fillerChipsHTML}
                        <div class="cf-section-label">Processing</div>
                        <div class="cf-settings-row"><span class="cf-settings-label">Mode</span><select class="cf-select" id="cf-s-mode">${procOptions}</select></div>
                        <div class="cf-settings-row"><span class="cf-settings-label">Max Auto Duration</span><select class="cf-select" id="cf-s-maxdur">${durOptions}</select></div>
                        <div class="cf-section-label">Playback</div>
                        <div class="cf-settings-row"><span class="cf-settings-label">AutoSkip</span><select class="cf-select" id="cf-s-autoskip">${skipOptions}</select></div>
                        <div class="cf-section-label">Display</div>
                        <div class="cf-settings-row"><span class="cf-settings-label">Chapter HUD</span>${_toggle('cfShowChapterHUD')}</div>
                        <div class="cf-settings-row"><span class="cf-settings-label">HUD Position</span><select class="cf-select" id="cf-s-hudpos">${hudPosOptions}</select></div>
                        <div class="cf-settings-row"><span class="cf-settings-label">Chapters on Bar</span>${_toggle('cfShowChapters')}</div>
                        <div class="cf-settings-row"><span class="cf-settings-label">POI Markers</span>${_toggle('cfShowPOIs')}</div>
                        <div class="cf-settings-row"><span class="cf-settings-label">Filler Markers</span>${_toggle('cfShowFillerMarkers')}</div>
                        <div class="cf-settings-row"><span class="cf-settings-label">Debug Logging</span>${_toggle('cfDebugLog')}</div>
                        <div class="cf-section-label">Cache</div>
                        <div class="cf-settings-row"><span class="cf-settings-label">Cached</span><span style="font-size:12px;color:rgba(255,255,255,0.4)">${this._countCache()} chapters</span></div>
                        <button class="cf-clear-btn" id="cf-clear-cache">Clear All Cache</button>
                    `;
                }

                TrustedHTML.setHTML(this._panelEl, `
                    <div class="cf-panel-header"><div><span class="cf-panel-title">Chapterizer</span><span class="cf-panel-version">v${SCRIPT_VERSION}</span></div><button class="cf-panel-close" id="cf-close">&times;</button></div>
                    <div class="cf-tab-bar"><div class="cf-tab ${this._activeTab === 'chapters' ? 'active' : ''}" data-cf-tab="chapters">Chapters</div><div class="cf-tab ${this._activeTab === 'analysis' ? 'active' : ''}" data-cf-tab="analysis">Analysis</div><div class="cf-tab ${this._activeTab === 'settings' ? 'active' : ''}" data-cf-tab="settings">Settings</div></div>
                    <div class="cf-panel-body">
                        <div style="display:flex;gap:6px;align-items:center;margin-bottom:8px"><button class="cf-generate-btn" id="cf-generate" style="margin-bottom:0;flex:1" ${this._isGenerating ? 'disabled' : ''}>${this._isGenerating ? 'Generating...' : (hasData ? 'Regenerate Chapters' : 'Generate Chapters')}</button></div>
                        <div class="cf-status-bar" id="cf-status-bar" style="display:${this._isGenerating ? 'block' : 'none'}"><div class="cf-status-fill" id="cf-status-fill"></div><span class="cf-status-text" id="cf-status-text"></span></div>
                        ${tabHTML}
                    </div>
                `);

                // ── Event bindings ──
                const self = this;
                this._panelEl.querySelector('#cf-close')?.addEventListener('click', () => self._togglePanel());
                this._panelEl.querySelector('#cf-generate')?.addEventListener('click', () => self._handleGenerate());
                this._panelEl.querySelectorAll('.cf-tab').forEach(tab => {
                    tab.addEventListener('click', (e) => { e.stopPropagation(); self._activeTab = tab.dataset.cfTab; self._renderPanel(); });
                });
                this._panelEl.querySelectorAll('[data-cf-seek]').forEach(el => {
                    el.addEventListener('click', () => self._seekTo(parseFloat(el.dataset.cfSeek)));
                });
                this._panelEl.querySelector('#cf-export-yt')?.addEventListener('click', () => self._exportChaptersYouTube());

                // AutoSkip bindings
                this._panelEl.querySelector('#cf-autoskip-mode')?.addEventListener('change', (e) => {
                    if (self._autoSkipActive) self._stopAutoSkip();
                    appState.settings.cfAutoSkipMode = e.target.value;
                    settingsManager.save(appState.settings);
                    self._renderPanel();
                });
                this._panelEl.querySelector('#cf-autoskip-toggle')?.addEventListener('click', () => {
                    if (self._autoSkipActive) self._stopAutoSkip(); else self._startAutoSkip();
                    self._renderPanel();
                });

                // Settings bindings
                const bindSelect = (id, key, transform) => {
                    this._panelEl.querySelector(id)?.addEventListener('change', (e) => {
                        appState.settings[key] = transform ? transform(e.target.value) : e.target.value;
                        settingsManager.save(appState.settings);
                        self._renderPanel();
                    });
                };

                bindSelect('#cf-s-mode', 'cfMode');
                bindSelect('#cf-s-maxdur', 'cfMaxAutoDuration', v => parseInt(v));
                bindSelect('#cf-s-autoskip', 'cfAutoSkipMode', v => {
                    if (v !== 'off' && self._lastTranscriptSegments?.length) setTimeout(() => self._startAutoSkip(), 100);
                    else self._stopAutoSkip();
                    return v;
                });
                bindSelect('#cf-s-hudpos', 'cfHudPosition');

                // Filler word chip toggles
                this._panelEl.querySelectorAll('.cf-filler-chip').forEach(chip => {
                    chip.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const word = chip.dataset.cfFiller;
                        const enabled = appState.settings.cfFillerWordsEnabled || {};
                        enabled[word] = !enabled[word];
                        appState.settings.cfFillerWordsEnabled = enabled;
                        settingsManager.save(appState.settings);
                        self._renderPanel();
                    });
                });
                this._panelEl.querySelector('#cf-filler-all')?.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const enabled = {};
                    ALL_FILLER_WORDS.forEach(w => enabled[w] = true);
                    appState.settings.cfFillerWordsEnabled = enabled;
                    settingsManager.save(appState.settings);
                    self._renderPanel();
                });
                this._panelEl.querySelector('#cf-filler-none')?.addEventListener('click', (e) => {
                    e.stopPropagation();
                    appState.settings.cfFillerWordsEnabled = {};
                    settingsManager.save(appState.settings);
                    self._renderPanel();
                });

                const _bindToggle = (key) => {
                    this._panelEl.querySelector(`#cf-toggle-${key}`)?.addEventListener('click', () => {
                        appState.settings[key] = !appState.settings[key];
                        settingsManager.save(appState.settings);
                        self._renderPanel();
                        if (key === 'cfShowChapters' || key === 'cfShowPOIs' || key === 'cfShowFillerMarkers') self._renderProgressBarOverlay();
                    });
                };
                _bindToggle('cfShowChapterHUD');
                _bindToggle('cfShowChapters');
                _bindToggle('cfShowPOIs');
                _bindToggle('cfShowFillerMarkers');
                _bindToggle('cfDebugLog');

                this._panelEl.querySelector('#cf-clear-cache')?.addEventListener('click', () => {
                    self._clearCache();
                    self._chapterData = null;
                    self._renderPanel();
                    self._renderProgressBarOverlay();
                });
            },

            _updateStatus(text, state, pct) {
                // Update player button mini-progress
                let indicator = document.getElementById('cf-mini-progress');
                const btn = document.getElementById('cf-player-btn');
                if (!indicator && btn) {
                    indicator = document.createElement('div');
                    indicator.id = 'cf-mini-progress';
                    indicator.style.cssText = 'position:absolute;bottom:-4px;left:0;width:100%;height:3px;border-radius:2px;overflow:hidden;pointer-events:none;';
                    btn.style.position = 'relative';
                    btn.appendChild(indicator);
                }
                if (indicator) {
                    if (state === 'loading') {
                        indicator.style.display = 'block';
                        const fill = typeof pct === 'number' ? pct : 30;
                        TrustedHTML.setHTML(indicator, `<div style="width:${fill}%;height:100%;background:#a78bfa;border-radius:2px;transition:width 0.4s"></div>`);
                        btn?.classList.add('cf-btn-active');
                    } else {
                        indicator.style.display = 'none';
                        btn?.classList.remove('cf-btn-active');
                    }
                }
                // Update panel status bar
                const statusBar = document.getElementById('cf-status-bar');
                const statusFill = document.getElementById('cf-status-fill');
                const statusText = document.getElementById('cf-status-text');
                if (statusBar) {
                    statusBar.style.display = state === 'loading' ? 'block' : 'none';
                }
                if (statusFill && typeof pct === 'number') {
                    statusFill.style.width = `${pct}%`;
                }
                if (statusText) statusText.textContent = text || '';
                // Update generate button with progress %
                const genBtn = document.getElementById('cf-generate');
                if (genBtn && state === 'loading' && typeof pct === 'number') {
                    genBtn.textContent = `Generating... ${pct}%`;
                }
            },
    
            async _handleGenerate() {
                const videoId = this._getVideoId();
                if (!videoId) return;
                const btn = document.getElementById('cf-generate');
                if (btn) { btn.disabled = true; btn.textContent = 'Generating... 0%'; btn.classList.add('cf-loading'); }
                const statusBar = document.getElementById('cf-status-bar');
                if (statusBar) statusBar.style.display = 'block';
                const data = await this._generateChapters(videoId, (t, s, p) => this._updateStatus(t, s, p));
                if (data) {
                    this._chapterData = data;
                    this._currentDuration = this._getVideoDuration();
                    this._runAnalysis(this._lastTranscriptSegments);
                    // Auto-start AutoSkip if a mode is configured
                    if (appState.settings.cfAutoSkipMode && appState.settings.cfAutoSkipMode !== 'off') {
                        this._startAutoSkip();
                    }
                    this._activeTab = 'chapters'; // auto-switch to show results
                    this._renderPanel();
                    this._renderProgressBarOverlay();
                }
                this._updateStatus(data ? 'Done' : 'Failed', data ? 'ready' : 'error', data ? 100 : 0);
                if (btn) { btn.disabled = false; btn.textContent = data ? 'Regenerate Chapters' : 'Generate Chapters'; btn.classList.remove('cf-loading'); }
            },
            // ═══ UI: Player Button ═══
            _injectPlayerButton() {
                if (document.getElementById('cf-player-btn')) return;
                const controls = document.querySelector('.ytp-right-controls');
                if (!controls) return;
                const btn = document.createElement('button');
                btn.id = 'cf-player-btn'; btn.className = 'ytp-button cf-btn'; btn.title = 'Chapterizer';
                TrustedHTML.setHTML(btn, `<svg viewBox="0 0 24 24" style="width:20px;height:20px;fill:currentColor"><path d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z"/></svg>`);
                btn.addEventListener('click', () => this._togglePanel());
                controls.insertBefore(btn, controls.firstChild);
            },

            // ═══ LIFECYCLE ═══
            _onVideoChange() {
                const videoId = this._getVideoId();
                if (!videoId || videoId === this._currentVideoId) return;
                if (!window.location.pathname.startsWith('/watch')) return;
                this._currentVideoId = videoId;
                this._chapterData = null;
                this._lastTranscriptSegments = null;
                this._lastActiveChapterIdx = -1;
                this._fillerData = null;
                this._pauseData = null;
                this._paceData = null;
                this._keywordsPerChapter = null;
                this._stopAutoSkip();
                this._stopChapterTracking();
                this._chapterHUDEl?.remove();
                this._chapterHUDEl = null;
                const cached = this._getCachedData(videoId);
                if (cached) this._chapterData = cached;

                this._waitForPlayer().then(() => {
                    this._currentDuration = this._getVideoDuration();
                    const s = appState.settings;
                    if (s.cfMode === 'manual' || s.cfShowPlayerButton) this._injectPlayerButton();
                    this._renderProgressBarOverlay();
                    if (this._panelEl?.classList.contains('cf-visible')) this._renderPanel();

                    const btn = document.getElementById('cf-player-btn');
                    if (btn) {
                        const badge = btn.querySelector('.cf-badge');
                        if (this._chapterData && !badge) { const b = document.createElement('span'); b.className = 'cf-badge'; btn.appendChild(b); }
                        else if (!this._chapterData && badge) badge.remove();
                    }

                    if (s.cfMode === 'auto' && !this._chapterData) {
                        const maxDur = (s.cfMaxAutoDuration || 9999) * 60;
                        if (this._currentDuration <= maxDur || maxDur >= 599940) this._handleGenerate();
                    }

                    // Re-fetch transcript for cached videos to enable analysis/autoskip
                    if (this._chapterData && !this._fillerData) {
                        this._fetchTranscript(videoId, null).then(segments => {
                            if (segments?.length) {
                                this._lastTranscriptSegments = segments;
                                this._runAnalysis(segments);
                                if (s.cfAutoSkipMode && s.cfAutoSkipMode !== 'off') this._startAutoSkip();
                            }
                        });
                    }
                });
            },

            _waitForPlayer(timeout = 10000) {
                return new Promise((resolve) => {
                    const check = () => {
                        const player = document.getElementById('movie_player');
                        const video = document.querySelector('video.html5-main-video');
                        if (player && video && video.duration) return resolve();
                        if (timeout <= 0) return resolve();
                        timeout -= 200;
                        setTimeout(check, 200);
                    };
                    check();
                });
            },

            // ═══ INIT / DESTROY ═══

            init() {
                const css = `
                    .cf-btn { position:relative;display:flex;align-items:center;justify-content:center;width:36px;height:36px;border:none;background:transparent;cursor:pointer;border-radius:6px;transition:background 0.2s;color:#fff; }
                    .cf-btn:hover { background:rgba(255,255,255,0.1); }
                    .cf-btn .cf-badge { position:absolute;top:2px;right:2px;width:8px;height:8px;border-radius:50%;background:#7c3aed; }
                    .cf-panel { position:fixed;top:80px;right:20px;width:380px;max-height:calc(100vh - 120px);background:#0f0f14;border:1px solid rgba(124,58,237,0.3);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,0.7),0 0 40px rgba(124,58,237,0.08);z-index:99999;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#e0e0e8;overflow:hidden;display:none;animation:cfSlideIn 0.25s cubic-bezier(0.16,1,0.3,1); }
                    .cf-panel.cf-visible { display:flex;flex-direction:column; }
                    .cf-panel-header { display:flex;align-items:center;justify-content:space-between;padding:14px 16px 12px;border-bottom:1px solid rgba(255,255,255,0.06);background:linear-gradient(180deg,rgba(124,58,237,0.08) 0%,transparent 100%); }
                    .cf-panel-title { font-size:14px;font-weight:700;background:linear-gradient(135deg,#a78bfa,#7c3aed);-webkit-background-clip:text;-webkit-text-fill-color:transparent;letter-spacing:0.5px; }
                    .cf-panel-version { font-size:10px;color:rgba(255,255,255,0.25);margin-left:8px; }
                    .cf-panel-close { width:28px;height:28px;border:none;background:transparent;color:rgba(255,255,255,0.4);cursor:pointer;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:16px;transition:all 0.15s; }
                    .cf-panel-close:hover { background:rgba(255,255,255,0.08);color:#fff; }
                    .cf-panel-body { flex:1;overflow-y:auto;padding:12px 16px 16px;scrollbar-width:thin;scrollbar-color:rgba(124,58,237,0.3) transparent; }
                    .cf-panel-body::-webkit-scrollbar { width:5px; } .cf-panel-body::-webkit-scrollbar-thumb { background:rgba(124,58,237,0.3);border-radius:10px; }
                    @keyframes cfPulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
                    .cf-generate-btn { width:100%;padding:10px;border:none;border-radius:10px;cursor:pointer;font-size:13px;font-weight:600;background:linear-gradient(135deg,#7c3aed,#6d28d9);color:#fff;transition:all 0.2s;margin-bottom:12px; }
                    .cf-generate-btn:hover:not(:disabled) { background:linear-gradient(135deg,#8b5cf6,#7c3aed);box-shadow:0 4px 16px rgba(124,58,237,0.3); } .cf-generate-btn:disabled { opacity:0.4;cursor:not-allowed; }
                    .cf-action-btn { flex:1;padding:7px 8px;border:1px solid rgba(124,58,237,0.25);border-radius:8px;cursor:pointer;font-size:11px;font-weight:500;background:rgba(124,58,237,0.08);color:rgba(255,255,255,0.6);transition:all 0.15s;font-family:inherit;position:relative;overflow:hidden; } .cf-action-btn:hover { background:rgba(124,58,237,0.15);color:#e0e0e8;border-color:rgba(124,58,237,0.4); } .cf-action-btn:disabled { opacity:0.5;cursor:not-allowed; }
                    .cf-chapter-list { list-style:none;padding:0;margin:0; }
                    .cf-chapter-item { display:flex;align-items:flex-start;gap:10px;padding:8px 10px;border-radius:8px;cursor:pointer;transition:background 0.15s;margin-bottom:2px; } .cf-chapter-item:hover { background:rgba(255,255,255,0.05); }
                    .cf-chapter-time { font-size:11px;font-weight:600;font-family:'SF Mono','Cascadia Code',monospace;color:#a78bfa;min-width:48px;padding-top:1px;flex-shrink:0; }
                    .cf-chapter-title { font-size:12.5px;color:rgba(255,255,255,0.8);line-height:1.4; }
                    .cf-chapter-dot { width:6px;height:6px;border-radius:50%;margin-top:5px;flex-shrink:0; }
                    .cf-poi-badge { display:inline-block;font-size:9px;font-weight:700;color:#ff6b6b;background:rgba(255,107,107,0.1);padding:1px 5px;border-radius:4px;margin-left:6px;vertical-align:middle;letter-spacing:0.5px; }
                    .cf-section-label { font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.2px;color:rgba(255,255,255,0.2);margin:14px 0 8px;padding-left:2px; } .cf-section-label:first-child { margin-top:0; }
                    .cf-settings-row { display:flex;align-items:center;justify-content:space-between;padding:8px 0;font-size:12px; }
                    .cf-settings-label { color:rgba(255,255,255,0.6); }
                    .cf-select { background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.08);color:#e0e0e8;border-radius:6px;padding:5px 8px;font-size:11px;outline:none;cursor:pointer;max-width:180px; } .cf-select:focus { border-color:rgba(124,58,237,0.5); }
                    .cf-input { background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.08);color:#e0e0e8;border-radius:6px;padding:5px 8px;font-size:11px;outline:none;max-width:180px;width:180px;font-family:inherit; } .cf-input:focus { border-color:rgba(124,58,237,0.5); } .cf-input::placeholder { color:rgba(255,255,255,0.2); }
                    .cf-toggle-track { width:36px;height:20px;border-radius:10px;background:rgba(255,255,255,0.1);cursor:pointer;position:relative;transition:background 0.2s;flex-shrink:0; } .cf-toggle-track.active { background:#7c3aed; }
                    .cf-toggle-knob { width:16px;height:16px;border-radius:50%;background:#fff;position:absolute;top:2px;left:2px;transition:transform 0.2s; } .cf-toggle-track.active .cf-toggle-knob { transform:translateX(16px); }
                    .cf-tab-bar { display:flex;gap:0;padding:0 16px;border-bottom:1px solid rgba(255,255,255,0.06); }
                    .cf-tab { padding:8px 10px;font-size:10px;font-weight:600;color:rgba(255,255,255,0.35);cursor:pointer;border-bottom:2px solid transparent;transition:all 0.15s;text-transform:uppercase;letter-spacing:0.5px;flex:1;text-align:center; } .cf-tab:hover { color:rgba(255,255,255,0.6); } .cf-tab.active { color:#a78bfa;border-bottom-color:#7c3aed; }
                    .cf-empty { text-align:center;padding:30px 20px;color:rgba(255,255,255,0.25);font-size:12px; }
                    .cf-clear-btn { background:transparent;border:1px solid rgba(239,68,68,0.3);color:rgba(239,68,68,0.7);border-radius:8px;padding:6px 12px;font-size:11px;cursor:pointer;transition:all 0.15s;margin-top:8px; } .cf-clear-btn:hover { background:rgba(239,68,68,0.1);color:#ef4444;border-color:rgba(239,68,68,0.5); }

                    /* Filler word chip grid */
                    .cf-chip-category { font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;color:rgba(255,255,255,0.15);margin:8px 0 4px;padding-left:1px; } .cf-chip-category:first-of-type { margin-top:4px; }
                    .cf-chip-grid { display:flex;flex-wrap:wrap;gap:5px;margin-bottom:4px; }
                    .cf-filler-chip { display:inline-flex;align-items:center;padding:4px 10px;border-radius:14px;font-size:11px;font-weight:500;font-family:inherit;cursor:pointer;transition:all 0.15s;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.03);color:rgba(255,255,255,0.35); }
                    .cf-filler-chip:hover { border-color:rgba(249,115,22,0.3);color:rgba(255,255,255,0.6);background:rgba(249,115,22,0.05); }
                    .cf-filler-chip.cf-chip-on { background:rgba(249,115,22,0.15);border-color:rgba(249,115,22,0.4);color:#fb923c;font-weight:600; }
                    .cf-filler-chip.cf-chip-on:hover { background:rgba(249,115,22,0.25);border-color:rgba(249,115,22,0.6); }
                    .cf-chip-action { font-size:9px;font-weight:600;padding:2px 8px;border-radius:4px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.04);color:rgba(255,255,255,0.3);cursor:pointer;transition:all 0.15s;font-family:inherit;text-transform:none;letter-spacing:0; }
                    .cf-chip-action:hover { background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.6);border-color:rgba(255,255,255,0.2); }
    
                    /* ═══ PROGRESS BAR: Chapter segments (FIXED z-index layering) ═══ */
                    .cf-bar-overlay { position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:25; }
                    .cf-chapter-markers { position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:24; }
                    .cf-chapter-seg { position:absolute;top:0;height:100%;pointer-events:auto;cursor:pointer;transition:opacity 0.15s; }
                    .cf-chapter-seg::before { content:'';position:absolute;top:0;left:0;right:0;bottom:0;background:var(--cf-seg-color);opacity:var(--cf-seg-opacity,0.35);transition:opacity 0.15s;border-radius:1px; }
                    .cf-chapter-seg:hover::before { opacity:0.55; }
                    .cf-chapter-seg.cf-seg-active::before { opacity:0.5; }
                    .cf-chapter-gap { position:absolute;top:-1px;bottom:-1px;width:3px;transform:translateX(-50%);background:#0f0f14;z-index:1;pointer-events:none;border-radius:1px; }
    
                    /* Chapter name labels — absolutely positioned above progress bar, zero layout impact */
                    .cf-chapter-label-row { position:absolute;bottom:100%;left:0;width:100%;height:0;pointer-events:none;z-index:25;opacity:0;transition:opacity 0.2s; }
                    .ytp-progress-bar:hover .cf-chapter-label-row,
                    .ytp-progress-bar-container:hover .cf-chapter-label-row { opacity:1; }
                    .cf-chapter-label { position:absolute;bottom:4px;height:14px;display:flex;align-items:center;padding:0 3px;font-size:9px;font-weight:600;color:var(--cf-label-fg, #e0e0e8);background:color-mix(in srgb, var(--cf-label-color, #7c3aed) 25%, #0f0f14 75%);border-radius:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;pointer-events:auto;transition:all 0.15s;letter-spacing:0.2px;border:1px solid color-mix(in srgb, var(--cf-label-color, #7c3aed) 20%, transparent);box-sizing:border-box;line-height:1; }
                    .cf-chapter-label:hover { background:color-mix(in srgb, var(--cf-label-color, #7c3aed) 40%, #0f0f14 60%);z-index:2; }
                    .cf-chapter-label.cf-label-active { background:color-mix(in srgb, var(--cf-label-color, #7c3aed) 45%, #0f0f14 55%);border-color:color-mix(in srgb, var(--cf-label-color, #7c3aed) 50%, transparent); }
    
                    /* POI markers */
                    .cf-poi-hitbox { position:absolute;top:50%;width:34px;height:34px;transform:translate(-50%,-50%);pointer-events:auto;cursor:pointer;z-index:26; }
                    .cf-poi-diamond { position:absolute;top:50%;left:50%;width:10px;height:10px;transform:translate(-50%,-50%) rotate(45deg);border-radius:2px;transition:all 0.2s;box-shadow:0 0 6px rgba(255,107,107,0.4);pointer-events:none; }
                    .cf-poi-hover { transform:translate(-50%,-50%) rotate(45deg) scale(1.6);box-shadow:0 0 12px rgba(255,107,107,0.7),0 0 24px rgba(255,107,107,0.3); }
    
                    /* Tooltips — positioned well above the bar to avoid YouTube overlap */
                    .cf-bar-tooltip { position:absolute;bottom:28px;left:50%;transform:translateX(-50%);padding:6px 12px;border-radius:8px;font-size:11px;white-space:nowrap;pointer-events:none;z-index:50;opacity:0;transition:opacity 0.15s; }
                    .cf-chapter-tip { background:rgba(15,15,20,0.95);color:#e0e0e8;border:1px solid rgba(124,58,237,0.25);box-shadow:0 4px 16px rgba(0,0,0,0.5);display:flex;gap:8px;align-items:center;backdrop-filter:blur(8px); }
                    .cf-tip-time { font-weight:700;color:#a78bfa;font-size:10px;font-variant-numeric:tabular-nums; }
                    .cf-tip-title { color:#e0e0e8;font-weight:500; }
    
                    .cf-tip-poi-icon { font-size:12px;color:#ff6b6b;filter:drop-shadow(0 0 3px rgba(255,107,107,0.6)); }
                    .cf-tip-label { color:#fca5a5;font-weight:500; }
                    .cf-poi-hitbox .cf-bar-tooltip { bottom:30px; }
    
                    /* Transcript hover preview */
                    .cf-transcript-tip { position:absolute;bottom:38px;background:rgba(10,10,15,0.95);color:rgba(255,255,255,0.8);padding:8px 12px;border-radius:8px;font-size:11px;width:300px;white-space:normal;word-wrap:break-word;pointer-events:none;z-index:30;opacity:0;transition:opacity 0.12s;border:1px solid rgba(124,58,237,0.15);box-shadow:0 4px 16px rgba(0,0,0,0.5);line-height:1.5;backdrop-filter:blur(8px); }
                    .cf-tx-chapter { font-size:10px;font-weight:700;color:#a78bfa;margin-bottom:4px;padding-bottom:4px;border-bottom:1px solid rgba(124,58,237,0.15);text-transform:uppercase;letter-spacing:0.5px; }
                    .cf-tx-line { font-size:11px;color:rgba(255,255,255,0.85);line-height:1.5;margin:2px 0; }
                    .cf-tx-dim { color:rgba(255,255,255,0.3);font-size:10px; }
                    .cf-tx-ts { font-family:'SF Mono','Cascadia Code',monospace;font-size:9px;color:#a78bfa;opacity:0.6;margin-right:4px; }
    
                    /* ═══ CHAPTER HUD — Floating overlay on video player ═══ */
                    .cf-chapter-hud { position:absolute;display:flex;align-items:center;gap:6px;padding:5px 8px 5px 6px;background:rgba(10,10,15,0.82);border-radius:10px;border:1px solid color-mix(in srgb, var(--cf-hud-accent, #7c3aed) 25%, transparent);backdrop-filter:blur(16px);z-index:60;pointer-events:auto;opacity:0;transition:opacity 0.3s, transform 0.2s;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;box-shadow:0 4px 20px rgba(0,0,0,0.5);max-width:70%; }
                    .cf-chapter-hud[data-cf-pos="top-left"] { top:12px;left:12px; }
                    .cf-chapter-hud[data-cf-pos="top-right"] { top:12px;right:12px; }
                    .cf-chapter-hud[data-cf-pos="bottom-left"] { bottom:60px;left:12px; }
                    .cf-chapter-hud[data-cf-pos="bottom-right"] { bottom:60px;right:12px; }
                    .cf-chapter-hud[style*="opacity: 1"] { opacity:1; }
                    .cf-hud-dot { width:8px;height:8px;border-radius:50%;flex-shrink:0;box-shadow:0 0 6px color-mix(in srgb, var(--cf-hud-accent, #7c3aed) 50%, transparent); }
                    .cf-hud-title { font-size:12px;font-weight:600;color:#e0e0e8;letter-spacing:0.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
                    .cf-hud-counter { font-size:9px;color:rgba(255,255,255,0.25);font-weight:600;flex-shrink:0;letter-spacing:0.5px; }
                    .cf-hud-nav { width:24px;height:24px;border:none;background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.5);cursor:pointer;border-radius:6px;display:flex;align-items:center;justify-content:center;transition:all 0.15s;padding:0;flex-shrink:0; }
                    .cf-hud-nav:hover { background:rgba(255,255,255,0.14);color:#fff; }
                    .cf-hud-nav.cf-hud-disabled { opacity:0.2;pointer-events:none; }
                    /* Hide HUD when controls are hidden (fullscreen idle) */
                    .ytp-autohide .cf-chapter-hud { opacity:0 !important; }
    
                    .cf-btn-active { animation:cfBtnPulse 1.5s infinite; }
                    @keyframes cfBtnPulse { 0%,100%{opacity:1} 50%{opacity:0.5} }
    

                    /* OpenCut-inspired: Filler markers */
                    .cf-filler-markers { position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none;z-index:52; }
                    .cf-filler-marker { position:absolute;top:-2px;width:3px;height:calc(100% + 4px);background:#f97316;border-radius:1px;opacity:0.7;pointer-events:auto;cursor:pointer;transition:opacity .15s,transform .15s; }
                    .cf-filler-marker:hover { opacity:1;transform:scaleX(2); }
                    .cf-filler-tip { white-space:nowrap;font-size:10px;background:rgba(249,115,22,0.95);color:#fff;border:none; }

                    /* OpenCut-inspired: Analysis boxes */
                    .cf-analysis-box { background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:8px;padding:10px;margin-bottom:8px; }
                    .cf-analysis-stat { display:inline-flex;flex-direction:column;align-items:center;padding:6px 12px;min-width:70px; }
                    .cf-stat-value { font-size:20px;font-weight:700;color:#e2e8f0;line-height:1.2; }
                    .cf-stat-label { font-size:9px;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:0.5px;margin-top:2px; }
                    .cf-filler-breakdown { margin-top:8px; }
                    .cf-filler-row { display:flex;align-items:center;gap:6px;padding:3px 0;font-size:11px; }
                    .cf-filler-word { color:#f97316;font-weight:600;min-width:70px;font-family:monospace; }
                    .cf-filler-bar-bg { flex:1;height:6px;background:rgba(255,255,255,0.06);border-radius:3px;overflow:hidden; }
                    .cf-filler-bar-fill { height:100%;background:linear-gradient(90deg,#f97316,#fb923c);border-radius:3px;transition:width .3s; }
                    .cf-filler-count { color:rgba(255,255,255,0.5);min-width:20px;text-align:right; }
                    .cf-muted { font-size:11px;color:rgba(255,255,255,0.3);padding:4px 0; }

                    /* OpenCut-inspired: Speech pace */
                    .cf-pace-box { padding:8px 10px; }
                    .cf-pace-grid { display:flex;gap:12px;justify-content:center; }
                    .cf-pace-normal .cf-stat-value { color:#10b981; }
                    .cf-pace-fast .cf-stat-value { color:#f97316; }
                    .cf-pace-slow .cf-stat-value { color:#60a5fa; }
                    .cf-pace-detail { font-size:10px;color:rgba(255,255,255,0.35);text-align:center;margin-top:6px; }

                    /* OpenCut-inspired: Keywords */
                    .cf-keywords-box { margin-bottom:8px; }
                    .cf-kw-row { display:flex;align-items:baseline;gap:6px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.04); }
                    .cf-kw-row:last-child { border-bottom:none; }
                    .cf-kw-chapter { font-size:10px;color:rgba(255,255,255,0.5);min-width:80px;max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
                    .cf-kw-tags { display:flex;flex-wrap:wrap;gap:3px; }
                    .cf-kw-tag { display:inline-block;font-size:9px;padding:1px 6px;border-radius:3px;background:rgba(139,92,246,0.12);color:#a78bfa;border:1px solid rgba(139,92,246,0.15); }

                    /* Status bar (in-panel progress) */
                    .cf-status-bar { position:relative;height:22px;background:rgba(255,255,255,0.04);border-radius:6px;overflow:hidden;margin:-6px 0 10px; }
                    .cf-status-fill { position:absolute;top:0;left:0;height:100%;background:linear-gradient(90deg,rgba(124,58,237,0.3),rgba(124,58,237,0.5));border-radius:6px;transition:width 0.4s ease; }
                    .cf-status-text { position:relative;z-index:1;display:block;font-size:10px;color:rgba(255,255,255,0.5);text-align:center;line-height:22px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 8px; }

                `;
                this._styleElement = document.createElement('style');
                this._styleElement.id = 'chapterizer-styles';
                this._styleElement.textContent = css;
                document.head.appendChild(this._styleElement);

                this._navHandler = () => {
                    this._onVideoChange();
                    if (!window.location.pathname.startsWith('/watch')) {
                        this._stopChapterTracking();
                        this._chapterHUDEl?.remove();
                        this._chapterHUDEl = null;
                    }
                };
                document.addEventListener('yt-navigate-finish', this._navHandler);

                this._clickHandler = (e) => {
                    if (!this._panelEl?.classList.contains('cf-visible')) return;
                    if (Date.now() - (this._lastRenderTime || 0) < 300) return;
                    if (this._panelEl.contains(e.target)) return;
                    if (e.target.closest('#cf-panel')) return;
                    const rect = this._panelEl.getBoundingClientRect();
                    if (rect.width > 0 && e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) return;
                    if (e.target.closest('#cf-player-btn')) return;
                    this._panelEl.classList.remove('cf-visible');
                };
                document.addEventListener('click', this._clickHandler);

                this._resizeObserver = new ResizeObserver(() => { if (this._chapterData) this._renderProgressBarOverlay(); });
                this._barObsHandler = () => {
                    setTimeout(() => {
                        const bar = document.querySelector('.ytp-progress-bar');
                        if (bar) this._resizeObserver.observe(bar);
                    }, 500);
                };
                document.addEventListener('yt-navigate-finish', this._barObsHandler);
                setTimeout(this._barObsHandler, 2000);

                if (window.location.pathname.startsWith('/watch')) setTimeout(() => this._onVideoChange(), 500);
                if (appState.settings?.cfDebugLog) console.log('[Chapterizer] v' + SCRIPT_VERSION + ' initialized');
            },

            destroy() {
                this._stopChapterTracking();
                this._stopAutoSkip();
                this._chapterHUDEl?.remove(); this._chapterHUDEl = null;
                if (this._navHandler) document.removeEventListener('yt-navigate-finish', this._navHandler);
                if (this._clickHandler) document.removeEventListener('click', this._clickHandler);
                if (this._barObsHandler) document.removeEventListener('yt-navigate-finish', this._barObsHandler);
                if (this._resizeObserver) this._resizeObserver.disconnect();
                this._styleElement?.remove();
                this._panelEl?.remove(); this._panelEl = null;
                document.getElementById('cf-player-btn')?.remove();
                document.querySelectorAll('.cf-bar-overlay,.cf-chapter-markers,.cf-chapter-label-row,.cf-filler-markers').forEach(el => el.remove());
            }

    };

    // ══════════════════════════════════════════════════════════════
    //  BOOTSTRAP
    // ══════════════════════════════════════════════════════════════

    function bootstrap() {
        if (!appState.settings.chapterForge) return;
        try {
            Chapterizer.init();
            if (appState.settings?.cfDebugLog) console.log('[Chapterizer] Standalone v' + SCRIPT_VERSION + ' initialized');
        } catch(e) {
            console.error('[Chapterizer] Init failed:', e);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(bootstrap, 500));
    } else {
        setTimeout(bootstrap, 500);
    }

})();
