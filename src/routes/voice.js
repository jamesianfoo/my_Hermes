'use strict';

const express = require('express');
const twilio = require('twilio');
const config = require('../config');
const elevenLabs = require('../services/elevenLabs');
const calcom = require('../services/calcom');
const googleSheets = require('../services/googleSheets');

const router = express.Router();
const VoiceResponse = twilio.twiml.VoiceResponse;

/*
 * In-memory call state, keyed by Twilio CallSid. Good enough for a single
 * process; swap for Redis if this ever runs on more than one dyno.
 */
const sessions = new Map();
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

function registerLead(callSid, lead, extra) {
  const session = Object.assign(
    {
      lead: lead,
      createdAt: Date.now(),
      problem: '',
      preferredTime: '',
      offeredSlot: null,
      booked: false,
      turns: [],
    },
    extra || {}
  );
  sessions.set(callSid, session);
  return session;
}

/** Record one side of the conversation, in order. */
function recordTurn(session, speaker, text) {
  if (!session || !text) return;
  if (!session.turns) session.turns = [];
  session.turns.push(speaker + ': ' + String(text).trim());
}

/** The conversation so far, as plain text for the sheet. */
function transcriptOf(session) {
  return (session && session.turns ? session.turns : []).join('\n');
}

function getSession(callSid) {
  let session = sessions.get(callSid);
  if (!session) {
    session = registerLead(callSid, {});
  }
  return session;
}

setInterval(function () {
  const cutoff = Date.now() - SESSION_TTL_MS;
  sessions.forEach(function (session, sid) {
    if (session.createdAt < cutoff) sessions.delete(sid);
  });
}, 15 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Sheet safety net
// ---------------------------------------------------------------------------

/**
 * Guarantee this lead exists in the sheet no matter how the call ends.
 *
 * The webhook normally logs the row before dialing and hands the range over via
 * registerLead. This covers the cases where that did not happen — the sheet
 * write failed, or the call reached us without going through the webhook — and
 * records the outcome so a lead that never booked is still actionable.
 *
 * Never throws: it is called from error paths, and must not create new ones.
 */
const SHEET_TIMEOUT_MS = 5000;

/** Bound a promise so a hung Sheets call can't stall the TwiML response. */
function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise(function (resolve, reject) {
      setTimeout(function () { reject(new Error(label + ' timed out')); }, SHEET_TIMEOUT_MS).unref();
    }),
  ]);
}

