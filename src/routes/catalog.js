const express = require('express');
const axios = require('axios');
const log = require('../helpers/logger');
const { genresDb, metadataDb } = require('../helpers/db');
const { discoverContent } = require('../api/tmdb');
const { getCachedPoster, setCachedPoster } = require('../helpers/cache');
const { TMDB_LANGUAGE } = process.env;

const router = express.Router();

router.get("/:configParameters?/catalog/:type/:id/:extra?.json", async (req, res, next) => {
    const { id, configParameters, type, extra: extraParam } = req.params;
    const extra = extraParam ? decodeURIComponent(extraParam) : '';
    let ageRange = null;
    let genre = null;
    let tmdbApiKey = null;
    let rpdbApiKey = null;
    let language = TMDB_LANGUAGE;
    let skip = 0;

    log.debug(`Received parameters: id=${id}, type=${type}, configParameters=${configParameters}, extra=${extra}`);

    if (configParameters) {
        try {
            const parsedConfig = JSON.parse(decodeURIComponent(configParameters));
            ageRange = parsedConfig.ageRange || null;
            tmdbApiKey = parsedConfig.tmdbApiKey || null;
            rpdbApiKey = parsedConfig.rpdbApiKey || null;
            language = parsedConfig.language || TMDB_LANGUAGE;
            log.debug(`Config parameters extracted: ageRange=${ageRange}, tmdbApiKey=${tmdbApiKey}, rpdbApiKey=${rpdbApiKey}, language=${language}`);
        } catch (error) {
            log.error(`Error parsing configParameters: ${error.message}`);
        }
    } else {
        log.warn('configParameters is missing');
    }

    const match = id.match(/^tmdb-discover-(movies|series)(-new|-popular)?-(\d+)$/);
    if (!match) {
        return res.status(400).json({ error: 'Invalid catalog id' });
    }
    const catalogType = match[1];
    const providerId = parseInt(match[3], 10);
    const providers = [providerId.toString()];

    if (extra.startsWith('skip=')) {
        const skipValue = parseInt(extra.split('=')[1], 10);
        skip = isNaN(skipValue) ? 0 : skipValue;
    }

    if (extra.includes('genre=')) {
        const genreName = extra.split('genre=')[1];
        log.debug(`Extracting genre: ${genreName}`);
        const genreRow = await new Promise((resolve, reject) => {
            genresDb.get("SELECT genre_id FROM genres WHERE genre_name = ? AND media_type = ?", [genreName, type === 'series' ? 'tv' : 'movie'], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row);
                }
            });
        });
        if (genreRow) {
            genre = genreRow.genre_id;
            log.debug(`Genre ID extracted: ${genre}`);
        } else {
            log.warn(`Genre not found for name: ${genreName}`);
        }
    } else {
        log.warn('Genre parameter is missing in extra');
    }

    try {
        const sortBy = catalogType === 'movies'
            ? (id.includes('-new') ? 'primary_release_date.desc' : 'popularity.desc')
            : (id.includes('-new') ? 'first_air_date.desc' : 'popularity.desc');

        log.debug(`Calling discoverContent with parameters: type=${catalogType}, ageRange=${ageRange}, sortBy=${sortBy}, genre=${genre}, language=${language}, skip=${skip}`);

        const discoverResults = await discoverContent(catalogType, providers, ageRange, sortBy, genre, tmdbApiKey, language, skip, type);

        const getRpdbPoster = (type, id, language, rpdbkey) => {
            const tier = rpdbkey.split("-")[0];
            const lang = language.split("-")[0];
            const baseUrl = `https://api.ratingposterdb.com/${rpdbkey}/tmdb/poster-default/${type}-${id}.jpg?fallback=true`;
        
            return (tier === "t0" || tier === "t1")
                ? baseUrl
                : `${baseUrl}&lang=${lang}`;
        };
        
        const posterCacheQueue = new Set();
        const cachedPosters = new Set();
        
        const getPosterUrl = async (content, rpdbApiKey) => {
            const posterId = `poster:${content.id}`;
            
            if (rpdbApiKey) {
                const cachedPoster = await getCachedPoster(posterId);
                if (cachedPoster) {
                    log.debug(`Using cached poster URL for id ${posterId}`);
                    return cachedPoster.poster_url;
                }
            }
        
            let posterUrl;
            
            if (rpdbApiKey) {
                const rpdbImage = getRpdbPoster(catalogType, content.id, language, rpdbApiKey);
                log.debug(`Fetching RPDB poster from URL: ${rpdbImage}`);
                
                try {
                    const response = await axios.head(rpdbImage);
                    if (response.status === 200) {
                        log.debug(`RPDB poster found for id ${posterId}`);
                        posterUrl = rpdbImage;
        
                        if (!cachedPosters.has(posterId)) {
                            posterCacheQueue.add({ id: posterId, url: posterUrl });
                            cachedPosters.add(posterId);
                        }
                    } else {
                        throw new Error('Not found');
                    }
                } catch (error) {
                    log.warn(`Error fetching RPDB poster: ${error.message}. Falling back to TMDB poster.`);
                    posterUrl = `https://image.tmdb.org/t/p/w500${content.poster_path}`;
                }
            } else {
                posterUrl = `https://image.tmdb.org/t/p/w500${content.poster_path}`;
            }
            
            return posterUrl;
        };
        
        const cachePosters = async () => {
            for (const { id, url } of posterCacheQueue) {
                try {
                    await setCachedPoster(id, url);
                } catch (error) {
                    log.error(`Failed to cache poster id ${id}: ${error.message}`);
                }
            }
            posterCacheQueue.clear();
            cachedPosters.clear();
        };
        
        const filteredResults = discoverResults.results.filter(content => content.poster_path);
        
        const metas = await Promise.all(filteredResults.map(async (content) => {
            const posterUrl = await getPosterUrl(content, rpdbApiKey);

            const metadata = await new Promise((resolve, reject) => {
                metadataDb.get("SELECT * FROM metadata WHERE id = ?", [content.id], (err, row) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(row);
                    }
                });
            });

            let releaseInfo;
            if (catalogType === 'movies') {
                releaseInfo = content.release_date ? content.release_date.split('-')[0] : null;
            } else if (catalogType === 'series') {
                const startYear = content.first_air_date ? content.first_air_date.split('-')[0] : null;
                const endYear = content.last_air_date ? content.last_air_date.split('-')[0] : (content.in_production ? '' : null);
                releaseInfo = startYear ? `${startYear}-${endYear || ''}` : null;
            }

            let genreNames = [];
            try {
                genreNames = await Promise.all(content.genre_ids.map(async (genreId) => {
                    return new Promise((resolve, reject) => {
                        genresDb.get("SELECT genre_name FROM genres WHERE genre_id = ? AND media_type = ?", [genreId, type === 'series' ? 'tv' : 'movie'], (err, row) => {
                            if (err) {
                                reject(err);
                            } else {
                                resolve(row ? row.genre_name : null);
                            }
                        });
                    });
                }));
            } catch (error) {
                console.error('Error fetching genres:', error);
            }

            const links = [];
            if (metadata) {
                if (metadata.genres) {
                    links.push(...metadata.genres.split(',').map(genre => ({
                        name: genre,
                        category: 'Genres',
                        url: `stremio:///discover`
                    })));
                }
                if (metadata.directors) {
                    links.push(...metadata.directors.split(',').map(director => ({
                        name: director,
                        category: 'Directors',
                        url: `stremio:///search?search=${encodeURIComponent(director)}`
                    })));
                }
                if (metadata.main_cast) {
                    links.push(...metadata.main_cast.split(',').map(actor => ({
                        name: actor,
                        category: 'Cast',
                        url: `stremio:///search?search=${encodeURIComponent(actor)}`
                    })));
                }
                if (metadata.vote_average && metadata.imdb_id) {
                    links.push({
                        name: metadata.vote_average.toFixed(1),
                        category: 'imdb',
                        url: `https://imdb.com/title/${metadata.imdb_id}`
                    });
                }
                links.push({
                    name: metadata.title,
                    category: 'share',
                    url: `https://www.strem.io/s/${metadata.media_type}/${metadata.title.toLowerCase().replace(/\s+/g, '-')}-${metadata.imdb_id ? metadata.imdb_id.replace('tt', '') : ''}`
                });
            }

            return {
                id: `tt:${content.id}`,
                type: catalogType === 'movies' ? 'movie' : 'series',
                name: catalogType === 'movies' ? content.title : content.name,
                poster: posterUrl,
                background: `https://image.tmdb.org/t/p/w1280${content.backdrop_path}`,
                description: content.overview,
                releaseInfo: releaseInfo || null,
                runtime: metadata ? metadata.runtime : null,
                links
            };
        }));
        
        res.json({ metas });
        
        await cachePosters();

    } catch (error) {
        log.error(`Error processing request: ${error.message}`);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Internal Server Error' });
        }
    }
});

module.exports = router;
