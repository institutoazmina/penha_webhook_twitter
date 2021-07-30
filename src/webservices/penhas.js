const FormData = require('form-data');
const axios = require('axios');

async function post_questionnaire(twitter_user_id, questionnaire_id) {
    const bodyFormData = new FormData();
    bodyFormData.append('token', process.env.PENHAS_API_TOKEN);
    bodyFormData.append('remote_id', twitter_user_id);
    bodyFormData.append('questionnaire_id', questionnaire_id);
    console.log('fazendo post do questionario\n')

    return await axios({
        method: 'post',
        url: process.env.PENHAS_API_URL + '/anon-questionnaires/new',
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

    const req = await axios({
        method: 'post',
        url: process.env.PENHAS_API_URL + '/anon-questionnaires/process',
        data: bodyFormData,
        headers: bodyFormData.getHeaders(),
    });

    console.log('Resposta da req do penhas');
    console.log(req.data);

    if (req.data.quiz_session) {
        console.log('current messages: ')
        if (req.data.quiz_session.current_msgs) {
            req.data.quiz_session.current_msgs.forEach(element => {
                console.log(element);
            });
        }
    }

    return req;
}

async function fetch_config_json() {
    const bodyFormData = new FormData();
    bodyFormData.append('token', process.env.PENHAS_API_TOKEN);

    return await axios({
        method: 'get',
        url: process.env.PENHAS_API_URL + '/anon-questionnaires/config',
        data: bodyFormData,
        headers: bodyFormData.getHeaders(),
        params: {
            token: process.env.PENHAS_API_TOKEN
        }
    });
}

module.exports = {
    post_questionnaire: post_questionnaire,
    post_answer: post_answer,
    fetch_config_json: fetch_config_json
}