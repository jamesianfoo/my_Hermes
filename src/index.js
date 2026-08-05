'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');

const config = require('./config');
const webhookRoutes = require('./routes/webhook');
const voiceRoutes = require('./routes/voice');

const app = express();

// Keep the raw body around — the Typeform signature is an HMAC over the exact
// bytes, so it cannot be recomputed from the parsed object.
app.use(express.json({
  limit: '1mb',
  verify: function (req, res, buf) { req.rawBody = buf; },
}));
app.use(express.urlencoded({ extended: false })); // Twilio posts form-encoded

app.use(function (req, res, next) {
  console.log(new Date().toISOString(), req.method, req.originalUrl);
  next();
});

// Generated ElevenLabs mp3s — Twilio <Play> fetches them from here.
const AUDIO_DIR = path.join(__dirname, 'audio');
if (!fs.existsSync(AUDIO_DIR)) {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
}
app.use('/audio', express.static(AUDIO_DIR, { maxAge: '1h' }));

app.get('/health', function (req, res) {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/webhook', webhookRoutes);
app.use('/voice', voiceRoutes);

app.use(function (req, res) {
  res.status(404).json({ error: 'Not found' });
});

app.use(function (err, req, res, next) {
  console.error('[error]', err.stack || err.message);
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(config.port, config.host, function () {
  console.log('Lead qualifier listening on ' + config.host + ':' + config.port);
  console.log('  SERVER_URL: ' + (config.serverUrl || '(not set — outbound calls will fail)'));
  console.log('  TIMEZONE:   ' + (process.env.TIMEZONE || '(not set — defaulting to UTC)'));

  const missing = [];
  if (!config.anthropic.apiKey) missing.push('ANTHROPIC_API_KEY');
  if (!config.twilio.accountSid) missing.push('TWILIO_ACCOUNT_SID');
  if (!config.twilio.authToken) missing.push('TWILIO_AUTH_TOKEN');
  if (!config.twilio.fromNumber) missing.push('TWILIO_PHONE_NUMBER');
  if (!config.calcom.apiKey) missing.push('CAL_API_KEY');
  if (!config.calcom.eventTypeId) missing.push('CAL_EVENT_TYPE_ID');
  if (!process.env.TIMEZONE) missing.push('TIMEZONE');
  if (missing.length) {
    console.warn('  Missing env vars: ' + missing.join(', '));
  }
});

function shutdown(signal) {
  console.log(signal + ' received, shutting down');
  server.close(function () { process.exit(0); });
  setTimeout(function () { process.exit(1); }, 10000).unref();
}
process.on('SIGTERM', function () { shutdown('SIGTERM'); });
process.on('SIGINT', function () { shutdown('SIGINT'); });

module.exports = app;
