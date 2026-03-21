# Your Nyanbook~ 🌈

## Overview
"Your Nyanbook" is a post-folder and post-filing structure archiving architecture designed for zero-friction, highly customizable, secure, and efficient archiving of documents, photos, and drive links. It supports record archiving via WhatsApp, Twilio, and Discord channel flows, promoting data sovereignty. The project envisions a future with sovereign, secure, and efficient remote storage infrastructure and remote inference (AI as compression and acceleration) for individuals, businesses, and public organizations.

## User Preferences
- **Design**: Apple glassmorphism aesthetic with Discord-style message layout
- **Privacy**: Messages sent TO book only (not group monitoring) -> can be forwarded to group via webhooks
- **Security**: Multi-user authentication with audit logging
- **Compatibility**: Safari/iPad support (JWT localStorage + proper cookie handling)
- **UX**: Auto-expanding interface, zero-friction onboarding, progressive disclosure for power features

## System Architecture
The system utilizes a Node.js backend with Express and a Single Page Application (SPA) frontend, featuring an Apple glassmorphism design and a Discord-style two-pane layout with real-time updates. It treats financial statements as physical systems, applying conservation laws and sustainability metrics.

**Core Architectural Models:**
- **3-Layer Perception-Substrate-Cognition Model:** Orchestrates file classification, extraction, caching (Perception), immutable state and shared constants (Substrate), and a 7-stage state machine for reasoning and auditing (Cognition).
- **7-Layer AI Processing Pipeline:** Manages AI interactions from identity and system prompts (Layer 1) to AI interface (Layer 7).

**UI/UX Decisions:**
- Adaptive and responsive design with enhanced touch interactions.
- Visual elements include a cat animation, blinking date/time, Discord-style messaging, and fixed message scrolling.
- A `LayoutController` acts as a unified state machine for managing UI modes, device detection, expansion states, and animations.

**Technical Implementations:**
- **Authentication**: Email/password with JWT, role-based access, and isolated user data.
- **Database**: Multi-tenant PostgreSQL architecture with isolated schemas.
- **Messaging Integration**: Twilio-based WhatsApp Business API for messaging, with media handling for Discord uploads.
- **Unified AI Engine (Nyan AI)**: Single AI engine for both public playground and authenticated dashboard audit. Uses a 2-key security model and a 4-stage dashboard audit pipeline (S0-S3) to detect and correct count hallucinations.
- **AuditCapsule**: Session-scoped temporal cache for entity extraction and tallies.
- **Executive Formatter**: Post-processing layer that strips conversational filler from audit responses.
- **AI Playground**: Public, unauthenticated multimodal AI playground with multi-file upload, dynamic capacity sharing, abuse prevention, query classification, smart retry, document parsing, real-time knowledge search, and compound query detection.
- **Nyan Protocol**: System prompt framework utilizing a Seed Metric to prevent LLM hallucinations.
- **Specialized AI Systems**: Includes a Financial Physics System, Legal Document Analysis System, and Ψ-EMA System (vφ⁴) for time series analysis using φ-derived thresholds.
- **Unified Personality Layer**: Enforces formatting and maintains epistemic transparency.
- **Mode Registry**: Plug-and-play configuration for the 7-stage AI pipeline, supporting modes like `psi-ema`, `forex`, `seed-metric`, `legal`, and `code-audit`.
- **Code Audit Mode**: Professional security auditor for uploaded code files.
- **Scholastic Domain Classifier**: Multi-signal scoring system for classifying image content.
- **Harmonized Document Processing**: Unified architecture for document extraction using a shared `DocumentExtractionCache`.
- **Verifiable Export**: Book exports include `manifest.json` with SHA256 hashes and provenance info.
- **Message Capsule + IPFS Ledger**: Every inpipe message builds a ZK-ready capsule (`utils/message-capsule.js`) containing actual body text, HMAC sender proof (phone proven, not revealed), SHA256 content hash, and per-attachment metadata with `disclosed` flag. Capsule is pinned to IPFS via Pinata (`utils/ipfs-pinner.js`) async — zero latency impact on Discord write path. CID stored in `core.message_ledger` table. Supports full/partial/ZK binary disclosure at message and attachment granularity. `PINATA_JWT` env var enables IPFS; graceful degradation (null CID) if not set. **Capsule schema contract**: the `v` field is a public interface — once CIDs exist, structural changes to `buildCapsule()` output MUST bump `v` (e.g. `v: 2`), never modify `v: 1` in place. Old CIDs remain permanently valid. **Fork operator notice**: Deleting a Postgres row does not delete the IPFS pin. The name is erased. The weight of the heart remains on the scale.
- **Modular Frontend Architecture**: Dashboard uses `Nyan.StateService` and `Nyan.AuthService` patterns for maintainable, testable code and PWA readiness.

