# Research — Chapterizer

## Executive Summary

Chapterizer is a polished YouTube userscript (v3.0.0, ~2600 lines) that auto-generates video chapters via browser-local NLP (TF-IDF + cosine similarity), detects filler words with word-level timing, and provides auto-skip functionality with three aggression presets. Its strongest differentiator is zero external dependencies — no APIs, no servers, no accounts. The UI is premium-grade with a chapter HUD, progress bar overlay, transcript hover preview, and an analysis dashboard.

The highest-value opportunities in priority order:

1. **Fix missing method definitions** — `_gmGet`, `_gmPostJson`, `_buildSapisidAuth` are called but never defined, breaking transcript fallback methods 4-6
2. **Add `.gitignore`** — repo ships none; standard JS/userscript ignores missing
3. **Web Worker offloading** — NLP computation (TF-IDF, TextRank, cosine similarity) blocks the main thread; long transcripts can cause jank
4. **Multi-language support** — stopword list and filler catalog are English-only; YouTube serves transcripts in 100+ languages
5. **Web Audio API silence detection** — complement transcript-gap-based pause detection with actual audio volume analysis for accuracy
6. **IndexedDB caching** — localStorage has a ~5-10MB quota and no structured queries; IndexedDB scales better for heavy users
7. **Merge duplicate RAF loops** — chapter tracking and auto-skip each run a separate `requestAnimationFrame` loop; merging saves CPU
8. **SponsorBlock data integration** — leverage existing crowdsourced segment data to improve chapter placement
9. **Chapter quality improvements** — adaptive window sizing, better title generation, handling of very long (2h+) videos
10. **YouTube Music parity** — `@match` includes `music.youtube.com` but UI/UX is untested there

## Product Map

- **Core workflows:** Transcript extraction (7-method failover) → NLP chapter generation → Progress bar overlay + HUD → Filler detection → AutoSkip
- **User personas:** YouTube power users who want structured navigation; content creators analyzing their own videos (filler counts, pace stats, chapter export); accessibility-conscious users who skip dead air
- **Platforms:** Chrome/Edge/Firefox/Brave/Opera via Tampermonkey/Violentmonkey/Greasemonkey userscript managers; works on `youtube.com` and `music.youtube.com`
- **Key integrations:** YouTube Innertube API (transcript extraction), YouTube DOM/Polymer (player integration), `GM_*` APIs (settings persistence, cross-origin requests), `localStorage` (chapter cache)

## Competitive Landscape

### SponsorBlock (browser extension, 10M+ users)
- **Does well:** Crowdsourced skip segments with massive community; fine-grained categories (sponsor, intro, outro, self-promo); chapters submitted by users are high quality
- **Learn from it:** Community-driven data model; integration API that other tools can consume; segment voting/reporting for quality
- **Avoid:** Requiring server infrastructure; the complexity of running a crowdsource platform

### Enhancer for YouTube / ImprovedTube (browser extensions, 1M+ users)
- **Does well:** Comprehensive YouTube UI customization; speed controls, cinema mode, auto-quality; massive user base validates the "YouTube enhancer" market
- **Learn from it:** Feature discoverability through contextual UI; settings sync across devices
- **Avoid:** Feature bloat; these extensions do everything poorly rather than one thing well

### Descript (commercial, $24/mo+)
- **Does well:** Audio-based filler word removal with actual waveform analysis; AI-powered chapter/summary generation; studio-grade editing
- **Learn from it:** Filler word detection accuracy from audio signals (not just transcript text); the value users place on filler removal (willingness to pay $24/mo)
- **Avoid:** Server-side AI dependency; subscription model

### Gling / TimeBolt / Recut (commercial silence removers)
- **Does well:** Audio waveform-based silence detection; frame-accurate cut points; batch processing; export to NLE timelines
- **Learn from it:** Silence detection thresholds and UX patterns; the "aggressive/gentle" preset paradigm (which Chapterizer already has)
- **Avoid:** Desktop-only limitation; requiring video file access

