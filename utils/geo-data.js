const CITY_EXPAND = { 'la': 'los angeles', 'ny': 'new york', 'nyc': 'new york city', 'sf': 'san francisco', 'dc': 'washington dc', 'hk': 'hong kong', 'kl': 'kuala lumpur' };

const COUNTRY_TO_CITY = {
  'united kingdom': 'london', 'united states': 'new york', 'south korea': 'seoul',
  'united arab emirates': 'dubai', 'vietnam': 'hanoi', 'korea': 'seoul',
  'japan': 'tokyo', 'china': 'beijing', 'indonesia': 'jakarta',
  'thailand': 'bangkok', 'malaysia': 'kuala lumpur', 'philippines': 'manila',
  'india': 'mumbai', 'australia': 'sydney', 'canada': 'toronto',
  'uk': 'london', 'england': 'london', 'britain': 'london',
  'france': 'paris', 'germany': 'berlin', 'spain': 'madrid',
  'italy': 'rome', 'switzerland': 'zurich', 'brazil': 'sao paulo',
  'uae': 'dubai', 'usa': 'new york',
  'mexico': 'mexico city', 'taiwan': 'taipei', 'hong kong': 'hong kong',
  'russia': 'moscow', 'turkey': 'istanbul', 'egypt': 'cairo',
  'nigeria': 'lagos', 'argentina': 'buenos aires', 'colombia': 'bogota',
  'chile': 'santiago', 'peru': 'lima', 'brazilian': 'sao paulo',
  'japanese': 'tokyo', 'korean': 'seoul', 'chinese': 'beijing',
  'indian': 'mumbai', 'thai': 'bangkok', 'indonesian': 'jakarta',
  'mexican': 'mexico city', 'turkish': 'istanbul', 'egyptian': 'cairo',
  'colombian': 'bogota', 'peruvian': 'lima', 'chilean': 'santiago',
  'argentinian': 'buenos aires', 'argentine': 'buenos aires',
  'vietnamese': 'hanoi', 'filipino': 'manila', 'philippine': 'manila',
  'malaysian': 'kuala lumpur', 'australian': 'sydney', 'canadian': 'toronto',
  'british': 'london', 'french': 'paris', 'german': 'berlin',
  'spanish': 'madrid', 'italian': 'rome', 'swiss': 'zurich',
  'russian': 'moscow', 'nigerian': 'lagos', 'taiwanese': 'taipei',
};

const CITY_TO_COUNTRY = {};
for (const [country, city] of Object.entries(COUNTRY_TO_CITY)) {
  if (!CITY_TO_COUNTRY[city] && /^[a-z\s]+$/i.test(country) && !(/ese$|ish$|ian$|ine$|ch$|ss$/.test(country))) {
    CITY_TO_COUNTRY[city] = country.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }
}

// Explicit overrides for city-states / sovereign cities where city == country.
// These are NOT in COUNTRY_TO_CITY (no demonym → city mapping exists), so without
// this block `cityToCountry['singapore']` etc. would be undefined and any caller
// that derives ISO2 from country name (e.g. World Bank TFR / GNI lookups) would
// silently bypass the structured silo and fall through to Brave.
const _CITY_STATES = {
  'singapore': 'Singapore',
  'hong kong': 'Hong Kong',
  'hongkong':  'Hong Kong',
  'dubai':     'United Arab Emirates',
  'abu dhabi': 'United Arab Emirates',
  'monaco':    'Monaco',
  'macau':     'Macao',
  'macao':     'Macao',
  'vatican':   'Vatican',
};
for (const [_city, _country] of Object.entries(_CITY_STATES)) {
  if (!CITY_TO_COUNTRY[_city]) CITY_TO_COUNTRY[_city] = _country;
}

