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

## AI Audit System
The Prometheus module (internal codename) provides AI-powered message verification using Groq API (llama-3.3-70b-versatile).

**Features:**
- **General Intelligence**: Single unified check powered by Groq's llama-3.3-70b-versatile model
- **H(0) Guard Rails**: Zero-hallucination protocol - flags uncertain data for human review
- **Bilingual Support**: Automatic Indonesian/English language detection and response
- **Prompt-Directed**: Direction and behavior controlled via system prompts, not rule type selection
- **UI Integration**: 🧿 AI Audit button in dashboard opens modal for message checking, 🧠 History button shows audit history

**API Endpoints:**
- `POST /api/prometheus/check` - Check messages against business rules
- `GET /api/prometheus/rules` - List available rule types

**Module Structure:**
- `prometheus/index.js` - Main Prometheus class
- `prometheus/prompts.js` - System prompts with H(0) protocol
- `prometheus/huggingface.js` - HuggingFace API client
- `prometheus/rules.js` - Business rules engine

**Environment:**
- `HF_API_TOKEN` - HuggingFace API token (required)

## External Dependencies
- **Database**: PostgreSQL (Supabase) with RLS configured via Supabase dashboard
- **WhatsApp**: Twilio WhatsApp Business API
- **AI**: HuggingFace Inference API (Qwen2.5-3B-Instruct)

## Database Notes
- **RLS Policy**: Row Level Security for `public.sessions` table is configured directly in Supabase SQL editor (not in code). Policy enables backend full access while satisfying Supabase security requirements.
- **Onboarding Flow**: 2-step wizard (Create Book → Activate with Join Code). Webhook URL is optional in Step 1.