async function ensureLeadLogged(session, outcome, booked) {
  try {
    if (session.sheetRowRange) {
      if (booked) {
        await withTimeout(googleSheets.markInspectionBooked(session.sheetRowRange, true), 'booked flag');
      }
      if (outcome && !session.outcomeRecorded) {
        session.outcomeRecorded = true;
        await withTimeout(googleSheets.appendFollowUpNote(session.sheetRowRange, outcome), 'note append');
      }
      // Rewritten each time so the row always holds the whole conversation,
      // however far it got.
      const transcript = transcriptOf(session);
      if (transcript) {
        await withTimeout(googleSheets.updateCell(session.sheetRowRange, 'P', transcript), 'transcript');
      }
      return;
    }

    // No row yet. Write one — but only once, even if several handlers fail.
    if (session.sheetLogStarted) return;
    session.sheetLogStarted = true;

    const lead = session.lead || {};
    const scoring = session.scoring || {};
    const result = await withTimeout(googleSheets.logLead({
      timestamp: new Date().toISOString(),
      name: lead.name,
      phone: lead.phone,
      email: lead.email,
      serviceNeeded: lead.serviceNeeded,
      score: scoring.score,
      tier: scoring.tier,
      urgency: scoring.urgency,
      estJobValue: scoring.estJobValue,
      callMade: true,
      ownerAlerted: Boolean(session.ownerAlerted),
      keySignals: scoring.keySignals,
      followUpNote: [scoring.followUpNote, outcome].filter(Boolean).join(' | '),
      problem: session.problem || lead.problem,
      inspectionBooked: Boolean(booked),
      transcript: transcriptOf(session),
    }), 'lead log');

    if (result.success) {
      session.sheetRowRange = result.rowRange;
      session.outcomeRecorded = Boolean(outcome);
    } else {
      // Let a later handler retry rather than losing the lead entirely.
      session.sheetLogStarted = false;
      console.error('[voice] lead not logged:', result.error, JSON.stringify(lead));
    }
  } catch (err) {
    session.sheetLogStarted = false;
    console.error('[voice] ensureLeadLogged failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Speech helpers
// ---------------------------------------------------------------------------

/**
 * Speak `text`: ElevenLabs mp3 via <Play>, falling back to <Say> if TTS fails
 * or times out.
 */
async function speak(node, text) {
  const url = await elevenLabs.synthesize(text);
  if (url) {
    node.play(url);
  } else {
    node.say({ voice: 'Polly.Joanna' }, text);
  }
}

/**
 * Build a <Gather> that speaks a prompt and posts the speech result to `action`.
 */
async function gather(response, text, action, session) {
  recordTurn(session, 'Agent', text);
  const g = response.gather({
    input: 'speech',
    action: action,
    method: 'POST',
    speechTimeout: 'auto',
    speechModel: 'phone_call',
    actionOnEmptyResult: true,
  });
  await speak(g, text);
  return g;
}

function send(res, response) {
  res.type('text/xml').send(response.toString());
}

async function hangupWith(res, text, session) {
  recordTurn(session, 'Agent', text);
  const response = new VoiceResponse();
  await speak(response, text);
  response.hangup();
  send(res, response);
}

// ---------------------------------------------------------------------------
// Timezone-aware date/time helpers — the timezone always comes from env.
// ---------------------------------------------------------------------------

function tz() {
  return process.env.TIMEZONE || config.timezone;
}

/** "YYYY-MM-DD" for a Date, in the configured timezone. */
function isoDateInTz(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz(),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** Spoken form, e.g. "Wednesday, August 6th at 10:00 AM". */
function spokenSlot(isoString) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz(),
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(isoString));
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function addDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

/** Weekday index (0-6) of a Date as seen in the configured timezone. */
function weekdayInTz(date) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: tz(), weekday: 'long' })
    .format(date)
    .toLowerCase();
  return WEEKDAYS.indexOf(name);
}

/**
 * Turn free-form speech ("tomorrow morning", "next Tuesday") into a candidate
 * date. Falls back to tomorrow, then walks forward day by day at the call site.
 */
function parseDatePreference(speech) {
  const text = String(speech || '').toLowerCase();
  const now = new Date();

  if (/\btoday\b/.test(text)) return isoDateInTz(now);
  if (/\btomorrow\b/.test(text)) return isoDateInTz(addDays(now, 1));

  for (let i = 0; i < WEEKDAYS.length; i++) {
    if (new RegExp('\\b' + WEEKDAYS[i] + '\\b').test(text)) {
      const today = weekdayInTz(now);
      let delta = (i - today + 7) % 7;
      if (delta === 0) delta = 7; // "monday" said on a Monday means next Monday
      return isoDateInTz(addDays(now, delta));
    }
  }

  return isoDateInTz(addDays(now, 1));
}

/** Prefer a slot matching a stated part of day, otherwise the earliest. */
function pickClosestSlot(slots, speech) {
  if (!slots.length) return null;
  const text = String(speech || '').toLowerCase();

  const sorted = slots.slice().sort();
  const hourOf = function (iso) {
    return parseInt(
      new Intl.DateTimeFormat('en-US', { timeZone: tz(), hour: 'numeric', hour12: false }).format(new Date(iso)),
      10
    );
  };

  if (/\bmorning\b/.test(text)) {
    const morning = sorted.find(function (s) { return hourOf(s) < 12; });
    if (morning) return morning;
  }
  if (/\bafternoon\b/.test(text)) {
    const afternoon = sorted.find(function (s) { return hourOf(s) >= 12 && hourOf(s) < 17; });
    if (afternoon) return afternoon;
  }
  if (/\bevening\b|\bafter work\b/.test(text)) {
    const evening = sorted.find(function (s) { return hourOf(s) >= 17; });
    if (evening) return evening;
  }

  return sorted[0];
}

/** Search up to `maxDays` forward from `startDate` for the first open slot. */
async function findSlot(startDate, speech, maxDays) {
  let date = startDate;
  for (let i = 0; i < (maxDays || 7); i++) {
    const slots = await calcom.getAvailability(date);
    const picked = pickClosestSlot(slots, speech);
    if (picked) return picked;
    date = isoDateInTz(addDays(new Date(date + 'T12:00:00Z'), 1));
  }
  return null;
}

