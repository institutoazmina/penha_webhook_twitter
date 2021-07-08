const express = require('express');
const router = express.Router();

const penhas_api = require('../../webservices/penhas');
const redis = require('../../storage/redis');

router.post('/config', async (req, res) => {
    const config_req = await penhas_api.fetch_config_json();
    await redis.set('json_config', JSON.stringify(config_req.data));

    res.json({ message: 'OK' });
});

module.exports = router;