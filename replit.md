# Nyanbook~ 🌈

## Overview
**Nyanbook** is a multi-tenant document archiving system for individuals and teams. Send messages via WhatsApp (Twilio) to automatically archive documents, photos, and links. Search archived messages by date, content, or metadata. Optional AI audit via Prometheus bot provides AI-powered query analysis. Data stored permanently in PostgreSQL with role-based access control. Anti-surveillance architecture emphasizing data sovereignty.

## Project Structure

### Main Pages
1. **Dashboard** (`/`) - Authenticated Nyanbook user area
   - Multi-user login/signup (email/password)
   - View archived messages and attachments
   - Search across archived content
   - Trigger AI audit queries via Prometheus bot
   - WhatsApp integration via Twilio (phone number routing)

2. **AI Playground** (`/AI`) - Public, unauthenticated Nyan AI interface
   - Multi-file upload (documents, images, spreadsheets)
   - Multimodal reasoning queries
   - No login required
   - Dynamic capacity sharing (rate limiting per IP)
   - Real-time knowledge search integration

### Auth Flows
- **Dashboard**: Email/password authentication → JWT tokens + session cookies
- **AI Playground**: IP-based rate limiting (no authentication required)
- **WhatsApp**: Twilio webhook signature verification → message routing by phone number

## System Architecture
Node.js backend (Express) with PostgreSQL database. Single-page frontend using Apple glassmorphism design and Discord-style two-pane layout for message browsing.

**7-Layer Stack:**
- **Layer 7: AI Interface** (playground.js - user interaction)
- **Layer 6: Orchestration** (pipeline-orchestrator - 7-stage state machine)
- **Layer 5: Verification** (two-pass-verification - LLM output validation)
- **Layer 4: Memory & Context** (data-package + context-extractor - session state)
- **Layer 3: Perception** (attachment-cascade + financial-physics - document parsing)
- **Layer 2: Measurement** (psi-EMA - 3D financial analysis: θ, z, R)
- **Layer 1: Identity** (nyan-protocol - system prompts + routing)
- **Layer 0: Constants** (φ=1.618 thresholds, conservation laws)

## Design Principles
- **Apple Glassmorphism**: Frosted glass UI with soft shadows and transparency
- **Discord-Style Layout**: Two-pane message browser (thread list + conversation view)
- **Cat Animation**: Transcendental cat visual element with blinking date/time
- **Responsive Design**: Desktop, mobile, and iPad support with auto-expanding interface
- **Permanent Retention**: All messages immutable after creation (no deletion)

## Technical Implementation

### Authentication & Authorization
- Email/password with bcrypt hashing
- JWT tokens (15min access, 7-day refresh)
- Session management with SHA256 hashing
- Multi-tenant isolation via PostgreSQL schemas
- Role-based access control (admin, user)

### Data Architecture
- **PostgreSQL Multi-Tenant**: Isolated schemas per user (tenant_1, tenant_2, etc.)
- **Core Schema**: Global tables (user_email_to_tenant, password_reset_tokens, audit logs)
- **Tenant Schema**: Per-user isolated data (messages, attachments, preferences)
- **Book Registry**: Dynamic indexing of Discord threads
- **Session Store**: Express-session with PostgreSQL backend

### WhatsApp Integration (Twilio)
- Webhook signature verification (push guard)
- Phone number → tenant routing via ALLOWED_GROUPS/ALLOWED_NUMBERS
- Media download from Twilio → upload to Discord
- Automatic message archiving to Discord thread

### AI Audit System (Prometheus Bot)
- LLM-powered message verification using Groq API
- Zero-hallucination guard rails via two-pass audit
- Bilingual support (English + Chinese)
- Audit logging via Idris (write-only) and Horus (read-only) bots
- Conditional Seed Metric injection (~300 token savings on non-seed queries)

### AI Processing Pipeline (7-Stage State Machine)
- **S-1**: Context Extraction (φ-8 message window, entity extraction)
- **S0**: Preflight (mode detection, routing, external data fetch)
- **S1**: Context Build (inject system prompts based on mode)
- **S2**: Reasoning (LLM call, ~1500 tokens)
- **S3**: Audit (LLM call, ~800 tokens)
- **S4**: Retry (search augmentation if audit rejected)
- **S5**: Personality (regex cleanup, NOT an LLM call)
- **S6**: Output (finalize DataPackage, stream via SSE)

**Complexity**: Best case 2 LLM calls (Reasoning + Audit), worst case 4 (with retry + re-audit).

### Sliding Window Memory
- 8-message context window per session
- Periodic summarization (5-sentence summaries every 2nd query)
- In-memory store (session context), Discord provides permanent retention
- Server restart clears context (acceptable for conversational AI)

### Search & Discovery
- Full-text indexing on message content
- Multilingual search support
- Metadata filtering (date range, sender, content type)
- DuckDuckGo + Brave Search integration for external data

