// ═══════════════════════════════════════════════════════════════
// TELEGRAM FORMAT — Markdown → Telegram HTML + chunker
// ═══════════════════════════════════════════════════════════════
// Telegram Bot API accepts a strict HTML subset:
//   <b>, <strong>, <i>, <em>, <s>, <strike>, <del>,
//   <u>, <ins>, <code>, <pre><code class="language-X">,
//   <a href="...">, <tg-spoiler>
//
// 4096 chars max per sendMessage — chunkText() splits at
// paragraph boundaries to preserve readability.
//
// Reference: Telegram Bot API § Formatting options
// ═══════════════════════════════════════════════════════════════

const MAX_MSG_LEN = 4096;

/**
 * Convert markdown text to Telegram-safe HTML.
 * Input is plain text potentially containing markdown syntax.
 * @param {string} text
 * @returns {string}
 */
function markdownToTelegramHtml(text) {
    if (!text) return '';
    let s = String(text);

    // 1. Escape HTML entities in raw text BEFORE inserting tags
    //    (only applies outside the markup we add below)
    //    We do a multi-pass: escape first, then inject tags.
    s = s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    // 2. Fenced code blocks  ```lang\ncode\n```  →  <pre><code>…</code></pre>
    s = s.replace(/```(\w+)?\n?([\s\S]*?)```/g, (_, lang, code) => {
        const cls = lang ? ` class="language-${lang}"` : '';
        return `<pre><code${cls}>${code.replace(/\n$/, '')}</code></pre>`;
    });

    // 3. Inline code  `code`
    s = s.replace(/`([^`\n]+)`/g, (_, code) => `<code>${code}</code>`);

    // 4. Bold  **text** or __text__
    s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    s = s.replace(/__(.+?)__/g, '<b>$1</b>');

    // 5. Italic  *text* or _text_  (single — not already consumed by bold)
    s = s.replace(/\*([^*\n]+)\*/g, '<i>$1</i>');
    s = s.replace(/_([^_\n]+)_/g, '<i>$1</i>');

    // 6. Strikethrough  ~~text~~
    s = s.replace(/~~(.+?)~~/g, '<s>$1</s>');

    // 7. Links  [label](url)
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>');

    return s;
}

/**
 * Split HTML string into chunks of ≤ maxLen characters.
 * Tries to cut at double-newline → newline → space → hard cut.
 * @param {string} html
 * @param {number} [maxLen]
 * @returns {string[]}
 */
function chunkText(html, maxLen = MAX_MSG_LEN) {
    if (html.length <= maxLen) return [html];

    const chunks = [];
    let remaining = html;

    while (remaining.length > 0) {
        if (remaining.length <= maxLen) {
            chunks.push(remaining);
            break;
        }

        let cut = remaining.lastIndexOf('\n\n', maxLen);
        if (cut <= 0) cut = remaining.lastIndexOf('\n', maxLen);
        if (cut <= 0) cut = remaining.lastIndexOf(' ', maxLen);
        if (cut <= 0) cut = maxLen;

        chunks.push(remaining.slice(0, cut));
        remaining = remaining.slice(cut).replace(/^\s+/, '');
    }

    return chunks;
}

module.exports = { markdownToTelegramHtml, chunkText };
