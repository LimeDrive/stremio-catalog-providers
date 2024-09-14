const axios = require('axios');
const queue = require('../helpers/queue');
const { providersDb, genresDb, catalogDb } = require('../helpers/db');
const { TMDB_BEARER_TOKEN, TMDB_LANGUAGE, TMDB_WATCH_REGION } = process.env;
const { getCache, setCache, getMetadataCache, setMetadataCache, setEpisodeCache } = require('../helpers/cache');
const log = require('../helpers/logger');

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

const makeRequest = (url, tmdbApiKey = null) => {
    const headers = {};

    if (!tmdbApiKey) {
        headers['Authorization'] = `Bearer ${TMDB_BEARER_TOKEN}`;
    }

    return new Promise((resolve, reject) => {
        queue.push({
            fn: () => axios.get(url, { headers })
                .then(response => {
                    log.debug(`API request successful for URL: ${url}`);
                    resolve(response.data);
                })
                .catch(error => {
                    log.error(`Error during API request for URL: ${url} - ${error.message}`);
                    reject(error);
                })
        });
    });
};

const determinePageFromSkip = async (providerId, skip, catalogDb, type, sortBy, ageRange) => {
    try {
        const cachedEntry = await new Promise((resolve, reject) => {
            catalogDb.get(
                "SELECT page, skip FROM cache WHERE provider_id = ? AND skip = ? AND type = ? AND sortBy = ? AND ageRange = ? ORDER BY skip DESC LIMIT 1",
                [providerId, skip, type, sortBy, ageRange],
                (err, row) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(row);
                    }
                }
            );
        });

        if (cachedEntry) {
            log.debug(`Cached Entry: ${cachedEntry}`);
            log.debug(`Determined Page from Cache: ${cachedEntry.page}`);
            return cachedEntry.page;
        }

        const lastEntry = await new Promise((resolve, reject) => {
            catalogDb.get(
                "SELECT page, skip FROM cache WHERE provider_id = ? AND type = ? AND sortBy = ? AND ageRange = ? ORDER BY skip DESC LIMIT 1",
                [providerId, type, sortBy, ageRange],
                (err, row) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(row);
                    }
                }
            );
        });

        log.debug(`Last Entry: ${lastEntry}`);

        if (lastEntry) {
            log.debug('Current Skip:', skip, 'Last Skip:', lastEntry.skip);

            if (skip > lastEntry.skip) {
                log.debug('Determined Page:', lastEntry.page + 1);
                return lastEntry.page + 1;
            }
        }

        log.debug('Default Page:', 1);
        return 1;
    } catch (error) {
        log.error('Error in determinePageFromSkip:', error);
        return 1;
    }
};

const fetchData = async (endpoint, params = {}, tmdbApiKey = null, providerId = null, ageRange = null) => {
    if (tmdbApiKey) {
        params.api_key = tmdbApiKey;
    }

    const { skip, type, sort_by: sortBy, ...queryParams } = params;

    const page = providerId ? await determinePageFromSkip(providerId, skip, catalogDb, type, sortBy, ageRange) : 1;

    const queryParamsWithPage = {
        ...queryParams,
        page,
        language: params.language || TMDB_LANGUAGE,
    };

    if (sortBy) {
        queryParamsWithPage.sort_by = sortBy;
    }

    const queryString = new URLSearchParams(queryParamsWithPage).toString();

    const url = `${TMDB_BASE_URL}${endpoint}?${queryString}`;

    log.debug(`Request URL: ${url}`);

    const cachedData = await getCache(url, skip);
    if (cachedData) {
        return cachedData;
    }

    const data = await makeRequest(url, tmdbApiKey);

    setCache(url, data, page, skip, providerId, type, sortBy, ageRange);
    log.debug(`Data stored in cache for URL: ${url} with page: ${page}, skip: ${skip}, providerId: ${providerId}, type: ${type}, sortBy: ${sortBy}, ageRange: ${ageRange}`);

    return data;
};

const fetchContentDetailsInBatches = async (contentList, mediaType, tmdbApiKey = null) => {
    const results = [];

    const processBatch = async (batch) => {
        return new Promise((resolve, reject) => {
            const batchResults = [];

            batch.forEach((contentId) => {
                queue.push({
                    fn: async () => {
                        const data = await fetchContentDetails(contentId, mediaType, tmdbApiKey);
                        batchResults.push(data);
                    }
                });
            });

            queue.drain(() => {
                resolve(batchResults);
            });
        });
    };

    for (let i = 0; i < contentList.length; i += 20) {
        const batch = contentList.slice(i, i + 20);
        const batchResult = await processBatch(batch);
        results.push(...batchResult);
    }

    return results;
};

