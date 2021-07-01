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

module.exports = {
    post_questionnaire: post_questionnaire,
    post_answer: post_answer
}