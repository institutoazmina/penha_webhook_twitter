const ua = require('axios');

const api_url = process.env.ANALYTICS_API_URL;
const api_token = process.env.ANALYTICS_API_TOKEN;

async function post_conversa(handle_hashed, first_msg_tz) {
    const req_url = `${api_url}/conversa`;

    let tries = 0;
    while (tries < 3) {
        try {
            const res = await ua.post(req_url, {
                handle_hashed: handle_hashed,
                started_at: first_msg_tz
            });

            return res;
        }
        catch {
            console.error('Erro ao mandar post de conversa para API de Analytics');
            tries++;
        }
    }

    return 1;
}

async function post_analytics(conversa_id, step_code, last_step_code, first_msg_tz, json_version_code, tag_code, finished, questionnaire_id) {
    const req_url = `${api_url}/analytics`;

    let tries = 0;
    while (tries < 3) {
        try {
            const res = await ua.post(req_url, {
                conversa_id: conversa_id,
                step_code: step_code,
                last_step_code: last_step_code,
                first_msg_tz: first_msg_tz,
                json_version_code: json_version_code,
                tag_code: tag_code,
                questionnaire_id: questionnaire_id,
                finished: finished
            });

            return res;
        }
        catch {
            console.error('Erro ao mandar post para API de Analytics');
            tries++;
        }
    }

    return 1;
}

async function timeout(analytics_id, timeout_epoch) {
    const req_url = `${api_url}/timeout`;
    console.log('Chegou na func de timeout no WS');
    let tries = 0;
    while (tries < 3) {
        try {
            const res = await ua.post(req_url, {
                analytics_id: analytics_id,
                timeout_epoch: timeout_epoch
            });

            return res;
        }
        catch (err) {
            console.log(err)
            console.error('Erro ao mandar post para API de Analytics');
            tries++;
        }
    }

    return 1;
}


module.exports = { post_analytics, post_conversa, timeout }