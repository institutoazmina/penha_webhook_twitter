require('dotenv').config()

const express = require('express');
const app = express();

app.get('/health-check', (req, res) => {
  res.json({ message: 'OK' })
})

module.exports = app;