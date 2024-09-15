const { genresDb, providersDb } = require('./db');
const log = require('../helpers/logger');
const { checkGenresExistForLanguage, fetchAndStoreGenres } = require('../api/tmdb');

const manifestTemplate = {
    id: 'community.tmdbstreamingcatalogproviders',
    version: '1.0.0',
    name: 'TMDB Streaming Catalog Providers',
    description: 'Catalog from TMDB streaming providers.',
    resources: ['catalog', 'meta'],
    types: ['movie', 'series'],
    idPrefixes: ['tt:'],
    catalogs: [],
    behaviorHints: {
        configurable: true,
        configurationRequired: false,
    }
};

const getProvider = (providerId) => {
    return new Promise((resolve, reject) => {
        providersDb.get("SELECT * FROM providers WHERE provider_id = ?", [providerId], (err, row) => {
            if (err) {
                reject(err);
            } else if (row) {
                resolve(row);
            } else {
                resolve(null);
            }
        });
    });
};

const getGenres = (type, language) => 
    new Promise((resolve, reject) => {
        const query = `SELECT genre_name FROM genres WHERE media_type = ? AND language = ?`;
        genresDb.all(query, [type, language], (err, rows) => {
            if (err) return reject(err);
            resolve(rows.map(row => row.genre_name));
        });
    });

const generateManifest = async (config) => {
    try {
        const { providers, language, tmdbApiKey, ageRange } = config;
        if (!Array.isArray(providers) || !providers.length) throw new Error('No providers specified.');

        if (language && !(await checkGenresExistForLanguage(language))) {
            log.debug(`Fetching genres for language: ${language}`);
            await fetchAndStoreGenres(language, tmdbApiKey);
        }

        const [movieGenres, seriesGenres] = await Promise.all([
            getGenres('movie', language),
            getGenres('tv', language)
        ]);

        const genreOptions = (genres) => genres.map(genre => genre);
        const isKidsMode = ageRange && ageRange !== '18+';

        const providerInfo = await Promise.all(providers.map(providerId => getProvider(providerId)));
        const catalogs = providerInfo.flatMap(provider => {
            if (!provider) return [];

            const baseCatalogs = [
                { type: 'movie', idSuffix: 'movies', namePrefix: 'Movies' },
                { type: 'series', idSuffix: 'series', namePrefix: 'Series' }
            ];

            return baseCatalogs.flatMap(base => {
                return ['Popular', 'New'].map(catalogType => ({
                    type: base.type,
                    id: `tmdb-discover-${base.idSuffix}-${catalogType.toLowerCase()}-${provider.provider_id}`,
                    name: `${catalogType} - ${provider.provider_name}`,
                    extra: [
                        { name: 'genre', isRequired: false, options: genreOptions(base.type === 'movie' ? movieGenres : seriesGenres) },
                        { name: 'skip', isRequired: false },
                        { name: 'ageRange', value: isKidsMode ? ageRange : '18+' }
                    ]
                }));
            });
        });

        const manifest = {
            ...manifestTemplate,
            catalogs: catalogs
        };

        return manifest;
    } catch (error) {
        console.error('Error generating manifest:', error);
        throw error;
    }
};

module.exports = generateManifest;
