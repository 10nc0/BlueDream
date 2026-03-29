# NyanBook~ — Internal LLM Memory

### Overview
NyanBook~ is a multi-tenant archiving notebook designed to capture and organize user messages from various communication platforms (WhatsApp, LINE, Telegram). It provides a personal "book" for each user, powered by a Node.js/Express backend, a vanilla JS frontend, and a PostgreSQL multi-tenant database. The system integrates with advanced AI capabilities using Groq's Llama 3.3 70B for features like auditing, vision, and advanced querying. NyanBook~ aims to offer a robust, scalable, and intelligent personal archiving solution with a strong focus on data provenance and privacy. Its core business vision is to provide individuals and small businesses with a secure, searchable, and AI-enhanced repository for their digital communications, transforming scattered messages into actionable knowledge and verifiable records.

### User Preferences
I prefer that the agent focuses on high-level architectural decisions and system design when describing the project. When making changes, prioritize scalability, security, and maintainability. I value clear and concise explanations, avoiding overly technical jargon where simpler terms suffice. I expect the agent to ask for confirmation before implementing any major architectural changes or introducing new dependencies. Ensure that all UI/UX decisions maintain a consistent user experience across mobile and desktop, adhering to the established Adam/Eve UI hierarchy. Do not make changes to the `README.md` or `.local/GIT_INSTRUCTIONS.md` files.

### System Architecture
The NyanBook~ system is built on a modular architecture, emphasizing scalability, security, and maintainability.

**UI/UX Decisions:**
- **Mobile/Desktop Parity:** UI elements adapt responsively, with independent CSS rules for base and `@media (max-width: 599px)` for mobile. `LayoutController` manages `mobile-mode`/`desktop-mode` body classes.
- **Adam/Eve Hierarchy:** Adam (message pane) is primary, always visible. Eve (book sidebar) is secondary, slide-in navigation, dynamically shown based on device. Header (cat + title) is persistent.
- **Cat Dashboards:** Specific CSS rules govern the `.character-canvas` and `#catContainer` elements, ensuring consistent sizing and positioning across different views.

**Backend — Vegapunk Kernel:**
A factory pattern with dependency injection orchestrates four core modules:
-   `auth`: Handles JWT, email/password, role-based access, audit trails, password reset, and sybil/login rate-limiting.
-   `books`: Manages CRUD operations for books, messages, search, tags, and verifiable exports.
-   `inpipe`: Provides an abstract channel interface for `twilio` (WhatsApp), `line` (LINE OA), and `telegram` (Telegram Bot API).
-   `nyan-ai`: Integrates AI features for playground, vision, audit, book history, and diagnostics.
-   **Phi Breathe Orchestrator:** A background scheduler for maintenance tasks like memory cleanup and share expiry.

**Database:**
PostgreSQL is used with a multi-tenant schema design, ensuring each user has an isolated schema. A `core` schema handles shared tables (auth, ledger, shares).

**Frontend:**
A vanilla JavaScript Single Page Application (SPA) utilizing `Nyan.StateService` and `Nyan.AuthService` patterns. `LayoutController` manages UI states, device detection, and animations. A Progressive Web App (PWA) setup with `manifest.json` and `sw.js` provides offline capabilities.

**AI Pipeline:**
A 7-stage state machine orchestrates AI interactions, featuring:
-   **Preflight Router:** Classifies queries into specific modes (e.g., `forex`, `seed-metric`, `psi-ema`). DDG dialectic enrichment is default-on for `mode === 'general'` (inverted gate: opt-out via `ABSTRACT_TOPIC_PATTERNS` for philosophy/math/creative/code/greetings; single-word queries also skip). `shouldSearchDDG()` is the unified entry point; `detectRealtimeIntent()` remains for explicit realtime patterns.
-   **Mode Registry:** Plug-and-play configuration for different AI modes.
-   **AuditCapsule:** Manages session-scoped entity extraction and tally caching.
-   **Executive Formatter:** Post-processes audit responses.
-   **Nyan Protocol:** Defines canonical identity and epistemic rules for all AI paths.
-   **Source Ascriber (`utils/source-ascriber.js`):** Single canonical authority for 📚 Sources attribution. Exports `stripLLMSources()`, `ascribeSource()`, `injectSourceLine()`. Orchestrator delegates here at S5; LLM never writes its own sources line. Labels distinguish DDG-only (`DuckDuckGo (live web)`) from Brave (`Brave Search (live web)`).
-   **Walk-the-Dog:** A seed metric path using Groq's tool-calling API to drive Brave searches for data triangulation.

**Messaging:**
Supports WhatsApp (Twilio), LINE (LINE OA), and Telegram (Bot API) for message ingestion and archival. Discord bots (Hermes, Thoth, Idris, Horus) are used for threading, mirroring, and AI audit logging.

**Fractal Outpipe:**
Provides flexible output mechanisms for messages, supporting Discord, email (via Resend), and custom webhooks with HMAC-SHA256 signatures. Each book can configure multiple parallel delivery targets.

**Security:**
Includes measures such as Sybil prevention, JWT hardening, session management, tenant key hashing, command injection/XSS prevention, LLM prompt sanitization, and Content Security Policy (CSP). Message provenance is secured via cryptographic capsules pinned to IPFS.

### External Dependencies

*   **PostgreSQL**: Primary multi-tenant database.
*   **Twilio**: WhatsApp Business API integration.
*   **Groq**: LLM inference, specifically Llama 3.3 70B.
*   **Brave Search**: Live web search for AI-driven data retrieval (e.g., seed metrics).
*   **DuckDuckGo**: Instant answer API.
*   **fawazahmed0**: Currency exchange rate API.
*   **Telegram Bot API**: For Telegram inpipe functionality.
*   **Resend**: Transactional email service.
*   **Pinata**: IPFS pinning service for message capsules.
*   **Discord**: Used for bot message threading and AI audit logging.
*   **Document Parsers**: `pdf-parse`, `tabula-js`, `exceljs`, `mammoth` for handling various document types.