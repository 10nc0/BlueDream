const { detectLanguage, getFtsConfig } = require('../../utils/language-detector');

module.exports = {
    name: 'language-detector',
    description: 'Detect the language of a text string. Returns ISO 639-1 code with confidence score. Supports CJK, Hangul, Cyrillic, Arabic, Devanagari, Thai, and Latin-script trigram matching.',
    parameters: {
        text: { type: 'string', required: true, description: 'Text to detect language of (min 3 chars for reliable detection)' }
    },
    async execute({ text }) {
        if (!text || typeof text !== 'string') return null;
        const result = detectLanguage(text);
        return JSON.stringify({
            lang: result.lang,
            confidence: result.confidence,
            ftsConfig: getFtsConfig(result.lang)
        });
    }
};
