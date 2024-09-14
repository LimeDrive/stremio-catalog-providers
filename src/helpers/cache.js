const { catalogDb, metadataDb, episodesDb } = require('./db');
const log = require('../helpers/logger');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { CACHE_CATALOG_CONTENT_DURATION_DAYS, CACHE_POSTER_CONTENT_DURATION_DAYS } = process.env;
const baseUrl = process.env.BASE_URL || 'http://localhost:7000';

const defaultCacheDurationDays = 3;
const cacheCatalogDurationDays = parseInt(CACHE_CATALOG_CONTENT_DURATION_DAYS, 10) || defaultCacheDurationDays;
const cacheCatalogDurationMillis = cacheCatalogDurationDays * 24 * 60 * 60 * 1000;

const posterCacheDurationDays = parseInt(CACHE_POSTER_CONTENT_DURATION_DAYS, 10) || defaultCacheDurationDays;
const posterCacheDurationMillis = posterCacheDurationDays * 24 * 60 * 60 * 1000;

log.debug(`Cache duration for catalog: ${cacheCatalogDurationMillis} milliseconds (${cacheCatalogDurationDays} days)`);
log.debug(`Cache duration for posters: ${posterCacheDurationMillis} milliseconds (${posterCacheDurationDays} days)`);

const getCache = (key) => {
    return new Promise((resolve, reject) => {
        catalogDb.get("SELECT value, expiration FROM cache WHERE key = ?", [key], (err, row) => {
            if (err) {
                log.error(`Error fetching cache for key ${key}:`, err);
                return reject(err);
            }
            if (row && row.expiration > Date.now()) {
                log.info(`Cache hit for key ${key}`);
                resolve(JSON.parse(row.value));
            } else {
                log.info(`Cache miss for key ${key}`);
                resolve(null);
            }
        });
    });
};

