const ua = require('axios');

async function post_analytics(conversa_id, handle_hashed, step_code, last_step_code, first_msg_tz) {
    const api_url = process.env.ANALYTICS_API_URL;
    const req_url = `${api_url}/analytics`;

    let tries = 0;
    while (tries < 3) {
        try {
            const res = await ua.post(req_url, {
                conversa_id: conversa_id,
                handle_hashed: handle_hashed,
                step_code: step_code,
                last_step_code: last_step_code,
                first_msg_tz: first_msg_tz
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

module.exports = post_analytics