const fetchContentDetails = async (contentId, mediaType, tmdbApiKey = null) => {
    const endpointType = mediaType === 'series' ? 'tv' : 'movie';
    const endpoint = `/${endpointType}/${contentId}`;
    const fetchWithoutLanguageFallback = process.env.TMDB_FETCH_TRAILER_TWITHOUT_LANGUAGE_FALLBACK === 'true';

    const fetchDetails = async (includeLanguage = true) => {
        const params = new URLSearchParams({ append_to_response: 'videos,credits,external_ids' });
        if (includeLanguage) {
            params.append('language', TMDB_LANGUAGE);
        }
        if (tmdbApiKey) {
            params.append('api_key', tmdbApiKey);
        }
        const url = `${TMDB_BASE_URL}${endpoint}?${params.toString()}`;
        log.debug(`Fetching content details for ID: ${contentId}, Type: ${mediaType}, URL: ${url}`);
        return await makeRequest(url, tmdbApiKey);
    };

    const fetchVideosWithoutLanguage = async () => {
        const params = new URLSearchParams({ append_to_response: 'videos' });
        if (tmdbApiKey) {
            params.append('api_key', tmdbApiKey);
        }
        const url = `${TMDB_BASE_URL}${endpoint}?${params.toString()}`;
        log.debug(`Fetching videos without language for ID: ${contentId}, URL: ${url}`);
        const videoData = await makeRequest(url, tmdbApiKey);
        return videoData.videos;
    };

    const cachedData = await getMetadataCache(contentId, endpointType);
    if (cachedData) {
        log.info(`Cache hit for content ID ${contentId}`);
        return cachedData;
    }

    let data = await fetchDetails(true);

    if (fetchWithoutLanguageFallback && data.videos && data.videos.results.length === 0) {
        log.info(`No videos found with language, retrying without language for ID: ${contentId}`);
        const videoData = await fetchVideosWithoutLanguage();
        data.videos = videoData;
    }

    const imdbId = data.external_ids ? data.external_ids.imdb_id : null;

    let selectedVideo = null;
    if (data.videos && data.videos.results.length > 0) {
        const sortedVideos = data.videos.results
            .filter(video => video.type === 'Trailer')
            .sort((a, b) => {
                if (a.official !== b.official) {
                    return a.official ? -1 : 1;
                }
                return new Date(a.published_at) - new Date(b.published_at);
            });

        selectedVideo = sortedVideos[0];
    }

    let directors = [];
    let writers = [];
    let mainCast = [];

    if (data.credits) {
        const crew = data.credits.crew || [];
        const cast = data.credits.cast || [];

        directors = crew
            .filter(person => person.job === 'Director')
            .map(person => ({ name: person.name, job: 'Director' }));

        writers = crew
            .filter(person => person.job === 'Writer')
            .map(person => ({ name: person.name, job: 'Writer' }));

        mainCast = cast.slice(0, 3).map(person => ({
            name: person.name,
            job: 'Actor'
        }));
    }

    const genreNames = data.genres.map(genre => genre.name).join(',');
    const collectionName = data.belongs_to_collection ? data.belongs_to_collection.name : null;
    const productionCompanies = data.production_companies.map(company => company.name).join(',');
    const productionCountries = data.production_countries.map(country => country.name).join(',');
    const spokenLanguages = data.spoken_languages.map(lang => lang.name).join(',');

    const formattedRuntime = formatRuntime(data.runtime || (data.episode_run_time ? data.episode_run_time[0] : null));

    setMetadataCache({
        id: data.id,
        title: data.title || data.name,
        original_title: data.original_title,
        overview: data.overview,
        release_date: data.release_date || data.first_air_date,
        popularity: data.popularity,
        vote_average: data.vote_average,
        vote_count: data.vote_count,
        original_language: data.original_language,
        genres: genreNames,
        runtime: formattedRuntime,
        provider_id: null,
        media_type: endpointType,
        budget: data.budget,
        revenue: data.revenue,
        homepage: data.homepage,
        poster_path: data.poster_path,
        backdrop_path: data.backdrop_path,
        tagline: data.tagline,
        status: data.status,
        belongs_to_collection: collectionName,
        production_companies: productionCompanies,
        production_countries: productionCountries,
        spoken_languages: spokenLanguages,
        video_key: selectedVideo ? selectedVideo.key : null,
        video_name: selectedVideo ? selectedVideo.name : null,
        video_published_at: selectedVideo ? selectedVideo.published_at : null,
        directors: directors.map(director => director.name).join(','),
        writers: writers.map(writer => writer.name).join(','),
        main_cast: mainCast.map(actor => actor.name).join(','),
        imdb_id: imdbId
    }, endpointType);

    setCache(url, data);

    return data;
};