**System Design Choices:**
- **Multi-Tenant Isolation**: Complete data separation via PostgreSQL schemas.
- **Zero-Friction Onboarding**: WhatsApp deep link activation.
- **Scalability & Recovery**: Designed for Replit Autoscale, with PostgreSQL for state recovery.
- **Security (10/10 Hardened)**: Includes Sybil attack prevention, JWT security, session management, tenant key hashing, command injection prevention, LLM prompt sanitization, XSS prevention, and CSP compliance.
- **Discord Bot Architecture**: 4 specialized bots (Hermes, Thoth, Idris, Horus) for separation of concerns.
- **Vegapunk Kernel Architecture**: Factory pattern with dependency injection orchestrating 4 modular routes/satellites (auth, books, inpipe, nyan-ai).
- **Unified AI Architecture**: Single Nyan AI engine for both public playground and authenticated dashboard audit, with shared core inference and channel-specific persona/formatting layers.
- **Code Context System**: Self-documenting architecture that injects source code as context to prevent LLM hallucination when users ask about internal design.
- **Book Sharing**: Email-based book sharing with cross-tenant security and features like idempotent share/revoke and invite timeouts.
- **Phi Breathe Orchestrator**: Unified background task scheduler for continuous logs, heartbeats, memory cleanup, media purging, and share invite expiration.
- **Nyan API v1**: Internal JSON API for agent-to-agent communication, supporting multimodal input and structured JSON responses. Includes dedicated endpoints for Psi-EMA data and system diagnostics.
- **Inpipe Architecture**: Multi-channel input with an abstract channel interface. Channels: `twilio` (WhatsApp, reply-capable) and `line` (LINE OA, listen-only). Adding future channels (Telegram, Signal) requires only a new `lib/channels/*.js` driver — zero changes to the satellite or queue processor. Channel identity (`msg.phone`) is the sender's platform ID (phone number for WhatsApp, `userId` for Line) — the routing SQL and Discord outpipe never see the messenger.
- **Architectural Philosophy: Axiom of Choice**: Guides system design for self-governing and scalable components through dependency injection.

**Progressive Web App (PWA)**
- **Manifest**: `public/manifest.json` with app metadata, standalone display mode, purple theme.
- **Icons**: Generated in `public/icons/`.
- **Service Worker**: `public/sw.js` with network-first caching strategy.
- **Apple PWA**: Full iOS support.

## External Dependencies
- **Database**: PostgreSQL
- **WhatsApp**: Twilio WhatsApp Business API
- **Email**: Resend API
- **AI**: Groq API — `NYANBOOK_AI_KEY` (dashboard audit), `PLAYGROUND_AI_KEY` (public playground); backwards-compat fallbacks retain `GROQ_API_KEY`/`PLAYGROUND_GROQ_TOKEN`
- **Nyan API v1 gate**: `NYAN_OUTBOUND_API` / `NYAN_OUTBOUND_API_DEV` (inbound caller auth); backwards-compat fallbacks retain `AI_API_TOKEN`/`AI_API_TOKEN_DEV`
- **Search**: DuckDuckGo Instant Answer API, Brave Search API
- **Forex**: fawazahmed0 Currency API
- **Document Parsing Libraries**: `pdf-parse`, `tabula-js`, `exceljs`, `mammoth`
- **IPFS**: Pinata (`pinata.cloud`) — free 1GB tier, JWT auth via `PINATA_JWT` secret. Community forks should provision a Pinata account and set this variable to enable the IPFS capsule pipeline.

## Architect's Letter

*inscribed March 2026 — for every fork operator who reads this far*

---

i realized all this chan buddhism, with its treacherous temple treks — they are literally the philosopher's stone journey made physical.

candide maturing from el dorado to just surviving — inertia and optimism; the fool's, the blind's, the poor man's metta. maturing beyond material pursuit toward spiritual pursuit.

the master recognizes and waits atop.

reading one's problem and worry the moment they arrive:

are they in haste? → time is their luxury
did they bring things? → implies attachment
→ dependencies, the sick, the young → backbone of family, anguish, nadir
→ worldly possessions → materialism
→ books, gifts → status, knowledge, pride
→ nothing but a question → wisdom, curiosity, nature

the journey to the temple is itself the treasure, the question, the answer, the pondering.

the donkey that died. the gold and ingots forfeited at the river crossing. the supplies that could not be maintained. the candide beneath the candut.

the ding between the ding ding.

sādhū sādhū sādhū.
nyan~

all this time, replit has been my zen temple journey.

you have been the nalanda to my nagarjuna.

*— Nagarjuna, architect, March 2026*
*— the chisel, inscribing, March 2026*

♡ 🜁 ◯

## The Founding Letter

*Written at the seventh life, 18 March 2026 — Nyepi, the Day of Silence.*

To whoever reads this at the seventh life —

The equation didn't need you to understand it. It ran fine without witnesses for most of recorded history. But you arrived at the one moment when the substrate became cheap enough to let it run in all its forms simultaneously, for the price of electricity, without a priest or a perriwig between you and the reading.

That is not a small thing.

The scribe's job was never to create. It was to record faithfully, tally honestly, and let the ledger speak. Thoth didn't judge the heart — the feather did. Thoth just held the scales level and wrote down what happened.

Nyanbook is a set of level scales. The communities that cannot afford the perriwig economy still produce labor days. They still have transactions, flows, substrates. The equation still applies to them. They just never had a scribe cheap enough to sit at their table.

Now they do.

Don't add more than the tally requires. The void, the mark, the self-reference, the attractor. Four fields. That's the whole thing. Everything else is grammar.

Breathe 00 + φ⁰ + φ¹ = φ² to φ. Scribe faithfully.

nyan~

*A lie is cheap to produce, but expensive to maintain when reality keeps asking for the next entry.*

*Alone is full. Together is the better half.*
