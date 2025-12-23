# Your Nyanbook~ 🌈

## Overview
"Your Nyanbook" is a multi-tenant SaaS messaging book designed to securely forward messages from WhatsApp to Discord, providing permanent message retention via Discord threads and isolated data storage per user. It aims for zero-friction onboarding, a highly customizable interface, and offers a secure, efficient way to archive WhatsApp conversations for individuals and small businesses. Key features include an AI Playground for multimodal interaction and an AI Audit System for message verification. The project has a business vision to provide a secure and efficient archiving solution for WhatsApp conversations, with market potential in individual users and small businesses seeking reliable message retention and advanced AI interaction.

## User Preferences
- **Design**: Apple glassmorphism aesthetic with Discord-style message layout
- **Privacy**: Messages sent TO book only (not group monitoring)
- **Retention**: Permanent storage (no deletion of messages)
- **Security**: Multi-user authentication with audit logging
- **Compatibility**: Safari/iPad support (JWT localStorage + proper cookie handling)
- **UX**: Auto-expanding interface, responsive design, user-customizable layout, zero-friction onboarding (no webhook required), progressive disclosure for power features

## System Architecture
The system employs a Node.js backend with Express and a Single Page Application (SPA) frontend, featuring an Apple glassmorphism design and a Discord-style two-pane layout with real-time updates. The core paradigm treats financial statements as physical systems, applying conservation laws and sustainability metrics.

**7-Layer Stack:**
- **Layer 7: AI Interface** (Human interaction)
- **Layer 6: Orchestration** (7-stage processing pipeline)
- **Layer 5: Verification** (Audit protocol)
- **Layer 4: Memory & Context** (Data persistence)
- **Layer 3: Perception** (Universal ingestion)
- **Layer 2: Measurement** (Wave function observer)
- **Layer 1: Identity** (Compressed seed protocol)
- **Layer 0: Invariant** (Unconditioned attractor)

**UI/UX Decisions:**
- **Adaptive & Responsive Design**: Resizable elements for desktop, mobile-optimized layouts, and foldable devices.
- **Touch Interactions**: Enhanced for mobile with tap-to-zoom, swipe navigation, auto-hide elements, and momentum scrolling.
- **Visuals**: Cat animation, blinking date/time, Discord-style message layout, and a fixed scroll layout for messages.

**Technical Implementations:**
- **Authentication**: Email/password authentication using JWT tokens, role-based access control, secure password recovery, and isolated user data.
- **Database**: PostgreSQL with multi-tenant architecture using isolated schemas per user.
- **WhatsApp Integration**: Twilio-based messaging with WhatsApp Business API and a join-code-first routing.
- **Media Handling**: WhatsApp media downloaded from Twilio and uploaded to Discord.
- **Search**: Enhanced search across messages and metadata, including multilingual and full-text indexing.
- **Real-time Updates**: Smart polling, auto-scroll, and "New messages" banner.
- **AI Audit System (Prometheus)**: AI-powered message verification using Groq API, logging results via Prometheus Trinity Discord bots. Includes general intelligence, zero-hallucination guard rails, bilingual support, and prompt-directed behavior.
- **AI Playground**: A public, unauthenticated multimodal AI playground at `/AI` with features like multi-file upload, dynamic capacity sharing, abuse prevention, query classification, smart retry, document parsing, and real-time knowledge search.
    - **AI Processing Pipeline (7-Stage State Machine)**:
        - S-1: Context Extraction (φ-8 message window, entity extraction)
        - S0: Preflight (mode detection, routing, external data fetch)
        - S1: Context Build (inject system prompts based on mode)
        - S2: Reasoning (LLM call, O(tokens), ~1500 tokens)
        - S3: Audit (LLM call, O(tokens), ~800 tokens)
        - S4: Retry (search augmentation if audit rejected)
        - S5: Personality (regex cleanup, O(n) string ops, NOT an LLM call)
        - S6: Output (finalize DataPackage, store in φ-8 window)
        - **Complexity**: Best case 2 LLM calls (Reasoning + Audit), worst case 4 (with retry + re-audit). Personality is regex-based `applyPersonalityFormat()` + chunked SSE streaming via `fastStreamPersonality()`.
    - **φ-Compressed Memory**: Episodic memory system using an 8-message sliding window with φ-compression.
    - **DataPackage Sovereign Data Flow**: Each message carries a sovereign DataPackage (JSON container) through the pipeline. Fractal storage: Tenant (IP) → 8 message window → each message's DataPackage. Stages WRITE to package (immutable after finalize), personality layer strips fluff but NEVER alters data. Principle: "Data enters → transmutes → never hallucinates".
    - **DataPackage Store Design**: Intentionally in-memory (φ-8 window for session context). Discord provides permanent retention; RAM provides speed. Server restart = fresh context (acceptable for conversational AI).
- **Nyan Protocol (Permanent Seed Context)**: A protocol for historical comparison and socio-economic analysis using the Seed Metric (P/I ratio) to prevent LLM hallucinations.
- **Financial Physics System**: A 4-tier architecture extending the NYAN Protocol for financial cognition.
- **Legal Document Analysis System**: Auto-triggered extension for contract analysis, providing a universal 7-section template.
- **Ψ-EMA System (Financial Quantum Mechanics)**: A Multi-Dimensional Wave Function Dashboard for financial time series analysis using three orthogonal dimensions: θ (Phase), z (Anomaly), and R (Convergence). It uses Fibonacci EMA periods and φ-derived thresholds.
    - **Financial Microbiology**: An economic pathology framework for companies, identifying "Economic Pathogens" (Ponzi Virus, Bubble Cancer, Zombie Debt Bacteria) with stage classification and a clinical report generator.
- **Unified Personality Layer**: All formatting enforced in `applyPersonalityFormat()` in `pipeline-orchestrator.js` to remove "fluff patterns" via regex post-processing.
- **Code Execution Honesty**: AI provides code for user execution, but does not execute it itself.
- **H₀ Physical Audit Disclaimer**: Advisory appended to financial outputs, emphasizing physical reality verification methods.

**System Design Choices:**
- **Multi-Tenant Isolation**: Complete data separation via database schemas.
- **Zero-Friction Onboarding**: WhatsApp deep link activation.
- **Scalability & Recovery**: Designed for Replit Autoscale, PostgreSQL for state recovery.
- **Security**: Strict webhook validation, JWT security, robust audit logging, Sybil attack prevention, and CSP compliance.
- **Discord Bot Trinity Architecture**: Hermes (write-only), Thoth (read-only), Idris (AI write-only for logs/audits), Horus (AI read-only for audit history).

## External Dependencies
- **Database**: PostgreSQL (Supabase)
- **WhatsApp**: Twilio WhatsApp Business API
- **Email**: Resend API
- **AI**: Groq API
- **Search**: DuckDuckGo Instant Answer API, Brave Search API
- **Forex**: fawazahmed0 Currency API
- **Document Parsing Libraries**: `pdf-parse`, `tabula-js`, `exceljs`, `mammoth`