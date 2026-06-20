# Changelog

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