### YouTube Studio Auto-Chapters
- **Does well:** Server-side ML on full audio+video signal; officially integrated into YouTube; no user action required
- **Learn from it:** Google's approach validates that auto-chapter generation is a real user need; their minimum video length requirements (chapter content must be >= 10 seconds)
- **Avoid:** Dependence on Google's infrastructure; auto-chapters are only available on some videos

### youtube-transcript-api (Python library, 3K+ stars)
- **Does well:** Clean API for transcript extraction with language selection; handles auto-generated and manual captions; good error handling
- **Learn from it:** Language fallback chain logic; transcript format handling; error classification
- **Avoid:** Python-only; server-side

### AutoCut (desktop tool for video silence removal)
- **Does well:** Whisper-based transcript + audio analysis; generates edit decision lists; fast batch processing
- **Learn from it:** Combining transcript and audio signals for higher accuracy filler/silence detection
- **Avoid:** Heavy ML model dependency (Whisper); desktop-only

## Security, Privacy, and Reliability

### Bugs Found
- **CRITICAL: Missing method definitions** (`Chapterizer.user.js`): `_gmGet()`, `_gmPostJson()`, and `_buildSapisidAuth()` are called in fallback transcript methods 4-6 (lines 753, 812-813, 876, 881, 955-956) but are never defined anywhere in the source. These fallback paths will throw `TypeError` and always fail. Methods 1-3 via `TranscriptService` still work, but the fallback chain is broken.
- **Missing `.gitignore`**: No `.gitignore` in the repo. Should exclude `node_modules/`, etc.

### Missing Guardrails
- **No rate limiting on transcript API calls**: Rapid SPA navigation could trigger many concurrent Innertube API requests. No debounce or abort controller on `_fetchTranscript`.
- **No error boundary around `_onVideoChange`**: If the generation throws unexpectedly, there's no top-level catch that prevents the script from becoming non-functional for subsequent navigations.
- **localStorage quota not handled gracefully**: `_setCachedData` catches quota errors and evicts 5 oldest entries, but doesn't inform the user; could silently lose data.
- **No content validation on cached data**: `_getCachedData` deserializes localStorage JSON without schema validation; corrupt or stale-format data could cause runtime errors.

