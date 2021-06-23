const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const redis = require('redis');

const redis_client = redis.createClient();
console.log(redis_client);

function get_challenge_response(crc_token, consumer_secret) {
    return crypto.createHmac('sha256', consumer_secret).update(crc_token).digest('base64');
};

router.get('/twitter-webhook', (req, res) => {
    const { crc_token } = req.query;
    console.log(crc_token);
    if (!crc_token) {
        res.status(400);
        return res.json({ error: "crc_token", error_type: "missing" });
    }

    const consumer_secret = process.env.TWITTER_CONSUMER_SECRET;

    return res.json({ response_token: 'sha256=' + get_challenge_response(crc_token, consumer_secret) });
});

router.post('/twitter-webhook', (req, res) => {
    const direct_messages = req.body.direct_message_events;

    direct_messages.forEach(dm => {
        const twitter_user_id = dm.message_create.sender_id;
        const remote_id = crypto.createHmac('sha256', twitter_user_id).digest('hex');
    });

    return res.json({ message: 'ok' });
});

module.exports = router;