# Roadmap — Chapterizer

## Research-Driven Additions

### P0 — Critical

- [ ] P0 — Implement missing `_gmGet`, `_gmPostJson`, `_buildSapisidAuth` methods
  Why: These methods are called in transcript fallback paths 4-6 (lines 753, 812-813, 876, 881, 955-956) but never defined — all three throw TypeError at runtime, making fallback methods dead code
  Evidence: Code scan — `_gmGet` called at line 753, `_gmPostJson` at 813/956, `_buildSapisidAuth` at 812/876/955; none defined anywhere in source
  Touches: `Chapterizer.user.js` — Chapterizer object (add three new methods using GM_xmlhttpRequest)
  Acceptance: Fallback transcript methods 4-6 successfully fetch transcripts when methods 1-3 fail; no TypeError in console
  Complexity: M

- [ ] P0 — Add `.gitignore` file
  Why: Repo has no `.gitignore` — `CLAUDE.md`, `.claude/`, `node_modules/`, and other artifacts will get committed
  Evidence: `Glob **/*` shows no `.gitignore` in repo
  Touches: New `.gitignore` at repo root
  Acceptance: Standard JS/userscript ignores present; `CLAUDE.md`, `.claude/`, `CODEX_CHANGELOG.md` excluded
  Complexity: S

- [ ] P0 — Add abort controller to transcript fetch pipeline
  Why: Rapid SPA navigation (clicking multiple videos quickly) can trigger concurrent `_fetchTranscript` calls with no cancellation; stale results from a previous video could overwrite current data
  Evidence: `_onVideoChange` calls `_handleGenerate` without canceling any in-flight fetch; `_isGenerating` guard only prevents double-click, not SPA race
  Touches: `Chapterizer.user.js` — `_fetchTranscript`, `_handleGenerate`, `_onVideoChange`
  Acceptance: Navigating away from a video while transcript is loading cancels the in-flight request; no stale data applied
  Complexity: M

### P1 — High Priority

- [ ] P1 — Merge chapter tracking and auto-skip into a single RAF loop
  Why: Two independent `requestAnimationFrame` loops (lines 1908-1934 and 1624-1669) run simultaneously, doubling per-frame CPU cost for no benefit
  Evidence: Code review — `_startChapterTracking` and `_startAutoSkip` each create their own RAF loop with independent tick functions
  Touches: `Chapterizer.user.js` — `_startChapterTracking`, `_startAutoSkip`, create unified `_startPlaybackLoop`
  Acceptance: Single RAF loop handles both chapter HUD updates and auto-skip; CPU profile shows one RAF callback per frame, not two
  Complexity: M

- [ ] P1 — Offload NLP computation to a Web Worker
  Why: TF-IDF vector computation, cosine similarity matrix, and TextRank (15 iterations × O(n²)) all run on the main thread; long videos (60+ min) with dense transcripts can cause visible jank
  Evidence: `_nlpTFIDF`, `_nlpCosine`, `_nlpTextRank` are pure functions with no DOM dependency — ideal Web Worker candidates; community reports of browser-based NLP causing frame drops
  Touches: `Chapterizer.user.js` — extract NLP functions into inline Worker blob; `_generateChaptersHeuristic` becomes async with Worker postMessage
  Acceptance: Chapter generation for a 2-hour video completes without dropping frames; main thread stays responsive during NLP computation
  Complexity: L

- [ ] P1 — Validate cached data schema on load
  Why: `_getCachedData` deserializes localStorage JSON without any schema check; if the cache format changes between versions, corrupt data causes runtime errors
  Evidence: Code review — `_getCachedData` at line 638 does `JSON.parse(raw)` with no field validation; no version field in cached data
  Touches: `Chapterizer.user.js` — `_getCachedData`, `_setCachedData` (add schema version field and validation)
  Acceptance: Cached data from older script versions is silently discarded and regenerated; invalid JSON doesn't crash the script
  Complexity: S

- [ ] P1 — Multi-language stopword support
  Why: `_NLP_STOPS` is English-only (line 1081); chapter generation on non-English transcripts produces garbage titles because stopwords aren't filtered
  Evidence: YouTube serves transcripts in 100+ languages; `TranscriptService._selectBestTrack` prefers English but falls back to other languages; competitor tools (youtube-transcript-api) support language-specific processing
  Touches: `Chapterizer.user.js` — `_NLP_STOPS`, `_generateChaptersHeuristic`, new stopword sets for top 10 languages (es, fr, de, pt, ja, ko, zh, hi, ar, ru)
  Acceptance: Chapter titles generated from Spanish/French/German transcripts contain meaningful keywords, not articles and prepositions
  Complexity: L

