require('dotenv').config()

const redis = require('../storage/redis');
const twitter = require('../webservices/twitter');
const analytics_api = require('../webservices/analytics');

async function process_queue() {
    try {
        const ttl = 3600000;
    
        const lock = await redis.setnx('timeout_started_at', (Date.now() / 1000));
        if (lock === 1) {
            await redis.pexpire('timeout_started_at', ttl);
    
            const keys = await redis.keys('*');
    
            let json_config = await redis.get('json_config');
            json_config = JSON.parse(json_config);
    
            const config_timeout_seconds = json_config.timeout_seconds;
            const config_timeout_msg = json_config.timeout_message;
    
            for (const key of keys) {
                if (key != 'json_config' && key != 'timeout_started_at') {       
                    console.log('key: ' + key);
        
                    let stash = await redis.get(key);
                    stash = JSON.parse(stash);

                    if (stash.last_msg_epoch && stash.last_analytics_id) {
                        const last_msg_epoch = stash.last_msg_epoch;
                        const last_msg_plus_timeout = (last_msg_epoch / 1000) + config_timeout_seconds;
        
                        const now = (Date.now() / 1000);
        
                        console.log("last_msg_plus_timeout: " + last_msg_plus_timeout);
                        console.log("now: " + now);
        
                        if (last_msg_plus_timeout <= now) {
                            console.log('hora de dar timeout')
                            const twitter_user_id = key;
            
                            await twitter.send_dm(twitter_user_id, config_timeout_msg);
                            const analytics_req = await analytics_api.timeout(stash.last_analytics_id, last_msg_plus_timeout);

                            const new_stash = {
                                last_conversa_finished_at: last_msg_plus_timeout
                            };
                            
                            await redis.set(twitter_user_id, JSON.stringify(new_stash));
                            //await redis.del(twitter_user_id);
                        }
                    }
                }
            }
    
            await redis.del('timeout_started_at');
            process.exit(1);
        }
        else {
            process.exit(1);
        }
    } catch (err) {
        console.error('Houve erro no timeout');
        console.error(err)
    }
}

process_queue();
