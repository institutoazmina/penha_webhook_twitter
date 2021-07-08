const redis = require('../storage/redis');
const penhas_api = require('../webservices/penhas');

async function update_config() {
    return await redis.get(twitter_user_id);
}

module.exports = {
    update_config: update_config
};
