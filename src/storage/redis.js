const redis = require('redis');
const { promisify } = require('util');

const host = process.env.REDIS_HOST;
const port = process.env.REDIS_PORT;
const password = process.env.REDIS_PASSWORD;

const redisClient = redis.createClient({
    host: host,
    port: port,
    password: password
});

redisClient.on('error', (error) => {
    console.error('Error on redis client');
    console.error(error);
});

redisClient.on('connect', () => {
    console.log('Redis client connected');
});

module.exports = {
    get: promisify(redisClient.get).bind(redisClient),
    set: promisify(redisClient.set).bind(redisClient),
    del: promisify(redisClient.del).bind(redisClient),
    rpush: promisify(redisClient.rpush).bind(redisClient),
    lpush: promisify(redisClient.lpush).bind(redisClient),
    keys: promisify(redisClient.keys).bind(redisClient),
    setnx: promisify(redisClient.setnx).bind(redisClient),
    pexpire: promisify(redisClient.pexpire).bind(redisClient),
    scan: promisify(redisClient.scan).bind(redisClient)
};
