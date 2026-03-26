/**
 * SEED METRIC CALCULATOR
 *
 * Direct calculation bypass for Seed Metric analysis.
 * Parses search results, applies proxy rules, builds table deterministically.
 *
 * Formula: Years = (LCU/sqm × 700) ÷ Single-Earner Income
 * NO P/I ratio — if LCU/sqm unavailable, show "N/A".
 *
 * Proxy Rules (from seed-metric.js):
 * - PRIMARY: Published LCU/m² → MULTIPLY BY 700 (non-negotiable)
 * - INCOME: Single-earner (not household/dual)
 * - Regime: <10yr 🟢 Optimism | 10-25yr 🟡 Extraction | >25yr 🔴 Fatalism
 */

// ─── Currency Registry ────────────────────────────────────────────────────────
// Single source of truth. To add a new currency: one entry here, nothing else.
// usdRate = 1 unit of this currency in USD.
// Used ONLY to normalize sanity-check bounds (e.g. "LCU/sqm plausible?") into
// a single universal range. NOT used for conversion — the Seed Metric ratio
// is LCU/LCU = unitless years, so currency cancels out in the division.
// cities  = lowercase city/country keywords that imply this currency.
const CURRENCY_REGISTRY = {
  USD: { symbols: ['USD', '$'],                    usdRate: 1,          cities: ['los angeles', 'la', 'new york', 'nyc', 'chicago', 'san francisco', 'sf', 'seattle', 'boston', 'miami', 'houston', 'dallas', 'denver', 'atlanta', 'phoenix', 'portland', 'austin', 'san diego', 'washington dc', 'philadelphia', 'minneapolis', 'detroit', 'honolulu', 'usa', 'united states'] },
  EUR: { symbols: ['EUR', '€'],                    usdRate: 0.92,       cities: ['paris', 'berlin', 'vienna', 'amsterdam', 'munich', 'rome', 'madrid', 'milan', 'brussels', 'lisbon', 'dublin', 'hamburg', 'frankfurt', 'helsinki', 'tallinn', 'riga', 'vilnius', 'athens', 'europe', 'eurozone'] },
  GBP: { symbols: ['GBP', '£'],                    usdRate: 1.27,       cities: ['london', 'manchester', 'birmingham', 'edinburgh', 'uk', 'united kingdom'] },
  JPY: { symbols: ['JPY', 'yen', '¥', '￥'],       usdRate: 0.0067,     cities: ['tokyo', 'osaka', 'kyoto', 'japan'] },
  KRW: { symbols: ['KRW', 'won', '₩'],             usdRate: 0.00077,    cities: ['seoul', 'busan', 'incheon', 'daegu', 'daejeon', 'korea'] },
  SGD: { symbols: ['SGD', 'S$'],                   usdRate: 0.74,       cities: ['singapore'] },
  HKD: { symbols: ['HKD', 'HK$'],                  usdRate: 0.128,      cities: ['hong kong'] },
  AUD: { symbols: ['AUD', 'A$'],                   usdRate: 0.65,       cities: ['sydney', 'melbourne', 'brisbane', 'perth', 'australia'] },
  CAD: { symbols: ['CAD', 'C$'],                   usdRate: 0.74,       cities: ['toronto', 'vancouver', 'montreal', 'calgary', 'canada'] },
  CHF: { symbols: ['CHF', 'Fr'],                   usdRate: 1.12,       cities: ['zurich', 'geneva', 'switzerland'] },
  CNY: { symbols: ['CNY', 'RMB', 'yuan', '元'],    usdRate: 0.138,      cities: ['beijing', 'shanghai', 'shenzhen', 'guangzhou', 'china'] },
  INR: { symbols: ['INR', 'Rs', '₹'],              usdRate: 0.012,      cities: ['mumbai', 'delhi', 'bangalore', 'hyderabad', 'chennai', 'india'] },
  IDR: { symbols: ['IDR', 'Rp'],                   usdRate: 0.000064,   cities: ['jakarta', 'surabaya', 'bali', 'indonesia'] },
  VND: { symbols: ['VND', 'dong', '₫'],            usdRate: 0.000040,   cities: ['hanoi', 'ho chi minh', 'saigon', 'vietnam'] },
  THB: { symbols: ['THB', 'baht', '฿'],            usdRate: 0.028,      cities: ['bangkok', 'phuket', 'thailand'] },
  MYR: { symbols: ['MYR', 'RM', 'ringgit'],        usdRate: 0.213,      cities: ['kuala lumpur', 'penang', 'malaysia'] },
  PHP: { symbols: ['PHP', '₱'],                    usdRate: 0.018,      cities: ['manila', 'cebu', 'philippines'] },
  AED: { symbols: ['AED', 'dirham'],               usdRate: 0.272,      cities: ['dubai', 'abu dhabi', 'uae'] },
  BRL: { symbols: ['BRL', 'R$'],                   usdRate: 0.196,      cities: ['sao paulo', 'rio', 'brazil'] },
  NZD: { symbols: ['NZD', 'NZ$'],                  usdRate: 0.61,       cities: ['auckland', 'wellington', 'new zealand'] },
  ZAR: { symbols: ['ZAR'],                         usdRate: 0.054,      cities: ['johannesburg', 'cape town', 'south africa'] },
  MXN: { symbols: ['MXN', 'MX$'],                 usdRate: 0.058,      cities: ['mexico city', 'guadalajara', 'mexico'] },
  TRY: { symbols: ['TRY', '₺', 'lira'],            usdRate: 0.031,      cities: ['istanbul', 'ankara', 'turkey'] },
  SEK: { symbols: ['SEK', 'kr', 'kronor'],          usdRate: 0.095,      cities: ['stockholm', 'gothenburg', 'malmö', 'sweden'] },
  NOK: { symbols: ['NOK', 'krone'],                 usdRate: 0.091,      cities: ['oslo', 'bergen', 'norway'] },
  DKK: { symbols: ['DKK'],                          usdRate: 0.14,       cities: ['copenhagen', 'denmark'] },
  PLN: { symbols: ['PLN', 'zł', 'zloty'],           usdRate: 0.25,       cities: ['warsaw', 'krakow', 'gdansk', 'poland'] },
  CZK: { symbols: ['CZK', 'Kč', 'koruna'],          usdRate: 0.043,      cities: ['prague', 'brno', 'czech republic', 'czechia'] },
  HUF: { symbols: ['HUF', 'Ft', 'forint'],          usdRate: 0.0027,     cities: ['budapest', 'hungary'] },
  TWD: { symbols: ['TWD', 'NT$'],                   usdRate: 0.031,      cities: ['taipei', 'kaohsiung', 'taiwan'] },
  ARS: { symbols: ['ARS', 'AR$'],                   usdRate: 0.00085,    cities: ['buenos aires', 'argentina'] },
  COP: { symbols: ['COP', 'COL$'],                  usdRate: 0.00024,    cities: ['bogota', 'medellin', 'colombia'] },
  PEN: { symbols: ['PEN', 'S/.', 'soles'],          usdRate: 0.27,       cities: ['lima', 'peru'] },
  CLP: { symbols: ['CLP', 'CL$'],                   usdRate: 0.0010,     cities: ['santiago', 'chile'] },
  EGP: { symbols: ['EGP', 'E£'],                    usdRate: 0.020,      cities: ['cairo', 'alexandria', 'egypt'] },
  KES: { symbols: ['KES', 'KSh', 'shillings'],      usdRate: 0.0077,     cities: ['nairobi', 'mombasa', 'kenya'] },
  NGN: { symbols: ['NGN', '₦', 'naira'],             usdRate: 0.00061,    cities: ['lagos', 'abuja', 'nigeria'] },
};