// Explicit overrides for US cities not captured by auto-inversion
// (COUNTRY_TO_CITY only lists 'new york' as the US representative city)
const _US = 'United States';
for (const _city of [
  'san francisco', 'los angeles', 'chicago', 'boston', 'seattle', 'miami',
  'austin', 'denver', 'washington dc', 'washington', 'phoenix', 'dallas',
  'houston', 'atlanta', 'portland', 'san diego', 'philadelphia', 'las vegas',
  'minneapolis', 'nashville', 'detroit', 'honolulu', 'anchorage', 'tampa',
  'orlando', 'charlotte', 'salt lake city', 'kansas city', 'pittsburgh',
  'memphis', 'richmond', 'buffalo', 'hartford', 'new orleans', 'cincinnati',
  'cleveland', 'columbus', 'indianapolis', 'louisville', 'milwaukee',
  'oklahoma city', 'tucson', 'albuquerque', 'fresno', 'sacramento',
  'san jose', 'raleigh', 'virginia beach', 'omaha', 'baton rouge',
]) {
  if (!CITY_TO_COUNTRY[_city]) CITY_TO_COUNTRY[_city] = _US;
}

const COUNTRY_CITY_MAP = {
  'vietnam': ['hanoi', 'ho chi minh'],
  'korea': ['seoul'], 'south korea': ['seoul'],
  'japan': ['tokyo'], 'china': ['beijing', 'shanghai'],
  'indonesia': ['jakarta'], 'thailand': ['bangkok'],
  'malaysia': ['kuala lumpur'], 'philippines': ['manila'],
  'india': ['mumbai', 'delhi'], 'australia': ['sydney'],
  'canada': ['toronto'], 'uk': ['london'],
  'england': ['london'], 'britain': ['london'],
  'france': ['paris'], 'germany': ['berlin'],
  'spain': ['madrid'], 'italy': ['rome'],
  'switzerland': ['zurich'], 'brazil': ['sao paulo'],
  'uae': ['dubai'], 'usa': ['new york'],
  'united states': ['new york'], 'mexico': ['mexico city'],
  'taiwan': ['taipei'], 'hong kong': ['hong kong'],
  'russia': ['moscow'], 'turkey': ['istanbul'],
  'egypt': ['cairo'], 'nigeria': ['lagos'],
  'argentina': ['buenos aires'], 'colombia': ['bogota'],
  'chile': ['santiago'], 'peru': ['lima'],
};

const KNOWN_CITIES_REGEX = /\b(tokyo|singapore|hong kong|hongkong|london|new york|ny|nyc|sydney|paris|berlin|shanghai|beijing|seoul|taipei|osaka|mumbai|bombay|delhi|new delhi|bangkok|jakarta|manila|kuala lumpur|kl|ho chi minh|saigon|hanoi|san francisco|sf|los angeles|la|chicago|toronto|vancouver|melbourne|auckland|dubai|abu dhabi|munich|frankfurt|amsterdam|madrid|barcelona|rome|milan|vienna|zurich|geneva|stockholm|copenhagen|oslo|helsinki|brussels|prague|warsaw|budapest|moscow|st petersburg|sao paulo|rio de janeiro|mexico city|buenos aires|bogota|lima|santiago|johannesburg|cape town|cairo|tel aviv|istanbul|athens|lisbon|dublin|edinburgh|manchester|birmingham|seattle|boston|washington dc|miami|dallas|houston|denver|phoenix|atlanta|detroit|philadelphia|minneapolis|portland|austin|san diego|honolulu|anchorage|montreal|calgary|ottawa|perth|brisbane|adelaide|wellington|christchurch|chengdu|shenzhen|guangzhou|hangzhou|nanjing|wuhan|xian|chongqing|tianjin|suzhou|qingdao|dalian|xiamen|fuzhou|ningbo|changsha|zhengzhou|jinan|shenyang|harbin|kunming|nanchang|hefei|taiyuan|shijiazhuang|lanzhou|urumqi|guiyang|nanning|haikou|lhasa|hohhot|yinchuan|xining)\b/gi;

const COUNTRY_CITY_MAP_KEYS_PATTERN = '\\b(' + Object.keys(COUNTRY_CITY_MAP).join('|') + ')\\b';

