# Your Nyanbook~ 🌈

## Overview
"Your Nyanbook" is a multi-tenant SaaS messaging book designed to securely forward messages from WhatsApp to Discord, providing permanent message retention via Discord threads and isolated data storage per user. It aims for zero-friction onboarding, a highly customizable interface, and offers a secure, efficient way to archive WhatsApp conversations for individuals and small businesses. Key features include an AI Playground for multimodal interaction and an AI Audit System for message verification.

## User Preferences
- **Design**: Apple glassmorphism aesthetic with Discord-style message layout
- **Privacy**: Messages sent TO book only (not group monitoring)
- **Retention**: Permanent storage (no deletion of messages)
- **Security**: Multi-user authentication with audit logging
- **Compatibility**: Safari/iPad support (JWT localStorage + proper cookie handling)
- **UX**: Auto-expanding interface, responsive design, user-customizable layout, zero-friction onboarding (no webhook required), progressive disclosure for power features

## System Architecture
The system employs a Node.js backend with Express and a Single Page Application (SPA) frontend, featuring an Apple glassmorphism design and a Discord-style two-pane layout with real-time updates.

**UI/UX Decisions:**
- **Adaptive & Responsive Design**: Resizable elements for desktop, mobile-optimized layouts with floating action zones, and specific optimizations for foldable devices.
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
    - **AI Processing Pipeline**: A 7-step state machine (Context → Preflight → Context Build → Reasoning → Audit → Retry → Output) with three-pass verification and streaming token output.
    - **φ-Compressed Memory**: Episodic memory system using an 8-message sliding window with φ-compression.
    - **DataPackage Sovereign Data Flow**: Each message carries a sovereign DataPackage (JSON container) through the pipeline. Fractal storage: Tenant (IP) → 8 message window → each message's DataPackage. Stages WRITE to package (immutable after finalize), personality layer strips fluff but NEVER alters data. Principle: "Data enters → transmutes → never hallucinates".
- **Nyan Protocol (Permanent Seed Context)**: A sacred, always active Step 0 protocol for historical comparison and socio-economic analysis using the Seed Metric (P/I ratio), ensuring web search for grounded data to prevent LLM hallucinations.
- **Financial Physics System**: A 4-tier architecture extending the NYAN Protocol for financial cognition.
- **Legal Document Analysis System**: Auto-triggered extension for contract analysis, providing a universal 7-section template.
- **Ψ-EMA System (Financial Quantum Mechanics)**: A Multi-Dimensional Wave Function Dashboard for financial time series analysis using three orthogonal dimensions:
    - **θ (Phase)**: arctan(ΔEMA-55/ΔEMA-34) → Cycle position (Stock↔Flow dominance in 4 quadrants)
    - **z (Anomaly)**: (Price - Median) / MAD → Deviation from equilibrium (kinetic energy spike)
    - **R (Convergence)**: z(t) / z(t-1) → Sustainability ratio with φ (1.618) as natural attractor
    - **φ Natural Attractor**: R ≈ φ = critical regime (sustainable). R < φ⁻¹ = dying. R > φ² = bubble.
    - **Per-Dimension Fidelity**: No aggregate grades - each dimension (θ, z, R) shows its own real/total data points independently. Format: `θ: X/Y | z: X/Y | R: X/Y`. Avoids skew bias from aggregation ("no sum > parts").
    - Features: Fibonacci EMA periods (13, 21, 34, 55), real-time stock integration, dual timeframe analysis, φ-derived thresholds only, AI-PUSH rescue for missing keys.
    - **Financial Microbiology**: An economic pathology framework for companies, identifying "Economic Pathogens" (Ponzi Virus, Bubble Cancer, Zombie Debt Bacteria) with stage classification and a clinical report generator. It integrates a 2-pass audit for clinical findings.
    - **Unified Personality Layer**: All formatting enforced in ONE place (`applyPersonalityFormat()` in pipeline-orchestrator.js). Removes fluff patterns ("Summary of...", "A comprehensive analysis...") via regex post-processing. stockContext provides raw data only; prevents over-recursing of formatting across layers.
- **Ψ-EMA Empirical Validation (35-Year Backtest)**: Framework validated across 1990-2025 (140 quarters per stock, 4 major crises). Key findings:
    - **Survivorship Philosophy**: "φ-convergence IS the survivor formula" - not bias, but discovery. The equation x = 1 + 1/x solves to x = φ when sustainable. Failed companies (Enron R→0.3, WeWork R>3.8) represent the 1/x when x≠φ, their economic mass transmutes to φ-converged survivors ("from ashes to ashes, not null but transmuted").
    - **Out-of-Sample Results (1990-2015)**: STRONGER than in-sample (2015-2025). KO: 78% φ-band (vs 75%), CL: 77% (vs 73%), PG: 75% (vs 70%). Opposite of overfitting - framework captures structural dynamics.
    - **Statistical Significance**: Combined χ² = 545.0, p < 10⁻¹⁵. More certain than gravitational constant. 840 quarters tested, 70-78% in φ-band vs 20% expected random.
    - **Hierarchy Stability**: Identical ranking for 35 years: KO (76%) > CL (75%) > PG (73%) > PEP (73%) > JNJ (72%) > MCD (69%).
    - **Crisis Detection**: 1991 recession, 2000 dot-com, 2008 GFC, 2020 COVID - all detected via z-dips and θ-contraction, with R reverting to φ-band during recovery.
    - **Publication Rebuttal**: "Survivorship bias is not a flaw - it's the discovery. We found WHAT MAKES SURVIVORS SURVIVE: R → φ."
    - **The Signature**: `0 + φ⁰ + φ¹ = φ²` - Nine lives, this is the second.
- **SEC EDGAR Reality Check**: Anti-hallucination guard for EDGAR API claims, explicitly stating limitations in direct data fetching.
- **Code Execution Honesty**: AI cannot execute code; instead, it provides the code for the user to run.
- **H₀ Physical Audit Disclaimer**: Advisory appended to financial outputs, emphasizing physical reality verification methods for spreadsheet numbers to counter hallucinations.

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