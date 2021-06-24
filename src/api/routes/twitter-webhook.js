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

    return await axios({
        method: 'post',
        url: 'https://dev-penhas-api.appcivico.com/anon-questionnaires/new',
        data: bodyFormData,
        headers: bodyFormData.getHeaders(),
    });
}

async function post_answer(session_id, question_ref, index) {
    const bodyFormData = new FormData();
    bodyFormData.append('token', process.env.PENHAS_API_TOKEN);
    bodyFormData.append('session_id', session_id);
    bodyFormData.append(question_ref, index);
    console.log('fazendo post do questionario\n')

    return await axios({
        method: 'post',
        url: 'https://dev-penhas-api.appcivico.com/anon-questionnaires/process',
        data: bodyFormData,
        headers: bodyFormData.getHeaders(),
    });
}

async function get_stash(twitter_user_id) {
    return await redis_client.getAsync(twitter_user_id);
}

async function save_stash(twitter_user_id, stash) {
    return await redis_client.setAsync(twitter_user_id, JSON.stringify(stash));
}

async function delete_stash(twitter_user_id) {
    return await redis_client.delAsync(twitter_user_id);
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

        let stash = await get_stash(twitter_user_id);
        stash = JSON.parse(stash);
        console.log(stash);

        if (stash) {
            let node = flow.filter((n) => {
                return n.code === stash.current_node;
            });
            node = node[0];

            if (dm.message_create.message_data.quick_reply_response) {
                const quick_reply = dm.message_create.message_data.quick_reply_response.metadata;

                if (quick_reply.substring(0, 4) === 'node') {
                    let next_node = flow.filter((n) => {
                        return n.code === quick_reply;
                    });
                    next_node = next_node[0];

                    if (next_node.questionnaire_id) {

                        const questionnaire_create = await post_questionnaire(twitter_user_id, next_node.questionnaire_id);
                        const questionnaire_data = questionnaire_create.data;

                        if (questionnaire_data.quiz_session.current_msgs[0]) {
                            const next_message = questionnaire_data.quiz_session.current_msgs[0];

                            await send_dm(twitter_user_id, next_message.content, next_message.options.map((opt) => {
                                return { label: opt.display.substring(0, 36), metadata: JSON.stringify({ question_ref: next_message.ref, index: opt.index, session_id: questionnaire_data.quiz_session.session_id, is_questionnaire: true }) }
                            }));

                            stash.current_node = next_node.code;
                            stash.is_questionnaire = true;
                            stash.current_questionnaire_question = next_message.code
                            console.log('nova stash: ');
                            console.log(stash);
                            await save_stash(twitter_user_id, stash);
                        }
                    }
                } else {
                    console.log('QR foi uma resposta de questionario\n')
                    const chosen_opt = quick_reply.substring(8);
                    console.log('chosen_opt: ' + chosen_opt)

                    const metadata = JSON.parse(quick_reply);
                    console.log(metadata)

                    const answer = await post_answer(metadata.session_id, metadata.question_ref, metadata.index);

                    if (answer.data.quiz_session.current_msgs[0]) {
                        const next_message = answer.data.quiz_session.current_msgs[0];

                        await send_dm(twitter_user_id, next_message.content, next_message.options.map((opt) => {
                            return { label: opt.display.substring(0, 36), metadata: JSON.stringify({ question_ref: next_message.ref, index: opt.index, session_id: answer.data.quiz_session.session_id, is_questionnaire: true }) }
                        }));

                        stash.current_node = next_node.code;
                        stash.is_questionnaire = true;
                        stash.current_questionnaire_question = next_message.code
                        console.log('nova stash: ');
                        console.log(stash);
                        await save_stash(twitter_user_id, stash);
                    }
                    else {
                        await delete_stash(twitter_user_id);
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

            await save_stash(twitter_user_id, step);
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