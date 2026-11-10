'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { preflightRouter } = require('../utils/preflight-router');
const { seedMetricCities, seedMetricCurrencies, ensureSeedMetricCeilings, dedupPushUrl } = require('../utils/seed-metric-resources');
const { CITY_TO_COUNTRY, COUNTRY_ISO2, ISO2_TO_CURRENCY, cityToExpectedCurrency } = require('../utils/geo-data');
const { buildSeedMetricTable, emptyCityRecord, calculateSeedMetric } = require('../utils/seed-metric-calculator');

const G20 = [
    ['argentina','buenos aires','ARS'], ['australia','sydney','AUD'],
    ['brazil','sao paulo','BRL'], ['canada','toronto','CAD'],
    ['china','beijing','CNY'], ['france','paris','EUR'], ['germany','berlin','EUR'],
    ['india','mumbai','INR'], ['indonesia','jakarta','IDR'], ['italy','rome','EUR'],
    ['japan','tokyo','JPY'], ['mexico','mexico city','MXN'], ['russia','moscow','RUB'],
    ['saudi arabia','riyadh','SAR'], ['south africa','johannesburg','ZAR'],
    ['south korea','seoul','KRW'], ['turkey','istanbul','TRY'],
    ['united kingdom','london','GBP'], ['united states','new york','USD']
];

