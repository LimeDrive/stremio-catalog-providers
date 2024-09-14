const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const log = require('../helpers/logger');

const dbDir = path.join(__dirname, '../../db');

if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
    log.debug('Created db directory');
}

const createDatabaseAndTable = (dbPath, tableName, createTableSQL) => {
    const db = new sqlite3.Database(dbPath, (err) => {
        if (err) {
            log.error(`Failed to connect to ${tableName}:`, err);
        } else {
            log.debug(`Connected to ${tableName} successfully`);
        }
    });

    db.serialize(() => {
        db.run(createTableSQL, (err) => {
            if (err) {
                log.error(`Error creating ${tableName}:`, err);
            } else {
                log.debug(`${tableName} created or already exists`);
            }
        });
    });

    return db;
};

const providersDb = createDatabaseAndTable(
    path.join(dbDir, 'providers.db'),
    'providers',
    `CREATE TABLE IF NOT EXISTS providers (
        provider_id INTEGER PRIMARY KEY,
        provider_name TEXT,
        logo_path TEXT
    )`
);

const catalogDb = createDatabaseAndTable(
    path.join(dbDir, 'catalog.db'),
    'cache',
    `CREATE TABLE IF NOT EXISTS cache (
        key TEXT PRIMARY KEY,
        value TEXT,
        expiration INTEGER,
        page INTEGER DEFAULT 1,
        skip INTEGER DEFAULT 0,
        provider_id INTEGER,
        type TEXT,
        sortBy TEXT,
        ageRange TEXT
    )`
);

const genresDb = createDatabaseAndTable(
    path.join(dbDir, 'genres.db'),
    'genres',
    `CREATE TABLE IF NOT EXISTS genres (
        genre_id INTEGER,
        genre_name TEXT,
        media_type TEXT,
        language TEXT,
        PRIMARY KEY (genre_id, media_type, language),
        UNIQUE (genre_id, media_type, language)
    )`
);

const metadataDb = createDatabaseAndTable(
    path.join(dbDir, 'metadata.db'),
    'metadata',
    `CREATE TABLE IF NOT EXISTS metadata (
        id INTEGER PRIMARY KEY,
        title TEXT,
        original_title TEXT,
        overview TEXT,
        release_date TEXT,
        popularity REAL,
        vote_average REAL,
        vote_count INTEGER,
        original_language TEXT,
        genres TEXT,
        runtime INTEGER,
        provider_id INTEGER,
        media_type TEXT,
        budget INTEGER,
        revenue INTEGER,
        homepage TEXT,
        poster_path TEXT,
        backdrop_path TEXT,
        tagline TEXT,
        status TEXT,
        belongs_to_collection TEXT,
        production_companies TEXT,
        production_countries TEXT,
        spoken_languages TEXT,
        video_key TEXT,
        video_name TEXT,
        video_published_at TEXT,
        directors TEXT,
        writers TEXT,
        main_cast TEXT,
        imdb_id TEXT
    )`
);

const episodesDb = createDatabaseAndTable(
    path.join(dbDir, 'episodes.db'),
    'episodes',
    `CREATE TABLE IF NOT EXISTS episodes (
        id INTEGER PRIMARY KEY,
        show_id INTEGER,
        season_number INTEGER,
        episode_number INTEGER,
        air_date TEXT,
        name TEXT,
        overview TEXT,
        production_code TEXT,
        runtime INTEGER,
        still_path TEXT,
        vote_average REAL,
        vote_count INTEGER,
        UNIQUE (show_id, season_number, episode_number)
    )`
);

module.exports = {
    providersDb,
    catalogDb,
    genresDb,
    metadataDb,
    episodesDb
};
