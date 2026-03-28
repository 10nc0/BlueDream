'use strict';

function measureCell(value) {
    const str = String(value ?? '');
    let len = 0;
    for (const ch of str) {
        const code = ch.codePointAt(0);
        if (code > 0x2000 && code < 0x3300) len += 2;
        else len += 1;
    }
    return len;
}

function formatTable(headers, rows, options = {}) {
    const { align, pad = 1 } = options;

    const allRows = [headers, ...rows];
    const colCount = headers.length;
    const widths = new Array(colCount).fill(0);

    for (const row of allRows) {
        for (let c = 0; c < colCount; c++) {
            const w = measureCell(row[c] ?? '');
            if (w > widths[c]) widths[c] = w;
        }
    }

    const padStr = ' '.repeat(pad);

    function formatRow(cells) {
        const parts = cells.map((cell, c) => {
            const s = String(cell ?? '');
            const extra = widths[c] - measureCell(s);
            const a = align ? align[c] : undefined;
            if (a === 'right') return ' '.repeat(extra) + s;
            if (a === 'center') {
                const left = Math.floor(extra / 2);
                return ' '.repeat(left) + s + ' '.repeat(extra - left);
            }
            return s + ' '.repeat(extra);
        });
        return `|${padStr}${parts.join(`${padStr}|${padStr}`)}${padStr}|`;
    }

    function separatorRow() {
        const parts = widths.map((w, c) => {
            const a = align ? align[c] : undefined;
            const inner = '-'.repeat(w + pad * 2);
            if (a === 'right') return inner.slice(0, -1) + ':';
            if (a === 'center') return ':' + inner.slice(2) + ':';
            return inner;
        });
        return `|${parts.join('|')}|`;
    }

    const lines = [
        formatRow(headers),
        separatorRow(),
        ...rows.map(r => formatRow(r))
    ];

    return lines.join('\n');
}

function parseMarkdownTable(markdown) {
    const lines = markdown.trim().split('\n').filter(l => l.trim().startsWith('|'));
    if (lines.length < 2) return null;

    const parseLine = (line) =>
        line.split('|').slice(1, -1).map(c => c.trim());

    const headers = parseLine(lines[0]);

    const sepParts = parseLine(lines[1]);
    const align = sepParts.map(s => {
        const left = s.startsWith(':');
        const right = s.endsWith(':');
        if (left && right) return 'center';
        if (right) return 'right';
        return 'left';
    });

    const rows = lines.slice(2).map(parseLine);

    return { headers, rows, align };
}

function reformatMarkdownTable(markdown, options = {}) {
    const parsed = parseMarkdownTable(markdown);
    if (!parsed) return markdown;
    return formatTable(parsed.headers, parsed.rows, { align: parsed.align, ...options });
}

module.exports = { formatTable, parseMarkdownTable, reformatMarkdownTable };
