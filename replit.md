# Your Nyanbook~ 🌈

## Overview
"Your Nyanbook" is a post-folder and post-filing structure archiving architecture, currently supporting records via WhatsApp -> Twilio -> Local / Discord channel flows. It aims to provide a zero-friction, highly customizable, secure, and efficient way to archive documents, photos, and drive links for individuals, businesses, and public organizations, promoting data sovereignty. The project envisions a future with sovereign, secure, and efficient remote storage infrastructure and remote inference (AI as compression and acceleration).

## User Preferences
- **Design**: Apple glassmorphism aesthetic with Discord-style message layout
- **Privacy**: Messages sent TO book only (not group monitoring) -> can be forwarded to group via webhooks
- **Security**: Multi-user authentication with audit logging
- **Compatibility**: Safari/iPad support (JWT localStorage + proper cookie handling)
- **UX**: Auto-expanding interface, zero-friction onboarding, progressive disclosure for power features

## System Architecture
The system utilizes a Node.js backend with Express and a Single Page Application (SPA) frontend, featuring an Apple glassmorphism design and a Discord-style two-pane layout with real-time updates. It treats financial statements as physical systems, applying conservation laws and sustainability metrics.

**7-Layer AI Processing Pipeline:**
- **Layer 7: AI Interface** (user interaction)
- **Layer 6: Orchestration** (7-stage state machine)
- **Layer 5: Verification** (two-pass LLM output validation)
- **Layer 4: Memory & Context** (session state management)
- **Layer 3: Perception** (document parsing, financial physics)
- **Layer 2: Measurement** (3D financial analysis: θ, z, R)
- **Layer 1: Identity** (system prompts, routing)
- **Layer 0: Constants** (φ=1.618 thresholds, conservation laws)

**UI/UX Decisions:**
- Adaptive & Responsive Design for various devices.
- Enhanced Touch Interactions for mobile.
- Visuals include a cat animation, blinking date/time, Discord-style message layout, and fixed scroll for messages.

**Technical Implementations:**
- **Authentication**: Email/password with JWT, role-based access control, secure password recovery, isolated user data.
- **Database**: PostgreSQL with multi-tenant architecture using isolated schemas.
- **WhatsApp Integration**: Twilio-based messaging with WhatsApp Business API.
- **Media Handling**: WhatsApp media downloaded from Twilio and uploaded to Discord.
- **Search**: Enhanced search across messages and metadata.
- **Real-time Updates**: Smart polling, auto-scroll.
- **AI Audit System (Prometheus)**: AI-powered message verification using Groq API, logging results via Discord bots. Features general intelligence, zero-hallucination guard rails, bilingual support, and prompt-directed behavior.
- **AI Playground**: Public, unauthenticated multimodal AI playground with multi-file upload, dynamic capacity sharing, abuse prevention, query classification, smart retry, document parsing, and real-time knowledge search.
    - **AI Processing Pipeline**: A 7-stage state machine for context extraction, preflight, context building, reasoning, auditing, retrying, personality application, and output finalization.
    - **Sliding Window Memory**: 8-message context window with periodic summarization.
    - **DataPackage Flow**: JSON container per message, immutable after finalization.
- **Nyan Protocol**: System prompt framework for historical comparison and socio-economic analysis, using a Seed Metric to prevent LLM hallucinations via mandatory source requirements.
- **Financial Physics System**: 4-tier architecture extending NYAN Protocol for financial cognition.
- **Legal Document Analysis System**: Auto-triggered extension for contract analysis.
- **Φ-Dynamics & Ψ-EMA System**: Multi-signal time series oscillator using robust signal processing and φ (1.618) as the measurement threshold, applicable across various domains.
- **Unified Personality Layer**: Enforces formatting via regex post-processing.
- **Code Execution Honesty**: AI provides code for user execution but does not execute it itself.

**System Design Choices:**
- **Multi-Tenant Isolation**: Complete data separation via database schemas.
- **Zero-Friction Onboarding**: WhatsApp deep link activation.
- **Scalability & Recovery**: Designed for Replit Autoscale, PostgreSQL for state recovery.
- **Push Guard vs Pull Action Pattern**: O(1) validation before expensive work.
- **Security (10/10 Hardened)**: Sybil attack prevention, JWT security, session management, tenant key hashing, command injection prevention, LLM prompt sanitization, XSS prevention, CSP compliance.
- **Discord Bot Trinity Architecture**: Hermes (write-only), Thoth (read-only), Idris (AI write-only), Horus (AI read-only).
- **Route Modularization**: Factory pattern with dependency injection for scalable and maintainable routing.
- **AI Architecture Split**: Nyan AI (public playground) and Prometheus AI (authenticated ledger auditor) for independent rate limiting and security.
- **Inpipe Architecture**: Multi-channel input with an abstract channel interface for extensibility.

## External Dependencies
- **Database**: PostgreSQL (Supabase)
- **WhatsApp**: Twilio WhatsApp Business API
- **Email**: Resend API
- **AI**: Groq API
- **Search**: DuckDuckGo Instant Answer API, Brave Search API
- **Forex**: fawazahmed0 Currency API
- **Document Parsing Libraries**: `pdf-parse`, `tabula-js`, `exceljs`, `mammoth`