function saidYes(speech) {
  return /\b(yes|yeah|yep|yup|sure|ok|okay|correct|that works|sounds good|perfect|book it|confirm)\b/i.test(
    String(speech || '')
  );
}

function saidNo(speech) {
  return /\b(no|nope|nah|not|different|another|else|can'?t|cannot|doesn'?t work)\b/i.test(String(speech || ''));
}

// ---------------------------------------------------------------------------
// Step 1 — greet
// ---------------------------------------------------------------------------

router.post('/start', async function (req, res) {
  const callSid = req.body.CallSid;
  const session = getSession(callSid);
  const name = (session.lead && session.lead.name) || '';
  const firstName = name ? String(name).split(/\s+/)[0] : '';

  const greeting =
    'Hi' + (firstName ? ' ' + firstName : '') + ', this is the scheduling assistant with ' +
    config.business.name + ', following up on your design enquiry. ' +
    'How can I help you?';

  const response = new VoiceResponse();
  try {
    await gather(response, greeting, '/voice/problem', session);
    // If the caller says nothing at all, retry once before giving up.
    await speak(response, 'Sorry, I did not catch that. I will try you again later. Goodbye.');
    response.hangup();
    send(res, response);
  } catch (err) {
    console.error('[voice/start]', err.message);
    await ensureLeadLogged(session, 'Call failed at greeting: ' + err.message, false);
    await hangupWith(res, 'Sorry, we are having a technical problem. We will call you back shortly.', session);
  }
});

// ---------------------------------------------------------------------------
// Step 2 — store the problem, ask for a preferred day/time
// ---------------------------------------------------------------------------

router.post('/problem', async function (req, res) {
  const callSid = req.body.CallSid;
  const session = getSession(callSid);
  session.problem = req.body.SpeechResult || '';
  recordTurn(session, 'Caller', session.problem);
  console.log('[voice/problem]', callSid, session.problem);

  const prompt = session.problem
    ? 'Got it, thanks for explaining that. What day and time work best for a call?'
    : 'No problem. What day and time work best for a call?';

  const response = new VoiceResponse();
  try {
    await gather(response, prompt, '/voice/schedule', session);
    await speak(response, 'I did not catch a day. Someone from our team will follow up with you. Goodbye.');
    response.hangup();
    send(res, response);
  } catch (err) {
    console.error('[voice/problem]', err.message);
    await ensureLeadLogged(session, 'Call failed after problem step: ' + err.message, false);
    await hangupWith(res, 'Sorry, we are having a technical problem. We will call you back shortly.', session);
  }
});

// ---------------------------------------------------------------------------
// Step 3 — check Cal.com, offer the closest slot
// ---------------------------------------------------------------------------

router.post('/schedule', async function (req, res) {
  const callSid = req.body.CallSid;
  const session = getSession(callSid);
  session.preferredTime = req.body.SpeechResult || '';
  recordTurn(session, 'Caller', session.preferredTime);
  console.log('[voice/schedule]', callSid, session.preferredTime);

  try {
    const targetDate = parseDatePreference(session.preferredTime);
    const slot = await findSlot(targetDate, session.preferredTime, 7);

    if (!slot) {
      // No availability is a normal outcome, not an error: end politely, but
      // make sure the lead is on the sheet with the reason so the office can
      // call back.
      await ensureLeadLogged(
        session,
        'No Cal.com availability in the 7 days from ' + targetDate +
          (session.preferredTime ? ' (caller asked for: ' + session.preferredTime + ')' : '') +
          ' - needs manual callback',
        false
      );
      return hangupWith(
        res,
        'I am not seeing any open times right now. I will have someone from the studio ' +
          'call you back with options. Thanks, and have a great day.',
        session
      );
    }

    session.offeredSlot = slot;

    const response = new VoiceResponse();
    await gather(
      response,
      'The closest opening I have is ' + spokenSlot(slot) + '. Does that work for you?',
      '/voice/confirm',
      session
    );
    await speak(response, 'I did not hear an answer. Someone will follow up to confirm. Goodbye.');
    response.hangup();
    send(res, response);
  } catch (err) {
    console.error('[voice/schedule]', err.message);
    await ensureLeadLogged(session, 'Calendar lookup failed: ' + err.message, false);
    await hangupWith(res, 'Sorry, I had trouble checking the calendar. Someone will call you right back.', session);
  }
});