const setCache = (key, value, page = 1, skip = 0, providerId = null, type = null, sortBy = null, ageRange = null) => {
    const expiration = Date.now() + cacheCatalogDurationMillis;
    log.debug(`Setting cache with expiration: ${new Date(expiration).toUTCString()}`);

    catalogDb.run(`
        INSERT OR REPLACE INTO cache (key, value, expiration, page, skip, provider_id, type, sortBy, ageRange)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
        [key, JSON.stringify(value), expiration, page, skip, providerId, type, sortBy, ageRange], 
        (err) => {
            if (err) {
                log.error('Error setting cache:', err);
            } else {
                log.debug(`Cache set with page: ${page}, skip: ${skip}, providerId: ${providerId}, type: ${type}, sortBy: ${sortBy}, ageRange: ${ageRange}`);
            }
        }
    );
};

const posterDirectory = path.join(__dirname, '../../db/rpdbPosters');

if (!fs.existsSync(posterDirectory)) {
    fs.mkdirSync(posterDirectory, { recursive: true });
}

const formatFileName = (posterId) => {
    return posterId.replace(/[^a-zA-Z0-9-_]/g, '_');
};

const getCachedPoster = async (posterId) => {
    const formattedPosterId = formatFileName(posterId);
    const filePath = path.join(posterDirectory, `${formattedPosterId}.jpg`);
    const fileStats = fs.existsSync(filePath) ? fs.statSync(filePath) : null;

    if (fileStats && (Date.now() - fileStats.mtimeMs < posterCacheDurationMillis)) {
        const posterUrl = `${baseUrl}/poster/${formattedPosterId}.jpg`;
        log.debug(`Cache hit for poster id ${posterId}, serving from ${posterUrl}`);
        return { poster_url: posterUrl };
    } else {
        log.debug(`Cache miss or expired for poster id ${posterId}`);
        return null;
    }
};

const setCachedPoster = async (posterId, posterUrl) => {
    const formattedPosterId = formatFileName(posterId);
    const filePath = path.join(posterDirectory, `${formattedPosterId}.jpg`);

    try {
        const response = await axios.get(posterUrl, { responseType: 'arraybuffer' });
        fs.writeFileSync(filePath, response.data);
        log.debug(`Poster id ${posterId} cached at ${filePath}`);
    } catch (error) {
        log.error(`Error caching poster id ${posterId} from URL ${posterUrl}: ${error.message}`);
        throw error;
    }
};

const cleanUpCache = () => {
    catalogDb.run("DELETE FROM cache WHERE expiration <= ?", [Date.now()], (err) => {
        if (err) {
            log.error('Failed to clean up cache:', err);
        } else {
            log.info('Cache cleanup completed successfully.');
        }
    });
};

const getMetadataCache = (id, mediaType) => {
    return new Promise((resolve, reject) => {
        const adjustedMediaType = mediaType === 'series' ? 'tv' : mediaType;

        metadataDb.get("SELECT * FROM metadata WHERE id = ? AND media_type = ?", [id, adjustedMediaType], (err, row) => {
            if (err) {
                log.error(`Error fetching metadata cache for ID ${id}:`, err);
                return reject(err);
            }
            if (row) {
                log.info(`Cache hit for metadata ID ${id}`);
                resolve(row);
            } else {
                log.info(`Cache miss for metadata ID ${id}`);
                resolve(null);
            }
        });
    });
};

const setMetadataCache = (data, mediaType) => {
    const insertSQL = `INSERT OR REPLACE INTO metadata 
        (id, title, original_title, overview, release_date, popularity, vote_average, vote_count, original_language, genres, runtime, provider_id, media_type, budget, revenue, homepage, poster_path, backdrop_path, tagline, status, belongs_to_collection, production_companies, production_countries, spoken_languages, video_key, video_name, video_published_at, directors, writers, main_cast, imdb_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`; // Ajoutez 31 placeholders ici

    metadataDb.run(insertSQL, [
        data.id,
        data.title,
        data.original_title,
        data.overview,
        data.release_date,
        data.popularity,
        data.vote_average,
        data.vote_count,
        data.original_language,
        data.genres,
        data.runtime,
        data.provider_id,
        mediaType,
        data.budget,
        data.revenue,
        data.homepage,
        data.poster_path,
        data.backdrop_path,
        data.tagline,
        data.status,
        data.belongs_to_collection,
        data.production_companies,
        data.production_countries,
        data.spoken_languages,
        data.video_key,
        data.video_name,
        data.video_published_at,
        data.directors,
        data.writers,
        data.main_cast,
        data.imdb_id
    ], (err) => {
        if (err) {
            log.error(`Error inserting content details into metadata.db for ID ${data.id}: ${err.message}`);
        } else {
            log.info(`Content details inserted into metadata.db for ID ${data.id}`);
        }
    });
};

const setEpisodeCache = (episodeData) => {
    const { id, show_id, season_number, episode_number, air_date, name, overview, production_code, runtime, still_path, vote_average, vote_count } = episodeData;

    const insertSQL = `INSERT OR REPLACE INTO episodes 
        (id, show_id, season_number, episode_number, air_date, name, overview, production_code, runtime, still_path, vote_average, vote_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    episodesDb.run(insertSQL, [
        id,
        show_id,
        season_number,
        episode_number,
        air_date,
        name,
        overview,
        production_code,
        runtime,
        still_path,
        vote_average,
        vote_count
    ], (err) => {
        if (err) {
            log.error(`Error inserting episode data into episodes.db for ID ${id}: ${err.message}`);
        } else {
            log.info(`Episode data inserted into episodes.db for ID ${id}`);
        }
    });
};

const getEpisodeCache = (show_id) => {
    return new Promise((resolve, reject) => {
        episodesDb.all("SELECT * FROM episodes WHERE show_id = ?", [show_id], (err, rows) => {
            if (err) {
                log.error(`Error fetching episodes data for show_id ${show_id}:`, err);
                return reject(err);
            }
            if (rows && rows.length > 0) {
                log.info(`Cache hit for all episodes of show_id ${show_id}`);
                resolve(rows);
            } else {
                log.info(`Cache miss for all episodes of show_id ${show_id}`);
                resolve(null);
            }
        });
    });
};

setInterval(cleanUpCache, 24 * 60 * 60 * 1000);

module.exports = {
    getCache,
    setCache,
    cleanUpCache,
    getCachedPoster,
    setCachedPoster,
    getMetadataCache,
    setMetadataCache,
    getEpisodeCache,
    setEpisodeCache
};
