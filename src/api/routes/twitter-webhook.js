const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const Twitter = require('twitter-lite');
const FormData = require('form-data');
const axios = require('axios');

const bluebird = require('bluebird');
const redis = require('redis');
bluebird.promisifyAll(redis.RedisClient.prototype);
bluebird.promisifyAll(redis.Multi.prototype);

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

async function post_questionnaire(twitter_user_id, questionnaire_id) {
    const bodyFormData = new FormData();
    bodyFormData.append('token', process.env.PENHAS_API_TOKEN);
    bodyFormData.append('remote_id', twitter_user_id);
    bodyFormData.append('questionnaire_id', questionnaire_id);
    console.log('fazendo post do questionario\n')

    return axios({
        method: 'post',
        url: 'https://dev-penhas-api.appcivico.com/anon-questionnaires/new',
        data: bodyFormData,
        headers: bodyFormData.getHeaders(),
    });
}

async function get_stash(twitter_user_id) {
    return await redis_client.getAsync(twitter_user_id);
}

async function send_dm(twitter_user_id, text, options) {
    let message_data;
    if (options) {
        message_data = {
            text: text,

            quick_reply: {
                type: 'options',
                options: options
            }
        }
    }
    else {
        message_data = {
            text: text
        }
    }

    return await client.post("direct_messages/events/new", {
        event: {
            type: "message_create",

            message_create: {
                target: { recipient_id: twitter_user_id },
                message_data: message_data
            }
        }
    });
}

router.get('/twitter-webhook', (req, res) => {
    const { crc_token } = req.query;

    if (!crc_token) {
        res.status(400);
        return res.json({ error: "crc_token", error_type: "missing" });
    }

    const consumer_secret = process.env.TWITTER_CONSUMER_SECRET;

    return res.json({ response_token: 'sha256=' + get_challenge_response(crc_token, consumer_secret) });
});

router.post('/twitter-webhook', async (req, res) => {
    const direct_messages = req.body.direct_message_events;

    direct_messages.forEach(async dm => {
        const twitter_user_id = dm.message_create.sender_id;
        const remote_id = crypto.createHmac('sha256', twitter_user_id).digest('hex');

        const stash = await get_stash(twitter_user_id);
        console.log(stash);

        if (stash) {
            let node = flow.filter((n) => {
                return n.code === stash.current_node;
            });
            node = node[0];

            if (dm.message_create.message_data.quick_reply_response) {
                const quick_reply = dm.message_create.message_data.quick_reply_response.metadata;

                if (quick_reply.substring(0, 13) === 'questionnaire') {
                    console.log('QR foi uma resposta de questionario\n')
                    const chosen_opt = quick_reply.substring(14);
                    console.log('chosen_opt: ' + chosen_opt)
                } else {

                    let next_node = flow.filter((n) => {
                        return n.code === quick_reply;
                    });
                    next_node = next_node[0];

                    if (next_node.questionnaire_id) {

                        const foo = await post_questionnaire(twitter_user_id, next_node, next_node.questionnaire_id);
                        console.log('===============================\n');
                        console.log(foo);
                        console.log('===============================\n');
                        // axios({
                        //     method: 'post',
                        //     url: 'https://dev-penhas-api.appcivico.com/anon-questionnaires/new',
                        //     data: bodyFormData,
                        //     headers: bodyFormData.getHeaders(),
                        // }).then((res) => {
                        //     const next_message = res.data.quiz_session.current_msg;

                        //     if (next_message) {
                        //         console.log('fazendo post da proxima mensagem\n')
                        //         client.post("direct_messages/events/new", {
                        //             event: {
                        //                 type: "message_create",

                        //                 message_create: {

                        //                     target: { recipient_id: twitter_user_id },

                        //                     message_data: {
                        //                         text: next_message.content,
                        //                         quick_reply: {
                        //                             type: 'options',
                        //                             options: next_message.options.map((opt) => {
                        //                                 return { label: opt.display.substring(0, 36), metadata: 'questionnaire_' + opt.code_value }
                        //                             })
                        //                         }
                        //                     },

                        //                 }
                        //             }
                        //         }).catch(err => {
                        //             console.log('erro no post dm/events/new\n');
                        //             console.log(err);
                        //         })

                        // stash.current_node = next_node.code;
                        // stash.is_questionnaire = true;
                        // stash.current_questionnaire_question = next_message.code
                        // redis_client.set(twitter_user_id, JSON.stringify(stash));

                    }
                }
            }
        }
        else {
            // Começando coversa
            const node = flow[0];
            const step = {
                current_node: flow[0].code,
                started_at: Date.now()
            }

            console.log(node.quick_replies);
            // Verificando por mensagens
            const messages = node.messages;
            if (messages) {
                const text = messages.join('\n');
                await send_dm(twitter_user_id, text, node.quick_replies);
            }
            redis_client.set(twitter_user_id, JSON.stringify(step));
        }

        //         console.log('twitter_user_id :' + twitter_user_id)
        //         const foo = redis_client.get(twitter_user_id, (err, reply) => {

        //             if (reply) {
        //                 console.log('stash encontrada\n')
        //                 let stash = JSON.parse(reply);
        //                 console.log(stash)



        //                     else {
        //                         console.log('QR foi um botão do fluxo\n')


        //                     }).catch((err) => {
        //                         console.log('erro no post anon-questionnaires/new\n');
        //                         console.log(err)
        //                     })
        //     }

        //                         console.log(next_node);
        // }
        //                 }
        //             }
        //             else {


        //     }
        //         });

    });

    return res.json({ message: 'ok' });
});

module.exports = router;