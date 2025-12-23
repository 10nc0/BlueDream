# Your Nyanbook~ 🌈

## Overview
"Your Nyanbook" is a multi-tenant SaaS messaging book designed to securely forward messages from WhatsApp to Discord. Its primary purpose is to provide permanent message retention via Discord threads and isolated data storage for each user. The project aims for zero-friction onboarding, a highly customizable interface, and offers a secure and efficient way for users to archive WhatsApp conversations, targeting individuals and small businesses needing reliable message retention and easy access. The project also features an AI Playground for multimodal interaction and an AI Audit System for message verification.

## User Preferences
- **Design**: Apple glassmorphism aesthetic with Discord-style message layout
- **Privacy**: Messages sent TO book only (not group monitoring)
- **Retention**: Permanent storage (no deletion of messages)
- **Security**: Multi-user authentication with audit logging
- **Compatibility**: Safari/iPad support (JWT localStorage + proper cookie handling)
- **UX**: Auto-expanding interface, responsive design, user-customizable layout, zero-friction onboarding (no webhook required), progressive disclosure for power features

## System Architecture
The system uses a Node.js backend with Express and a Single Page Application (SPA) frontend, featuring an Apple glassmorphism design and a Discord-style two-pane layout, with real-time updates and responsiveness.

**UI/UX Decisions:**
- **Adaptive Layout**: Desktop has resizable sidebar/header; mobile has automatic layout, harmonized header, and floating action zone.
- **Touch Interactions**: Optimized for iPhone with tap-to-zoom, swipe navigation, auto-hide elements, 48px touch targets, and momentum scrolling.
- **Visual Elements**: Cat animation in header, blinking date/time, Discord-style message layout.
- **Mobile Optimization**: Optimized for mobile real estate, especially in the Playground and Dashboard, to maximize message display area and minimize UI chrome.
- **Fixed Scroll Layout**: Header fixed at top, input fixed at bottom, only message area scrolls.
- **Foldable Device Support**: Detects foldable devices and adjusts layout for unfolded tablet mode.

**Technical Implementations:**
- **Authentication**: Email/password authentication using JWT tokens, role-based access control, and isolated user data storage, with secure password recovery via email.
- **Database**: PostgreSQL with multi-tenant architecture, using isolated schemas per user.
- **WhatsApp Integration**: Twilio-based messaging using WhatsApp Business API with a join-code-first routing architecture.
- **Media Handling**: WhatsApp media downloaded from Twilio and uploaded to Discord as native attachments.
- **Search & Metadata**: Enhanced search across messages and metadata, supporting multilingual text and full-text search indexing.
- **Real-time Updates**: Smart polling with `?after={messageId}`, auto-scroll, "New messages" banner, and jump-to-message functionality.
- **AI Audit System (Prometheus)**: AI-powered message verification using Groq API, providing general intelligence, zero-hallucination guard rails, bilingual support, and prompt-directed behavior. Audit results are logged via the Prometheus Trinity Discord bots.
- **AI Playground**: A sovereign, public AI playground at `/AI` without authentication, offering multimodal support (Text, Photo, Audio, Documents), multi-file upload, dynamic capacity sharing, and abuse prevention. It features query classification, smart retry mechanisms, document parsing, and a search cascade for real-time knowledge.
    - **Preflight Router**: Unified Stage 0+1 pre-processing for mode detection, ticker extraction, and stock data fetching.
    - **Context Extractor**: Extracts entities from conversation history for context-aware routing and two-step conversations.
    - **φ-Compressed Memory**: An episodic memory system using a per-session 8-message sliding window with φ-compression for summaries.
    - **Pipeline Orchestrator**: A 7-step state machine for AI processing (Context → Preflight → Context Build → Reasoning → Audit → Retry → Output) with automatic retry on audit failure.
    - **Three-Pass Verification**: Draft, Audit (with potential correction), and Personality formatting for responses, including dual-mode auditing.
    - **Audio Accessibility**: Mic button recordings are treated as user queries for voice interaction.
    - **Streaming Token Output**: Real-time SSE streaming for "watching it think" UX.