const formatRuntime = (minutes) => {
    if (!minutes) return null;

    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;

    if (hours > 0 && remainingMinutes === 0) {
        return `${hours}h`;
    } else if (hours > 0) {
        return `${hours}h${remainingMinutes.toString().padStart(2, '0')}`;
    } else {
        return `${remainingMinutes}min`;
    }
};

const fetchAndStoreEpisodes = async (seriesId, tmdbApiKey, specificSeason = null) => {
    const seriesDetails = await fetchData(`/tv/${seriesId}`, {}, tmdbApiKey);
    const { number_of_seasons } = seriesDetails;

    const seasonsToFetch = specificSeason ? [specificSeason] : Array.from({ length: number_of_seasons }, (_, i) => i + 1);

    for (const seasonNumber of seasonsToFetch) {
        const seasonDetails = await fetchData(`/tv/${seriesId}/season/${seasonNumber}`, {}, tmdbApiKey);
        const { episodes } = seasonDetails;

        for (const episode of episodes) {
            log.debug(`Caching episode: ${JSON.stringify(episode, null, 2)}`);
            await setEpisodeCache(episode);
        }
    }

    return seriesDetails;
};

const discoverContent = async (type, watchProviders = [], ageRange = null, sortBy = 'popularity.desc', genre = null, tmdbApiKey = null, language = TMDB_LANGUAGE, skip = 0) => {
    const mediaType = type === 'series' ? 'tv' : 'movie';
    const endpoint = `/discover/${mediaType}`;

    const regions = TMDB_WATCH_REGION ? TMDB_WATCH_REGION.split(',') : [];
    const providerId = watchProviders[0];

    const params = {
        with_watch_providers: watchProviders.join(','),
        sort_by: sortBy,
        language,
        skip,
        type
    };

    if (ageRange) {
        switch(ageRange) {
            case '0-5':
                if (mediaType === 'movie') {
                    params.certification_country = 'US';
                    params.certification = 'G';
                    params.without_genres = '27,18,53,80,10752,37,10749,10768,10767,10766,10764,10763,9648,99,36';
                }
                if (mediaType === 'tv') {
                    params.with_genres = '10762'; // Kids only
                }
                break;

            case '6-11':
                if (mediaType === 'movie') {
                    params.certification_country = 'US';
                    params.certification = 'G';
                    params.without_genres = '27,18,53,80,10752,37,10749,10768,10767,10766,10764,10763,9648,99,36';
                }
                if (mediaType === 'tv') {
                    params.with_genres = '10762'; // Kids only
                }
                break;

            case '12-15':
                if (mediaType === 'movie') {
                    params.certification_country = 'US';
                    params.certification = 'PG';
                }
                if (mediaType === 'tv') {
                    params.with_genres = '16'; // Animation only
                }
                break;

            case '16-17':
                if (mediaType === 'movie') {
                    params.certification_country = 'US';
                    params.certification = 'PG-13';
                }
                break;

            case '18+':
                if (mediaType === 'movie') {
                    params.include_adult = true; 
                }
                break;

            default:
                log.warn(`Unknown ageRange: ${ageRange}`);
                break;
        }
    }

    if (genre) {
        params.with_genres = genre;
    }

    const fetchForRegion = async (region) => {
        params.watch_region = region;
        return await fetchData(endpoint, params, tmdbApiKey, providerId, ageRange);
    };

    const results = await Promise.all(regions.map(region => fetchForRegion(region)));

    const combinedResults = results.reduce((acc, result) => acc.concat(result.results), []);

    const uniqueResults = Array.from(new Map(combinedResults.map(item => [item.id, item])).values());

    await fetchContentDetailsInBatches(uniqueResults.map(item => item.id), type, tmdbApiKey);

    return {
        ...results[0],
        results: uniqueResults
    };
};

