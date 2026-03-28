'use strict';

const CJK_RANGE = /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/;
const HIRAGANA = /[\u3040-\u309F]/;
const KATAKANA = /[\u30A0-\u30FF]/;
const HANGUL = /[\uAC00-\uD7AF\u1100-\u11FF]/;
const CYRILLIC = /[\u0400-\u04FF]/;
const ARABIC = /[\u0600-\u06FF\u0750-\u077F]/;
const DEVANAGARI = /[\u0900-\u097F]/;
const THAI = /[\u0E00-\u0E7F]/;

const TRIGRAMS = {
    en: 'the and ing tion her hat his for are was ent ion ter est ers ith ver all'.split(' '),
    id: 'ang dan kan yan nya ing ber men eng ada ata ari ter ala apa itu dia'.split(' '),
    ms: 'ang dan kan yan nya ing ber men eng ada ata ari ter ala apa itu dia'.split(' '),
    es: 'ión que los las del con una ado por est ent cia nte ara mos era sta'.split(' '),
    fr: 'les des ent que une ait est par ion ous eur ant ais eme our lle'.split(' '),
    de: 'ein sch die der und den ich ung eit ber ach ine ent ver ges cht'.split(' '),
    it: 'zione che per con una del gli ato ell ent are ion tto ono ere tta'.split(' '),
    pt: 'que dos das ção com uma ent por ado est ões mos nte ais era ade'.split(' '),
    nl: 'een het van den het der die oor eer ijk aat ijk ing aar ijk end'.split(' '),
    tr: 'lar ler bir ını ası eri yor dan ına ile lık lar ini lik ize ara'.split(' '),
};

const FTS_CONFIG_MAP = {
    en: 'english',
    da: 'danish',
    nl: 'dutch',
    fi: 'finnish',
    fr: 'french',
    de: 'german',
    hu: 'hungarian',
    it: 'italian',
    no: 'norwegian',
    pt: 'portuguese',
    ro: 'romanian',
    ru: 'russian',
    es: 'spanish',
    sv: 'swedish',
    tr: 'turkish',
};

function detectLanguage(text) {
    if (!text || typeof text !== 'string') {
        return { lang: 'en', confidence: 0 };
    }

    const cleaned = text.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
    if (cleaned.length < 3) {
        return { lang: 'en', confidence: 0 };
    }

    const totalChars = cleaned.length;
    let cjkCount = 0, hiraCount = 0, kataCount = 0, hangulCount = 0;
    let cyrillicCount = 0, arabicCount = 0, devanagariCount = 0, thaiCount = 0;

    for (const ch of cleaned) {
        if (CJK_RANGE.test(ch)) cjkCount++;
        if (HIRAGANA.test(ch)) hiraCount++;
        if (KATAKANA.test(ch)) kataCount++;
        if (HANGUL.test(ch)) hangulCount++;
        if (CYRILLIC.test(ch)) cyrillicCount++;
        if (ARABIC.test(ch)) arabicCount++;
        if (DEVANAGARI.test(ch)) devanagariCount++;
        if (THAI.test(ch)) thaiCount++;
    }

    const scriptThreshold = 0.15;

    if ((hiraCount + kataCount) / totalChars > scriptThreshold) {
        return { lang: 'ja', confidence: 0.95 };
    }
    if (hangulCount / totalChars > scriptThreshold) {
        return { lang: 'ko', confidence: 0.95 };
    }
    if (cjkCount / totalChars > scriptThreshold) {
        const jpIndicators = hiraCount + kataCount;
        if (jpIndicators > 0) return { lang: 'ja', confidence: 0.85 };
        return { lang: 'zh', confidence: 0.9 };
    }
    if (cyrillicCount / totalChars > scriptThreshold) {
        return { lang: 'ru', confidence: 0.85 };
    }
    if (arabicCount / totalChars > scriptThreshold) {
        return { lang: 'ar', confidence: 0.85 };
    }
    if (devanagariCount / totalChars > scriptThreshold) {
        return { lang: 'hi', confidence: 0.85 };
    }
    if (thaiCount / totalChars > scriptThreshold) {
        return { lang: 'th', confidence: 0.85 };
    }

    const lower = cleaned.toLowerCase();
    const scores = {};

    for (const [lang, trigrams] of Object.entries(TRIGRAMS)) {
        let hits = 0;
        for (const tri of trigrams) {
            let idx = -1;
            while ((idx = lower.indexOf(tri, idx + 1)) !== -1) {
                hits++;
            }
        }
        scores[lang] = hits;
    }

    let bestLang = 'en';
    let bestScore = 0;
    let secondScore = 0;

    for (const [lang, score] of Object.entries(scores)) {
        if (score > bestScore) {
            secondScore = bestScore;
            bestScore = score;
            bestLang = lang;
        } else if (score > secondScore) {
            secondScore = score;
        }
    }

    if (bestScore === 0) {
        return { lang: 'en', confidence: 0.1 };
    }

    const ratio = secondScore > 0 ? bestScore / secondScore : 3;
    let confidence;
    if (ratio > 2) confidence = 0.9;
    else if (ratio > 1.5) confidence = 0.75;
    else if (ratio > 1.2) confidence = 0.6;
    else confidence = 0.4;

    if (bestLang === 'id' || bestLang === 'ms') {
        const msIndicators = /\b(tidak|bukan|tetapi|kerana|sahaja)\b/i;
        const idIndicators = /\b(tidak|bukan|tetapi|karena|saja)\b/i;
        if (msIndicators.test(cleaned) && /kerana|sahaja/.test(cleaned.toLowerCase())) {
            bestLang = 'ms';
        } else {
            bestLang = 'id';
        }
    }

    return { lang: bestLang, confidence: Math.min(confidence, 0.95) };
}

function getFtsConfig(lang) {
    return FTS_CONFIG_MAP[lang] || 'simple';
}

function normalizeForSearch(text) {
    if (!text || typeof text !== 'string') return '';
    return text
        .normalize('NFKC')
        .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
        .replace(/\u3000/g, ' ')
        .toLowerCase()
        .trim();
}

module.exports = { detectLanguage, getFtsConfig, normalizeForSearch, FTS_CONFIG_MAP };