- **Nyan Protocol (Permanent Seed Context)**: A specific protocol for historical comparison and socio-economic analysis using the Seed Metric (P/I ratio). It's a sacred, always active Step 0 protocol.
- **Financial Physics System**: A 4-tier architecture for financial cognition, extending the NYAN Protocol.
- **Legal Document Analysis System**: Stage 1+ extension for contract/agreement analysis, auto-triggered by legal keywords, providing a universal 7-section template.
- **Ψ-EMA System**: Multi-Dimensional Wave Function Dashboard implementing Financial Quantum Mechanics. It analyzes financial time series using three orthogonal dimensions (Phase θ, Anomaly z, Convergence R) with Fibonacci EMA periods. It includes real-time stock integration using yfinance for historical prices and SEC EDGAR for fundamental metrics, with smart and three-tier ticker detection.
    - **Dual Timeframe Analysis** (Dec 23, 2025): Default shows BOTH Daily (1d) AND Weekly (7d) Ψ-EMA analysis to avoid daily noise bias
    - **Optimized Data Fetching**: Exact period strings (3mo daily, 13mo weekly). Weekly candles = compressed OHLC snapshots (like blockchain blocks), no gap filling needed
    - **Fidelity Proxying** (Dec 23, 2025): φ-interpolation for small gaps (2-3 days/weeks only), marked with * for transparency. Never extrapolates beyond latest historical date. Fidelity grading (A/B/C/D) handles data quality signaling instead of hard gates
    - **Atomic Unit of Compression**: TIME (quarter/semester/annum) for stocks; HOUSEHOLD for future individual scope
    - **LOW_SIGNAL Consolidation Fix** (Dec 23, 2025): When z-score near zero (z < 0.15σ), R ratio becomes undefined. Instead of false "decay" diagnosis, system now outputs "⚪ R Undefined (Consolidation Zone)" with warning. Low z at high price = price tracking median (consolidation at highs), NOT momentum loss. Prevents inverted diagnoses like "decay" when stock is at all-time highs.
- **Financial Microbiology** (Dec 23, 2025): Economic pathology framework treating companies as organisms:
    - **Economic Pathogens**:
      - 🦠 **Ponzi Virus**: R > 2.5 (unsustainable acceleration, new capital feeds old obligations)
      - 🎈 **Bubble Cancer**: z > +3σ AND R > 2.0 (unchecked exponential growth, price disconnected from fundamentals)
      - 🧟 **Zombie Debt Bacteria**: Debt service ratio > 1.0 (interest exceeds income capacity)
    - **Stage Classification**: Stage I-IV based on severity (like cancer staging)
    - **Clinical Report Generator**: Produces pathology-style reports with Patient, Vital Signs, Diagnosis, Microscopy, Prognosis, Treatment
    - **Pipeline Integration**: AI responses use medical/pharmaceutical language when pathogens detected
    - **LOL = Ledger Observation Laboratory**: "Economic microbiology is what happens when we actually LOOK."
    - **2-Pass Audit Integration**: Clinical findings (vital signs, diagnosis, treatment, prognosis) pass through audit verification and are exactly preserved in personality formatting layer
- **H₀ Physical Audit Disclaimer** (Dec 23, 2025): "Seeing is believing" company financial verification for Financial Physics:
    - **H₀ PHYSICAL AUDIT ADVISORY**: Grounds spreadsheet numbers in physical reality verification
    - **Verification Methods**: 
      - Warehouse visits (stock taking) to verify inventory claims
      - Sample PO/AR/vendor verification to confirm receivables
      - Customer site visits to validate revenue relationships
      - Truck counting/shipments as proxy for P × Q correlation
      - Bank statement reconciliation for cash flow verification
    - **Philosophy**: Numbers without physical substrate are hallucinations. P (price) must correspond to actual Q (quantity).
    - **Pipeline Integration**: Automatically appended to Ψ-EMA + Financial Microbiology outputs
    - **Personality Preservation**: H₀ disclaimer preserved exactly through audit and formatting layers

**System Design Choices:**
- **Multi-Tenant Isolation**: Complete data separation via database schemas.
- **Zero-Friction Onboarding**: WhatsApp deep link activation.
- **Scalability & Recovery**: Designed for Replit Autoscale, PostgreSQL stores all book state for recovery.
- **Security**: Strict webhook validation, JWT security, robust audit logging, Sybil attack prevention, and CSP compliance.
- **Discord Bot Trinity Architecture**:
    - **Human Trinity**: Hermes (write-only), Thoth (read-only).
    - **Prometheus Trinity**: Idris (AI write-only for logs/audits), Horus (AI read-only for audit history).

## External Dependencies
- **Database**: PostgreSQL (Supabase)
- **WhatsApp**: Twilio WhatsApp Business API
- **Email**: Resend API
- **AI**: Groq API
- **Search**: DuckDuckGo Instant Answer API, Brave Search API
- **Document Parsing Libraries**: `pdf-parse`, `tabula-js`, `exceljs`, `mammoth`