require('winston-daily-rotate-file');
const express = require('express');
const winston = require('winston');
const expressWinston = require('express-winston');
const body_parser = require('body-parser')

// Routes
const health_check = require('./routes/health-check');
const twitter_webhook = require('./routes/twitter-webhook');

const app = express();

// parse application/json
app.use(body_parser.json())

const transport = new winston.transports.DailyRotateFile({
    filename: 'azmina-chatbot_%DATE%.log',
    datePattern: 'YYYY-MM-DD-HH',
    zippedArchive: true,
    maxSize: '20m',
    maxFiles: '14d',
    dirname: process.env.LOG_DIR || "/tmp/"
});

app.use(expressWinston.logger({
    transports: [
        transport
    ],
    format: winston.format.combine(
        winston.format.colorize(),
        winston.format.json()
    ),
    meta: true,
    msg: "HTTP {{req.method}} {{req.url}}",
    expressFormat: true,
    colorize: false,
    ignoreRoute: function (req, res) { return false; }
}));

// Routes
app.use(health_check);
app.use(twitter_webhook);

app.use(expressWinston.errorLogger({
    transports: [
        new winston.transports.Console()
    ],
    format: winston.format.combine(
        winston.format.colorize(),
        winston.format.json()
    )
}));

module.exports = app;
