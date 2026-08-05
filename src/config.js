'use strict';

require('dotenv').config();

const config = {
  port: parseInt(process.env.PORT, 10) || 3000,
  host: '0.0.0.0',
  serverUrl: (process.env.SERVER_URL || '').replace(/\/+$/, ''),
  timezone: process.env.TIMEZONE || 'UTC',

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
  },

  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    fromNumber: process.env.TWILIO_PHONE_NUMBER,
    ownerNumber: process.env.OWNER_PHONE_NUMBER,
  },

  elevenLabs: {
    apiKey: process.env.ELEVEN_API_KEY,
    voiceId: process.env.ELEVEN_VOICE_ID,
    modelId: 'eleven_turbo_v2',
    timeoutMs: parseInt(process.env.ELEVEN_TIMEOUT_MS, 10) || 8000,
  },

  typeform: {
    secret: process.env.TYPEFORM_SECRET,
  },

  calcom: {
    apiKey: process.env.CAL_API_KEY,
    eventTypeId: process.env.CAL_EVENT_TYPE_ID,
    username: process.env.CAL_USERNAME,
    eventTypeSlug: process.env.CAL_EVENT_TYPE_SLUG,
  },

  googleSheets: {
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    sheetName: process.env.GOOGLE_SHEET_NAME || 'Leads',
    clientEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    // Support the common "\n"-escaped form used in .env files.
    privateKey: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  },

  business: {
    name: process.env.BUSINESS_NAME || 'the design studio',
    // What the assistant calls itself on calls and in chat.
    agentName: process.env.AGENT_NAME || 'Ivy',
  },
};

module.exports = config;
