const Twitter = require('twitter-lite');

const client = new Twitter({
    consumer_key: process.env.TWITTER_CONSUMER_KEY,
    consumer_secret: process.env.TWITTER_CONSUMER_SECRET,
    // bearer_token: process.env.TWITTER_BEARER_TOKEN,
    access_token_key: process.env.TWITTER_ACCESS_TOKEN,
    access_token_secret: process.env.TWITTER_ACCESS_TOKEN_SECRET
});

function get_message_data(text, options, attachment) {
    const message_data_obj = { text: text }

    if (options) {
        message_data_obj.quick_reply = {
            type: 'options',
            options: options
        }
    }

    if (attachment) {
        message_data_obj.attachment = {
            type: 'media',
            media: { id: attachment }
        }
    }
    console.log(message_data_obj);
    return message_data_obj;
}

async function send_dm(twitter_user_id, text, options, attachment) {
    const message_data = get_message_data(text, options, attachment);

    try {
        const direct_message = await client.post("direct_messages/events/new", {
            event: {
                type: "message_create",

                message_create: {
                    target: { recipient_id: twitter_user_id },
                    message_data: message_data
                }
            }
        });

        return direct_message;
    }
    catch (err) {
        console.error('Erro ao enviar DM');
        console.error(err);

        return err;
    }

}

module.exports = {
    send_dm: send_dm
};
