'use strict';

const axios = require('axios');
const config = require('../config');

const cal = axios.create({
  baseURL: 'https://api.cal.com/v2',
  headers: {
    Authorization: 'Bearer ' + (config.calcom.apiKey || ''),
    'cal-api-version': '2024-08-13',
    'Content-Type': 'application/json',
  },
  timeout: 15000,
});

/**
 * Normalize the various shapes Cal.com returns for slots into a flat array of
 * ISO start strings.
 */
function extractSlots(payload, date) {
  const data = (payload && payload.data) || payload || {};

  // Shape A: { data: { "2026-08-05": [ { start: "..." }, ... ] } }
  const byDate = data[date];
  if (Array.isArray(byDate)) {
    return byDate.map(function (s) { return typeof s === 'string' ? s : (s.start || s.time); }).filter(Boolean);
  }

  // Shape B: { data: { slots: { "2026-08-05": [...] } } }
  if (data.slots && typeof data.slots === 'object') {
    if (Array.isArray(data.slots[date])) {
      return data.slots[date]
        .map(function (s) { return typeof s === 'string' ? s : (s.start || s.time); })
        .filter(Boolean);
    }
    // Fall back to every date present, in chronological order.
    return Object.keys(data.slots)
      .sort()
      .reduce(function (acc, key) {
        const entries = Array.isArray(data.slots[key]) ? data.slots[key] : [];
        return acc.concat(entries.map(function (s) {
          return typeof s === 'string' ? s : (s.start || s.time);
        }));
      }, [])
      .filter(Boolean);
  }

  // Shape C: { data: [ { start: "..." }, ... ] }
  if (Array.isArray(data)) {
    return data.map(function (s) { return typeof s === 'string' ? s : (s.start || s.time); }).filter(Boolean);
  }

  return [];
}

/**
 * Get bookable slots for a single date (YYYY-MM-DD).
 * @param {string} date
 * @returns {Promise<string[]>} ISO start times
 */
async function getAvailability(date) {
  const params = {
    eventTypeId: Number(config.calcom.eventTypeId),
    start: date,
    end: date,
    timeZone: process.env.TIMEZONE,
  };

  if (config.calcom.username && config.calcom.eventTypeSlug) {
    params.username = config.calcom.username;
    params.eventTypeSlug = config.calcom.eventTypeSlug;
  }

  try {
    const res = await cal.get('/slots', { params: params });
    const slots = extractSlots(res.data, date);
    console.log('[calcom] ' + slots.length + ' slot(s) for ' + date);
    return slots;
  } catch (err) {
    if (err.response) {
      console.error('[calcom] getAvailability error', err.response.status, JSON.stringify(err.response.data));
    } else {
      console.error('[calcom] getAvailability error:', err.message);
    }
    return [];
  }
}

/**
 * Book an inspection.
 * @param {string} startIso  ISO start time of the chosen slot
 * @param {{name?:string, email?:string, phone?:string}} lead
 * @returns {Promise<{success:boolean, booking?:object, error?:string}>}
 */
async function bookAppointment(startIso, lead) {
  // The attendee must always carry a contact method. Email is only included
  // when it is a real, non-empty value — Cal.com rejects an empty string.
  const attendee = {
    name: (lead && lead.name) || 'Home inspection lead',
    timeZone: process.env.TIMEZONE,
    language: 'en',
  };

  const email = lead && typeof lead.email === 'string' ? lead.email.trim() : '';
  if (email) {
    attendee.email = email;
  }
  if (lead && lead.phone) {
    attendee.phoneNumber = lead.phone;
  }

  const body = {
    eventTypeId: Number(process.env.CAL_EVENT_TYPE_ID),
    start: startIso,
    attendee: attendee,
  };

  try {
    const res = await cal.post('/bookings', body);
    console.log('[calcom] booked', startIso, 'for', attendee.name);
    return { success: true, booking: (res.data && res.data.data) || res.data };
  } catch (err) {
    if (err.response) {
      console.error('[calcom] booking error status:', err.response.status);
      console.error('[calcom] booking error body:', JSON.stringify(err.response.data));
      return {
        success: false,
        error: 'Cal.com ' + err.response.status + ': ' + JSON.stringify(err.response.data),
      };
    }
    console.error('[calcom] booking error:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = {
  getAvailability: getAvailability,
  bookAppointment: bookAppointment,
};
