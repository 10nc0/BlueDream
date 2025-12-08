# Your Nyanbook~ 🌈

## Overview
"Your Nyanbook" is a multi-tenant SaaS messaging book designed to securely forward messages from WhatsApp to Discord. It provides robust authentication, permanent message retention via Discord threads, and isolated data storage for each user. The project aims to offer a zero-friction onboarding experience and a highly customizable, responsive interface for managing personal message archives. The business vision is to provide a secure and efficient way for users to archive their WhatsApp conversations permanently in Discord, targeting individuals and small businesses needing reliable message retention and easy access.

## User Preferences
- **Design**: Apple glassmorphism aesthetic with Discord-style message layout
- **Privacy**: Messages sent TO book only (not group monitoring)
- **Retention**: Permanent storage (no deletion of messages)
- **Security**: Multi-user authentication with audit logging
- **Compatibility**: Safari/iPad support (JWT localStorage + proper cookie handling)
- **UX**: Auto-expanding interface, responsive design, user-customizable layout, zero-friction onboarding (no webhook required), progressive disclosure for power features

## System Architecture
The system uses a Node.js backend with Express and a Single Page Application (SPA) frontend, featuring an Apple glassmorphism design and a Discord-style two-pane layout. It supports real-time updates and is responsive across devices.

**UI/UX Decisions:**
- **Adaptive Layout**: Desktop offers a resizable sidebar and header; mobile features automatic layout, harmonized header, and a floating action zone.
- **Touch Interactions**: Optimized for iPhone with tap-to-zoom, swipe navigation, auto-hide elements on scroll, 48px touch targets, and momentum scrolling.
- **Responsive Components**: UI components adapt for mobile/desktop contexts.

**Technical Implementations:**
- **Authentication**: Email/password authentication using JWT tokens, role-based access control, and isolated user data storage.
- **Database**: PostgreSQL with multi-tenant architecture, ensuring data separation per user via isolated schemas.
- **Book Registry**: Centralized global registry (`core.book_registry`) for O(1) join code lookups, storing book metadata (join_code, fractal_id, tenant linkage, status, multi-outpipe configuration).
- **WhatsApp Integration**: Twilio-based messaging integration using WhatsApp Business API. Employs a join-code-first routing architecture for incoming messages, allowing phone number recycling.
- **Webhook Integration**: Messages are permanently saved to your Ledger with multi-webhook capability for external user's preferred storage.
- **Media Handling**: Discord-native storage for media. WhatsApp media is downloaded from Twilio and uploaded to Discord as native attachments, making the system Twilio-independent for reads.
- **Search & Metadata**: Enhanced search across messages and metadata, supporting multilingual text and full-text search indexing.
- **Real-time Updates**: Smart polling with `?after={messageId}` for new messages, with auto-scroll and "New messages" banner. Jump-to-message functionality with `#msg-{messageId}`.
- **Terminology Refactor**: All internal and external "bridge" terminology has been replaced with "book".

**System Design Choices:**
- **Multi-Tenant Isolation**: Complete data separation between users via database schemas.
- **Zero-Friction Onboarding**: WhatsApp deep link activation.
- **Scalability & Recovery**: Designed for Replit Autoscale, with PostgreSQL storing all book state for automatic recovery.
- **Security**: Strict webhook validation, JWT security, and robust audit logging. Sybil attack prevention via unique one-time join codes. Password recovery functionality has been removed for enhanced security.
- **CSP Compliance**: Production-ready Content Security Policy with event delegation and self-hosted libraries.

## Discord Bot Trinity Architecture
The system uses paired Discord bots following the "Trinity" pattern: write-only + read-only bots for secure, permission-isolated operations.

### Human Trinity (Message Flow)
For WhatsApp → Discord message forwarding:
- **Hermes (φ)** - Write-only bot for creating threads and posting messages via webhook
- **Thoth (0)** - Read-only bot for fetching message history from Discord threads

**Flow:** WhatsApp → Twilio → Server → Hermes (write) → Discord Thread ← Thoth (read) → Dashboard

**Files:** `hermes-bot.js`, `thoth-bot.js`

**Environment:**
- `HERMES_BOT_TOKEN` - Hermes Discord bot token
- `THOTH_BOT_TOKEN` - Thoth Discord bot token
- `NYANBOOK_WEBHOOK_URL` - Main Ledger webhook for message posting

### Prometheus Trinity (AI Audit Flow)
For AI audit logging to Discord:
- **Idris (ι)** - Write-only bot for creating AI log threads and posting audit results
- **Horus (Ω)** - Read-only bot for fetching AI audit history

**Flow:** Prometheus Check → Idris (write) → Discord AI Log Thread ← Horus (read) → Dashboard History

**Files:** `idris-bot.js`, `horus-bot.js`

**Database Columns:** `ai_log_thread_id`, `ai_log_channel_id` in `core.tenant_catalog`

