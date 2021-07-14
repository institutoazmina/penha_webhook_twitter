const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const Twitter = require('twitter-lite');
const FormData = require('form-data');
const axios = require('axios');

const stasher = require('../stash');
const redis = require('../../storage/redis');
const twitter_api = require('../../webservices/twitter');
const penhas_api = require('../../webservices/penhas');
const analytics_api = require('../../webservices/analytics');

// const flow = require('./../../data/flow.nodes.json');
const { time } = require('console');


function get_challenge_response(crc_token, consumer_secret) {
    return crypto.createHmac('sha256', consumer_secret).update(crc_token).digest('base64');
};

async function start_again() {

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
    const encoded_flow = await redis.get('json_config');
    const flow = JSON.parse(encoded_flow);

    const direct_messages = req.body.direct_message_events;

    if (direct_messages) {
        direct_messages.forEach(async dm => {
            const msg_tz = new Date(Number(dm.created_timestamp));
            const twitter_user_id = dm.message_create.sender_id;
            const remote_id = crypto.createHmac('sha256', twitter_user_id).digest('hex');

            let stash = await stasher.get_stash(twitter_user_id);
            stash = JSON.parse(stash);

            if (stash) {
                let node = flow.nodes.filter((n) => {
                    return n.code === stash.current_node;
                });
                node = node[0];

                if (dm.message_create.message_data.quick_reply_response) {
                    const quick_reply = dm.message_create.message_data.quick_reply_response.metadata;

                    if (quick_reply.substring(0, 4) === 'node') {
                        let next_node = flow.nodes.filter((n) => {
                            return n.code === quick_reply;
                        });
                        next_node = next_node[0];

                        const analytics_post = await analytics_api.post_analytics(stash.conversa_id, next_node.code, stash.current_node, stash.first_msg_tz, 1, undefined, 'DURING_DECISION_TREE');
                        const analytics_id = analytics_post.data.id;

                        stash.current_node = next_node.code;
                        stash.last_analytics_id = analytics_id;
                        await stasher.save_stash(twitter_user_id, stash);

                        if (next_node.questionnaire_id) {

                            const questionnaire_create = await penhas_api.post_questionnaire(twitter_user_id, next_node.questionnaire_id);
                            const questionnaire_data = questionnaire_create.data;

                            if (questionnaire_data.quiz_session.current_msgs[0]) {
                                const next_message = questionnaire_data.quiz_session.current_msgs[0];

                                await twitter_api.send_dm(twitter_user_id, next_message.content, next_message.options.map((opt) => {
                                    return { label: opt.display.substring(0, 36), metadata: JSON.stringify({ question_ref: next_message.ref, index: opt.index, session_id: questionnaire_data.quiz_session.session_id, is_questionnaire: true }) }
                                }));

                                const analytics_post = await analytics_api.post_analytics(stash.conversa_id, next_message.code, stash.current_node, stash.first_msg_tz, 1, undefined, undefined, next_node.questionnaire_id);
                                const analytics_id = analytics_post.data.id;

                                stash.last_analytics_id = analytics_id;
                                stash.current_node = next_node.code;
                                stash.is_questionnaire = true;
                                stash.current_questionnaire_question = next_message.code;
                                stash.current_questionnaire_question_type = next_message.type;
                                stash.current_questionnaire_question_ref = next_message.ref;
                                stash.current_questionnaire_options = next_message.options;
                                stash.current_questionnaire_id = next_node.questionnaire_id;
                                stash.session_id = questionnaire_data.quiz_session.session_id;

                                await stasher.save_stash(twitter_user_id, stash);
                            }
                        }
                    } else {
                        const metadata = JSON.parse(quick_reply);

                        if (metadata.is_questionnaire) {
                            let timeout = 0;

                            const answer = await penhas_api.post_answer(metadata.session_id, metadata.question_ref, metadata.index);

                            answer.data.quiz_session.current_msgs.forEach(async msg => {
                                setTimeout(
                                    async () => {
                                        if (msg.type === 'yesno') {
                                            await twitter_api.send_dm(twitter_user_id, msg.content, [
                                                {
                                                    label: 'Sim',
                                                    metadata: JSON.stringify({ question_ref: msg.ref, index: 'Y', session_id: answer.data.quiz_session.session_id, is_questionnaire: true })
                                                },
                                                {
                                                    label: 'Não',
                                                    metadata: JSON.stringify({ question_ref: msg.ref, index: 'N', session_id: answer.data.quiz_session.session_id, is_questionnaire: true })
                                                }
                                            ]);
                                        } else if (msg.type === 'onlychoice') {
                                            await twitter_api.send_dm(twitter_user_id, msg.content, msg.options.map((opt) => {
                                                return { label: opt.display.substring(0, 36), metadata: JSON.stringify({ question_ref: msg.ref, index: opt.index, session_id: answer.data.quiz_session.session_id, is_questionnaire: true }) }
                                            }));
                                        }
                                        else if (msg.type === 'displaytext') {
                                            await twitter_api.send_dm(twitter_user_id, msg.content)
                                        }
                                        else if (msg.type === 'button') {
                                            const content = msg.content.length > 1 ? msg.content : 'Texto de finalização do questionário';

                                            let payload;
                                            if (msg.code.substring(0, 3) === 'FIM') {
                                                payload = JSON.stringify({ question_ref: msg.ref, session_id: answer.data.quiz_session.session_id, is_questionnaire_end: true })
                                            }
                                            else {
                                                payload = JSON.stringify({ question_ref: msg.ref, session_id: answer.data.quiz_session.session_id, is_questionnaire_reset: true })
                                            }

                                            await twitter_api.send_dm(twitter_user_id, content, [
                                                {
                                                    label: msg.label,
                                                    metadata: payload
                                                }
                                            ]);
                                        }
                                        else if (msg.type === 'text') {
                                            await twitter_api.send_dm(twitter_user_id, msg.content);

                                            stash.current_questionnaire_question = msg.code;
                                            stash.current_questionnaire_question_type = msg.type;
                                            stash.current_questionnaire_question_ref = msg.ref;

                                            await stasher.save_stash(twitter_user_id, stash);
                                        }

                                        if (msg.code) {


                                            const analytics_post = await analytics_api.post_analytics(stash.conversa_id, msg.code, stash.current_questionnaire_question, stash.first_msg_tz, 1, undefined, 'DURING_QUESTIONNAIRE', stash.current_questionnaire_id);
                                            analytics_id = analytics_post.data.id;

                                            stash.last_analytics_id = analytics_id;
                                            stash.current_questionnaire_question = msg.code;
                                            stash.current_questionnaire_question_type = msg.type;
                                            stash.current_questionnaire_question_ref = msg.ref;
                                            stash.current_questionnaire_options = msg.options;

                                            await stasher.save_stash(twitter_user_id, stash);
                                        }
                                    },
                                    timeout
                                );

                                timeout += 1000;
                            });

                        }
                        else if (metadata.is_restart) {
                            await analytics_api.post_analytics(stash.conversa_id, stash.current_node, stash.current_node, stash.first_msg_tz, 1, undefined, 'QUESTIONNAIRE_GAVE_UP');
                            await stasher.delete_stash(twitter_user_id);
                            await twitter_api.send_dm(twitter_user_id, 'Fluxo reiniciado, na próxima mensagem você irá receber a mensagem inicial.')
                        }
                        else if (metadata.is_questionnaire_end) {
                            await analytics_api.post_analytics(stash.conversa_id, msg.code, stash.current_questionnaire_question, stash.first_msg_tz, 1, undefined, 'QUESTIONNAIRE_FINISHED', stash.current_questionnaire_id);

                            const node = flow.nodes[0];
                            const stash = {
                                current_node: flow.nodes[0].code,
                                started_at: Date.now(),
                                first_msg_epoch: Number(dm.created_timestamp),
                                first_msg_tz: msg_tz,
                            }

                            // Iniciando conversa na API de analytics
                            const conversa = await analytics_api.post_conversa(remote_id, msg_tz);
                            const conversa_id = conversa.data.id;
                            stash.conversa_id = conversa_id;

                            // Fazendo post de analytics
                            const analytics_post = await analytics_api.post_analytics(conversa_id, stash.current_node, undefined, stash.first_msg_tz, 1, undefined, 'DURING_DECISION_TREE');
                            const analytics_id = analytics_post.data.id;
                            stash.last_analytics_id = analytics_id;

                            // Verificando por mensagens
                            const messages = node.messages;
                            if (messages) {
                                const text = messages.join('\n');
                                await twitter_api.send_dm(twitter_user_id, text, node.quick_replies);
                            }

                            await stasher.save_stash(twitter_user_id, stash);
                        }
                        else if (metadata.is_questionnaire_reset) {
                            await analytics_api.post_analytics(stash.conversa_id, msg.code, stash.current_questionnaire_question, stash.first_msg_tz, 1, undefined, 'QUESTIONNAIRE_RESET', stash.current_questionnaire_id);

                            const node = flow.nodes[0];
                            const stash = {
                                current_node: flow.nodes[0].code,
                                started_at: Date.now(),
                                first_msg_epoch: Number(dm.created_timestamp),
                                first_msg_tz: msg_tz,
                            }

                            // Iniciando conversa na API de analytics
                            const conversa = await analytics_api.post_conversa(remote_id, msg_tz);
                            const conversa_id = conversa.data.id;
                            stash.conversa_id = conversa_id;

                            // Fazendo post de analytics
                            const analytics_post = await analytics_api.post_analytics(conversa_id, stash.current_node, undefined, stash.first_msg_tz, 1, undefined, 'DURING_DECISION_TREE');
                            const analytics_id = analytics_post.data.id;
                            stash.last_analytics_id = analytics_id;

                            // Verificando por mensagens
                            const messages = node.messages;
                            if (messages) {
                                const text = messages.join('\n');
                                await twitter_api.send_dm(twitter_user_id, text, node.quick_replies);
                            }

                            await stasher.save_stash(twitter_user_id, stash);
                        }


                    }

                }
                else {
                    const untreated_msg = dm.message_create.message_data.text;
                    const sent_msg = untreated_msg.toLowerCase();

                    if (sent_msg === 'reiniciar') {
                        await analytics_api.post_analytics(stash.conversa_id, stash.current_node, stash.current_node, stash.first_msg_tz, 1, undefined, 'QUESTIONNAIRE_GAVE_UP');
                        await stasher.delete_stash(twitter_user_id);

                        const node = flow.nodes[0];
                        const stash = {
                            current_node: flow.nodes[0].code,
                            started_at: Date.now(),
                            first_msg_epoch: Number(dm.created_timestamp),
                            first_msg_tz: msg_tz,
                        }

                        // Iniciando conversa na API de analytics
                        const conversa = await analytics_api.post_conversa(remote_id, msg_tz);
                        const conversa_id = conversa.data.id;
                        stash.conversa_id = conversa_id;

                        // Fazendo post de analytics
                        const analytics_post = await analytics_api.post_analytics(conversa_id, stash.current_node, undefined, stash.first_msg_tz, 1, undefined, 'DURING_DECISION_TREE');
                        const analytics_id = analytics_post.data.id;
                        stash.last_analytics_id = analytics_id;

                        // Verificando por mensagens
                        const messages = node.messages;
                        if (messages) {
                            const text = messages.join('\n');
                            await twitter_api.send_dm(twitter_user_id, text, node.quick_replies);
                        }

                        await stasher.save_stash(twitter_user_id, stash);

                    }
                    else {
                        if (stash.is_questionnaire && stash.current_questionnaire_question_type === 'text') {
                            let timeout = 0;

                            const answer = await penhas_api.post_answer(stash.session_id, stash.current_questionnaire_question_ref, sent_msg);

                            answer.data.quiz_session.current_msgs.forEach(async msg => {
                                setTimeout(
                                    async () => {
                                        if (msg.type === 'yesno') {
                                            await twitter_api.send_dm(twitter_user_id, msg.content, [
                                                {
                                                    label: 'Sim',
                                                    metadata: JSON.stringify({ question_ref: msg.ref, index: 'Y', session_id: answer.data.quiz_session.session_id, is_questionnaire: true })
                                                },
                                                {
                                                    label: 'Não',
                                                    metadata: JSON.stringify({ question_ref: msg.ref, index: 'N', session_id: answer.data.quiz_session.session_id, is_questionnaire: true })
                                                }
                                            ]);
                                        } else if (msg.type === 'onlychoice') {
                                            await twitter_api.send_dm(twitter_user_id, msg.content, msg.options.map((opt) => {
                                                return { label: opt.display.substring(0, 36), metadata: JSON.stringify({ question_ref: msg.ref, index: opt.index, session_id: answer.data.quiz_session.session_id, is_questionnaire: true }) }
                                            }));
                                        }
                                        else if (msg.type === 'displaytext') {
                                            await twitter_api.send_dm(twitter_user_id, msg.content)
                                        }
                                        else if (msg.type === 'button') {
                                            const content = msg.content.length > 1 ? msg.content : 'Texto de finalização do questionário';
                                            await twitter_api.send_dm(twitter_user_id, content, [
                                                {
                                                    label: msg.label,
                                                    metadata: JSON.stringify({ question_ref: msg.ref, session_id: answer.data.quiz_session.session_id, is_questionnaire_end: true })
                                                }
                                            ]);
                                        }
                                        else if (msg.type === 'text') {
                                            await twitter_api.send_dm(twitter_user_id, msg.content);

                                            stash.current_questionnaire_question = msg.code;
                                            stash.current_questionnaire_question_type = msg.type;
                                            stash.current_questionnaire_question_ref = msg.ref;

                                            await stasher.save_stash(twitter_user_id, stash);
                                        }
                                    },
                                    timeout
                                );

                                timeout += 1000;
                            });

                        }

                    }

                }
            }
            else {
                // Começando coversa
                const node = flow.nodes[0];
                const stash = {
                    current_node: flow.nodes[0].code,
                    started_at: Date.now(),
                    first_msg_epoch: Number(dm.created_timestamp),
                    first_msg_tz: msg_tz,
                }

                // Iniciando conversa na API de analytics
                const conversa = await analytics_api.post_conversa(remote_id, msg_tz);
                const conversa_id = conversa.data.id;
                stash.conversa_id = conversa_id;

                // Fazendo post de analytics
                const analytics_post = await analytics_api.post_analytics(conversa_id, stash.current_node, undefined, stash.first_msg_tz, 1, undefined, 'DURING_DECISION_TREE');
                const analytics_id = analytics_post.data.id;
                stash.last_analytics_id = analytics_id;

                // Verificando por mensagens
                const messages = node.messages;
                if (messages) {
                    const text = messages.join('\n');
                    await twitter_api.send_dm(twitter_user_id, text, node.quick_replies);
                }

                await stasher.save_stash(twitter_user_id, stash);
            }


        });
    }

    return res.json({ message: 'ok' });
});


module.exports = router;