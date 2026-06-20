# Changelog

## [3.2.0] - 2026-06-20

### Added
- Web Worker offloading — NLP computation (TF-IDF, cosine similarity, TextRank, POI detection) now runs off the main thread
- Multi-language stopword support with auto-detection for 10 languages (es, fr, de, pt, ja, ko, zh, hi, ar, ru)
- TextTiling depth-score boundary detection replaces raw cosine similarity thresholds for higher-confidence chapter boundaries
- Adaptive NLP window sizing — 120s groups for videos >45min, 60s for shorter
- Intra-segment pause detection from word-level timing gaps
- IndexedDB caching with LRU eviction (replaces localStorage, auto-migrates existing cache)
- Settings export/import via JSON files
- Chapter quality confidence score (high/medium/low) shown in Chapters tab
- Transcript download in SRT and VTT formats
- Chapter export as JSON with structured data (timestamps, titles, POIs, confidence)
- Undo button on auto-skip toasts to seek back to pre-skip position
- Filler word regex compilation memoization
- Multi-language filler word catalogs (es, fr, de, pt, ja) — auto-activated when non-English transcript detected
- SponsorBlock integration — fetches segment data and snaps chapter boundaries to sponsor/intro/outro edges

### Changed
- Chapter tracking and auto-skip merged into single RAF playback loop (halved per-frame CPU cost)

## [3.1.0] - 2026-06-20

### Fixed
- Implemented missing `_gmGet`, `_gmPostJson`, and `_buildSapisidAuth` methods that caused transcript fallback methods 4-6 to throw TypeError (dead code since v3.0.0)
- Added abort controller to transcript fetch pipeline — rapid SPA navigation no longer causes stale results from a previous video to overwrite current data
- Added cache schema validation — corrupt or version-mismatched cached data is silently discarded and regenerated instead of crashing

### Added
- `.gitignore` file with standard JS/userscript exclusions
- CHANGELOG.md for version history tracking

## [3.0.0] - 2026-06-19

### Added
- Initial public release
- NLP-powered chapter generation using TF-IDF + cosine similarity
- 7-method transcript extraction failover pipeline
- Filler word detection with word-level timing (26 words across 3 categories)
- AutoSkip with three aggression presets (Gentle/Normal/Aggressive)
- Chapter HUD overlay with prev/next navigation
- Color-coded chapter segments on YouTube's progress bar
- Points of Interest detection (emphasis, enumeration, named entities)
- Transcript hover preview on progress bar
- Speech pace analysis and keywords-by-chapter in Analysis tab
- One-click chapter export to clipboard
- Smart localStorage caching per video ID
