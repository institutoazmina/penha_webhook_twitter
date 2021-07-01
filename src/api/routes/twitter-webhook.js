const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const Twitter = require('twitter-lite');
const FormData = require('form-data');
const axios = require('axios');

const stasher = require('../stash');
const twitter_api = require('../../webservices/twitter');
const penhas_api = require('../../webservices/penhas');

const flow = require('./../../data/flow.json');
const { time } = require('console');


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

router.post('/twitter-webhook', async (req, res) => {
    const direct_messages = req.body.direct_message_events;

    if (direct_messages) {
        direct_messages.forEach(async dm => {
            const twitter_user_id = dm.message_create.sender_id;
            const remote_id = crypto.createHmac('sha256', twitter_user_id).digest('hex');

            let stash = await stasher.get_stash(twitter_user_id);
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

                            const questionnaire_create = await penhas_api.post_questionnaire(twitter_user_id, next_node.questionnaire_id);
                            const questionnaire_data = questionnaire_create.data;

                            if (questionnaire_data.quiz_session.current_msgs[0]) {
                                const next_message = questionnaire_data.quiz_session.current_msgs[0];

                                await twitter_api.send_dm(twitter_user_id, next_message.content, next_message.options.map((opt) => {
                                    return { label: opt.display.substring(0, 36), metadata: JSON.stringify({ question_ref: next_message.ref, index: opt.index, session_id: questionnaire_data.quiz_session.session_id, is_questionnaire: true }) }
                                }));

                                stash.current_node = next_node.code;
                                stash.is_questionnaire = true;
                                stash.current_questionnaire_question = next_message.code;
                                stash.current_questionnaire_question_type = next_message.type;
                                stash.current_questionnaire_question_ref = next_message.ref;
                                stash.session_id = questionnaire_data.quiz_session.session_id;
                                console.log('nova stash: ');
                                console.log(stash);
                                await stasher.save_stash(twitter_user_id, stash);
                            }
                        }
                    } else {
                        console.log('QR foi uma resposta de questionario\n')
                        const chosen_opt = quick_reply.substring(8);
                        console.log('chosen_opt: ' + chosen_opt)

                        const metadata = JSON.parse(quick_reply);
                        console.log(metadata);

                        if (metadata.is_questionnaire) {
                            const answer = await penhas_api.post_answer(metadata.session_id, metadata.question_ref, metadata.index);

                            answer.data.quiz_session.current_msgs.forEach(async msg => {
                                setTimeout(
                                    () => {
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
                                            await twitter_api.send_dm(twitter_user_id, msg.content, [
                                                {
                                                    label: msg.label,
                                                    metadata: JSON.stringify({ question_ref: msg.ref, session_id: answer.data.quiz_session.session_id, is_restart: true })
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
                        else if (metadata.is_restart) {
                            await stasher.delete_stash(twitter_user_id);
                            await twitter_api.send_dm(twitter_user_id, 'Fluxo reiniciado, na próxima mensagem você irá receber a mensagem inicial.')
                        }


                    }

                }
                else {
                    if (dm.message_create.message_data.text === 'reiniciar') {
                        await stasher.delete_stash(twitter_user_id);
                        await twitter_api.send_dm(twitter_user_id, "Certo, vou deletar minha memória sobre você, na próxima mensagem irei te responder com a primeira mensagem do fluxo.");
                    }
                    else {
                        if (stash.is_questionnaire && stash.current_questionnaire_question_type === 'text') {
                            let timeout = 0;

                            const answer = await penhas_api.post_answer(stash.session_id, stash.current_questionnaire_question_ref, dm.message_create.message_data.text);

                            answer.data.quiz_session.current_msgs.forEach(async msg => {
                                setTimeout(
                                    () => {
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
                                            await twitter_api.send_dm(twitter_user_id, msg.content, [
                                                {
                                                    label: msg.label,
                                                    metadata: JSON.stringify({ question_ref: msg.ref, session_id: answer.data.quiz_session.session_id, is_restart: true })
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
                    await twitter_api.send_dm(twitter_user_id, text, node.quick_replies);
                }

                await stasher.save_stash(twitter_user_id, step);
            }


        });
    }

    return res.json({ message: 'ok' });
});

module.exports = router;