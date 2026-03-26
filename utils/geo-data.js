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

const KNOWN_CITIES_REGEX = /\b(tokyo|singapore|hong kong|hongkong|london|new york|nyc|sydney|paris|berlin|shanghai|beijing|seoul|taipei|osaka|mumbai|bombay|delhi|new delhi|bangkok|jakarta|manila|kuala lumpur|kl|ho chi minh|saigon|hanoi|san francisco|sf|los angeles|la|chicago|toronto|vancouver|melbourne|auckland|dubai|abu dhabi|munich|frankfurt|amsterdam|madrid|barcelona|rome|milan|vienna|zurich|geneva|stockholm|copenhagen|oslo|helsinki|brussels|prague|warsaw|budapest|moscow|st petersburg|sao paulo|rio de janeiro|mexico city|buenos aires|bogota|lima|santiago|johannesburg|cape town|cairo|tel aviv|istanbul|athens|lisbon|dublin|edinburgh|manchester|birmingham|seattle|boston|washington dc|miami|dallas|houston|denver|phoenix|atlanta|detroit|philadelphia|minneapolis|portland|austin|san diego|honolulu|anchorage|montreal|calgary|ottawa|perth|brisbane|adelaide|wellington|christchurch|chengdu|shenzhen|guangzhou|hangzhou|nanjing|wuhan|xian|chongqing|tianjin|suzhou|qingdao|dalian|xiamen|fuzhou|ningbo|changsha|zhengzhou|jinan|shenyang|harbin|kunming|nanchang|hefei|taiyuan|shijiazhuang|lanzhou|urumqi|guiyang|nanning|haikou|lhasa|hohhot|yinchuan|xining)\b/gi;

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

module.exports = {
  CITY_EXPAND,
  COUNTRY_TO_CITY,
  CITY_TO_COUNTRY,
  COUNTRY_CITY_MAP,
  KNOWN_CITIES_REGEX,
  COUNTRY_CITY_MAP_KEYS_PATTERN,
  CURRENCY_REGISTRY,
};
