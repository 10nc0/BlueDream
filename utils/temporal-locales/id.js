'use strict';

/**
 * Indonesian locale vocabulary for the temporal resolver.
 * See utils/temporal-locales/en.js for the full shape contract.
 */
module.exports = {
    _id: 'id',

    monthNames: [
        'januari', 'februari', 'maret', 'april', 'mei', 'juni',
        'juli', 'agustus', 'september', 'oktober', 'november', 'desember'
    ],

    // ID-specific abbreviations (merged with EN at resolver boot)
    monthAbbrevs: [
        [],
        [],
        [],
        [],
        [],
        [],
        [],
        ['agu', 'ags'],
        [],
        ['okt'],
        [],
        ['des'],
    ],

    unitMap: {
        'hari': 'day',
        'minggu': 'week', 'pekan': 'week',
        'bulan': 'month',
        'kuartal': 'quarter', 'kwartal': 'quarter',
        'tahun': 'year', 'thn': 'year'
    },

    relFragments: {
        unitSuffixMap: {
            'ini': 0,
            'lalu': -1, 'kemarin': -1, 'kemaren': -1, 'sebelumnya': -1,
            'depan': 1, 'berikutnya': 1
        },
        unitPrefixMap: null,
        lastNSuffixLastN: 'terakhir(?:nya)?',
        lastNSuffixNAgo: '(?:yg|yang)\\s+lalu|lalu',
        lastNPrefix: null,
        agoSuffix: null
    },

    todayRegex: 'hari\\s+ini',
    yesterdayRegex: 'kemarin',
    dayBeforeYesterdayRegex: 'kemarin\\s+(?:lusa|dulu)',
    dayBeforeYesterdayLabel: 'kemarin lusa',

    xtdAliases: {
        ytd: 'tahun\\s+berjalan',
        mtd: 'bulan\\s+berjalan',
        qtd: 'kuartal\\s+berjalan|kwartal\\s+berjalan'
    }
};