const CURRENCY_REGISTRY = {
  USD: { symbols: ['USD', '$'],                    cities: ['los angeles', 'la', 'new york', 'nyc', 'chicago', 'san francisco', 'sf', 'seattle', 'boston', 'miami', 'houston', 'dallas', 'denver', 'atlanta', 'phoenix', 'portland', 'austin', 'san diego', 'washington dc', 'philadelphia', 'minneapolis', 'detroit', 'honolulu', 'usa', 'united states'] },
  EUR: { symbols: ['EUR', '€'],                    cities: ['paris', 'berlin', 'vienna', 'amsterdam', 'munich', 'rome', 'madrid', 'milan', 'brussels', 'lisbon', 'dublin', 'hamburg', 'frankfurt', 'europe', 'eurozone'] },
  GBP: { symbols: ['GBP', '£'],                    cities: ['london', 'manchester', 'birmingham', 'edinburgh', 'uk', 'united kingdom'] },
  JPY: { symbols: ['JPY', 'yen', '¥', '￥'],       cities: ['tokyo', 'osaka', 'kyoto', 'japan'] },
  KRW: { symbols: ['KRW', 'won', '₩'],             cities: ['seoul', 'busan', 'incheon', 'daegu', 'daejeon', 'korea'] },
  SGD: { symbols: ['SGD', 'S$'],                   cities: ['singapore'] },
  HKD: { symbols: ['HKD', 'HK$'],                  cities: ['hong kong'] },
  AUD: { symbols: ['AUD', 'A$'],                   cities: ['sydney', 'melbourne', 'brisbane', 'perth', 'australia'] },
  CAD: { symbols: ['CAD', 'C$'],                   cities: ['toronto', 'vancouver', 'montreal', 'calgary', 'canada'] },
  CHF: { symbols: ['CHF', 'Fr'],                   cities: ['zurich', 'geneva', 'switzerland'] },
  CNY: { symbols: ['CNY', 'RMB', 'yuan', '元'],    cities: ['beijing', 'shanghai', 'shenzhen', 'guangzhou', 'china'] },
  INR: { symbols: ['INR', 'Rs', '₹'],              cities: ['mumbai', 'delhi', 'bangalore', 'hyderabad', 'chennai', 'india'] },
  IDR: { symbols: ['IDR', 'Rp'],                   cities: ['jakarta', 'surabaya', 'bali', 'indonesia'] },
  VND: { symbols: ['VND', 'dong', '₫'],            cities: ['hanoi', 'ho chi minh', 'saigon', 'vietnam'] },
  THB: { symbols: ['THB', 'baht', '฿'],            cities: ['bangkok', 'phuket', 'thailand'] },
  MYR: { symbols: ['MYR', 'RM', 'ringgit'],        cities: ['kuala lumpur', 'penang', 'malaysia'] },
  PHP: { symbols: ['PHP', '₱', 'peso'],            cities: ['manila', 'cebu', 'philippines'] },
  AED: { symbols: ['AED', 'dirham'],               cities: ['dubai', 'abu dhabi', 'uae'] },
  BRL: { symbols: ['BRL', 'R$'],                   cities: ['sao paulo', 'rio', 'brazil'] },
  NZD: { symbols: ['NZD', 'NZ$'],                  cities: ['auckland', 'wellington', 'new zealand'] },
  ZAR: { symbols: ['ZAR', 'R'],                    cities: ['johannesburg', 'cape town', 'south africa'] },
  MXN: { symbols: ['MXN', 'MX$'],                 cities: ['mexico city', 'guadalajara', 'mexico'] },
  TRY: { symbols: ['TRY', '₺'],                    cities: ['istanbul', 'ankara', 'turkey'] },
};

/**
 * Map a city key to its expected ISO-4217 currency code, derived from
 * CURRENCY_REGISTRY (the city → currency relation already lives there).
 * Used to disambiguate ambiguous symbols like '¥' (JPY for Tokyo, CNY for
 * Beijing) and '$' (USD for NYC, AUD for Sydney, etc.) at extraction time.
 *
 * @param {string} cityKey - Lowercased city key (e.g. 'beijing', 'tokyo')
 * @returns {string|null}  - ISO-4217 code (e.g. 'CNY', 'JPY') or null if unknown
 */
