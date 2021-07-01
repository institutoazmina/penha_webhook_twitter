const redis = require('../storage/redis');

async function get_stash(twitter_user_id) {
    return await redis.get(twitter_user_id);
}

async function save_stash(twitter_user_id, stash) {
    return await redis.set(twitter_user_id, JSON.stringify(stash));
}

async function delete_stash(twitter_user_id) {
    return await redis.del(twitter_user_id);
}

module.exports = {
    get_stash: get_stash,
    save_stash: save_stash,
    delete_stash: delete_stash
};
