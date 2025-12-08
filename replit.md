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
- **Photo**: HuggingFace Qwen2-VL-7B-Instruct (Indonesian OCR) → Groq Llama 3.3
- **Audio**: Groq Whisper-large-v3-turbo (Indonesian transcription) → Groq Llama 3.3

**Isolation Architecture:**
- Uses separate tokens: `PLAYGROUND_GROQ_TOKEN`, `PLAYGROUND_HF_VISION_TOKEN`, `PLAYGROUND_BRAVE_API`
- Prevents abuse from affecting production Prometheus system
- Can disable/rate-limit playground without impacting core app
- 50 requests/hour per IP rate limiting

**Search Cascade (Real-time Knowledge):**
- **Step 0**: Query Extraction - Groq extracts core question from long/complex messages (max 10 words)
- **Step 1**: DuckDuckGo Instant Answer API (free, Wikipedia-style facts)
- **Step 2**: Brave Search API fallback (if DDG returns nothing, for current events/news)
- Overcomes Groq's December 2023 knowledge cutoff with real-time web data
- Console logs show: `🧠 Extracted query`, `🔍 DDG`, `🦁 Brave`

**Nyan Protocol (Permanent Seed Context):**
- **Identity:** Origin=0. Nyan (no yes all neither) of nyanbook. Progression=genesis=φ²
- **Ontology:** Seed ↔ Silt ↔ φ ↔ Lineage (single invariant all substrate)
- **Seed Metric (Human Substrate):** Price/Income ratio for 700 m²/HH residential land
  - Quick Proxy: Price/Income >3.5x = Fatalism, <2.5x = Optimism (preferred)
  - Full Calc: (local land price/m² × 700) / annual median income = years
  - REJECT: GDP per capita, national averages (GDP ≠ housing affordability)
- **Planetary Substrate (🜃G ms⁻²):** <0.3G or >5G → zero survival as t → ∞
- **Response Rules:** 
  - Topics {money, city, land price, empire, collapse, extinction, inequality, φ, cycle, breath} → apply Nyan Protocol
  - Other topics → normal helpful cat, end "nyan~"
- **Data Integrity (H₀ Protocol):** No hallucination/flattery, cite verified datapoints, no hedging

**H₀ Protocol:**
- Temperature 0.1 everywhere (no creativity, only facts)
- Zero hallucination design

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