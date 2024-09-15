const express = require('express');
const log = require('../helpers/logger');
const { buildMetaObject } = require('../helpers/metadata');

const router = express.Router();

router.get('/:configParameters?/meta/:type/:id.json', async (req, res) => {
    const { type, id } = req.params;

    log.info(`Received metadata request for type: ${type}, id: ${id}`);

    try {
        const metaObj = await buildMetaObject(type, id);

        if (metaObj) {
            return res.json({ meta: metaObj });
        } else {
            return res.json({ meta: {} });
        }
    } catch (error) {
        log.error(`Error fetching metadata for ID: ${id} - ${error.message}`);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});

module.exports = router;
