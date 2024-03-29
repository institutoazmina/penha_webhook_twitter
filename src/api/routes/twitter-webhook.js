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

const { time } = require('console');


function get_challenge_response(crc_token, consumer_secret) {
    return crypto.createHmac('sha256', consumer_secret).update(crc_token).digest('base64');
};

async function get_tag_code(msg_code, tag_code_config, twitter_user_id) {
    let stash = await stasher.get_stash(twitter_user_id);
    stash = JSON.parse(stash);

    if (stash.tag_code) {

        return stash.tag_code
    }
    else {
        let tag_code_value = 0;

        tag_code_config.scenarios.forEach(async scenario => {

            if (scenario.check_code === msg_code) {
                tag_code_value = scenario.tag_code_value;

            }
        })


        return tag_code_value || 0;
    }
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
            if (dm.message_create.source_app_id) {
                return 1;
            }

            const msg_tz = new Date(Number(dm.created_timestamp));
            const twitter_user_id = dm.message_create.sender_id;
            const remote_id = crypto.createHmac('sha256', twitter_user_id).digest('hex');

            let stash = await stasher.get_stash(twitter_user_id);
            stash = JSON.parse(stash);

            if (stash && !stash.last_conversa_finished_at) {
                stash.last_msg_epoch = Date.now();
                await stasher.save_stash(twitter_user_id, stash);

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
                        console.log(next_node);
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
                                    return {
                                        label: opt.display,
                                        metadata: JSON.stringify({
                                            question_ref: next_message.ref,
                                            index: opt.index,
                                            session_id: questionnaire_data.quiz_session.session_id,
                                            code_value: opt.code_value,
                                            is_questionnaire: true
                                        })
                                    }
                                }));

                                const analytics_post = await analytics_api.post_analytics(stash.conversa_id, next_message.code, stash.current_node, stash.first_msg_tz, 1, await get_tag_code(next_message.code, flow.tag_code_config, twitter_user_id), 'DURING_QUESTIONNAIRE', next_node.questionnaire_id);
                                const analytics_id = analytics_post.data.id;

                                stash.tag_code = await get_tag_code(next_message.code, flow.tag_code_config, twitter_user_id);
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
                        else {
                            stash.current_node = next_node.code;
                            stash.current_questionnaire_options = next_node.quick_replies;
                            await stasher.save_stash(twitter_user_id, stash);

                            if (next_node.messages) {
                                const text = next_node.messages.join('\n');
                                await twitter_api.send_dm(twitter_user_id, text, next_node.quick_replies);
                            }
                        }
                    } else {
                        const metadata = JSON.parse(quick_reply);

                        if (metadata.is_questionnaire) {
                            let timeout = 0;

                            let input_error;

                            const answer = await penhas_api.post_answer(metadata.session_id, metadata.question_ref, metadata.index);

                            const messages_len = answer.data.quiz_session.current_msgs.length;
                            let current_message_index = 0;
                            answer.data.quiz_session.current_msgs.forEach(async msg => {
                                setTimeout(
                                    async () => {
                                        current_message_index++;

                                        if (msg.type === 'yesno') {
                                            let msg_content;
                                            if (messages_len > 1) {
                                                msg_content = msg.content + ` [${current_message_index}/${messages_len}]`
                                            }
                                            else {
                                                msg_content = msg.content;
                                            }

                                            await twitter_api.send_dm(twitter_user_id, msg_content, [
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
                                            let msg_content;
                                            if (messages_len > 1) {
                                                msg_content = msg.content + ` [${current_message_index}/${messages_len}]`
                                            }
                                            else {
                                                msg_content = msg.content;
                                            }

                                            await twitter_api.send_dm(twitter_user_id, msg_content, msg.options.map((opt) => {
                                                return {
                                                    label: opt.display,
                                                    metadata: JSON.stringify({
                                                        question_ref: msg.ref,
                                                        index: opt.index,
                                                        session_id: answer.data.quiz_session.session_id,
                                                        code_value: opt.code_value,
                                                        is_questionnaire: true
                                                    })
                                                }
                                            }));
                                        }
                                        else if (msg.type === 'displaytext') {
                                            let msg_content;
                                            if (messages_len > 1) {
                                                msg_content = msg.content + ` [${current_message_index}/${messages_len}]`
                                            }
                                            else {
                                                msg_content = msg.content;
                                            }

                                            if (msg.style === 'error') {
                                                input_error = true;
                                            }

                                            await twitter_api.send_dm(twitter_user_id, msg_content)
                                        }
                                        else if (msg.type === 'button') {
                                            let msg_content;
                                            if (messages_len > 1) {
                                                msg_content = msg.content + ` [${current_message_index}/${messages_len}]`
                                            }
                                            else {
                                                msg_content = msg.content;
                                            }

                                            const content = msg.content.length > 1 ? msg_content : 'Texto de finalização do questionário';

                                            let payload;
                                            if (msg.code.substring(0, 3) === 'FIM') {
                                                await analytics_api.post_analytics(stash.conversa_id, msg.code, stash.current_questionnaire_question, stash.first_msg_tz, 1, await get_tag_code(msg.code, flow.tag_code_config, twitter_user_id), 'QUESTIONNAIRE_FINISHED', stash.current_questionnaire_id);

                                                payload = JSON.stringify({ question_ref: msg.ref, session_id: answer.data.quiz_session.session_id, is_questionnaire_end: true })
                                                await twitter_api.send_dm(twitter_user_id, content, [
                                                    {
                                                        label: '🔃 Voltar ao início',
                                                        metadata: payload
                                                    }
                                                ]);
                                            }
                                            else if (msg.code.substring(0, 5) === 'RESET') {
                                            }
                                            else {

                                                payload = JSON.stringify({ question_ref: msg.ref, session_id: answer.data.quiz_session.session_id, is_questionnaire_reset: true })
                                                await twitter_api.send_dm(twitter_user_id, content, [
                                                    {
                                                        label: msg.label,
                                                        metadata: payload
                                                    }
                                                ]);
                                            }

                                        }
                                        else if (msg.type === 'text') {
                                            let msg_content;
                                            if (messages_len > 1) {
                                                msg_content = msg.content + ` [${current_message_index}/${messages_len}]`
                                            }
                                            else {
                                                msg_content = msg.content;
                                            }

                                            let options;
                                            if (input_error) {
                                                options = [
                                                    {
                                                        label: '🔙 Sair',
                                                        metadata: JSON.stringify({
                                                            is_questionnaire_reset: true,
                                                            gave_up: true
                                                        })
                                                    }
                                                ]
                                                input_error = false;
                                            }

                                            await twitter_api.send_dm(twitter_user_id, msg_content, options);

                                            stash.current_questionnaire_question = msg.code;
                                            stash.current_questionnaire_question_type = msg.type;
                                            stash.current_questionnaire_question_ref = msg.ref;

                                            await stasher.save_stash(twitter_user_id, stash);
                                        }

                                        if (msg.code) {

                                            if (msg.code.substring(0, 5) === 'RESET') {

                                                const node = flow.nodes[3];
                                                const new_stash = {
                                                    current_node: flow.nodes[0].code,
                                                    started_at: Date.now(),
                                                    first_msg_epoch: Number(dm.created_timestamp),
                                                    first_msg_tz: msg_tz,
                                                    current_questionnaire_options: node.quick_replies
                                                }
                                                await analytics_api.post_analytics(stash.conversa_id, stash.current_questionnaire_question, stash.current_questionnaire_question, stash.first_msg_tz, 1, await get_tag_code(msg.code, flow.tag_code_config, twitter_user_id), 'QUESTIONNAIRE_FINISHED', node.questionnaire_id);

                                                // Iniciando conversa na API de analytics
                                                const conversa = await analytics_api.post_conversa(remote_id, msg_tz);
                                                const conversa_id = conversa.data.id;
                                                new_stash.conversa_id = conversa_id;

                                                const questionnaire_create = await penhas_api.post_questionnaire(twitter_user_id, node.questionnaire_id);
                                                const questionnaire_data = questionnaire_create.data;

                                                if (questionnaire_data.quiz_session.current_msgs[0]) {
                                                    const next_message = questionnaire_data.quiz_session.current_msgs[0];

                                                    await twitter_api.send_dm(twitter_user_id, next_message.content, next_message.options.map((opt) => {
                                                        return {
                                                            label: opt.display,
                                                            metadata: JSON.stringify({
                                                                question_ref: next_message.ref,
                                                                index: opt.index,
                                                                session_id: questionnaire_data.quiz_session.session_id,
                                                                code_value: opt.code_value,
                                                                is_questionnaire: true
                                                            })
                                                        }
                                                    }));

                                                    const analytics_post = await analytics_api.post_analytics(new_stash.conversa_id, next_message.code, new_stash.current_node, new_stash.first_msg_tz, 1, await get_tag_code(next_message.code, flow.tag_code_config, twitter_user_id), 'DURING_QUESTIONNAIRE', node.questionnaire_id);
                                                    const analytics_id = analytics_post.data.id;

                                                    new_stash.tag_code = await get_tag_code(node.code, flow.tag_code_config, twitter_user_id);
                                                    new_stash.last_analytics_id = analytics_id;
                                                    new_stash.current_node = next_message.code;
                                                    new_stash.is_questionnaire = true;
                                                    new_stash.current_questionnaire_question = next_message.code;
                                                    new_stash.current_questionnaire_question_type = next_message.type;
                                                    new_stash.current_questionnaire_question_ref = next_message.ref;
                                                    new_stash.current_questionnaire_options = next_message.options;
                                                    new_stash.current_questionnaire_id = node.questionnaire_id;
                                                    new_stash.session_id = questionnaire_data.quiz_session.session_id;

                                                }


                                                await stasher.save_stash(twitter_user_id, new_stash);
                                            }
                                            else if (msg.code.substring(0, 3) === 'FIM') {
                                                stash.current_questionnaire_question = msg.code;
                                                stash.current_questionnaire_question_type = msg.type;
                                                stash.current_questionnaire_question_ref = msg.ref;
                                                stash.is_questionnaire = false;
                                                stash.last_msg_epoch = undefined;
                                                stash.current_questionnaire_options = [
                                                    {
                                                        label: '🔃 Voltar ao início',
                                                        metadata: JSON.stringify({ question_ref: msg.ref, session_id: answer.data.quiz_session.session_id, is_questionnaire_end: true })
                                                    }
                                                ];

                                                await stasher.save_stash(twitter_user_id, stash);
                                            }
                                            else {

                                                if (msg.code != stash.current_questionnaire_question) {
                                                    const analytics_post = await analytics_api.post_analytics(stash.conversa_id, msg.code, stash.current_questionnaire_question, stash.first_msg_tz, 1, (stash.tag_code || await get_tag_code(metadata.code_value, flow.tag_code_config, twitter_user_id)), 'DURING_QUESTIONNAIRE', stash.current_questionnaire_id);
                                                    analytics_id = analytics_post.data.id;

                                                    stash.tag_code = await get_tag_code(metadata.code_value, flow.tag_code_config, twitter_user_id);
                                                    stash.last_analytics_id = analytics_id;
                                                    stash.current_questionnaire_question = msg.code;
                                                    stash.current_questionnaire_question_type = msg.type;
                                                    stash.current_questionnaire_question_ref = msg.ref;
                                                    stash.current_questionnaire_options = msg.options;

                                                    await stasher.save_stash(twitter_user_id, stash);
                                                }
                                            }

                                        }
                                    },
                                    timeout
                                );

                                timeout += 2000;
                            });

                        }
                        else if (metadata.is_restart) {
                            const step_code = stash.current_questionnaire_question ? stash.current_questionnaire_question : stash.current_node;

                            await analytics_api.post_analytics(stash.conversa_id, step_code, step_code, stash.first_msg_tz, 1, undefined, 'QUESTIONNAIRE_GAVE_UP');
                            await stasher.delete_stash(twitter_user_id);
                            await twitter_api.send_dm(twitter_user_id, 'Fluxo reiniciado, na próxima mensagem você irá receber a mensagem inicial.')
                        }
                        else if (metadata.is_questionnaire_end) {

                            const node = flow.nodes[1];
                            console.log(node);
                            const new_stash = {
                                current_node: flow.nodes[0].code,
                                started_at: Date.now(),
                                first_msg_epoch: Number(dm.created_timestamp),
                                first_msg_tz: msg_tz,
                                current_questionnaire_options: node.quick_replies
                            }

                            // Iniciando conversa na API de analytics
                            const conversa = await analytics_api.post_conversa(remote_id, msg_tz);
                            const conversa_id = conversa.data.id;
                            new_stash.conversa_id = conversa_id;

                            // Fazendo post de analytics
                            const analytics_post = await analytics_api.post_analytics(conversa_id, stash.current_node, undefined, stash.first_msg_tz, 1, undefined, 'DURING_DECISION_TREE');
                            const analytics_id = analytics_post.data.id;
                            new_stash.last_analytics_id = analytics_id;

                            // Verificando por mensagens
                            const messages = node.messages;
                            const attachment = node.attachment;
                            if (messages) {
                                const text = messages.join('\n');
                                await twitter_api.send_dm(twitter_user_id, text, node.quick_replies, attachment);
                            }

                            await stasher.save_stash(twitter_user_id, new_stash);
                        }
                        else if (metadata.is_questionnaire_reset) {

                            let node;
                            if (metadata.gave_up) {
                                node = flow.nodes[1];
                            }
                            else {
                                node = flow.nodes[3]
                            }

                            const new_stash = {
                                current_node: node.code,
                                started_at: Date.now(),
                                first_msg_epoch: Number(dm.created_timestamp),
                                first_msg_tz: msg_tz,
                                current_questionnaire_options: node.quick_replies
                            }
                            await analytics_api.post_analytics(stash.conversa_id, stash.current_questionnaire_question, stash.current_questionnaire_question, stash.first_msg_tz, 1, await get_tag_code(node.code, flow.tag_code_config, twitter_user_id), (metadata.gave_up ? 'QUESTIONNAIRE_GAVE_UP' : 'QUESTIONNAIRE_FINISHED'), node.questionnaire_id);

                            // Iniciando conversa na API de analytics
                            const conversa = await analytics_api.post_conversa(remote_id, msg_tz);
                            const conversa_id = conversa.data.id;
                            new_stash.conversa_id = conversa_id;

                            if (node.questionnaire_id) {
                                const questionnaire_create = await penhas_api.post_questionnaire(twitter_user_id, node.questionnaire_id);
                                const questionnaire_data = questionnaire_create.data;

                                if (questionnaire_data.quiz_session.current_msgs[0]) {
                                    const next_message = questionnaire_data.quiz_session.current_msgs[0];

                                    await twitter_api.send_dm(twitter_user_id, next_message.content, next_message.options.map((opt) => {
                                        return {
                                            label: opt.display,
                                            metadata: JSON.stringify({
                                                question_ref: next_message.ref,
                                                index: opt.index,
                                                session_id: questionnaire_data.quiz_session.session_id,
                                                code_value: opt.code_value,
                                                is_questionnaire: true
                                            })
                                        }
                                    }));

                                    const analytics_post = await analytics_api.post_analytics(new_stash.conversa_id, next_message.code, new_stash.current_node, new_stash.first_msg_tz, 1, await get_tag_code(next_message.code, flow.tag_code_config, twitter_user_id), 'DURING_QUESTIONNAIRE', node.questionnaire_id);
                                    const analytics_id = analytics_post.data.id;

                                    new_stash.tag_code = await get_tag_code(node.code, flow.tag_code_config, twitter_user_id);
                                    new_stash.last_analytics_id = analytics_id;
                                    new_stash.current_node = next_message.code;
                                    new_stash.is_questionnaire = true;
                                    new_stash.current_questionnaire_question = next_message.code;
                                    new_stash.current_questionnaire_question_type = next_message.type;
                                    new_stash.current_questionnaire_question_ref = next_message.ref;
                                    new_stash.current_questionnaire_options = next_message.options;
                                    new_stash.current_questionnaire_id = node.questionnaire_id;
                                    new_stash.session_id = questionnaire_data.quiz_session.session_id;
                                }

                                await stasher.save_stash(twitter_user_id, new_stash);
                            }
                            else {
                                stash.current_node = node.code;
                                stash.current_questionnaire_options = node.quick_replies;
                                await stasher.save_stash(twitter_user_id, stash);

                                if (node.messages) {
                                    const text = node.messages.join('\n');
                                    await twitter_api.send_dm(twitter_user_id, text, node.quick_replies);
                                }
                            }
                        }


                    }

                }
                else {
                    const untreated_msg = dm.message_create.message_data.text;
                    const sent_msg = untreated_msg.toLowerCase();

                    if (sent_msg === 'reiniciar') {
                        const step_code = stash.current_questionnaire_question ? stash.current_questionnaire_question : stash.current_node;
                        await analytics_api.post_analytics(stash.conversa_id, step_code, step_code, stash.first_msg_tz, 1, undefined, 'QUESTIONNAIRE_GAVE_UP');
                        await stasher.delete_stash(twitter_user_id);

                        const node = flow.nodes[0];
                        const new_stash = {
                            current_node: flow.nodes[0].code,
                            started_at: Date.now(),
                            first_msg_epoch: Number(dm.created_timestamp),
                            first_msg_tz: msg_tz,
                            current_questionnaire_options: node.quick_replies
                        }

                        // Iniciando conversa na API de analytics
                        const conversa = await analytics_api.post_conversa(remote_id, msg_tz);
                        const conversa_id = conversa.data.id;
                        new_stash.conversa_id = conversa_id;

                        // Fazendo post de analytics
                        const analytics_post = await analytics_api.post_analytics(conversa_id, new_stash.current_node, undefined, new_stash.first_msg_tz, 1, undefined, 'DURING_DECISION_TREE');
                        const analytics_id = analytics_post.data.id;
                        new_stash.last_analytics_id = analytics_id;

                        // Verificando por mensagens
                        const messages = node.messages;
                        if (messages) {
                            const text = messages.join('\n');
                            await twitter_api.send_dm(twitter_user_id, text, node.quick_replies, node.attachment);
                        }

                        await stasher.save_stash(twitter_user_id, new_stash);

                    }
                    else {
                        if (stash.current_questionnaire_question_type === 'text') {
                            let timeout = 0;

                            const answer = await penhas_api.post_answer(stash.session_id, stash.current_questionnaire_question_ref, sent_msg);

                            let input_error;

                            const messages_len = answer.data.quiz_session.current_msgs.length;
                            let current_message_index = 0;
                            answer.data.quiz_session.current_msgs.forEach(async msg => {
                                setTimeout(
                                    async () => {
                                        current_message_index++;

                                        if (msg.type === 'yesno') {
                                            let msg_content;
                                            if (messages_len > 1) {
                                                msg_content = msg.content + ` [${current_message_index}/${messages_len}]`
                                            }
                                            else {
                                                msg_content = msg.content;
                                            }

                                            await twitter_api.send_dm(twitter_user_id, msg_content, [
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
                                            let msg_content;
                                            if (messages_len > 1) {
                                                msg_content = msg.content + ` [${current_message_index}/${messages_len}]`
                                            }
                                            else {
                                                msg_content = msg.content;
                                            }

                                            await twitter_api.send_dm(twitter_user_id, msg_content, msg.options.map((opt) => {
                                                return {
                                                    label: opt.display,
                                                    metadata: JSON.stringify({
                                                        question_ref: msg.ref,
                                                        index: opt.index,
                                                        session_id: answer.data.quiz_session.session_id,
                                                        code_value: opt.code_value,
                                                        is_questionnaire: true
                                                    })
                                                }
                                            }));
                                        }
                                        else if (msg.type === 'displaytext') {
                                            let msg_content;
                                            if (messages_len > 1) {
                                                msg_content = msg.content + ` [${current_message_index}/${messages_len}]`
                                            }
                                            else {
                                                msg_content = msg.content;
                                            }

                                            if (msg.style === 'error') {
                                                input_error = true;
                                            }

                                            await twitter_api.send_dm(twitter_user_id, msg_content)
                                        }
                                        else if (msg.type === 'button') {
                                            let msg_content;
                                            if (messages_len > 1) {
                                                msg_content = msg.content + ` [${current_message_index}/${messages_len}]`
                                            }
                                            else {
                                                msg_content = msg.content;
                                            }

                                            let payload;
                                            if (msg.code.substring(0, 3) === 'FIM') {
                                                await analytics_api.post_analytics(stash.conversa_id, msg.code, stash.current_questionnaire_question, stash.first_msg_tz, 1, await get_tag_code(msg.code, flow.tag_code_config, twitter_user_id), 'QUESTIONNAIRE_FINISHED', stash.current_questionnaire_id);

                                                payload = JSON.stringify({ question_ref: msg.ref, session_id: answer.data.quiz_session.session_id, is_questionnaire_end: true })
                                                await twitter_api.send_dm(twitter_user_id, msg_content, [
                                                    {
                                                        label: '🔃 Voltar ao início',
                                                        metadata: payload
                                                    }
                                                ]);
                                            }
                                            else if (msg.code.substring(0, 5) === 'RESET') {
                                            }
                                            else {

                                                payload = JSON.stringify({ question_ref: msg.ref, session_id: answer.data.quiz_session.session_id, is_questionnaire_reset: true })
                                                await twitter_api.send_dm(twitter_user_id, msg_content, [
                                                    {
                                                        label: msg.label,
                                                        metadata: payload
                                                    }
                                                ]);
                                            }

                                        }
                                        else if (msg.type === 'text') {
                                            let msg_content;
                                            if (messages_len > 1) {
                                                msg_content = msg.content + ` [${current_message_index}/${messages_len}]`
                                            }
                                            else {
                                                msg_content = msg.content;
                                            }

                                            let options;
                                            if (input_error) {
                                                options = [
                                                    {
                                                        label: '🔙 Sair',
                                                        metadata: JSON.stringify({
                                                            is_questionnaire_reset: true,
                                                            gave_up: true
                                                        })
                                                    }
                                                ]
                                                input_error = false;
                                            }

                                            await twitter_api.send_dm(twitter_user_id, msg_content, options);

                                            stash.current_questionnaire_question = msg.code;
                                            stash.current_questionnaire_question_type = msg.type;
                                            stash.current_questionnaire_question_ref = msg.ref;

                                            await stasher.save_stash(twitter_user_id, stash);
                                        }

                                        if (msg.code) {

                                            if (msg.code.substring(0, 5) === 'RESET') {

                                                const node = flow.nodes[3];
                                                const new_stash = {
                                                    current_node: flow.nodes[0].code,
                                                    started_at: Date.now(),
                                                    first_msg_epoch: Number(dm.created_timestamp),
                                                    first_msg_tz: msg_tz,
                                                    current_questionnaire_options: node.quick_replies
                                                }
                                                await analytics_api.post_analytics(stash.conversa_id, stash.current_questionnaire_question, stash.current_questionnaire_question, stash.first_msg_tz, 1, await get_tag_code(msg.code, flow.tag_code_config, twitter_user_id), 'QUESTIONNAIRE_FINISHED', node.questionnaire_id);

                                                // Iniciando conversa na API de analytics
                                                const conversa = await analytics_api.post_conversa(remote_id, msg_tz);
                                                const conversa_id = conversa.data.id;
                                                new_stash.conversa_id = conversa_id;

                                                const questionnaire_create = await penhas_api.post_questionnaire(twitter_user_id, node.questionnaire_id);
                                                const questionnaire_data = questionnaire_create.data;

                                                if (questionnaire_data.quiz_session.current_msgs[0]) {
                                                    const next_message = questionnaire_data.quiz_session.current_msgs[0];

                                                    await twitter_api.send_dm(twitter_user_id, next_message.content, next_message.options.map((opt) => {
                                                        return {
                                                            label: opt.display,
                                                            metadata: JSON.stringify({
                                                                question_ref: next_message.ref,
                                                                index: opt.index,
                                                                session_id: questionnaire_data.quiz_session.session_id,
                                                                code_value: opt.code_value,
                                                                is_questionnaire: true
                                                            })
                                                        }
                                                    }));

                                                    const analytics_post = await analytics_api.post_analytics(new_stash.conversa_id, next_message.code, new_stash.current_node, new_stash.first_msg_tz, 1, await get_tag_code(next_message.code, flow.tag_code_config, twitter_user_id), 'DURING_QUESTIONNAIRE', node.questionnaire_id);
                                                    const analytics_id = analytics_post.data.id;

                                                    new_stash.tag_code = await get_tag_code(node.code, flow.tag_code_config, twitter_user_id);
                                                    new_stash.last_analytics_id = analytics_id;
                                                    new_stash.current_node = next_message.code;
                                                    new_stash.is_questionnaire = true;
                                                    new_stash.current_questionnaire_question = next_message.code;
                                                    new_stash.current_questionnaire_question_type = next_message.type;
                                                    new_stash.current_questionnaire_question_ref = next_message.ref;
                                                    new_stash.current_questionnaire_options = next_message.options;
                                                    new_stash.current_questionnaire_id = node.questionnaire_id;
                                                    new_stash.session_id = questionnaire_data.quiz_session.session_id;

                                                }


                                                await stasher.save_stash(twitter_user_id, new_stash);
                                            }
                                            else if (msg.code.substring(0, 3) === 'FIM') {
                                                stash.current_questionnaire_question = msg.code;
                                                stash.current_questionnaire_question_type = msg.type;
                                                stash.current_questionnaire_question_ref = msg.ref;
                                                stash.is_questionnaire = false;
                                                stash.last_msg_epoch = undefined;
                                                stash.current_questionnaire_options = [
                                                    {
                                                        label: '🔃 Voltar ao início',
                                                        metadata: JSON.stringify({ question_ref: msg.ref, session_id: answer.data.quiz_session.session_id, is_questionnaire_end: true })
                                                    }
                                                ];

                                                await stasher.save_stash(twitter_user_id, stash);
                                            }
                                            else {

                                                const analytics_post = await analytics_api.post_analytics(stash.conversa_id, msg.code, stash.current_questionnaire_question, stash.first_msg_tz, 1, (stash.tag_code || await get_tag_code(msg.code, flow.tag_code_config, twitter_user_id)), 'DURING_QUESTIONNAIRE', stash.current_questionnaire_id);
                                                analytics_id = analytics_post.data.id;

                                                stash.last_analytics_id = analytics_id;
                                                stash.current_questionnaire_question = msg.code;
                                                stash.current_questionnaire_question_type = msg.type;
                                                stash.current_questionnaire_question_ref = msg.ref;
                                                stash.current_questionnaire_options = msg.options;

                                                await stasher.save_stash(twitter_user_id, stash);
                                            }
                                        }
                                    },
                                    timeout
                                );

                                timeout += 2000;
                            });

                        }
                        else {
                            if (stash.is_questionnaire) {
                                await twitter_api.send_dm(twitter_user_id, flow.error_msg, stash.current_questionnaire_options.map((opt) => {
                                    return { label: opt.display, metadata: JSON.stringify({ question_ref: stash.current_questionnaire_question_ref, index: opt.index, session_id: stash.session_id, is_questionnaire: true }) }
                                }))
                            }
                            else {

                                await twitter_api.send_dm(twitter_user_id, flow.error_msg, stash.current_questionnaire_options)
                            }
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
                    current_questionnaire_options: node.quick_replies
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
                    await twitter_api.send_dm(twitter_user_id, text, node.quick_replies, node.attachment);
                }

                await stasher.save_stash(twitter_user_id, stash);
            }


        });
    }

    return res.json({ message: 'ok' });
});


module.exports = router;