async function main() {
    for (const [country, city, currency] of G20) {
        const routed = await preflightRouter({query:`Seed metric for ${country}?`});
        assert.equal(routed.mode, 'seed-metric', country);
        const cities = seedMetricCities(routed);
        assert(!cities.some(key=>key.endsWith(' national')), `${country}: national fallback became a fake city`);
        assert(cities.some(key => key === city || (key === 'ny' && city === 'new york')), `${country}: missing representative city`);
        assert(seedMetricCurrencies(cities).includes(currency), `${country}: missing currency guard`);
        assert.equal(cityToExpectedCurrency(city), currency, `${city}: currency`);
        assert.equal(ISO2_TO_CURRENCY[COUNTRY_ISO2[CITY_TO_COUNTRY[city]?.toLowerCase()]], currency, `${city}: structured-data routing`);
        const row = emptyCityRecord('2000s');
        for (const period of ['current','historical']) {
            row[period].pricePerSqm = {value:1000,currency};
            row[period].income = {value:50000,currency};
        }
        const table = buildSeedMetricTable({cities:{[city]:row}},'2000s');
        assert.match(table, /14yr/, `${city}: fixture calculation`);
        assert(!table.includes('NaN') && !table.includes('Infinity'), city);
        row.historical.pricePerSqm = null;
        assert.match(buildSeedMetricTable({cities:{[city]:row}},'2000s'), /N\/A/, `${city}: missing data`);
    }
    assert.equal(calculateSeedMetric(1000,50000).years,14);
    const sg = await preflightRouter({query:'Seed metric for singapore and tokyo?'});
    assert.deepEqual(seedMetricCurrencies(seedMetricCities(sg)), ['USD','SGD','JPY']);
    const calls = [], state = {};
    const fetchMap = async currencies => {
        calls.push(currencies);
        return Object.fromEntries(currencies.map(currency => [currency,100000]));
    };
    await ensureSeedMetricCeilings(state,['singapore','tokyo'],fetchMap);
    await ensureSeedMetricCeilings(state,['singapore','tokyo'],fetchMap);
    await ensureSeedMetricCeilings(state,['singapore','tokyo','riyadh'],fetchMap);
    assert.deepEqual(calls,[['USD','SGD','JPY'],['SAR']]);
    assert.deepEqual(Object.keys(await state.ceilingMapP),['USD','SGD','JPY','SAR']);

    // Execute the actual post-walk block against a successful, fake BIS result.
    const source = fs.readFileSync(require.resolve('../utils/pipeline-orchestrator'),'utf8');
    const start = source.indexOf('    for (const cityKey of cities) {',source.indexOf('// ── Post-dog-walk BIS fill'));
    const end = source.indexOf('    // ── Cross-period invariant validation',start);
    const urls = [], warnings = [], data = {cities:{tokyo:{
        current:{pricePerSqm:{value:1700000,currency:'JPY'}},historical:{pricePerSqm:null}
    }}};
    const sandbox = {cities:['tokyo'],parsedData:data,CITY_TO_COUNTRY,COUNTRY_ISO2,
        histYear:'2000',sourceUrls:urls,dedupPushUrl,rescuePricePerSqm:value=>value,
        logger:{debug(){},warn:details=>warnings.push(details)},
        require:()=>({fetchBisPricePerSqm:async()=>({value:1600000,currency:'JPY',sourceUrl:'https://www.bis.org/statistics/pp.htm'})})};
    await vm.runInNewContext('(async()=>{'+source.slice(start,end)+'})()',sandbox);
    await vm.runInNewContext('(async()=>{'+source.slice(start,end)+'})()',sandbox);
    assert.equal(warnings.length,0);
    assert.equal(urls.length,1);
    assert.equal(data.cities.tokyo.historical.pricePerSqm.value,1600000);
    assert.equal(urls[0].url,'https://www.bis.org/statistics/pp.htm');

    // Exercise the real ceiling builder, substituting only the rate lookup.
    const ceilingSource = fs.readFileSync(require.resolve('../lib/tools/income-ceiling'),'utf8');
    const builder = ceilingSource.slice(ceilingSource.indexOf('async function buildCeilingMap('),ceilingSource.indexOf('\nmodule.exports'));
    let active = 0, peak = 0;
    const build = vm.runInNewContext(builder+'\nbuildCeilingMap',{
        getIncomeCeilingLcu:async()=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>setImmediate(resolve));active--;return 100000;}
    });
    await build(G20.map(row=>row[2]));
    assert(peak<=2,`unbounded ceiling concurrency: ${peak}`);
    assert.equal(active,0);

    const extractionStart = source.indexOf('  async _microExtractField(');
    const extractionEnd = source.indexOf('  async stepSeedMetricToolCall(',extractionStart);
    const { cleanMarkdownJson } = require('../utils/parse-helpers');
    const { normaliseCurrency } = require('../utils/geo-data');
    const { rescueDroppedSuffix } = require('../utils/seed-metric-calculator');
    const Extractor = vm.runInNewContext('(class {'+source.slice(extractionStart,extractionEnd)+'})',{
        cleanMarkdownJson,normaliseCurrency,rescueDroppedSuffix,AI_MODELS:{TEMPERATURE_DETERMINISTIC:0},
        logger:{warn(){}}
    });
    const extractor = new Extractor(), budgets = [];
    extractor.llmUrl='fixture';extractor.llmModel='fixture';
    extractor.groqWithRetry=async request=>{
        budgets.push(request.data.max_tokens);
        return {data:{choices:[budgets.length===1
            ? {finish_reason:'length',message:{content:null}}
            : {finish_reason:'stop',message:{content:'{"value":1000,"type":"pricePerSqm","currency":"JPY"}'}}]}};
    };
    assert.equal((await extractor._microExtractField({text:'1000 JPY per sqm',query:'Tokyo',prompt:'fixture'})).value,1000);
    assert.deepEqual(budgets,[100,800]);
    let attempts=0;
    extractor.groqWithRetry=async()=>{attempts++;return {data:{choices:[{finish_reason:'length',message:{content:null}}]}};};
    await assert.rejects(()=>extractor._microExtractField({text:'',query:'Tokyo',prompt:'fixture'}),/after one retry/);
    assert.equal(attempts,2);

    // A missing exchange rate must not relabel a USD ceiling as SAR.
    const { FetchCache } = require('../lib/fetch-cache');
    const cache = new FetchCache();
    cache.set('income-ceiling:usd',100000);
    const ceilingModule = {exports:{}}, fxCountries = [];
    vm.runInNewContext(ceilingSource,{
        module:ceilingModule,AbortSignal,
        require:name=>{
            if(name==='../fetch-cache')return {urlCache:cache};
            if(name==='../logger')return {debug(){},warn(){}};
            if(name==='../fetch-retry')return {fetchWithRetry:()=>{throw new Error('Unexpected network call');}};
            if(name==='./bis-spp')return {fetchLcuPerUsd:async country=>{fxCountries.push(country);return null;}};
            throw new Error(name);
        }
    });
    assert.equal(await ceilingModule.exports.getIncomeCeilingLcu('SAR'),null);
    assert.deepEqual(fxCountries,['SA']);
    console.log('PASS: 19/19 G20 countries route, map currency/ISO2, calculate fixture tables and preserve missing-data N/A. Singapore/Tokyo fetches only USD+SGD+JPY; late cities extend once; BIS citation retained; ceiling concurrency <=2. No live providers or paid inference.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