// Build a flat symbol→code lookup (longest symbols checked first to avoid prefix collisions)
const _SYMBOL_MAP = (() => {
  const map = [];
  for (const [code, info] of Object.entries(CURRENCY_REGISTRY)) {
    for (const sym of info.symbols) {
      map.push({ sym, code });
    }
  }
  map.sort((a, b) => b.sym.length - a.sym.length);
  return map;
})();

/**
 * Detect currency from city name and/or text content.
 * Priority: city keyword match → explicit symbol in text → USD fallback.
 * Note: ¥ is shared by JPY/CNY — city context disambiguates; default JPY.
 */
function detectCurrency(city = '', text = '') {
  const cityLower = city.toLowerCase();
  for (const [code, info] of Object.entries(CURRENCY_REGISTRY)) {
    if (info.cities.includes(cityLower)) return code;
  }
  for (const [code, info] of Object.entries(CURRENCY_REGISTRY)) {
    if (info.cities.some(c => c.length > 2 && cityLower.includes(c))) return code;
  }
  // Scan text for explicit currency symbols/codes (longest first)
  for (const { sym, code } of _SYMBOL_MAP) {
    const escaped = sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?:^|\\s|[^\\w])${escaped}(?:\\s|[^\\w]|$)`, 'i').test(text)) return code;
  }
  return 'USD';
}

/** Normalize an LCU value to USD scale for sanity-check bounds only. Not a conversion. */
function usdEquiv(value, currency) {
  return value * (CURRENCY_REGISTRY[currency]?.usdRate ?? 1);
}

/** Parse numeric multiplier suffixes (million/billion/k and CJK units). */
function applyMultiplier(value, raw) {
  if (/billion|bn/i.test(raw))           return value * 1_000_000_000;
  if (/million|mil\b|億/i.test(raw) || /\bM\b/.test(raw)) return value * 1_000_000;
  if (/만|万/i.test(raw))                return value * 10_000;
  if (/\bk\b|thousand/i.test(raw))       return value * 1_000;
  return value;
}

/**
 * Normalize European number formats before running regex parsers.
 * Collapses space-as-thousands-separator: "3 800" → "3800", "3 800 000" → "3800000".
 * Applied twice to handle chained groups (e.g. "1 234 567" → "1234567").
 * Covers Finnish/Scandinavian/French formats common in property portal snippets.
 */
function normalizeNumberFormat(text) {
  if (!text) return text;
  const once = s => s.replace(/(\d) (\d{3})(?!\d)/g, '$1$2');
  return once(once(text));
}

// Regex fragments reused in both parsers
const _SQM  = '(?:sq\\s*m|sqm|m²|square\\s*met(?:er|re)s?)';
const _PSF  = '(?:psf|sq\\s*ft|sqft)';
const _NUM  = '([\\d,]+(?:\\.\\d+)?)';
const _MULT = '(?:\\s*(?:billion|bn|million|mil|M|k|thousand|만|万|億|억))?';
// _CURSYM: optional currency noise before/after a number.
// LCU/LCU cancels — detectCurrency(city) determines the LCU.
// This just skips past whatever symbol/code sits next to the digit.
const _SYMS_EXACT = _SYMBOL_MAP.map(e => e.sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
const _CURSYM = `(?:(?:${_SYMS_EXACT}|[A-Z]{1,3}\\$?)\\s*)?`;

/**
 * Classify price source as "built" (apartment/condo) or "land" (vacant plot).
 * Returns null if classification is ambiguous.
 */
function classifyPriceType(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/\b(?:apartment|flat|condo|condominium|residential|house|home|unit|room|hdb|built|property\s+price|housing)\b/.test(t)) return 'built';
  if (/\b(?:land|plot|site|vacant|hectare|acre|tanah|terrain|terreno)\b/.test(t)) return 'land';
  return null;
}

// ─── Price per sqm parser ─────────────────────────────────────────────────────
/**
 * Parse price per square meter from text.
 * Handles any currency via CURRENCY_REGISTRY.
 * @param {string} text
 * @param {string} city - city name for currency hint
 * @returns {{ value: number, currency: string, raw: string, isPsf: boolean }|null}
 */
function parsePricePerSqm(text, city = '') {
  if (!text) return null;
  text = normalizeNumberFormat(text);

  const currency = detectCurrency(city, text);
  const { usdRate } = CURRENCY_REGISTRY[currency];

  const _AREA = `(?:${_SQM}|${_PSF})`;
  // _CURSYM: optional currency noise — LCU/LCU cancels.
  const patterns = [
    new RegExp(`${_CURSYM}${_NUM}${_MULT}\\s*(?:\\/|per)\\s*${_AREA}`, 'gi'),
    new RegExp(`${_NUM}${_MULT}\\s*(?:${_SYMS_EXACT})?\\s*(?:\\/|per)\\s*${_AREA}`, 'gi'),
    new RegExp(`(?:price|cost|average|median)\\s*(?:per|\\/)\\s*${_AREA}[^0-9]*${_NUM}`, 'gi'),
    new RegExp(`${_CURSYM}${_NUM}${_MULT}\\s+${_PSF}`, 'gi'),
    new RegExp(`${_NUM}${_MULT}\\s*(?:yuan|won|yen|ringgit|baht|rupee|rupiah|dong|peso|franc|krona|krone)\\s*(?:\\/|per)\\s*${_AREA}`, 'gi'),
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const raw = match[0];
      const valueStr = (match[1] || match[2] || '').replace(/,/g, '');
      if (!valueStr) continue;
      if (/^(19|20)\d{2}$/.test(valueStr)) {
        const hasCurrencyContext = /[\$€£¥₩₹₫₱฿]|yuan|won|yen|ringgit|rupee|dollar|franc|krona|sgd|hkd|usd|eur|gbp|jpy|krw|inr|cny|rmb/i.test(raw);
        if (!hasCurrencyContext) continue;
      }
      let value = applyMultiplier(parseFloat(valueStr), raw);
      if (!isFinite(value) || value <= 0) continue;
      const isPsf = /psf|sq\s*ft|sqft/i.test(raw);
      if (isPsf) value *= 10.764;
      const usd = value * usdRate;
      if (usd >= 10 && usd <= 150_000) {
        const priceType = classifyPriceType(raw) || classifyPriceType(text);
        return { value, currency, raw, isPsf, priceType };
      }
    }
  }
  return null;
}

// ─── Triangulation: total price ÷ area → LCU/sqm ───────────────────────────────
/**
 * Derive price per sqm by triangulation when no direct LCU/sqm quote exists.
 * Finds (total_price, area_sqm) pairs within 200 chars proximity and divides.
 * Example: "S$1.2M for 85sqm" → S$14,117/sqm
 *
 * @param {string} text
 * @param {string} city - city name for currency hint
 * @returns {{ value, currency, raw, isPsf, triangulated }|null}
 */
function triangulateFromTotalPrice(text, city = '') {
  if (!text) return null;
  text = normalizeNumberFormat(text);

  const currency = detectCurrency(city, text);
  const { usdRate } = CURRENCY_REGISTRY[currency];

  // Collect area mentions with text positions
  const areaPattern = new RegExp(`${_NUM}\\s*(?:${_SQM}|${_PSF})`, 'gi');
  const areas = [];
  for (const m of text.matchAll(areaPattern)) {
    const numStr = m[1].replace(/,/g, '');
    if (/^(19|20)\d{2}$/.test(numStr)) continue;
    let area = parseFloat(numStr);
    if (!isFinite(area) || area <= 0) continue;
    const isPsf = /psf|sq\s*ft|sqft/i.test(m[0]);
    if (isPsf) area /= 10.764;
    if (area < 10 || area > 10_000) continue;
    areas.push({ area, index: m.index, raw: m[0], isPsf });
  }
  if (areas.length === 0) return null;

  // Collect total price mentions — but NOT those already followed by /sqm (direct quotes)
  const _NOTPER = `(?!\\s*(?:\\/|\\bper\\b)\\s*(?:${_SQM}|${_PSF}))`;
  const pricePatterns = [
    new RegExp(`${_CURSYM}${_NUM}${_MULT}${_NOTPER}`, 'gi'),
    new RegExp(`${_NUM}${_MULT}\\s*(?:${_SYMS_EXACT})${_NOTPER}`, 'gi'),
    new RegExp(`${_NUM}\\s*(?:billion|bn|million|mil\\b|[Mm]\\b|thousand|[Kk]\\b|万|億|억)${_NOTPER}`, 'gi'),
  ];
  const prices = [];
  for (const pat of pricePatterns) {
    for (const m of text.matchAll(pat)) {
      const numStr = (m[1] || m[2] || '').replace(/,/g, '');
      if (!numStr) continue;
      if (/^(19|20)\d{2}$/.test(numStr)) continue;
      const value = applyMultiplier(parseFloat(numStr), m[0]);
      if (!isFinite(value) || value <= 0) continue;
      const usd = value * usdRate;
      if (usd < 5_000 || usd > 2_000_000_000) continue;
      prices.push({ value, index: m.index, raw: m[0] });
    }
  }
  if (prices.length === 0) return null;

  // Pair closest (price, area) within 200 chars
  const WINDOW = 200;
  const candidates = [];
  for (const a of areas) {
    for (const p of prices) {
      if (Math.abs(a.index - p.index) > WINDOW) continue;
      const derived = p.value / a.area;
      const usd = derived * usdRate;
      if (usd < 10 || usd > 150_000) continue;
      candidates.push({ value: derived, currency, usd, dist: Math.abs(a.index - p.index), raw: `${p.raw} ÷ ${a.raw}` });
    }
  }
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => a.dist - b.dist);
  const best = candidates[0];
  const priceType = classifyPriceType(best.raw) || classifyPriceType(text);
  return { value: best.value, currency, raw: best.raw, isPsf: false, triangulated: true, priceType };
}

/**
 * Resolve price per sqm: direct quote first, triangulation fallback.
 * Direct /sqm quotes from property portals are authoritative (e.g. "£7,474/m²").
 * Triangulation (total ÷ area) is the fallback when no direct quote exists.
 */
function resolvePrice(text, city = '') {
  return parsePricePerSqm(text, city) || triangulateFromTotalPrice(text, city);
}

// ─── Income parser ────────────────────────────────────────────────────────────
/**
 * Parse median/individual annual income from text.
 * Handles any currency via CURRENCY_REGISTRY.
 * @param {string} text
 * @param {string} city
 * @param {boolean} preferSingleEarner
 * @returns {{ value: number, currency: string, type: string, raw: string }|null}
 */
function parseIncome(text, city = '', preferSingleEarner = true) {
  if (!text) return null;
  text = normalizeNumberFormat(text);

  const currency = detectCurrency(city, text);
  const { usdRate } = CURRENCY_REGISTRY[currency];

  const hasIndividual = /individual|personal|single[\s-]?earner|per\s*capita/i.test(text);
  const hasHousehold  = /household|family|dual[\s-]?earner/i.test(text);
  const incomeType    = hasIndividual ? 'single' : (hasHousehold ? 'household' : 'unknown');

  const _YEAR  = '(?:per\\s*year|annually|\\/year|\\/yr|p\\.a\\.|per\\s*annum)';
  const _MONTH = '(?:per\\s*month|monthly|\\/month|\\/mo|p\\.m\\.|mensuel|bulanan|cada\\s*mes|al\\s*mes)';
  const _INC   = '(?:income|salary|wage|earnings|pay|gaji|salaire|sueldo)';

  const annualPatterns = [
    new RegExp(`${_INC}[^\\d]{0,40}${_CURSYM}${_NUM}${_MULT}`, 'gi'),
    new RegExp(`${_CURSYM}${_NUM}${_MULT}\\s*${_YEAR}`, 'gi'),
    new RegExp(`${_NUM}${_MULT}\\s*(?:${_SYMS_EXACT})?\\s*${_YEAR}`, 'gi'),
    new RegExp(`(?:median|average|mean)\\s*(?:individual|household)?\\s*${_INC}[^\\d]{0,30}${_CURSYM}${_NUM}${_MULT}`, 'gi'),
    new RegExp(`${_INC}\\s*(?:of|is|was|:)\\s*${_CURSYM}${_NUM}${_MULT}`, 'gi'),
  ];

  const monthlyPatterns = [
    new RegExp(`${_CURSYM}${_NUM}${_MULT}\\s*${_MONTH}`, 'gi'),
    new RegExp(`${_NUM}${_MULT}\\s*(?:${_SYMS_EXACT})?\\s*${_MONTH}`, 'gi'),
    new RegExp(`${_INC}[^\\d]{0,40}${_CURSYM}${_NUM}${_MULT}[^.]{0,20}${_MONTH}`, 'gi'),
    new RegExp(`(?:monthly|month)\\s*${_INC}[^\\d]{0,30}${_CURSYM}${_NUM}${_MULT}`, 'gi'),
  ];

  const _isMonthlyContext = /\b(?:per\s*month|monthly|\/month|\/mo|p\.m\.|mensuel|bulanan|cada\s*mes|al\s*mes)\b/i;

  function tryPatterns(patterns, multiplier) {
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const raw = match[0];
        const valueStr = (match[1] || match[2] || '').replace(/,/g, '');
        if (!valueStr) continue;
        if (/^(19|20)\d{2}$/.test(valueStr)) {
          const hasCurrencyContext = /[\$€£¥₩₹₫₱฿]|yuan|won|yen|ringgit|rupee|dollar|franc|krona|sgd|hkd|usd|eur|gbp|jpy|krw|inr|cny|rmb/i.test(raw);
          if (!hasCurrencyContext) continue;
        }
        if (multiplier === 1) {
          const matchEnd = match.index + raw.length;
          const vicinity = text.slice(Math.max(0, match.index - 30), Math.min(text.length, matchEnd + 30));
          if (_isMonthlyContext.test(vicinity)) continue;
        }
        let value = applyMultiplier(parseFloat(valueStr), raw) * multiplier;
        if (!isFinite(value) || value <= 0) continue;
        const usd = value * usdRate;
        if (usd >= 500 && usd <= 1_000_000) {
          return { value, currency, type: incomeType, raw, monthly: multiplier === 12 };
        }
      }
    }
    return null;
  }

  return tryPatterns(annualPatterns, 1) || tryPatterns(monthlyPatterns, 12);
}

/**
 * Parse search results for Seed Metric data.
 * @param {string}   searchContext   - Combined Brave result text
 * @param {string[]} cities          - City names to look for
 * @param {string}   historicalDecade - e.g., "1970s"
 * @param {number}   currentYear     - Request timestamp year (passed from orchestrator, avoids repeated Date calls)
 */
function parseSeedMetricData(searchContext, cities = [], historicalDecade = String(new Date().getFullYear() - 50).slice(0, 3) + '0s', currentYear = new Date().getFullYear()) {
  const result = { cities: {}, parseLog: [] };
  
  if (!searchContext) {
    result.parseLog.push('No search context provided');
    return result;
  }

  // Protect decimal points (e.g. "1.65", "0.87") from being treated as sentence
  // boundaries by [^.]* patterns. Replace "N.N" with "N\x00N", restore before
  // passing segments to value parsers (parseIncome, resolvePrice, parseTFR).
  const _protect   = t => t.replace(/(\d)\.(\d)/g, '$1\x00$2');
  const _restore   = t => t.replace(/\x00/g, '.');
  searchContext = _protect(searchContext);

  // Normalize city names
  const normalizedCities = cities.map(c => c.toLowerCase().trim());
  
  for (const city of normalizedCities) {
    result.cities[city] = {
      current: { pricePerSqm: null, income: null, tfr: null },
      historical: { pricePerSqm: null, income: null, tfr: null, decade: historicalDecade }
    };
    
    // Current year window: accept any year within 5 years of the request timestamp
    // (many govts publish stats 1-3 years after the reference period)
    const _recentYears = Array.from({ length: 6 }, (_, k) => String(currentYear - k)).join('|');
    const cityPatterns = [
      new RegExp(`${city}[^.]*(?:${_recentYears}|current|today|now|latest|recent)[^.]*`, 'gi'),
      new RegExp(`(?:${_recentYears}|current|today|now|latest|recent)[^.]*${city}[^.]*`, 'gi'),
    ];

    const _decadeBase = parseInt(historicalDecade) || 1970;
    const _histYears = Array.from({ length: 10 }, (_, k) => String(_decadeBase + k)).join('|');
    const _histKeywords = `${historicalDecade}|${_histYears}|historical|\\d+\\s*years?\\s*ago`;
    const historicalPatterns = [
      new RegExp(`${city}[^.]*(?:${_histKeywords})[^.]*`, 'gi'),
      new RegExp(`(?:${_histKeywords})[^.]*${city}[^.]*`, 'gi'),
    ];

    // Try to find current data
    for (const pattern of cityPatterns) {
      const matches = searchContext.match(pattern);
      if (matches) {
        const segment = _restore(matches.join(' '));
        if (!result.cities[city].current.pricePerSqm) {
          result.cities[city].current.pricePerSqm = resolvePrice(segment, city);
        }
        if (!result.cities[city].current.income) {
          result.cities[city].current.income = parseIncome(segment, city);
        }
      }
    }

    // Try to find historical data
    for (const pattern of historicalPatterns) {
      const matches = searchContext.match(pattern);
      if (matches) {
        const segment = _restore(matches.join(' '));
        if (!result.cities[city].historical.pricePerSqm) {
          result.cities[city].historical.pricePerSqm = resolvePrice(segment, city);
        }
        if (!result.cities[city].historical.income) {
          result.cities[city].historical.income = parseIncome(segment, city);
        }
      }
    }

    // Historical fallback: scan all decade-keyword sentences (no city anchor)
    if (!result.cities[city].historical.pricePerSqm || !result.cities[city].historical.income) {
      const histFallbackPattern = new RegExp(
        `[^.]*(?:${_histKeywords}|decades?\\s*ago|post[\\s-]war|mid[\\s-]century)[^.]*`,
        'gi'
      );
      const histMatches = searchContext.match(histFallbackPattern);
      if (histMatches) {
        const allHistText = _restore(histMatches.join(' '));
        if (!result.cities[city].historical.pricePerSqm) {
          result.cities[city].historical.pricePerSqm = resolvePrice(allHistText, city);
        }
        if (!result.cities[city].historical.income) {
          result.cities[city].historical.income = parseIncome(allHistText, city);
        }
      }
    }

    // Fallback: search entire context for this city
    if (!result.cities[city].current.pricePerSqm || !result.cities[city].current.income) {
      const cityMentions = searchContext.match(new RegExp(`[^.]*${city}[^.]*`, 'gi'));
      if (cityMentions) {
        const allCityText = _restore(cityMentions.join(' '));
        if (!result.cities[city].current.pricePerSqm) {
          result.cities[city].current.pricePerSqm = resolvePrice(allCityText, city);
        }
        if (!result.cities[city].current.income) {
          result.cities[city].current.income = parseIncome(allCityText, city);
        }
      }
    }
    
    // ── TFR: NOT extracted here — handled by TFR capsule in orchestrator ────
    // TFR bypass does dedicated Brave searches per city for both current and
    // historical periods, then merges into parsedData.cities[city].*.tfr.
    // This avoids regex cross-city contamination and decimal-in-sentence issues.

    // ── LCU/LCU invariant assertion ─────────────────────────────────────────
    // Both price and income are parsed via detectCurrency(city, ...) which always
    // returns the city's LCU first. Since Years = (LCU/sqm × 700) ÷ LCU/year,
    // the currency cancels out → unitless ratio. No conversion needed.
    // This assertion catches any future regression where currencies diverge.
    for (const slot of ['current', 'historical']) {
      const priceCur = result.cities[city][slot].pricePerSqm?.currency;
      const incCur   = result.cities[city][slot].income?.currency;
      if (priceCur && incCur && priceCur !== incCur) {
        result.parseLog.push(`⚠️ ${city} ${slot}: LCU VIOLATION price=${priceCur} income=${incCur} — nulling income (ratio would be meaningless)`);
        result.cities[city][slot].income = null;
      }
    }

    const _currP = result.cities[city].current.pricePerSqm;
    const _histP = result.cities[city].historical.pricePerSqm;
    const _currPSuffix = _currP?.triangulated ? ' (triangulated)' : '';
    const _histPSuffix = _histP?.triangulated ? ' (triangulated)' : '';
    result.parseLog.push(`${city} CURRENT: price/sqm=${_currP?.value || 'N/A'}${_currPSuffix} [${_currP?.priceType || '?'}], income=${result.cities[city].current.income?.value || 'N/A'}${result.cities[city].current.income?.monthly ? ' (monthly×12)' : ''}, tfr=${result.cities[city].current.tfr ?? 'N/A'}`);
    result.parseLog.push(`${city} HISTORICAL: price/sqm=${_histP?.value || 'N/A'}${_histPSuffix} [${_histP?.priceType || '?'}], income=${result.cities[city].historical.income?.value || 'N/A'}${result.cities[city].historical.income?.monthly ? ' (monthly×12)' : ''}, tfr=${result.cities[city].historical.tfr ?? 'N/A'}`);
  }
  
  return result;
}

/**
 * Calculate Seed Metric values and assign regime
 * PRIMARY: (LCU/sqm × 700) ÷ Single-Earner Income = Years
 * Thresholds: <10yr Optimism | 10-25yr Extraction | >25yr Fatalism
 * 
 * NO mortgage calculations, NO interest rates, NO down payments
 * NO P/I ratio — Years is the only output metric.
 * 
 * @param {number} pricePerSqm - Price per square meter
 * @param {number} income - Annual income (SINGLE-EARNER, not household)
 * @returns {object} { price700sqm, years, regime, emoji, isProxy }
 */
function calculateSeedMetric(pricePerSqm, income) {
  if (!pricePerSqm || !income || income === 0) {
    return { price700sqm: null, years: null, regime: 'N/A', emoji: '⚪', isProxy: false };
  }
  
  const price700sqm = pricePerSqm * 700;
  const years = price700sqm / income;
  
  // Regime assignment (φ-derived from 25yr fertility window) - 3-tier
  let regime, emoji;
  if (years < 10) {
    regime = 'Optimism';
    emoji = '🟢';
  } else if (years <= 25) {
    regime = 'Extraction';
    emoji = '🟡';
  } else {
    regime = 'Fatalism';
    emoji = '🔴';
  }
  
  return { price700sqm, years, regime, emoji, isProxy: false };
}

/**
 * Format currency value with appropriate symbol and scale.
 * Symbols are derived from CURRENCY_REGISTRY so all currencies are supported.
 * Scale: T (trillion) → B (billion) → M (million) → K (thousand) → raw
 * @param {number} value - Numeric value
 * @param {string} currency - Currency code
 * @returns {string} Formatted string
 */
function formatCurrency(value, currency = 'USD') {
  if (value == null || isNaN(value)) return 'N/A';

  // Prefer a short non-alphabetic symbol (₫ ₩ $ € £ ¥ Rp RM) over the 3-letter code.
  // Falls back to code-prefix for currencies with only alphabetic identifiers.
  const regEntry = CURRENCY_REGISTRY[currency];
  const sym = (() => {
    if (!regEntry) return currency + ' ';
    // Priority 1: Unicode currency char or mixed (e.g. $, €, ₩, ₫, S$, HK$)
    const unicodeOrMixed = regEntry.symbols.find(s => s.length <= 3 && !/^[A-Za-z]+$/.test(s));
    if (unicodeOrMixed) return unicodeOrMixed;
    // Priority 2: Short alphabetic abbreviation used as symbol (e.g. Rp, RM, Fr)
    const shortAlpha = regEntry.symbols.find(s => s.length <= 2);
    if (shortAlpha) return shortAlpha;
    // Fallback: code with space
    return regEntry.symbols[0] + ' ';
  })();

  if (value >= 1_000_000_000_000) {
    return `${sym}${(value / 1_000_000_000_000).toFixed(1)}Tr`;
  } else if (value >= 1_000_000_000) {
    return `${sym}${(value / 1_000_000_000).toFixed(1)}B`;
  } else if (value >= 1_000_000) {
    return `${sym}${(value / 1_000_000).toFixed(1)}M`;
  } else if (value >= 1_000) {
    return `${sym}${(value / 1_000).toFixed(0)}K`;
  } else {
    return `${sym}${value.toFixed(0)}`;
  }
}

/**
 * Parse Total Fertility Rate from text.
 * Brave snippets: "TFR of 1.67", "fertility rate: 0.87", "total fertility rate was 2.1"
 * @param {string} text
 * @returns {number|null}
 */
function parseTFR(text) {
  if (!text) return null;
  const _reject = /per\s*1[,.]?000|‰|treatment|clinic|ivf|in\s*vitro|crude\s+birth/i;
  const patterns = [
    /\btotal\s+fertility\s+rate\b[^0-9]*([0-9]+\.[0-9]+)/i,
    /\bTFR\b[^0-9]*([0-9]+\.[0-9]+)/i,
    /\bfertility\s+rate\b[^0-9]*([0-9]+\.[0-9]+)/i,
    /\bbirth\s+rate\b[^0-9]*([0-9]+\.[0-9]+)/i,
    /\bbirths?\s+per\s+woman\b[^0-9]*([0-9]+\.[0-9]+)/i,
    /\bfertility\b[^0-9]*([0-9]+\.[0-9]+)/i,
  ];
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m) {
      const ctx = text.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30);
      if (_reject.test(ctx)) continue;
      const v = parseFloat(m[1]);
      if (v >= 0.5 && v <= 10) return Math.round(v * 100) / 100;
    }
  }
  return null;
}

/**
 * Build Seed Metric table from parsed data.
 * Deterministic — no LLM touch. Column headers match the canonical gate format.
 * @param {object} parsedData - Output from parseSeedMetricData()
 * @param {string} historicalDecade - e.g., "1970s"
 * @param {number} currentYear - e.g., 2026 (defaults to this year)
 * @returns {string} Markdown table with regime readings
 */
function buildSeedMetricTable(parsedData, historicalDecade = String(new Date().getFullYear() - 50).slice(0, 3) + '0s', currentYear = new Date().getFullYear()) {
  const rows = [];
  const summaries = [];

  rows.push('| City | Period | LCU/sqm | 700sqm Land Price | Income (LCU) | Years | Regime | TFR |');
  rows.push('|------|--------|---------|-------------------|--------------|-------|--------|-----|');

  for (const [city, data] of Object.entries(parsedData.cities || {})) {
    const cityTitle = city.charAt(0).toUpperCase() + city.slice(1);

    // Historical row
    const histPriceSqm = data.historical?.pricePerSqm?.value;
    const histIncome   = data.historical?.income?.value;
    const histCurrency = data.historical?.pricePerSqm?.currency || data.historical?.income?.currency || detectCurrency(city);
    const histMetric   = calculateSeedMetric(histPriceSqm, histIncome);

    // Current row
    const currPriceSqm = data.current?.pricePerSqm?.value;
    const currIncome   = data.current?.income?.value;
    const currCurrency = data.current?.pricePerSqm?.currency || data.current?.income?.currency || detectCurrency(city);
    const currMetric   = calculateSeedMetric(currPriceSqm, currIncome);

    // Regime labels
    const histRegime = histMetric.regime !== 'N/A' ? `${histMetric.emoji} ${histMetric.regime}` : 'N/A';
    const currRegime = currMetric.regime !== 'N/A' ? `${currMetric.emoji} ${currMetric.regime}` : 'N/A';

    // Years display
    const histYears = histMetric.years != null ? `${Math.round(histMetric.years)}yr` : 'N/A';
    const currYears = currMetric.years != null ? `${Math.round(currMetric.years)}yr` : 'N/A';

    // TFR
    const histTfr = data.historical?.tfr != null ? String(data.historical.tfr) : 'N/A';
    const currTfr = data.current?.tfr   != null ? String(data.current.tfr)   : 'N/A';

    // LCU/sqm display
    const histSqm = histPriceSqm ? `${formatCurrency(histPriceSqm, histCurrency)}/sqm` : 'N/A';
    const currSqm = currPriceSqm ? `${formatCurrency(currPriceSqm, currCurrency)}/sqm` : 'N/A';

    rows.push(`| ${cityTitle} | ${historicalDecade} | ${histSqm} | ${formatCurrency(histMetric.price700sqm, histCurrency)} | ${formatCurrency(histIncome, histCurrency)} | ${histYears} | ${histRegime} | ${histTfr} |`);
    rows.push(`| ${cityTitle} | ${currentYear} | ${currSqm} | ${formatCurrency(currMetric.price700sqm, currCurrency)} | ${formatCurrency(currIncome, currCurrency)} | ${currYears} | ${currRegime} | ${currTfr} |`);

    // Summary line
    const direction = (currMetric.years != null && histMetric.years != null)
      ? (currMetric.years > histMetric.years ? '↑worsened' : '↓improved')
      : '';
    summaries.push(`**${cityTitle}**: ${histYears} → ${currYears} = ${currMetric.emoji} ${currMetric.regime}${direction ? ` (${direction})` : ''}`);
  }

  const table        = rows.join('\n');
  const summaryBlock = summaries.join('\n');

  return `${table}\n\n${summaryBlock}`;
}

/**
 * Validate Seed Metric output format
 * @param {string} output - LLM-generated output
 * @returns {object} { valid: boolean, issues: string[] }
 */
function validateSeedMetricOutput(output, historicalDecade = String(new Date().getFullYear() - 50).slice(0, 3) + '0s') {
  const issues = [];

  if (!output) {
    issues.push('Empty output');
    return { valid: false, issues };
  }

  // Build dynamic historical year regex from the provided decade (e.g. "2000s" → /200\d/)
  const decadeDigits = historicalDecade.replace(/[^0-9]/g, '').slice(0, 3); // "1970s"→"197", "2000s"→"200"
  const histRegex = new RegExp(`(?:${decadeDigits}\\d|~?${decadeDigits}|${historicalDecade.replace(/s$/, '')}s?)`, 'i');

  // Build dynamic current year regex (accept any 202x or 203x year)
  const currRegex = /(?:202\d|203\d|now|today|present)/i;

  // Check for table header (must have LCU/sqm column, NO P/I column)
  // Accept both markdown format (| City | ...) and LLM natural format (City | ...)
  const hasTableHeader = /(?:\|\s*)?City\s*\|.*Period\s*\|.*Regime\s*\|?/i.test(output);
  if (!hasTableHeader) {
    issues.push('FORBIDDEN: Missing table header. Output MUST use | City | Period | LCU/sqm | 700sqm Land Price | Income (LCU) | Years | Regime | format.');
  }

  // Check table row count — need at least 2 rows per city (historical + current)
  // Accept rows with or without leading |
  const tableRows = output.match(/^(?:\|)?[^|\n-][^|\n]*(?:\|[^|\n]*){4,}\|?$/gm);
  const dataRows = tableRows ? tableRows.filter(r => !/City|Period|Regime/i.test(r)).length : 0;
  if (hasTableHeader && dataRows < 2) {
    issues.push('FORBIDDEN: Table needs at least 2 data rows (historical + current). Must show historical AND now.');
  }

  // Check that table rows contain historical and current period references
  if (hasTableHeader && dataRows >= 2) {
    const rowText = tableRows ? tableRows.join(' ') : '';
    const hasHistRow = histRegex.test(rowText);
    const hasCurrRow = currRegex.test(rowText);
    if (!hasHistRow) {
      issues.push(`Table missing historical period row (${historicalDecade}). Must show historical data.`);
    }
    if (!hasCurrRow) {
      issues.push('Table missing current period row (202x). Must show current data.');
    }
  }
  
  // Check for forbidden P/I column in table header
  const hasPIColumn = /\|\s*P\/I\s*\|/i.test(output);
  if (hasPIColumn) {
    issues.push('FORBIDDEN: Table has P/I column. Use LCU/sqm column instead. Years = (LCU/sqm × 700) ÷ Income.');
  }
  
  // Check for City column in table header (must be unified table, not split per city)
  const hasCityColumn = /\|\s*City\s*\|/i.test(output);
  if (hasTableHeader && !hasCityColumn) {
    issues.push('Missing City column in table header. Must use unified | City | Period | ... | format (not separate tables per city).');
  }
  
  // Check for split tables (separate table per city = wrong format)
  const tableHeaderCount = (output.match(/\|\s*(?:City\s*\|)?\s*Period\s*\|/gi) || []).length;
  if (tableHeaderCount > 1) {
    issues.push('FORBIDDEN: Multiple tables detected. Must use ONE unified table with City column, not separate tables per city.');
  }
  
  // Check for emoji regime readings with labels.
  // Only required when at least one row has numeric data (not all-N/A).
  // If Brave found no income/price data for any row, all-N/A is the honest output.
  // Detect if at least one row has real monetary data (not all-N/A).
  // Look for currency-prefixed values: $13,419 / £7,700 / ¥759,000 / €8,000 etc.
  // Year periods (2024) and formula literals (LCU/sqm) don't match — they lack a digit right after $¥£€.
  const hasAnyNumericRow = /[$¥£€]\s*[\d,]+/.test(output);
  const hasRegimeEmoji = /[🟢🟡🔴]/.test(output);
  const hasRegimeLabel = /(?:OPTIMISM|EXTRACTION|FATALISM|Optimism|Extraction|Fatalism)/i.test(output);
  if (hasAnyNumericRow && !hasRegimeEmoji) {
    issues.push('Missing regime emoji (🟢/🟡/🔴) — must appear in Regime column for rows with data');
  }
  if (hasAnyNumericRow && !hasRegimeLabel) {
    issues.push('Missing regime label (Optimism/Extraction/Fatalism)');
  }
  
  // Check for summary lines after table (e.g., **London**: 13.1yr → 101.2yr = 🔴 Fatalism)
  // Also accept ⚪ N/A yr for missing historical data
  const hasSummaryLine = /\*\*[^*]+\*\*\s*:\s*(?:[\d.]+|[⚪⬜]?\s*N\/A)\s*yr\s*→\s*(?:[\d.]+|[⚪⬜]?\s*N\/A)\s*yr/i.test(output);
  if (hasTableHeader && !hasSummaryLine) {
    issues.push('Missing summary lines after table. Need: **[City]**: [old]yr → [new]yr = [emoji] [Regime] (↑worsened/↓improved)');
  }
  
  // REGIME MISMATCH DETECTION — parse table rows by column index
  // Table format: | City | Period | LCU/sqm | 700sqm Land Price | Income (LCU) | Years | Regime |
  // Column indices: 0=City, 1=Period, 2=LCU/sqm, 3=700sqm, 4=Income, 5=Years, 6=Regime
  // Accept table lines with or without leading | (LLM natural format uses no leading |)
  const allTableLines = output.split('\n').filter(line => {
    const t = line.trim();
    return t.includes('|') && !/^[\s|:-]+$/.test(t);
  });
  const dataLines = allTableLines.filter(line => !/City|Period|Regime/i.test(line) && !/^[\s|:-]+$/.test(line.trim()));
  for (const line of dataLines) {
    const cols = line.split('|').map(c => c.trim()).filter(c => c.length > 0);
    if (cols.length >= 6) {
      const yearsCol = cols.length >= 7 ? cols[5] : cols[cols.length - 2];
      const regimeCol = cols.length >= 7 ? cols[6] : cols[cols.length - 1];
      const yearsNum = parseFloat(yearsCol.replace(/[,yr\s]/gi, ''));
      const regimeMatch = regimeCol.match(/(Optimism|Extraction|Fatalism)/i);
      if (!isNaN(yearsNum) && regimeMatch) {
        const regime = regimeMatch[1].toLowerCase();
        if (yearsNum < 10 && regime !== 'optimism') {
          issues.push(`REGIME MISMATCH: ${yearsNum}yr should be 🟢 Optimism (<10yr), not ${regimeMatch[1]}`);
        } else if (yearsNum >= 10 && yearsNum <= 25 && regime !== 'extraction') {
          issues.push(`REGIME MISMATCH: ${yearsNum}yr should be 🟡 Extraction (10-25yr), not ${regimeMatch[1]}`);
        } else if (yearsNum > 25 && regime !== 'fatalism') {
          issues.push(`REGIME MISMATCH: ${yearsNum}yr should be 🔴 Fatalism (>25yr), not ${regimeMatch[1]}`);
        }
      }
    }
  }
  
  // Check for 700sqm mention (not just "sqm" or wrong size)
  const has700sqm = /700\s*(?:sqm|sq\s*m|m²)/i.test(output);
  if (!has700sqm) {
    issues.push('Missing 700sqm reference');
  }
  
  // Check for prose paragraphs (bad sign — output MUST be table, not prose)
  const proseIndicators = output.match(/(?:Fast forward|Using the Seed Metric|we can calculate|we can estimate|However,|it's essential|In conclusion|assuming a|Comparing the two|Assuming an|The median|approximately \d|50 years ago)/gi);
  if (proseIndicators && proseIndicators.length >= 2) {
    issues.push('FORBIDDEN: Contains prose paragraphs instead of table. Must use | City | Period | LCU/sqm | ... | Regime | format.');
  }
  
  // Check paragraph count - if >3 paragraphs and no table header, reject
  const paragraphs = output.split(/\n\n+/).filter(p => p.trim().length > 50);
  if (paragraphs.length > 3 && !hasTableHeader) {
    issues.push('FORBIDDEN: Too many paragraphs without table format. Output must be a markdown table.');
  }
  
  // Check for missing historical data (must have BOTH historical AND current)
  // Use dynamic histRegex (already defined above) to accept user-specified years
  const hasHistorical = histRegex.test(output) || /~?\d{4}s?|50\s*(?:yr|year)s?\s*ago/i.test(output);
  const hasCurrentData = currRegex.test(output);
  if (!hasHistorical && hasCurrentData) {
    issues.push(`Missing historical (${historicalDecade}) data. Must show BOTH historical AND current periods.`);
  }

  // Check for "no data" prose cop-out on CURRENT LCU/sqm only
  // Historical N/A is acceptable (use ⚪ N/A in table cell — not prose excuse)
  const currentNoDataCopout = /(?:no data|no precise|unavailable|cannot find).*(?:current|2024|2025|today|present)/i;
  if (currentNoDataCopout.test(output)) {
    issues.push('FORBIDDEN: "No data" cop-out on current period. Must use live Brave search data.');
  }
  
  // Check for wrong 700sqm interpretation (e.g., "3-room = 700sqm")
  const wrong700sqm = /(?:3-room|HDB|apartment|flat)[^.]*(?:approximately|about|around)?\s*700\s*(?:sqm|sq\s*m|m²)/i.test(output);
  if (wrong700sqm) {
    issues.push('Wrong 700sqm interpretation (apartment ≠ 700sqm)');
  }
  
  // HALLUCINATION DETECTION - specific wrong patterns
  // 1. 700 sqft confusion (should be 700 m², not sqft)
  if (/700\s*(?:sqft|sq\s*ft|square\s*feet)/i.test(output)) {
    issues.push('Wrong unit: 700 sqft instead of 700 m² (10x error)');
  }
  
  // 2. Mortgage/interest rate calculations (FORBIDDEN - Years = (LCU/sqm × 700) ÷ Income)
  if (/(?:down\s*payment|interest\s*rate|mortgage|pay\s*off|amortiz|loan\s*term|\d+%\s*interest)/i.test(output)) {
    issues.push('FORBIDDEN: Contains mortgage/interest calculations. Years = Price ÷ Income (simple division)');
  }
  
  // 3. P/I 3.5 threshold (FORBIDDEN - removed fallback mode)
  if (/(?:P\/I|price[\s-]*to[\s-]*income).*3\.5|threshold.*3\.5/i.test(output)) {
    issues.push('FORBIDDEN: P/I 3.5 threshold. Use 10/25yr only.');
  }
  
  // 3b. Raw P/I ratio used without LCU/sqm (indicates bypassing the formula)
  const rawPIUsed = /(?:price[\s-]*to[\s-]*income|P\/I)\s*(?:ratio)?\s*(?:is|=|:)\s*[\d.]+/i.test(output);
  const hasSqmColumn = /\|\s*(?:\$\/sqm|LCU\/sqm)\s*\|/i.test(output);
  if (rawPIUsed && !hasSqmColumn) {
    issues.push('Raw P/I ratio used without LCU/sqm source data. Must use (LCU/sqm × 700) ÷ income formula.');
  }
  
  // 4. Generic sqft mention without 700m² (likely wrong unit)
  if (/\d+\s*sqft/i.test(output) && !has700sqm) {
    issues.push('Uses sqft without proper 700m² reference');
  }
  
  return {
    valid: issues.length === 0,
    issues
  };
}

/**
 * Parse LLM PURIFY output into the same structure as parseSeedMetricData.
 * Expected LLM output — one line per (city, period):
 *   [City] [Period]: sqm=VALUE CURRENCY | income=VALUE CURRENCY | TFR=VALUE | type=built/land/N/A
 *
 * The LLM does quanta extraction (including triangulation: total÷area=sqm).
 * This function does zero interpretation — it only reads the structured result.
 *
 * @param {string}   purifyText        - LLM PURIFY output
 * @param {string[]} cities            - Normalized city keys (lowercase)
 * @param {string}   historicalDecade  - e.g. "1970s"
 * @param {number}   currentYear       - Request timestamp year
 */
function parsePurifyOutput(purifyText, cities = [], historicalDecade = '1970s', currentYear = new Date().getFullYear()) {
  const result = { cities: {}, parseLog: [] };
  if (!purifyText || !cities.length) return result;

  const normalizedCities = cities.map(c => c.toLowerCase().trim());
  for (const city of normalizedCities) {
    result.cities[city] = {
      current:    { pricePerSqm: null, income: null, tfr: null },
      historical: { pricePerSqm: null, income: null, tfr: null, decade: historicalDecade }
    };
  }

  // Match each structured line the LLM outputs.
  // Brackets are optional — LLM occasionally omits them despite instructions.
  // Format: [City] [Period]: sqm=V CUR | income=V CUR | TFR=V | type=T
  //    or:   City Period:    sqm=V CUR | income=V CUR | TFR=V | type=T
  const lineRx = /\[?([A-Za-z][^\]\[|:\n]{1,40}?)\]?\s*\[?(\d{4}[^\]\[|:\n]{0,20}?)\]?\s*:\s*sqm=([^\s|]+)(?:\s+([A-Z]{2,4}))?\s*\|\s*income=([^\s|]+)(?:\s+([A-Z]{2,4}))?\s*\|\s*TFR=([^\s|]+)\s*\|\s*type=(\S+)/gi;

  for (const match of purifyText.matchAll(lineRx)) {
    const cityRaw = match[1].trim();
    const period  = match[2].trim();
    const sqmStr  = match[3].trim();
    const sqmCurr = match[4]?.trim() || '';
    const incStr  = match[5].trim();
    const incCurr = match[6]?.trim() || sqmCurr;
    const tfrStr  = match[7].trim();
    const typeStr = match[8]?.trim() || '';

    // Match LLM city name to our city keys (substring both ways, diacritic-insensitive)
    // e.g. PURIFY outputs "São Paulo" but our key is "sao paulo" — strip accents before match
    const stripDia = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const cityLower = stripDia(cityRaw.toLowerCase());
    let cityKey = normalizedCities.find(c => {
      const cn = stripDia(c);
      return cn.includes(cityLower) || cityLower.includes(cn);
    });
    if (!cityKey) {
      // Companion city chosen by LLM — not in preflight list.
      // Accept it dynamically so the companion's data flows through to the table.
      cityKey = cityLower;
      normalizedCities.push(cityKey);
      result.cities[cityKey] = {
        current:    { pricePerSqm: null, income: null, tfr: null },
        historical: { pricePerSqm: null, income: null, tfr: null, decade: historicalDecade }
      };
      result.parseLog.push(`PURIFY: companion city "${cityRaw}" accepted dynamically`);
    }

    // Current vs historical — LLM already labelled the period year
    const periodYear = parseInt(period.replace(/[^0-9]/g, ''));
    const isHistorical = !isNaN(periodYear) && periodYear < currentYear - 8;
    const slot = isHistorical ? 'historical' : 'current';

    const currency = sqmCurr || detectCurrency(cityKey, '');

    if (sqmStr !== 'N/A') {
      const v = parseFloat(sqmStr.replace(/[^0-9.]/g, ''));
      if (isFinite(v) && v > 0) {
        const pt = typeStr && typeStr !== 'N/A' ? typeStr.toLowerCase() : null;
        result.cities[cityKey][slot].pricePerSqm = { value: v, currency, priceType: pt === 'built' || pt === 'land' ? pt : null };
      }
    }
    if (incStr !== 'N/A') {
      const v = parseFloat(incStr.replace(/[^0-9.]/g, ''));
      if (isFinite(v) && v > 0) result.cities[cityKey][slot].income = { value: v, currency: incCurr || currency };
    }
    if (tfrStr !== 'N/A') {
      const v = parseFloat(tfrStr);
      if (isFinite(v) && v > 0 && v < 15) result.cities[cityKey][slot].tfr = v;
    }

    result.parseLog.push(`PURIFY ${cityKey} ${slot}(${period}): sqm=${result.cities[cityKey][slot].pricePerSqm?.value ?? 'N/A'} ${currency}, income=${result.cities[cityKey][slot].income?.value ?? 'N/A'}, TFR=${result.cities[cityKey][slot].tfr ?? 'N/A'}`);
  }

  // Summary log
  for (const city of normalizedCities) {
    const c = result.cities[city];
    result.parseLog.push(`${city} CURRENT: price/sqm=${c.current.pricePerSqm?.value ?? 'N/A'}, income=${c.current.income?.value ?? 'N/A'}, tfr=${c.current.tfr ?? 'N/A'}`);
    result.parseLog.push(`${city} HISTORICAL: price/sqm=${c.historical.pricePerSqm?.value ?? 'N/A'}, income=${c.historical.income?.value ?? 'N/A'}, tfr=${c.historical.tfr ?? 'N/A'}`);
  }

  return result;
}

module.exports = {
  parsePricePerSqm,
  parseIncome,
  parseTFR,
  parseSeedMetricData,
  parsePurifyOutput,
  calculateSeedMetric,
  formatCurrency,
  buildSeedMetricTable,
  validateSeedMetricOutput
};
