'use strict';

// Keyword frequency extractor for monthly summary emails.
//
// Tags ("#perbaikan") are user-typed labels — already counted elsewhere.
// Keywords are auto-extracted content words from the message body itself.
// For a workshop ledger this surfaces what was actually discussed
// (ban, oli, rem, aki ...) instead of just what was hashtagged.
//
// Strategy: lowercase → tokenize on Unicode word boundaries → drop tokens
// that are URLs / pure digits / phone-like / shorter than minLength /
// stopwords for the message's detected language / already counted as a tag.
// Sort by frequency desc, return top N.
//
// No stemming, no lemmatization. At ledger scale (≤ a few thousand
// messages per book per month) raw token frequency is plenty signal,
// and skipping stem dictionaries keeps the module dependency-free and
// works equally well for Indonesian (no built-in stem dict) as English.

const { detectLanguage } = require('../utils/language-detector');

// Multilingual stopword sets. Curated from the most common function
// words in each language — small enough to read at a glance, large
// enough to push content words to the top of the frequency list.
//
// Languages covered match the trigram set in language-detector.js.
// Forks can override the whole map via EMAIL.KEYWORDS_STOPWORDS in
// config/constants.js — see options.stopwordsByLang below.
const DEFAULT_STOPWORDS = {
    en: new Set([
        'the','and','for','are','but','not','you','all','can','her','was','one','our','out',
        'has','have','had','his','him','she','they','them','their','this','that','with','from',
        'were','what','when','where','which','will','would','your','yours','about','there','here',
        'just','like','some','any','only','then','than','also','been','being','into','over',
        'such','very','more','most','much','many','make','made','does','done','say','said',
        'get','got','let','put','use','used','way','its','too','off','yes','because','i','m','s','t',
        'do','don','isn','it','is','of','on','in','at','to','no','as','an','or','if','be','by','we','am',
        're','ve','ll','d'
    ]),
    id: new Set([
        'yang','dan','di','ke','dari','untuk','dengan','dalam','pada','adalah','itu','ini','tidak',
        'akan','sudah','juga','atau','saja','saya','aku','kamu','kau','dia','mereka','kita','kami',
        'apa','siapa','kapan','mana','bagaimana','kenapa','mengapa','jadi','agar','supaya','karena',
        'tetapi','tapi','namun','jika','kalau','seperti','sebagai','telah','sedang','masih','sangat',
        'lebih','paling','semua','setiap','beberapa','banyak','sedikit','satu','dua','tiga','tidak',
        'bukan','belum','pernah','selalu','hanya','sama','bagi','oleh','para','antar','antara',
        'baik','sini','sana','situ','begitu','demikian','tersebut','yaitu','yakni','yah','iya','ya',
        'ok','oke','nya','lah','kah','pun','pak','bu','bro','sis','min','om','tante','gan','sob',
        'gak','ga','enggak','engga','nggak','ngga','udah','udh','dah','udahan','aja','kalo','klo'
    ]),
    ms: new Set([
        'yang','dan','di','ke','dari','untuk','dengan','dalam','pada','adalah','itu','ini','tidak',
        'akan','sudah','juga','atau','sahaja','saya','awak','dia','mereka','kita','kami','apa',
        'bila','mana','bagaimana','kenapa','mengapa','jadi','agar','kerana','tetapi','tapi',
        'jika','kalau','seperti','sebagai','telah','sedang','masih','sangat','lebih','paling',
        'semua','setiap','beberapa','banyak','sedikit','bukan','belum','pernah','selalu','hanya'
    ]),
    es: new Set([
        'que','los','las','con','una','del','por','para','como','este','esta','estos','estas',
        'mas','muy','sin','sus','les','nos','han','ser','son','soy','fue','sea','ese','esa',
        'pero','desde','sobre','entre','hasta','cuando','donde','quien','cual','algo','todo',
        'el','la','de','en','un','y','o','si','no','al','lo','le','se','su','te','me','ya','va'
    ]),
    fr: new Set([
        'les','des','est','une','que','qui','dans','pour','avec','sur','par','sont','plus',
        'mais','aussi','tout','tous','toute','toutes','cette','ces','leur','leurs','nous','vous',
        'ils','elle','elles','son','sa','ses','mon','ma','mes','ton','ta','tes','notre','votre',
        'le','la','de','en','un','et','ou','si','ne','pas','au','du','aux','ce','je','tu','il',
        'on','y','c','d','l','n','s','t','j','m'
    ]),
    de: new Set([
        'der','die','das','und','ist','ein','eine','einen','einem','einer','sich','auch','auf',
        'mit','dem','den','des','von','zum','zur','aus','bei','nach','vor','aber','oder','wenn',
        'als','wie','was','wer','wo','wann','warum','sind','war','waren','wird','werden','sein',
        'haben','hat','hatten','dass','dann','noch','nur','schon','sehr','mehr','sehr','zu','an'
    ]),
    it: new Set([
        'che','del','con','una','per','sono','non','più','come','anche','quando','dove','quale',
        'ogni','tutto','tutti','tutta','tutte','questo','questa','questi','queste','quel','quella',
        'gli','dei','degli','delle','sulla','nella','negli','nelle','dalla','dai','dagli','dalle',
        'il','la','lo','le','i','un','di','a','e','o','se','ma','né','ne','si','mi','ti','ci','vi'
    ]),
    pt: new Set([
        'que','dos','das','com','uma','por','para','como','este','esta','estes','estas','seu',
        'sua','seus','suas','foi','ser','são','são','mas','sem','sobre','entre','quando','onde',
        'o','a','os','as','de','em','um','e','ou','se','não','no','na','do','da','ao','à'
    ]),
    nl: new Set([
        'het','een','van','den','der','die','dat','met','voor','zijn','niet','aan','door','heeft',
        'wordt','worden','werd','heb','hebben','had','hadden','maar','ook','nog','wel','als',
        'de','en','in','op','te','of','om','er','ik','je','wij','hij','zij','we','ze'
    ]),
    tr: new Set([
        'bir','bu','şu','o','ben','sen','biz','siz','onlar','için','ile','gibi','daha','çok',
        'değil','var','yok','olan','olarak','kadar','sonra','önce','ama','ancak','fakat','veya',
        'eğer','çünkü','ki','de','da','ve','mi','mı','mu','mü','ne','ya'
    ]),
    ja: new Set(),  // no Latin tokenization useful for Japanese
    zh: new Set(),
    ko: new Set(),
    ru: new Set(),
    ar: new Set(),
    hi: new Set(),
    th: new Set()
};

