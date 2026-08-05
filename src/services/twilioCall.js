'use strict';

const twilio = require('twilio');
const config = require('../config');

let client = null;
function getClient() {
  if (!client) {
    if (!config.twilio.accountSid || !config.twilio.authToken) {
      throw new Error('TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are not set');
    }
    client = twilio(config.twilio.accountSid, config.twilio.authToken);
  }
  return client;
}

/**
 * Place the outbound qualification call.
 * @param {{phone:string, name?:string}} lead
 * @returns {Promise<{success:boolean, sid?:string, error?:string}>}
 */
async function placeOutboundCall(lead) {
  const serverUrl = config.serverUrl;
  if (!serverUrl) {
    return { success: false, error: 'SERVER_URL is not set' };
  }
  if (!lead || !lead.phone) {
    return { success: false, error: 'Lead has no phone number' };
  }

  try {
    const call = await getClient().calls.create({
      to: lead.phone,
      from: config.twilio.fromNumber,
      url: serverUrl + '/voice/start',
      method: 'POST',
      statusCallback: serverUrl + '/voice/status',
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    });

    console.log('[twilioCall] outbound call queued', call.sid, '->', lead.phone);
    return { success: true, sid: call.sid };
  } catch (err) {
    console.error('[twilioCall] failed to place call:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Text the owner about a hot lead. Best effort — never throws.
 */
async function alertOwner(lead, scoring) {
  if (!config.twilio.ownerNumber || !config.twilio.fromNumber) {
    return { success: false, error: 'Owner or from number not configured' };
  }

  const body = [
    `${scoring.tier} lead (${scoring.score}/10): ${lead.name || 'Unknown'}`,
    `${lead.phone || 'no phone'} | ${lead.serviceNeeded || 'service TBD'}`,
    `Est. $${scoring.estJobValue} | ${scoring.urgency}`,
    scoring.followUpNote,
  ].join('\n');

  try {
    await getClient().messages.create({
      to: config.twilio.ownerNumber,
      from: config.twilio.fromNumber,
      body: body,
    });
    return { success: true };
  } catch (err) {
    console.error('[twilioCall] owner alert failed:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { placeOutboundCall: placeOutboundCall, alertOwner: alertOwner };
