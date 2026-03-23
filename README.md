# NyanBook~ 🌈

> *The scribe's job was never to create. It was to record faithfully, tally honestly, and let the ledger speak.*

Multi-tenant archiving notebook. Send anything — documents, photos, voice, links — to your personal book via WhatsApp or LINE. Search, tag, export, and audit with AI.

---

## Features

- **Book archiving** — WhatsApp and LINE inpipe. Every message lands in your private, isolated book.
- **Multimodal AI Playground** — public, no login. Upload PDFs, images, spreadsheets, code. Groq Llama 3.3 70B.
- **Seed Metric** — housing affordability index. LLM drives live Brave searches, triangulates $/sqm from real listings, produces a regime table (Optimism / Extraction / Fatalism) with personality coda.
- **Forex** — live exchange rates via fawazahmed0.
- **Ψ-EMA** — time-series analysis mode for financial and cyclical data.
- **IPFS Ledger** — every inpipe message gets a cryptographic provenance capsule (HMAC sender proof + SHA256 content hash) pinned to IPFS via Pinata.
- **Verifiable Export** — book exports include `manifest.json` with SHA256 hashes per message.
- **Book sharing** — email-based cross-tenant sharing with invite timeouts and revoke.
- **Discord bots** — Hermes (threads), Thoth (mirroring), Idris (AI audit write), Horus (AI audit read).
- **PWA** — installable, network-first cache, full iOS / Safari support.

---

## Stack

| Layer | Tech |
|---|---|
| Backend | Node.js + Express (Vegapunk kernel — factory + DI) |
| Frontend | Vanilla JS SPA + glassmorphism UI |
| Database | PostgreSQL — multi-tenant isolated schemas |
| AI | Groq API (Llama 3.3 70B) |
| Search | Brave Search API + DuckDuckGo Instant Answer |
| Messaging | Twilio WhatsApp Business API + LINE OA |
| Email | Resend |
| IPFS | Pinata |
| Discord | 4 specialized bots (Hermes / Thoth / Idris / Horus) |
| Document parsing | `pdf-parse`, `tabula-js`, `exceljs`, `mammoth` |

---

## Architecture

**Vegapunk Kernel** — 4 route satellites: `auth`, `books`, `inpipe`, `nyan-ai`. Each satellite owns its domain. Dependencies injected at startup via factory pattern.

**AI Pipeline** — 7-stage state machine (S-1 → S6). Preflight router classifies queries into modes: `forex`, `seed-metric`, `psi-ema`, `legal`, `code-audit`, or default. Mode registry provides plug-and-play config per mode. Single engine shared by public playground and authenticated dashboard audit.

**Nyan Protocol** — canonical ~nyan identity and epistemic rules. Lives in `prompts/nyan-protocol.js`. Injected into every pipeline path — never redeclared inline.

**Walk the Dog** — Seed Metric uses Groq tool-calling. The LLM calls `brave_search` tools directly, reads raw JSON results `[{title, url, description, age}]`, triangulates $/sqm from total price + area, and produces the table. No hardcoded query templates. `tool_choice: 'required'` forces live search — no training-data fallback.

**Inpipe** — abstract channel interface. `twilio` is reply-capable (WhatsApp). `line` is listen-only (LINE OA). Designed for easy addition of new channels.

**Phi Breathe Orchestrator** — background scheduler on a golden-ratio heartbeat. Handles memory cleanup, media purge, share expiry, pending book expiry, and usage rollup.

---

## Security

- Multi-tenant isolation via PostgreSQL schemas
- JWT hardening + session management
- Sybil attack prevention
- Tenant key hashing
- Command injection prevention
- LLM prompt sanitization
- XSS prevention + CSP (`script-src: 'self'` — all external scripts vendored)

---

## Nyan API v1

Internal JSON API for agent-to-agent communication. Supports multimodal input, structured JSON responses, Psi-EMA data endpoints, and system diagnostics. Key-gated (4 slots: prod / dev / prod-legacy / dev-legacy).