const DEFAULT_OPTIONS = {
    topN: 10,
    minLength: 3,
    stopwordsByLang: DEFAULT_STOPWORDS
};

const URL_RE = /https?:\/\/\S+|www\.\S+/gi;
// Word splitter: anything that isn't a Unicode letter or digit.
// \p{L} covers Latin, Cyrillic, Greek, etc.; \p{N} covers digits.
const SPLIT_RE = /[^\p{L}\p{N}]+/u;
const ALL_DIGITS_RE = /^\d+$/;
const HAS_DIGITS_RE = /\d/;

// File extension fragments ("foto.jpg" → tokenizer yields "foto" + "jpg";
// without this, "jpg"/"pdf" pollute the top keywords for any book that
// shares photos or invoices). Lowercased, no leading dot.
const FILE_EXTENSIONS = new Set([
    // images
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'tiff', 'tif', 'heic', 'heif', 'avif', 'ico',
    // video
    'mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'flv', 'm4v', '3gp',
    // audio
    'mp3', 'wav', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'flac', 'wma',
    // documents
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'txt', 'csv', 'tsv', 'md',
    // archives
    'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz',
    // code/data
    'json', 'xml', 'yaml', 'yml', 'html', 'htm', 'css', 'js', 'ts', 'sql', 'log',
    // misc
    'apk', 'exe', 'dmg', 'iso', 'eml', 'vcf', 'ics'
]);

function tokenize(text) {
    if (!text || typeof text !== 'string') return [];
    return text
        .replace(URL_RE, ' ')
        .toLowerCase()
        .normalize('NFKC')
        .split(SPLIT_RE)
        .filter(Boolean);
}