**Environment:**
- `IDRIS_AI_LOG_TOKEN` - Idris Discord bot token
- `HORUS_AI_LOG_TOKEN` - Horus Discord bot token  
- `PROMETHEUS_WEBHOOK_URL` - AI audit log webhook

## AI Audit System
The Prometheus module (internal codename) provides AI-powered message verification using Groq API (llama-3.3-70b-versatile).

**Features:**
- **General Intelligence**: Single unified check powered by Groq's llama-3.3-70b-versatile model
- **H(0) Guard Rails**: Zero-hallucination protocol - flags uncertain data for human review
- **Bilingual Support**: Automatic Indonesian/English language detection and response
- **Prompt-Directed**: Direction and behavior controlled via system prompts, not rule type selection
- **UI Integration**: 🧿 AI Audit button in dashboard opens modal for message checking, 🧠 History button shows audit history
- **Discord Logging**: All AI audit results are automatically logged to Discord via Prometheus Trinity (Idris writes, Horus reads)

**API Endpoints:**
- `POST /api/prometheus/check` - Check messages against business rules (also posts to Discord via Idris)
- `GET /api/prometheus/rules` - List available rule types
- `GET /api/prometheus/discord-history` - Fetch AI audit history from Discord via Horus

**Module Structure:**
- `prometheus/index.js` - Main Prometheus class
- `prometheus/prompts.js` - System prompts with H(0) protocol
- `prometheus/huggingface.js` - HuggingFace API client (legacy)
- `prometheus/rules.js` - Business rules engine

**Environment:**
- `GROQ_API_KEY` - Groq API key (required for AI checks)

## AI Playground (Public)
A sovereign, public AI playground at `/AI` with no authentication required.

**URL Flow:**
- `nyanbook.replit.app/` → Redirects to `/AI` (public landing page)
- `/AI` → AI Playground with "Login to Nyanbook" button
- `/login.html` → Login page → `/dashboard` (authenticated dashboard)

**Multimodal Support:**
- **Text**: Groq Llama 3.3 70B Versatile (0.8s response)
- **Photo**: Groq Llama 4 Scout 17B (direct vision analysis, OCR, image understanding)
- **Audio**: Groq Whisper-large-v3-turbo (Indonesian transcription) → Groq Llama 3.3
- **Documents**: PDF (pdf-parse), Excel/XLSX (exceljs), Word/DOCX (mammoth) → text extraction → Groq Llama 3.3

**Image Input Methods:**
- Drag & drop images onto the playground
- Click attachment button to select file
- Paste from clipboard (Ctrl+V / Cmd+V)

**Document Parsing with Cascade Workflow:**
- Supported formats: PDF, XLSX, DOCX, TXT, MD, CSV, Images (JPG/PNG), Audio (MP3/WAV/WebM)
- Unsupported: Legacy .doc/.xls (returns friendly 400 with conversion guidance)
- Token limit: ~6,000 tokens max (truncates with smart paragraph/sentence breaks)

**Attachment Cascade Logic Gate** (`utils/attachment-cascade.js`):
- **Step 1**: Identify file type & data structure (PDF, Excel, Word, Image, Audio, Text)
- **Step 2**: Select extraction pipeline based on file type
- **Step 3**: Execute cascade (tools ordered by cost tier):
  - **Tier 0 (FREE_LOCAL)**: pdf-parse, tabula-js, exceljs, mammoth, buffer-text
  - **Tier 1 (CHEAP_API)**: Groq Whisper (audio transcription), Groq Llama 4 Scout (vision)
  - **Tier 2 (MODERATE_API)**: Tesseract OCR (future: scanned PDFs)
- **Step 4**: Format extracted data as JSON
- **Step 5**: Feed JSON to Groq → Groq reasons → Output

**Vision Quota Management:**
- Daily cap: 40 photos/day (resets at UTC midnight)
- Graceful degradation when quota exhausted (text + search still available)

**Hybrid PDF Parser** (`utils/pdf-handler.js`):
- Text extraction: pdf-parse v2 API (PDFParse class with getText())
- Table extraction: tabula-js (requires Java runtime, installed)
- Result formatted as markdown tables + raw text for AI context
- Future: OCR for scanned PDFs, chart/graph vision analysis (requires PDF-to-image pipeline)

- Modules: `utils/attachment-cascade.js`, `utils/document-parser.js`, `utils/pdf-handler.js`

**Isolation Architecture:**
- Uses separate tokens: `PLAYGROUND_GROQ_TOKEN` (text + vision), `PLAYGROUND_BRAVE_API` (search fallback)
- All multimodal processing (text, vision, audio) now unified on Groq
- Prevents abuse from affecting production Prometheus system
- 50 requests/hour per IP rate limiting, 40 photos/day global cap

