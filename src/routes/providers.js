const express = require('express');
const log = require('../helpers/logger');
const { providersDb } = require('../helpers/db');

const router = express.Router();

router.get('/providers', (req, res) => {
    log.info('Route /providers: Fetching providers from the database');

    providersDb.all('SELECT provider_id AS id, provider_name AS display_name, logo_path FROM providers', [], (err, rows) => {
        if (err) {
            log.error('Error querying database:', err);
            return res.status(500).json({ error: 'Error querying database' });
        }
        
        res.json(rows);
    });
});

module.exports = router;