function cityToExpectedCurrency(cityKey) {
  if (!cityKey) return null;
  const key = cityKey.toLowerCase().trim();
  for (const [code, def] of Object.entries(CURRENCY_REGISTRY)) {
    if (def.cities.includes(key)) return code;
  }
  return null;
}

const FRED_MSA_CODES = {
  'san francisco': 6075, 'sf': 6075,
  'los angeles': 31080, 'la': 31080,
  'new york': 35620, 'new york city': 35620, 'nyc': 35620,
  'chicago': 16980,
  'boston': 14460,
  'seattle': 42660,
  'miami': 33100,
  'austin': 12420,
  'denver': 19740,
  'washington dc': 47900, 'dc': 47900, 'washington': 47900,
  'phoenix': 38060,
  'dallas': 19100,
  'houston': 26420,
  'atlanta': 12060,
  'portland': 38900,
  'san diego': 41740,
  'philadelphia': 37980,
  'las vegas': 29820,
  'minneapolis': 33460,
  'nashville': 34980,
};

const COUNTRY_ISO2 = {
  'united states': 'US', 'usa': 'US', 'united states of america': 'US',
  'japan': 'JP',
  'united kingdom': 'GB', 'uk': 'GB', 'britain': 'GB', 'england': 'GB',
  'singapore': 'SG',
  'germany': 'DE',
  'australia': 'AU',
  'hong kong': 'HK',
  'india': 'IN',
  'brazil': 'BR',
  'france': 'FR',
  'canada': 'CA',
  'thailand': 'TH',
  'indonesia': 'ID',
  'malaysia': 'MY',
  'philippines': 'PH', 'philippine': 'PH',
  'mexico': 'MX',
  'china': 'CN',
  'south korea': 'KR', 'korea': 'KR',
  'taiwan': 'TW',
  'turkey': 'TR',
  'egypt': 'EG',
  'nigeria': 'NG',
  'argentina': 'AR',
  'colombia': 'CO',
  'chile': 'CL',
  'peru': 'PE',
  'russia': 'RU',
  'vietnam': 'VN',
  'south africa': 'ZA',
  'switzerland': 'CH',
  'italy': 'IT',
  'spain': 'ES',
  'netherlands': 'NL',
  'sweden': 'SE',
  'norway': 'NO',
  'united arab emirates': 'AE', 'uae': 'AE',
  'monaco': 'MC', 'macao': 'MO', 'macau': 'MO', 'vatican': 'VA',
};

// ISO-3166-1 alpha-2 → ISO-4217 currency code
// Used to tag World Bank LCU income with the correct currency symbol
const ISO2_TO_CURRENCY = {
  US: 'USD', JP: 'JPY', GB: 'GBP', SG: 'SGD', DE: 'EUR',
  AU: 'AUD', HK: 'HKD', IN: 'INR', BR: 'BRL', FR: 'EUR',
  CA: 'CAD', TH: 'THB', ID: 'IDR', MY: 'MYR', PH: 'PHP',
  MX: 'MXN', CN: 'CNY', KR: 'KRW', TW: 'TWD', TR: 'TRY',
  EG: 'EGP', NG: 'NGN', AR: 'ARS', CO: 'COP', CL: 'CLP',
  PE: 'PEN', RU: 'RUB', VN: 'VND', ZA: 'ZAR', CH: 'CHF',
  IT: 'EUR', ES: 'EUR', NL: 'EUR', SE: 'SEK', NO: 'NOK',
  AE: 'AED', NZ: 'NZD', AT: 'EUR', BE: 'EUR', PT: 'EUR',
  FI: 'EUR', IE: 'EUR', GR: 'EUR', DK: 'DKK', PL: 'PLN',
  CZ: 'CZK', HU: 'HUF', RO: 'RON', IL: 'ILS', SA: 'SAR',
  QA: 'QAR', KW: 'KWD', ZW: 'USD',
};

