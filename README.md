# Chapterizer

![Version](https://img.shields.io/badge/version-3.0.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Platform](https://img.shields.io/badge/platform-YouTube-FF0000?logo=youtube&logoColor=white)
![Tampermonkey](https://img.shields.io/badge/Tampermonkey-compatible-00485B?logo=tampermonkey&logoColor=white)
![Violentmonkey](https://img.shields.io/badge/Violentmonkey-compatible-6a4dbc)

> Auto-generates chapters, detects filler words, and skips pauses on YouTube. Works instantly — no setup, no servers, no API keys.

![Screenshot](screenshot.png)

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/)
2. [Click here to install Chapterizer](https://raw.githubusercontent.com/SysAdminDoc/Chapterizer/main/Chapterizer.user.js)
3. Confirm installation when prompted
4. Open any YouTube video — chapters generate automatically

No configuration required. It works out of the box.

## Features

| Feature | Description | Default |
|---------|-------------|---------|
| Auto Chapter Generation | NLP-powered topic segmentation using TF-IDF + cosine similarity | Enabled (Auto) |
| Filler Word Detection | Detects 26 filler words/phrases across 3 categories | `um`, `umm` active |
| AutoSkip | Skips pauses and filler words during playback | Normal mode |
| Chapter HUD | Floating overlay showing current chapter with prev/next nav | Enabled |
| Progress Bar Overlay | Color-coded chapter segments on YouTube's seekbar | Enabled |
| Points of Interest | Highlights key moments (emphasis, enumeration, named entities) | Enabled |
| Transcript Hover | Preview transcript text by hovering the progress bar | Enabled |
| Filler Markers | Orange markers on the seekbar showing filler word locations | Enabled |
| Speech Pace Analysis | Words-per-minute breakdown with fast/slow segment detection | In Analysis tab |
| Keywords by Chapter | Top keywords extracted per chapter via TF-IDF | In Analysis tab |
| Chapter Export | Copy YouTube-formatted chapter timestamps to clipboard | One click |
| Smart Caching | Chapters cached in localStorage per video ID | Automatic |

## How It Works

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  YouTube      │────>│  Transcript   │────>│  NLP Engine   │────>│  UI Render    │
│  Video Load   │     │  Extraction   │     │               │     │               │
│               │     │  7 methods    │     │  TF-IDF       │     │  Chapters     │
│  Auto-detect  │     │  with auto    │     │  Cosine sim   │     │  HUD + Bar    │
│  duration     │     │  failover     │     │  TextRank     │     │  Fillers      │
│  + cached?    │     │  + word-level │     │  POI scoring  │     │  AutoSkip     │
└──────────────┘     └──────────────┘     └──────────────┘     └──────────────┘
```

### Transcript Extraction (7-Method Failover)

Chapterizer uses a robust multi-method transcript pipeline. If one method fails, it automatically tries the next:

1. **`ytInitialPlayerResponse`** — Fastest, reads YouTube's page-level variable
2. **Innertube API** — Most reliable for SPA navigation
3. **Polymer Element Data** — Extracts from `ytd-watch-flexy` component
4. **GM Page Fetch** — Fresh page download with regex extraction
5. **Innertube Player API** — Authenticated API call with SAPISIDHASH
6. **Innertube `get_transcript`** — Protobuf-encoded transcript endpoint
7. **DOM Scrape** — Final fallback, clicks "Show Transcript" and reads the panel

All methods support **word-level timing** from YouTube's `json3` format, enabling precise filler word detection down to individual words.

### Chapter Generation (Zero-Dependency NLP)

No external APIs or servers. Everything runs in-browser:

- Transcript split into 60-second analysis windows
- **TF-IDF vectors** computed per window with bigram support
- **Cosine similarity** measured between adjacent windows
- Topic boundaries detected at similarity drops below adaptive threshold
- Chapter count scaled to video length (~1 per 3–5 minutes, capped at 15)
- Titles generated from top key phrases (bigrams preferred)
- **TextRank** used for sentence importance scoring in POI detection

## Filler Words

Chapterizer ships with 26 filler words organized into three categories. Each is individually toggleable via polished chip buttons in Settings.

| Category | Words |
|----------|-------|
| **Common** | um, umm, uh, uhh, hmm, hm, er, erm, ah, mhm |
| **Phrases** | you know, I mean, sort of, kind of, okay so, so yeah, yeah so, like |
| **Extended** | basically, literally, actually, right, anyway, whatever, I guess, you see |

**Default:** Only `um` and `umm` are enabled on install — conservative so it works well for everyone out of the box. Power users can enable more from Settings.

Quick-select buttons ("All" / "None") make bulk toggling instant.

## AutoSkip Modes

| Mode | Pause Threshold | Skip Fillers | Silence Speed | Description |
|------|----------------|--------------|---------------|-------------|
| **Off** | — | No | — | No automatic skipping |
| **Gentle** | > 3.0s | No | Normal | Only skips long pauses |
| **Normal** | > 1.5s | Yes | Normal | Skips pauses + enabled filler words |
| **Aggressive** | > 0.5s | Yes | 2.0x | Skips all gaps, speeds through silence |

AutoSkip builds a sorted skip-zone list from detected pauses and fillers, then uses a single `requestAnimationFrame` loop with cursor-based scanning for minimal CPU overhead.

## Configuration

Access settings via the Chapterizer button (list icon) in YouTube's player controls → **Settings** tab.

### Processing
| Setting | Options | Default |
|---------|---------|---------|
| Mode | Auto (All Videos) / Manual (Button Only) | Auto |
| Max Auto Duration | 15 min – Unlimited | Unlimited |

### Display
| Setting | Options | Default |
|---------|---------|---------|
| Chapter HUD | On / Off | On |
| HUD Position | Top Left / Top Right / Bottom Left / Bottom Right | Top Left |
| Chapters on Bar | On / Off | On |
| POI Markers | On / Off | On |
| Filler Markers | On / Off | On |
| Debug Logging | On / Off | Off |

## Analysis Tab

After chapter generation, the **Analysis** tab provides:

- **Silence/Pauses** — Count and total duration of detected pauses (percentage of video)
- **Filler Words** — Total count with per-word breakdown and visual bar chart
- **Speech Pace** — Average WPM with min/max range and fast/slow classification
- **Keywords by Chapter** — Top 5 keywords extracted per chapter

## Browser Support

Tested with:
- **Tampermonkey** on Chrome, Edge, Firefox, Brave, Opera
- **Violentmonkey** on Chrome, Firefox
- **Greasemonkey** on Firefox

Works on `youtube.com` and `music.youtube.com`.

## FAQ

**Q: Why are chapters not generating?**
The video needs available captions/subtitles (auto-generated or manual). Videos without any transcript cannot be processed.

**Q: Chapters seem inaccurate for very short videos.**
The NLP engine needs enough transcript content to detect topic shifts. Videos under ~3 minutes may produce generic results.

**Q: AutoSkip is skipping too much / too little.**
Adjust the AutoSkip mode (Gentle → Normal → Aggressive) and toggle specific filler words on/off in Settings to fine-tune behavior.

**Q: Does this send data anywhere?**
No. All processing happens locally in your browser. No external APIs, no servers, no tracking. Transcript data is fetched directly from YouTube's own endpoints.

**Q: How do I export chapters for my own video?**
Generate chapters → Chapters tab → **Copy Chapters**. This copies YouTube-formatted timestamps (`0:00 Title`) to your clipboard, ready to paste into a video description.

## Contributing

Issues and PRs welcome. If you encounter a video where transcript extraction fails, include the video URL in your issue.

## License

[MIT](LICENSE)