const mergeProviders = (providers) => {
    const merged = {};

    providers.forEach(provider => {
        const { provider_id, provider_name, logo_path } = provider;

        if (!merged[provider_name]) {
            merged[provider_name] = { provider_id, logo_path };
        }
    });

    return Object.entries(merged).map(([provider_name, details]) => ({
        provider_id: details.provider_id,
        provider_name,
        logo_path: details.logo_path
    }));
};

const updateProviders = async () => {
    try {
        const regions = TMDB_WATCH_REGION ? TMDB_WATCH_REGION.split(',') : [];
        const movieEndpoint = `/watch/providers/movie`;
        const tvEndpoint = `/watch/providers/tv`;

        const fetchProvidersForRegion = async (region) => {
            const params = { watch_region: region };
            const [movieData, tvData] = await Promise.all([
                fetchData(movieEndpoint, params),
                fetchData(tvEndpoint, params)
            ]);
            return [...movieData.results, ...tvData.results];
        };

        const results = await Promise.all(regions.map(region => fetchProvidersForRegion(region)));
        const combinedProviders = mergeProviders(results.flat());

        const insertOrUpdateProvider = providersDb.prepare(`
            INSERT INTO providers (provider_id, provider_name, logo_path) 
            VALUES (?, ?, ?)
            ON CONFLICT(provider_id) DO UPDATE SET
                provider_name = excluded.provider_name,
                logo_path = excluded.logo_path;
        `);

        combinedProviders.forEach(provider => {
            insertOrUpdateProvider.run(provider.provider_id, provider.provider_name, provider.logo_path);
        });

        insertOrUpdateProvider.finalize();
        log.info('Providers update completed.');
    } catch (error) {
        log.error(`Error during providers update: ${error.message}`);
    }
};

updateProviders();

const fetchGenres = async (type, language, tmdbApiKey = TMDB_API_KEY) => {
    const mediaType = type === 'series' ? 'tv' : 'movie';
    const endpoint = `/genre/${mediaType}/list`;

    try {
        const response = await axios.get(`${TMDB_BASE_URL}${endpoint}`, {
            params: { api_key: tmdbApiKey, language }
        });
        log.debug(`Genres retrieved for ${type} (${language})`);
        return response.data.genres;
    } catch (error) {
        log.error(`Error fetching genres from TMDB: ${error.message}`);
        throw error;
    }
};

const storeGenresInDb = (genres, mediaType, language) => 
    new Promise((resolve, reject) => {
        genresDb.serialize(() => {
            genresDb.run('BEGIN TRANSACTION');
            const insertGenre = genresDb.prepare(`
                INSERT INTO genres (genre_id, genre_name, media_type, language)
                VALUES (?, ?, ?, ?)
                ON CONFLICT DO NOTHING;
            `);

            genres.forEach((genre, index) => {
                insertGenre.run(genre.id, genre.name, mediaType, language, (err) => {
                    if (err) {
                        log.error(`Error inserting genre: ${err.message}`);
                        genresDb.run('ROLLBACK');
                        reject(err);
                        return;
                    }

                    if (index === genres.length - 1) {
                        insertGenre.finalize();
                        genresDb.run('COMMIT');
                        log.info(`Genres stored for ${mediaType} (${language})`);
                        resolve();
                    }
                });
            });
        });
    });

const checkGenresExistForLanguage = async (language) => 
    new Promise((resolve, reject) => {
        log.debug(`Checking genres for ${language}`);
        genresDb.get(
            `SELECT 1 FROM genres WHERE language = ? LIMIT 1`,
            [language], 
            (err, row) => err ? reject(err) : resolve(!!row)
        );
    });

const fetchAndStoreGenres = async (language, tmdbApiKey = TMDB_API_KEY) => {
    try {
        const movieGenres = await fetchGenres('movie', language, tmdbApiKey);
        const tvGenres = await fetchGenres('series', language, tmdbApiKey);

        await storeGenresInDb(movieGenres, 'movie', language);
        await storeGenresInDb(tvGenres, 'tv', language);

        log.info(`Genres fetched and stored for ${language}`);
    } catch (error) {
        log.error(`Error fetching/storing genres: ${error.message}`);
    }
};

module.exports = { makeRequest, fetchData, discoverContent, updateProviders, checkGenresExistForLanguage, fetchAndStoreGenres, fetchAndStoreEpisodes };