// extractKeywords: messages → top-N [word, count] pairs.
//
// messages: array of objects with at least `text` (string body).
//           Other tally fields (media, phone, etc.) are ignored here.
// options.excludeWords: Set<string> — words to drop (e.g. existing tags)
// options.topN: max pairs to return (default 10)
// options.minLength: drop tokens shorter than this (default 3)
// options.stopwordsByLang: {lang: Set<string>} (default DEFAULT_STOPWORDS)
function extractKeywords(messages, options = {}) {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const exclude = options.excludeWords instanceof Set
        ? options.excludeWords
        : new Set(options.excludeWords || []);
    const stopwordsByLang = opts.stopwordsByLang || DEFAULT_STOPWORDS;

    if (!Array.isArray(messages) || messages.length === 0) return [];

    const counts = new Map();

    for (const msg of messages) {
        const text = msg && msg.text;
        if (!text || typeof text !== 'string') continue;

        const lang = (detectLanguage(text) || {}).lang || 'en';
        const stopwords = stopwordsByLang[lang] || stopwordsByLang.en || new Set();

        for (const tok of tokenize(text)) {
            if (tok.length < opts.minLength) continue;
            if (ALL_DIGITS_RE.test(tok)) continue;
            // Drop "words" that are mostly digits (phone fragments, IDs):
            // any token with digits AND length > 4 is almost never a content word.
            if (HAS_DIGITS_RE.test(tok) && tok.length > 4) continue;
            // Drop file-extension fragments produced from filenames
            // (e.g. "foto.jpg" → "foto" + "jpg"; we keep "foto", drop "jpg").
            if (FILE_EXTENSIONS.has(tok)) continue;
            if (stopwords.has(tok)) continue;
            if (exclude.has(tok)) continue;

            counts.set(tok, (counts.get(tok) || 0) + 1);
        }
    }

    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, opts.topN);
}

// extractNumericTokens: messages → top-N [token, count] pairs of pure-digit
// tokens whose length falls inside [minDigitLength, maxDigitLength].
//
// Why a separate function instead of relaxing extractKeywords' digit filter:
// reference codes (license-plate digit-parts, order numbers, mileage,
// invoice numbers, prices) carry value DIFFERENT from content keywords —
// readers scan them as a distinct list ("which job sheets did we hit
// most?"), not interleaved with vocabulary. Keeping them in their own
// block in the email also keeps content keywords readable.
//
// The length window is the whole point. Lower bound (default 4) drops
// quantities like "2", "10", "50%". Upper bound (default 8) drops phone
// fragments — most local Indonesian numbers are 10-12 digits, intl with
// country code 11-15. So 4 ≤ len ≤ 8 captures plates ("1234"), order
// numbers ("INV12345" → tokenizer splits into "inv" + "12345"; we'd see
// "12345" here), mileages ("80000"), prices ("150000" — borderline 6
// digits), without leaking phones.
//
// Tokenizer is shared with extractKeywords so URL-stripping and Unicode
// normalisation behave identically. The only difference is the filter:
// here we KEEP pure digits inside the window; we drop everything else.
function extractNumericTokens(messages, options = {}) {
    const opts = {
        topN: 5,
        minDigitLength: 4,
        maxDigitLength: 8,
        ...options
    };

    if (!Array.isArray(messages) || messages.length === 0) return [];
    if (opts.minDigitLength > opts.maxDigitLength) return [];

    const counts = new Map();

    for (const msg of messages) {
        const text = msg && msg.text;
        if (!text || typeof text !== 'string') continue;

        for (const tok of tokenize(text)) {
            if (!ALL_DIGITS_RE.test(tok)) continue;
            if (tok.length < opts.minDigitLength) continue;
            if (tok.length > opts.maxDigitLength) continue;
            counts.set(tok, (counts.get(tok) || 0) + 1);
        }
    }

    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, opts.topN);
}

module.exports = {
    extractKeywords,
    extractNumericTokens,
    tokenize,
    DEFAULT_STOPWORDS,
    FILE_EXTENSIONS
};