// ---------------------------------------------------------------------------
// Step 4 — book and confirm
// ---------------------------------------------------------------------------

router.post('/confirm', async function (req, res) {
  const callSid = req.body.CallSid;
  const session = getSession(callSid);
  const speech = req.body.SpeechResult || '';
  recordTurn(session, 'Caller', speech);
  console.log('[voice/confirm]', callSid, speech);

  try {
    if (!session.offeredSlot) {
      await ensureLeadLogged(session, 'Lost offered slot mid-call - needs manual callback', false);
      return hangupWith(res, 'Sorry, I lost track of that time. Someone will call you back to schedule. Goodbye.', session);
    }

    if (saidNo(speech) && !saidYes(speech)) {
      // Look for the next opening after the one we already offered.
      const nextDate = isoDateInTz(addDays(new Date(session.offeredSlot), 1));
      const alternative = await findSlot(nextDate, session.preferredTime, 7);

      if (!alternative) {
        await ensureLeadLogged(
          session,
          'Caller declined the offered slot and no alternative was available - needs manual callback',
          false
        );
        return hangupWith(
          res,
          'No problem. I will have the office call you with more options. Thanks for your time.',
          session
        );
      }

      session.offeredSlot = alternative;
      const response = new VoiceResponse();
      await gather(
        response,
        'No problem. I also have ' + spokenSlot(alternative) + '. Does that one work?',
        '/voice/confirm',
        session
      );
      await speak(response, 'I did not hear an answer. Someone will follow up. Goodbye.');
      response.hangup();
      return send(res, response);
    }

    if (!saidYes(speech)) {
      const response = new VoiceResponse();
      await gather(
        response,
        'Sorry, I did not catch that. Should I book ' + spokenSlot(session.offeredSlot) + '? Please say yes or no.',
        '/voice/confirm',
        session
      );
      await speak(response, 'I did not hear an answer. Someone will follow up. Goodbye.');
      response.hangup();
      return send(res, response);
    }

    const lead = Object.assign({}, session.lead, {
      problem: session.problem || (session.lead && session.lead.problem) || '',
    });

    const result = await calcom.bookAppointment(session.offeredSlot, lead);

    if (!result.success) {
      await ensureLeadLogged(
        session,
        'Caller agreed to ' + session.offeredSlot + ' but Cal.com booking failed (' + result.error +
          ') - BOOK MANUALLY',
        false
      );
      return hangupWith(
        res,
        'I was not able to lock that in on my end. Someone from the office will call you right back to ' +
          'confirm your consultation. Sorry about that, and thanks for your patience.',
        session
      );
    }

    session.booked = true;
    await ensureLeadLogged(session, 'Booked ' + session.offeredSlot + ' on the call', true);

    await hangupWith(
      res,
      'You are all set for ' + spokenSlot(session.offeredSlot) + '. ' +
        'You will get a confirmation shortly. Thanks, and we will see you then.',
      session
    );
  } catch (err) {
    console.error('[voice/confirm]', err.message);
    await ensureLeadLogged(session, 'Call failed during booking: ' + err.message, false);
    await hangupWith(res, 'Sorry, something went wrong on our end. Someone will call you right back.', session);
  }
});

// ---------------------------------------------------------------------------
// Twilio status callback
// ---------------------------------------------------------------------------

router.post('/status', function (req, res) {
  const callSid = req.body.CallSid;
  console.log(
    '[voice/status]',
    callSid,
    req.body.CallStatus,
    req.body.To || '',
    req.body.CallDuration ? req.body.CallDuration + 's' : ''
  );

  const terminal = ['completed', 'failed', 'busy', 'no-answer', 'canceled'];
  if (terminal.indexOf(req.body.CallStatus) !== -1) {
    const session = sessions.get(callSid);
    if (session) {
      session.finalStatus = req.body.CallStatus;
      session.completedAt = Date.now();

      // Last line of defence: if the call died before any handler could log
      // (dropped call, crash, unanswered), the lead still lands on the sheet.
      ensureLeadLogged(
        session,
        session.booked ? null : 'Call ended (' + req.body.CallStatus + ') without booking',
        Boolean(session.booked)
      ).catch(function (err) {
        console.error('[voice/status] final log failed:', err.message);
      });
    }
  }

  res.sendStatus(204);
});

module.exports = router;
module.exports.registerLead = registerLead;
module.exports.sessions = sessions;