// Static symbol/word → ISO-4217 map for unambiguous tokens.
// Ambiguous symbols (¥, $) are handled inline in normaliseCurrency via cityHint.
const _SYMBOL_TO_ISO = {
  '€': 'EUR', '£': 'GBP', '₩': 'KRW', '₹': 'INR', '₣': 'CHF',
  '₪': 'ILS', '฿': 'THB', '₫': 'VND', '₱': 'PHP', '₦': 'NGN',
  '₺': 'TRY', '₴': 'UAH', '₸': 'KZT', '₼': 'AZN', '₽': 'RUB',
  'yen': 'JPY', 'won': 'KRW', 'yuan': 'CNY', 'renminbi': 'CNY',
  'baht': 'THB', 'dong': 'VND', 'ringgit': 'MYR', 'peso': 'PHP',
  'rupee': 'INR', 'rupiah': 'IDR', 'real': 'BRL', 'lira': 'TRY',
  'dirham': 'AED', 'franc': 'CHF', 'frank': 'CHF', 'krona': 'SEK',
  'krone': 'NOK', 'forint': 'HUF', 'zloty': 'PLN', 'koruna': 'CZK',
  'shekel': 'ILS', 'dinar': 'KWD', 'riyal': 'SAR', 'rand': 'ZAR',
};

/**
 * Normalise a raw currency token (symbol, text name, or ISO code) to its
 * ISO-4217 three-letter code.  Ambiguous symbols (¥, $) are resolved via
 * cityHint when provided; otherwise they fall back to JPY and USD respectively.
 *
 * This is a safety net — the LLM prompt already asks for ISO codes.  It catches
 * cases where the LLM returns a glyph ("¥") or a word ("yen") instead.
 *
 * @param {string}  raw   - Raw currency token from LLM or scraper output
 * @param {string}  [city] - Lowercased city key for disambiguation (optional)
 * @returns {string|null}  - ISO-4217 code, original token if unrecognised, or null/undefined passthrough
 */
function normaliseCurrency(raw, city) {
  if (raw == null) return raw;
  const t = typeof raw === 'string' ? raw.trim() : String(raw).trim();
  if (!t) return t;

  // Ambiguous: ¥ / ￥ (JPY in Japan, CNY in China) — checked before the map.
  if (t === '¥' || t === '￥') {
    const expected = city ? cityToExpectedCurrency(city) : null;
    return (expected === 'JPY' || expected === 'CNY') ? expected : 'JPY';
  }

  // Ambiguous: $ (USD, AUD, SGD, CAD, HKD, NZD, …) — checked before the map.
  if (t === '$') {
    const expected = city ? cityToExpectedCurrency(city) : null;
    return expected || 'USD';
  }

  // Unambiguous symbol / text name lookup — checked BEFORE the 3-letter ISO
  // pass-through so that "yen", "won", "won" etc. resolve correctly rather
  // than being uppercased to "YEN", "WON" as pseudo-ISO codes.
  const fromMap = _SYMBOL_TO_ISO[t] || _SYMBOL_TO_ISO[t.toLowerCase()];
  if (fromMap) return fromMap;

  // Already a 3-letter ISO code (case-insensitive) — normalise case only.
  if (/^[A-Za-z]{3}$/.test(t)) return t.toUpperCase();

  return t;
}

module.exports = {
  CITY_EXPAND,
  COUNTRY_TO_CITY,
  CITY_TO_COUNTRY,
  COUNTRY_CITY_MAP,
  KNOWN_CITIES_REGEX,
  COUNTRY_CITY_MAP_KEYS_PATTERN,
  CURRENCY_REGISTRY,
  FRED_MSA_CODES,
  COUNTRY_ISO2,
  ISO2_TO_CURRENCY,
  cityToExpectedCurrency,
  normaliseCurrency,
};
