const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const redis = require('redis');
const Twitter = require('twitter-lite');

const client = new Twitter({
    consumer_key: process.env.TWITTER_CONSUMER_KEY,
    consumer_secret: process.env.TWITTER_CONSUMER_SECRET,
    // bearer_token: process.env.TWITTER_BEARER_TOKEN,
    access_token_key: process.env.TWITTER_ACCESS_TOKEN,
    access_token_secret: process.env.TWITTER_ACCESS_TOKEN_SECRET
});

const flow = require('./../../data/flow.json');
console.log(flow);

const redis_client = redis.createClient();

function get_challenge_response(crc_token, consumer_secret) {
    return crypto.createHmac('sha256', consumer_secret).update(crc_token).digest('base64');
};

router.get('/twitter-webhook', (req, res) => {
    const { crc_token } = req.query;

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
        console.log(dm);
        const twitter_user_id = dm.message_create.sender_id;
        const remote_id = crypto.createHmac('sha256', twitter_user_id).digest('hex');

        console.log('twitter_user_id :' + twitter_user_id)
        const foo = redis_client.get(twitter_user_id, (err, reply) => {
            console.log("err: " + err);
            console.log("reply: " + reply);

            if (reply) {
                console.log('tem')
                const stash = JSON.parse(reply);
                console.log(stash)

                let node = flow.filter((n) => {
                    return n.code === stash.current_node;
                });
                node = node[0];
            }
            else {
                // Começando coversa
                const node = flow[0];
                const step = {
                    current_node: flow[0].code,
                    started_at: Date.now()
                }
                redis_client.set(twitter_user_id, JSON.stringify(step));
                console.log(node.quick_replies);
                // Verificando por mensagens
                const messages = node.messages;
                if (messages) {

                    client.post("direct_messages/events/new", {
                        event: {
                            type: "message_create",

                            message_create: {

                                target: { recipient_id: twitter_user_id },

                                message_data: {
                                    text: messages.join('\n'),
                                    quick_reply: {
                                        type: 'options',
                                        options: node.quick_replies
                                    }
                                },

                            }
                        }

                    }).catch(err => {
                        console.log(err);
                    })
                }


            }
        });

    });

    return res.json({ message: 'ok' });
});

module.exports = router;