const Twitter = require('twitter-lite');

const client = new Twitter({
    consumer_key: process.env.TWITTER_CONSUMER_KEY,
    consumer_secret: process.env.TWITTER_CONSUMER_SECRET,
    // bearer_token: process.env.TWITTER_BEARER_TOKEN,
    access_token_key: process.env.TWITTER_ACCESS_TOKEN,
    access_token_secret: process.env.TWITTER_ACCESS_TOKEN_SECRET
});

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

module.exports = {
    send_dm: send_dm
};