## Advanced Features

### Nyan Protocol
System prompt framework for analytical reasoning with mandatory source requirements. Prevents LLM hallucinations via falsifiable thresholds (Seed Metric: Price/Income ratio).

### Seed Metric Conditional Injection
Detects seed-metric-related queries and conditionally loads proxy cascade (700sqm conversion rules, income proxy, P/I ratio methodology). Saves ~300 tokens on non-seed queries.

### Financial Physics System
4-tier architecture extending Nyan Protocol for financial cognition analysis.

### Legal Document Analysis
Auto-triggered extension for contract analysis with universal 7-section template.

### Φ-Dynamics & Ψ-EMA System
Multi-signal time series oscillator using robust signal processing and φ (1.618) as the measurement threshold. Φ-Dynamics is the theoretical framework (R = 1 + 1/R = φ), while Ψ-EMA is the three-dimensional measurement instrument.

**Glossary & Framing**: Ψ-EMA is a **general-purpose time series oscillator**, not stock-market-specific. Examples herein use capital markets due to data accessibility, but identical mathematics apply to climate (temperature dynamics), sports (win-rate momentum), demographics (population flows), and any system with stock/flow decomposition.

**Philosophical Foundation**: See `philosophy.md` for complete theoretical grounding: the **Time Series Fidelity Law** (0 + φ⁰ + φ¹ = φ²), its manifestation across all domains, the Möbius closure, and Buddhist Dependent Origination correspondence.

**Core Principle**: φ is **endogenous** - derived from the self-referential equation x = 1 + 1/x, the unique positive fixed point of self-similar recursion. The Ψ-EMA pipeline applies this derived constant as calibration thresholds.

**Measurement**: Ψ-EMA (θ, z, R) classifies system states across any domain via signal decomposition:
- **θ (Phase)**: atan2(Flow, Stock) - cycle position in 4 quadrants (0°-360°)
- **z (Anomaly)**: (Value - Median) / MAD - robust z-score, detects deviations beyond φ² threshold
- **R (Convergence)**: z(t)/z(t-1) - ratio of successive standardized values, classifies amplitude growth/decay/stability
- Uses Fibonacci EMA periods (13, 21, 34, 55) for consistency

**Substrate-Agnostic**: Same signal processing applies to any domain where Stock⊥Flow decomposition is valid.

## Security Architecture

### Push Guard vs Pull Action Pattern (O(1) Strategy)
- **Push Guard**: O(1) validation before expensive work (signature verification, routing flags, secret checks)
- **Pull Action**: On-demand work triggered only after guard passes (data fetching, LLM calls, parsing)
- Examples: Twilio signature verification → pull message routing; routing flags set → conditionally pull context injection
- Fail-closed startup checks for critical secrets; O(1) guards at all ingress points

### Hardened Security (10/10)
- **Sybil Attack Prevention**: Dual-layer rate limiting (in-memory + database). Limits: 3/hour per IP, 5/day per IP, 10/day per domain. Disposable email domains blocked.
- **JWT Security**: Issuer/audience validation, HS256 only, 15min access tokens, 7-day refresh tokens
- **Session Management**: SHA256 hashed session IDs, 1-hour TTL with 5-minute auto-cleanup
- **Tenant Key Hashing**: IP+UserAgent hashed with SHA256 (no raw PII stored)
- **Command Injection Prevention**: Strict ticker sanitization (A-Z0-9 only, 1-10 chars, must start with letter) before subprocess spawn
- **LLM Prompt Sanitization**: 50KB limit, control character removal before Groq API calls
- **XSS Prevention**: DOMPurify with strict allowed tags/attributes for all markdown rendering
- **CSP Compliance**: Strict Content Security Policy headers
- **Credential Isolation**: No secrets in codebase; all credentials via environment variables

### Discord Bot Architecture
- **Hermes** (φ): Write-only bot for creating archive threads
- **Thoth** (0): Read-only bot for mirroring messages
- **Idris** (ι): Write-only bot for AI audit logging
- **Horus** (Ω): Read-only bot for AI audit history

## User Preferences
- **Design**: Apple glassmorphism aesthetic with Discord-style message layout
- **Privacy**: Messages sent TO book only (not monitored)
- **Retention**: Permanent storage (no deletion of messages)
- **Security**: Multi-user authentication with audit logging
- **Compatibility**: Safari/iPad support (JWT localStorage + proper cookie handling)
- **UX**: Auto-expanding interface, responsive design, user-customizable layout, progressive disclosure for power features

## External Dependencies
- **Database**: PostgreSQL (Supabase)
- **WhatsApp**: Twilio WhatsApp Business API
- **Email**: Resend API
- **AI**: Groq API
- **Search**: DuckDuckGo Instant Answer API, Brave Search API
- **Forex**: fawazahmed0 Currency API
- **Document Parsing**: pdf-parse, tabula-js, exceljs, mammoth