### Recovery and Rollback
- No "undo" for auto-skip (if user didn't want to skip, content is already past). Consider a brief toast with an "undo seek" action.
- No export/import for settings — if localStorage is cleared, all settings and cached chapters are lost.
- No way to report a "bad chapter split" to improve the algorithm.

## Architecture Assessment

### Module Boundaries
- **Single-file monolith**: 2607 lines in one IIFE. Acceptable for a userscript but makes testing impossible. Consider splitting into logical modules (transcript service, NLP engine, UI, settings) that get bundled at build time.
- **Two parallel objects**: `TranscriptService` and `Chapterizer` both handle transcript fetching with overlapping logic. `Chapterizer._fetchTranscript` calls `TranscriptService._getCaptionTracks` as method 1, then has its own fallback methods 2-7. This creates confusion about which extraction pipeline is canonical.

### Refactor Candidates
- **Dual RAF loops** (`Chapterizer.user.js` lines 1908-1934 and 1624-1669): Chapter tracking and auto-skip each run their own `requestAnimationFrame` loop. These could be merged into a single tick function.
- **`_renderPanel()` full re-render** (lines 2011-2237): Every settings change triggers a complete HTML rebuild of the panel via `TrustedHTML.setHTML`. Incremental DOM updates would reduce flicker and improve performance.
- **NLP stopword set** (line 1081): A large `Set` literal inline in the object. Should be a module-level constant to avoid re-creation.
- **`_detectFillers` regex re-creation** (lines 1436-1454): `_getFillerSets()` creates new `RegExp` objects on every call. Could be memoized against the current settings.

### Test and Documentation Gaps
- **Zero tests**: No test infrastructure at all. The NLP engine (TF-IDF, cosine similarity, TextRank) is deterministic and testable; extracting it into a testable module would catch regressions.
- **No CHANGELOG**: Version history not tracked.
- **No CONTRIBUTING.md**: README mentions "Issues and PRs welcome" but no guidance on how to contribute.

## Rejected Ideas

| Idea | Reason | Source |
|------|--------|--------|
| Server-side AI for chapter generation | Contradicts core philosophy of zero external dependencies and local processing | Descript, Opus Clip |
| Crowdsourced chapter database | Requires server infrastructure; SponsorBlock already fills this niche well | SponsorBlock model |
| Video download / offline processing | Outside scope; use case is in-browser real-time enhancement | youtube-dl |
| Real-time speech-to-text (Whisper in browser) | Too heavy for a userscript; WASM Whisper exists but is 150MB+ and slow | whisper.cpp |
| Chrome Web Store extension port | Viable long-term but userscript reach is broader across browsers; MV3 restrictions on content scripts add complexity | CWS ecosystem |
| Web Audio API silence detection | YouTube's CORS policy blocks `createMediaElementSource()` on the `<video>` element; `captureStream()` also blocked by EME/DRM. Audio-level RMS analysis is not feasible in a userscript | Web Audio API spec, WebAudio/web-audio-api#2453 |
| Ad blocking / sponsor blocking | Well-served by uBlock Origin + SponsorBlock; adding this would bloat scope and invite legal risk | Enhancer for YouTube |
| Playback speed controls | Already native to YouTube; duplicating this adds no value | ImprovedTube |
| Video quality auto-selection | Off-topic; YouTube enhancer feature, not a chapter tool | ImprovedTube |

## Sources

### Competitor Tools
- https://github.com/niccokunzmann/sponsorblock (SponsorBlock)
- https://github.com/niccokunzmann/ImprovedTube (ImprovedTube)
- https://github.com/niccokunzmann/youtube-transcript-api (youtube-transcript-api)
- https://www.descript.com/
- https://www.gling.ai/
- https://www.timebolt.io/
- https://www.recut.video/

### NLP / Technical
- https://github.com/retextjs/retext (NLP processing chain)
- https://github.com/winkjs/wink-nlp (browser-compatible NLP)
- https://github.com/spencermountain/compromise (JavaScript NLP library)
- https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API
- https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API

### Community Signal
- https://www.reddit.com/r/youtube/ (chapter generation feature requests)
- https://www.reddit.com/r/userscripts/ (userscript ecosystem)
- https://support.google.com/youtube/answer/9884579 (YouTube auto-chapters)

### NLP Libraries & Techniques
- https://github.com/winkjs/wink-nlp (browser-ready NLP, 650K tokens/sec)
- https://github.com/wooorm/franc (language detection, 82-419 languages)
- https://github.com/stopwords-iso/stopwords-iso (stopword lists for 62 languages)
- https://aclanthology.org/J97-1003.pdf (TextTiling — depth-score segmentation)

### Podcast Chapter Formats
- https://podlove.org/simple-chapters/ (Podlove Simple Chapters spec)
- https://podcasting2.org/docs/podcast-namespace/tags/chapters (Podcasting 2.0 JSON chapters)

### Standards / APIs
- https://developer.mozilla.org/en-US/docs/Web/API/MediaSession (MediaSession API chapters)
- https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API
- https://www.w3.org/TR/trusted-types/ (Trusted Types spec)
- https://podlove.org/specifications/chapters/ (podcast chapters spec — adjacent domain)

## Open Questions

1. **Are the missing `_gmGet`/`_gmPostJson`/`_buildSapisidAuth` methods intentionally removed or accidentally omitted?** They were likely part of an earlier version. The current code calls them but they don't exist, making fallback methods 4-6 dead code. Need to determine whether to re-implement or remove the dead call sites.
2. **What is the target user profile for YouTube Music support?** The `@match` includes `music.youtube.com` but the UI is designed for standard YouTube. Music videos have different transcript availability and viewing patterns.
3. **Is there an appetite for a build system?** The single-file approach is simple but prevents testing, tree-shaking, and module splitting. A Rollup/esbuild pipeline would enable these without changing the delivery format (still ships as one `.user.js`).
