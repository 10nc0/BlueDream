/**
 * Executive Formatter - Post-processing for dashboard audit responses
 * Strips conversational filler and formats for executive-style brevity
 * Supports bilingual (Indonesian/English) content
 */

const APOLOGY_PATTERNS = [
  /mohon maaf[^.]*\.\s*/gi,
  /maaf[^.]*kesalahan[^.]*\.\s*/gi,
  /saya mohon maaf[^.]*\.\s*/gi,
  /i('m| am) sorry[^.]*\.\s*/gi,
  /i apologize[^.]*\.\s*/gi,
  /my apologies[^.]*\.\s*/gi,
  /apologies for[^.]*\.\s*/gi,
];

const FILLER_PATTERNS = [
  /saya berharap[^.!]*[.!]\s*/gi,
  /semoga informasi ini[^.!]*[.!]\s*/gi,
  /terima kasih atas[^.!]*[.!]\s*/gi,
  /i hope this[^.!]*[.!]\s*/gi,
  /hope this helps[^.!]*[.!]\s*/gi,
  /thank you for[^.!]*[.!]\s*/gi,
  /please let me know[^.!]*[.!]\s*/gi,
  /if you have any[^.!]*[.!]\s*/gi,
  /jika ada pertanyaan[^.!]*[.!]\s*/gi,
  /silakan hubungi[^.!]*[.!]\s*/gi,
];

const INTRO_FILLER_PATTERNS = [
  /^berikut adalah informasi[^:]*[:.]?\s*/i,
  /^berikut informasi[^:]*[:.]?\s*/i,
  /^here is the information[^:]*[:.]?\s*/i,
  /^here are the details[^:]*[:.]?\s*/i,
  /^based on (the |my )?analysis[^:]*[:.]?\s*/i,
  /^berdasarkan analisis[^:]*[:.]?\s*/i,
];

const SELF_REFERENCE_PATTERNS = [
  /saya telah[^.]*\.\s*/gi,
  /saya sudah[^.]*\.\s*/gi,
  /i have (reviewed|analyzed|checked)[^.]*\.\s*/gi,
  /let me (explain|clarify)[^.]*[:.]?\s*/gi,
  /izinkan saya[^.]*[:.]?\s*/gi,
];

function stripApologies(text) {
  let result = text;
  for (const pattern of APOLOGY_PATTERNS) {
    result = result.replace(pattern, '');
  }
  return result;
}

function stripFiller(text) {
  let result = text;
  for (const pattern of FILLER_PATTERNS) {
    result = result.replace(pattern, '');
  }
  return result;
}

function stripIntroFiller(text) {
  let result = text;
  for (const pattern of INTRO_FILLER_PATTERNS) {
    result = result.replace(pattern, '');
  }
  return result;
}

function stripSelfReferences(text) {
  let result = text;
  for (const pattern of SELF_REFERENCE_PATTERNS) {
    result = result.replace(pattern, '');
  }
  return result;
}

function normalizeWhitespace(text) {
  return text
    .replace(/\n{3,}/g, '\n\n')
    .replace(/  +/g, ' ')
    .replace(/^\s+/gm, '')
    .trim();
}

function formatExecutiveResponse(text) {
  if (!text || typeof text !== 'string') {
    return text;
  }

  let result = text;

  result = stripApologies(result);
  result = stripFiller(result);
  result = stripIntroFiller(result);
  result = stripSelfReferences(result);
  result = normalizeWhitespace(result);

  if (!result || result.length < 5) {
    return text;
  }

  return result;
}

function formatAuditResponse(response) {
  if (!response) return response;

  if (typeof response === 'string') {
    return formatExecutiveResponse(response);
  }

  if (typeof response === 'object') {
    const formatted = { ...response };

    if (formatted.answer) {
      formatted.answer = formatExecutiveResponse(formatted.answer);
    }
    if (formatted.response) {
      formatted.response = formatExecutiveResponse(formatted.response);
    }
    if (formatted.text) {
      formatted.text = formatExecutiveResponse(formatted.text);
    }
    if (formatted.content) {
      formatted.content = formatExecutiveResponse(formatted.content);
    }

    return formatted;
  }

  return response;
}

module.exports = {
  formatExecutiveResponse,
  formatAuditResponse,
  stripApologies,
  stripFiller,
  stripIntroFiller,
  stripSelfReferences,
  normalizeWhitespace,
};
