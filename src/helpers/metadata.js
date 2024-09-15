const log = require('../helpers/logger');
const { getMetadataCache, getEpisodeCache } = require('../helpers/cache');
const { fetchAndStoreEpisodes, fetchData } = require('../api/tmdb');

function createShareSlug(contentType, contentTitle, imdbId) {
    const normalizedTitle = contentTitle.trim().toLowerCase().replace(/\s+/g, '-');
    const formattedImdbId = imdbId ? imdbId.replace('tt', '') : '';
    return `${contentType}/${normalizedTitle}-${formattedImdbId}`;
}

async function buildMetaObject(type, id) {
    const cleanedId = id.startsWith('tt:') ? id.slice(3) : id;
    log.info(`Cleaned ID: ${cleanedId}`);

    const cachedData = await getMetadataCache(cleanedId, type);

    if (!cachedData) {
        log.warn(`No metadata found for ID: ${cleanedId}`);
        return null;
    }

    log.info(`Cache hit for metadata ID: ${cleanedId}`);

    const ensureEpisodesInCache = async (seriesId) => {
        const cachedEpisodes = await getEpisodeCache(seriesId);

        let seasonsInCache = new Set();

        if (cachedEpisodes && cachedEpisodes.length > 0) {
            log.debug(`Found ${cachedEpisodes.length} episodes in cache for series ID: ${seriesId}`);

            cachedEpisodes.forEach((episode) => seasonsInCache.add(episode.season_number));

            const seriesDetails = await fetchData(`/tv/${seriesId}`, {}, process.env.TMDB_API_KEY);
            const currentNumberOfSeasons = seriesDetails.number_of_seasons;

            let missingSeasons = [];
            for (let i = 1; i <= currentNumberOfSeasons; i++) {
                if (!seasonsInCache.has(i)) {
                    missingSeasons.push(i);
                }
            }

            if (missingSeasons.length > 0) {
                log.info(`Fetching missing seasons: ${missingSeasons.join(', ')}`);
                
                for (const season of missingSeasons) {
                    await fetchAndStoreEpisodes(seriesId, process.env.TMDB_API_KEY, season);
                }
            } else {
                log.info(`Fetching only the latest season: Season ${currentNumberOfSeasons}`);
                await fetchAndStoreEpisodes(seriesId, process.env.TMDB_API_KEY, currentNumberOfSeasons);
            }

            return await getEpisodeCache(seriesId);
        } else {
            log.info(`Cache is empty or incomplete, fetching all episodes.`);
            await fetchAndStoreEpisodes(seriesId, process.env.TMDB_API_KEY);
        }

        return await getEpisodeCache(seriesId);
    };
    
    if (type === 'series') {
        await ensureEpisodesInCache(cleanedId);
    }

    async function buildSeriesVideos(seriesId) {
        const episodes = await getEpisodeCache(seriesId);
        if (!episodes) return [];
    
        return episodes.map(episode => ({
            id: `${seriesId}:${episode.season_number}:${episode.episode_number}`,
            title: episode.name || 'No Title',
            released: episode.air_date ? new Date(episode.air_date).toISOString() : null,
            thumbnail: episode.still_path ? `https://image.tmdb.org/t/p/w500${episode.still_path}` : null,
            episode: episode.episode_number,
            season: episode.season_number,
            overview: episode.overview || 'No Overview'
        }));
    }
    
    let videos = [];
    if (type === 'series') {
        videos = await buildSeriesVideos(cleanedId);
    }

    const metaObj = {
        id: `${cachedData.imdb_id}`,
        type: cachedData.media_type,
        name: cachedData.title,
        background: cachedData.backdrop_path ? `https://image.tmdb.org/t/p/original${cachedData.backdrop_path}` : null,
        description: cachedData.overview,
        releaseInfo: cachedData.release_date ? new Date(cachedData.release_date).getFullYear().toString() : null,
        released: cachedData.release_date ? new Date(cachedData.release_date).toISOString() : null,
        runtime: cachedData.runtime ? cachedData.runtime : null,
        language: cachedData.original_language,
        country: cachedData.production_countries ? cachedData.production_countries.split(',')[0] : null,
        trailers: cachedData.video_key ? [{ source: cachedData.video_key, type: 'Trailer' }] : [],
        ...(type === 'series' && { videos }), // Inclut 'videos' seulement si c'est une série
        links: [
            ...cachedData.genres ? cachedData.genres.split(',').map(genre => ({
                name: genre,
                category: 'Genres',
                url: `stremio:///discover`
            })) : [],
            ...cachedData.directors ? cachedData.directors.split(',').map(director => ({
                name: director,
                category: 'Directors',
                url: `stremio:///search?search=${encodeURIComponent(director)}`
            })) : [],
            ...cachedData.main_cast ? cachedData.main_cast.split(',').map(actor => ({
                name: actor,
                category: 'Cast',
                url: `stremio:///search?search=${encodeURIComponent(actor)}`
            })) : [],
            cachedData.vote_average && cachedData.imdb_id ? {
                name: cachedData.vote_average.toFixed(1),
                category: 'imdb',
                url: `https://imdb.com/title/${cachedData.imdb_id}`
            } : [],
            {
                name: cachedData.title,
                category: 'share',
                url: `https://www.strem.io/s/${createShareSlug(cachedData.media_type, cachedData.title, cachedData.imdb_id)}`
            }
        ]
    };

    return metaObj;
}

module.exports = { buildMetaObject, createShareSlug };