- [ ] P1 — Add CHANGELOG.md
  Why: No version history tracked; users seeing a new version have no way to know what changed
  Evidence: Repo has no CHANGELOG; only 6 git commits with minimal messages
  Touches: New `CHANGELOG.md` at repo root
  Acceptance: CHANGELOG exists with v3.0.0 initial entry and format ready for future releases
  Complexity: S

### P2 — Medium Priority

- [ ] P2 — IndexedDB caching with LRU eviction
  Why: localStorage has ~5-10MB quota per origin (shared with YouTube); current eviction (remove first 5 when >20 entries) is not LRU and can lose recent data
  Evidence: `_setCachedData` line 640-643 — arbitrary first-5 eviction on quota error; no access-time tracking; IndexedDB offers ~50MB+ quota with structured queries
  Touches: `Chapterizer.user.js` — `_getCachedData`, `_setCachedData`, `_countCache`, `_clearCache`; migrate from localStorage to IndexedDB with LRU timestamps
  Acceptance: Cache survives beyond 20 entries; least-recently-accessed entries are evicted first; old localStorage cache migrated on first run
  Complexity: M

- [ ] P2 — Web Audio API silence detection
  Why: Current pause detection relies solely on transcript segment gaps (line 1546-1559); actual audio silence between words isn't detected, producing false positives where the speaker pauses but the transcript has no gap
  Evidence: Descript, Gling, and TimeBolt all use audio waveform analysis for silence detection; Web Audio API's AnalyserNode provides real-time frequency/volume data in-browser with no external dependency
  Touches: `Chapterizer.user.js` — new `_detectSilenceAudio` method using `AudioContext` + `AnalyserNode` on the video element; merge results with transcript-based pause detection
  Acceptance: AutoSkip correctly identifies actual silent moments even when transcript segments are continuous; fewer false-positive skips
  Complexity: L

- [ ] P2 — Settings export/import
  Why: All settings stored in GM storage with no backup mechanism; clearing browser data or switching machines loses all configuration
  Evidence: No export/import UI exists; `settingsManager` only has `load()`/`save()` with no serialization to file
  Touches: `Chapterizer.user.js` — Settings tab UI (add Export/Import buttons); `settingsManager` (add `export()` returning JSON string, `import()` accepting JSON)
  Acceptance: User can export settings to a JSON file and import on another browser/machine; import validates schema before applying
  Complexity: S

- [ ] P2 — Memoize filler word regex compilation
  Why: `_getFillerSets()` creates new `Set` and `RegExp` objects on every call; called per-segment during filler detection
  Evidence: Line 1436-1454 — `_getFillerSets()` rebuilds data structures from scratch; called by `_detectFillers` which iterates over every transcript segment
  Touches: `Chapterizer.user.js` — `_getFillerSets` (add memoization keyed on `cfFillerWordsEnabled` settings hash)
  Acceptance: Filler detection time for a 1000-segment transcript drops measurably; regex objects reused between calls when settings haven't changed
  Complexity: S

- [ ] P2 — Undo seek on auto-skip with toast action
  Why: When AutoSkip jumps past a filler or pause, there's no way to go back to hear what was skipped; users report wanting to hear context around detected fillers
  Evidence: `showToast` already supports an `action` option with an onClick callback (line 78-83); AutoSkip does `video.currentTime = zone.end` with no undo (line 1653)
  Touches: `Chapterizer.user.js` — auto-skip tick function (save pre-skip position, show brief toast with "Undo" action)
  Acceptance: After a skip, a non-intrusive toast appears briefly; clicking "Undo" seeks back to pre-skip position
  Complexity: S

- [ ] P2 — Consolidate transcript extraction pipeline
  Why: `TranscriptService` and `Chapterizer._fetchTranscript` both contain transcript fetching logic with overlapping methods; `TranscriptService` has 5 methods, `Chapterizer` has 7, and they partially call each other
  Evidence: `_fetchTranscript` line 660-854 calls `TranscriptService._getCaptionTracks` as its primary method, then falls back to its own methods 2-7 which duplicate similar logic
  Touches: `Chapterizer.user.js` — merge all transcript methods into `TranscriptService`; `Chapterizer._fetchTranscript` becomes a thin wrapper
  Acceptance: Single transcript extraction pipeline with clear method ordering; no duplicated fetch/parse logic between the two objects
  Complexity: M

- [ ] P2 — Adaptive NLP window sizing for long videos
  Why: Current 60-second fixed analysis windows (line 1225) work well for 10-30 min videos but produce too many windows for 2h+ content (120+ windows), slowing TF-IDF computation
  Evidence: `groupWindowCount = 2` (2 × 30s = 60s) is hardcoded; comment on line 1222-1224 explains the previous approach scaled with video length but caused vectors to converge
  Touches: `Chapterizer.user.js` — `_generateChaptersHeuristic` (implement two-pass approach: coarse 120s windows for videos >45min, then refine boundaries with 60s windows around detected breaks)
  Acceptance: 2-hour video generates chapters in <2 seconds with meaningful topic boundaries; 15-min videos are unaffected
  Complexity: M

