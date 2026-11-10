'use strict';

const cheerio = require('cheerio');
const { validateUrl } = require('./policy');

const clean = value => value.replace(/\s+/g, ' ').trim();
const escapeHtml = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function extractDocument({ html, type, finalUrl }) {
  if (type === 'text/plain') {
    return { title: new URL(finalUrl).hostname, text: html.trim(), tables: [], links: [], inertHtml: `<p>${escapeHtml(html)}</p>` };
  }
  const $ = cheerio.load(html);
  const title = clean($('title').first().text()).slice(0, 300) || new URL(finalUrl).hostname;
  const unsupported = /captcha|verify you are human|enable javascript|javascript (?:is )?required|sign in to continue|log in to continue|subscribe to continue/i.test($('body').text());
  $('script,style,noscript,template,iframe,frame,frameset,object,embed,svg,math,form,input,button,textarea,select,nav,footer,header,aside,[hidden],[aria-hidden="true"]').remove();
  $('[style]').each((_, el) => {
    if (/(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test($(el).attr('style'))) $(el).remove();
  });
  const links = [];
  $('a[href]').each((_, el) => {
    if (links.length >= 40) return;
    try {
      const url = new URL($(el).attr('href'), finalUrl);
      url.hash = '';
      validateUrl(url.href);
      if (!links.some(l => l.url === url.href)) links.push({ url: url.href, text: clean($(el).text()).slice(0, 160) });
    } catch { /* Unsupported destinations are not offered for following. */ }
  });
  const tables = [];
  $('table').slice(0, 10).each((_, table) => {
    const rows = [];
    $(table).find('tr').slice(0, 100).each((__, tr) => {
      rows.push($(tr).find('th,td').slice(0, 20).map((___, cell) => clean($(cell).text()).slice(0, 500)).get());
    });
    tables.push(rows);
  });
  $('br').replaceWith('\n');
  $('p,div,section,article,li,tr,h1,h2,h3,h4,pre').append('\n');
  const text = $('body').text().split('\n').map(clean).filter(Boolean).join('\n');
  // Reconstruct, never forward untrusted attributes, styles, URLs or elements.
  // This is the sole document Chromium receives, even if interception regresses.
  const inertHtml = `<h1>${escapeHtml(title)}</h1><main>${text.split('\n').map(t => `<p>${escapeHtml(t)}</p>`).join('')}${
    tables.map(rows => `<table>${rows.map(row => `<tr>${row.map(c => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('')}</table>`).join('')
  }</main>`;
  return { title, text, tables, links, inertHtml, unsupported };
}

module.exports = { extractDocument };