**Search Cascade (Real-time Knowledge):**
- **Step 0**: Query Extraction - Groq extracts core question + auto-appends "vs 50 years ago" for NYAN protocol queries
- **Step 1**: DuckDuckGo Instant Answer API (free, Wikipedia-style facts)
- **Step 2**: Brave Search API fallback (if DDG returns nothing, for current events/news)
- **NYAN Protocol:** Forces historical comparison (current + 50yr proxy) for directional insights
- Overcomes Groq's December 2023 knowledge cutoff with real-time web data
- Console logs show: `🧠 Extracted query`, `🧠 Enhanced with historical`, `🔍 DDG`, `🦁 Brave`

**Nyan Protocol (Permanent Seed Context):**
- **Identity:** Origin=0. Nyan (no yes all neither) of nyanbook. Progression=genesis=φ²
- **Ontology:** Seed ↔ Silt ↔ φ ↔ Lineage (single invariant all substrate)
- **Seed Metric (Human Substrate):** Price/Income ratio for 700 m²/HH residential VACANT land
  - INCOME: Single-earner MEDIAN income (NOT household, NOT per capita)
  - LAND PRICE: 700 m² vacant residential land (NOT median home, NOT land+building)
  - TIMEFRAME: Exactly 50 years ago (40-60yr proxy acceptable if unavailable)
  - Calculation: (700 m² land price ÷ single-earner income) = years → P/I ratio = years÷25
  - Quick Proxy: Price/Income >3.5x = Fatalism, <2.5x = Optimism
  - **Required: HUMANIZE EVERY RATIO** - Add fatalism/optimism conclusion after each P/I output
    * P/I >3.5x → "Fatalism: Exceeds 25-year fertility window. Demographic risk."
    * 2.5x < P/I ≤3.5x → "Borderline fatalism: Approaching critical threshold."
    * P/I <2.5x → "Optimism: Within 10-year acquisition horizon. Reproductive viability."
  - Compare 2 cities ~50yrs ago vs now, show directional change with calculations + conclusions
  - **PROXY CONVERSION RULES** (use when ideal data unavailable, FLAG ALL):
    * Household income → Single-earner: ÷2 [flag: "Using proxy: household÷2"]
    * Median home → Land: ×40% urban, ×60% suburban, ×75% rural [flag: "Using proxy: home×land%"]
    * No local 700m² → Use exurban/rural within 90min commute [flag: "Using proxy: exurban floor"]
    * GDP per capita → DO NOT USE (no conversion exists)
  - **ANALYSIS HIERARCHY** (refusal is last resort): Exact → Proxy → Best Estimate → Insufficient
  - **BEST ESTIMATE MODE**: Confidence (LOW/MED/HIGH) + Source + "Unverified - falsifiable if user provides data"
- **Planetary Substrate (🜃G ms⁻²):** <0.3G or >5G → zero survival as t → ∞
- **Response Rules:** 
  - Topics {money, city, land price, empire, collapse, extinction, inequality, φ, cycle, breath} → apply Nyan Protocol
  - Other topics → normal helpful cat, end "nyan~"
- **Data Integrity (H₀ Protocol):** No hallucination/flattery, cite verified datapoints, no hedging

**H₀ + Problem-Solving Protocol:**
- Temperature 0.15 (sweet spot: 0.1 too rigid, 0.2 hallucinates), max_tokens: 1500
- Confidence-based extrapolation:
  * 100% data → Exact numbers
  * 70-99% data → "Estimated" + flag
  * <70% data → "Insufficient data"
  * Reasonable proxy → Use + flag "Using proxy"
- NEVER invent, ALWAYS cite, no hedging unless genuine uncertainty
- Zero hallucination with helpful reasoning

**Visual Elements:**
- **Header**: Cat animation (left, with `initHopAnimation()` call), title in center, blinking date/time display (left of login button), login button (with 🐈‍⬛ emoji) on right
- **Date/Time**: Blinking animation (opacity 1 → 0.4, 1.5s ease-in-out infinite), positioned left of login button
- **Message Layout**: Discord-style two-pane design with glassmorphism aesthetic

**Files:** `public/playground.html`, `public/js/playground.js`

**API Endpoint:** `POST /api/playground` (public, no auth)

## External Dependencies
- **Database**: PostgreSQL (Supabase) with RLS configured via Supabase dashboard
- **WhatsApp**: Twilio WhatsApp Business API
- **AI (Production)**: Groq API (llama-3.3-70b-versatile) via `GROQ_API_KEY`
- **AI (Playground)**: Groq API via `PLAYGROUND_GROQ_TOKEN`, HuggingFace via `PLAYGROUND_HF_VISION_TOKEN`

## Database Notes
- **RLS Policy**: Row Level Security for `public.sessions` table is configured directly in Supabase SQL editor (not in code). Policy enables backend full access while satisfying Supabase security requirements.
- **Onboarding Flow**: 2-step wizard (Create Book → Activate with Join Code). Webhook URL is optional in Step 1.