### P3 — Lower Priority / Under Consideration

- [ ] P3 — Multi-language filler word catalogs
  Why: `FILLER_CATALOG` is English-only; non-English speakers get no filler detection
  Evidence: Line 119-123 — filler words hardcoded in English; YouTube serves transcripts globally; Spanish "este/pues", German "äh/also", Japanese "えーと/あのー" are common fillers
  Touches: `Chapterizer.user.js` — `FILLER_CATALOG` (add language-keyed catalogs), `_getFillerSets` (detect transcript language and select appropriate catalog)
  Acceptance: Filler words detected correctly in at least Spanish, French, German, and Japanese transcripts
  Complexity: M

- [ ] P3 — Chapter quality confidence score
  Why: Users have no way to know if generated chapters are meaningful or if the NLP engine struggled (e.g., very short video, monotopic content)
  Evidence: `_generateChaptersHeuristic` returns chapters without any quality metadata; similarity variance, boundary strength, and keyword distinctiveness could indicate confidence
  Touches: `Chapterizer.user.js` — `_generateChaptersHeuristic` (compute confidence from boundary similarity drops), panel UI (show confidence indicator)
  Acceptance: Panel shows a quality indicator (e.g., "High/Medium/Low confidence"); low-confidence chapters show a warning
  Complexity: S

- [ ] P3 — SponsorBlock segment awareness
  Why: SponsorBlock's crowdsourced skip segments could improve chapter boundary placement — a sponsor segment is a natural chapter break, and intro/outro segments can be excluded from chapter generation
  Evidence: SponsorBlock API is public and free; 10M+ users contribute segment data; segments categorized by type (sponsor, intro, outro, self-promo)
  Touches: `Chapterizer.user.js` — new optional integration that queries SponsorBlock API for current video; uses segment boundaries as chapter boundary hints
  Acceptance: When SponsorBlock data exists, chapter boundaries align with sponsor segments; works without SponsorBlock (graceful degradation)
  Complexity: M

- [ ] P3 — YouTube Music UI adaptation
  Why: `@match` includes `music.youtube.com` but the panel, HUD, and progress bar overlay are designed for standard YouTube's layout; Music has a different player structure
  Evidence: README says "Works on youtube.com and music.youtube.com" but no Music-specific DOM selectors or layout adjustments exist in the code
  Touches: `Chapterizer.user.js` — `_injectPlayerButton`, `_renderProgressBarOverlay`, `_createPanel` (add Music-specific selectors and positioning)
  Acceptance: Chapter HUD and progress bar overlay render correctly on YouTube Music player; panel opens without overlapping Music-specific UI
  Complexity: M

- [ ] P3 — Transcript download as SRT/VTT
  Why: Current transcript download (`TranscriptService.downloadTranscript`) only exports plain text; SRT and VTT are standard subtitle formats that video editors and accessibility tools consume
  Evidence: `_formatTranscript` at line 506 only produces `[timestamp] text` format; segments already have `startMs`/`endMs` which map directly to SRT/VTT timing
  Touches: `Chapterizer.user.js` — `TranscriptService` (add SRT and VTT formatters), panel UI (format selector in export)
  Acceptance: User can download transcript as .srt or .vtt file with correct timing; files validate in a subtitle editor
  Complexity: S

- [ ] P3 — Chapter export as JSON for programmatic use
  Why: Current export is clipboard-only YouTube-formatted timestamps; developers and automation tools need structured data
  Evidence: `_exportChaptersYouTube` at line 650 only formats as `time title` lines; chapter data already exists as structured objects
  Touches: `Chapterizer.user.js` — `_exportChaptersYouTube` (add JSON export option alongside clipboard), panel UI
  Acceptance: User can export chapters as JSON with start/end times, titles, and POI data
  Complexity: S

- [ ] P3 — Incremental panel rendering
  Why: `_renderPanel()` rebuilds the entire panel HTML on every interaction (settings toggle, tab switch, filler chip click), causing unnecessary DOM churn
  Evidence: Line 2011 — `_renderPanel` calls `TrustedHTML.setHTML` on the entire panel body for every state change; re-wires all event listeners each time
  Touches: `Chapterizer.user.js` — `_renderPanel` and sub-renderers (adopt targeted DOM updates instead of full innerHTML replacement)
  Acceptance: Toggling a filler chip or settings toggle updates only the changed element; no full panel flicker
  Complexity: L
