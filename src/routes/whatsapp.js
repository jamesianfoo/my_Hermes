'use strict';

const express = require('express');
const twilio = require('twilio');
const config = require('../config');
const whatsappAgent = require('../services/whatsappAgent');
const leadScorer = require('../services/leadScorer');
const calcom = require('../services/calcom');
const googleSheets = require('../services/googleSheets');
const voiceRoutes = require('./voice');

const router = express.Router();
const MessagingResponse = twilio.twiml.MessagingResponse;

/*
 * Conversations keyed by the sender's WhatsApp number. Same trade-off as the
 * voice sessions: fine for one process, move to Redis before scaling out.
 */
const chats = new Map();
const CHAT_TTL_MS = 24 * 60 * 60 * 1000; // matches WhatsApp's service window

setInterval(function () {
  const cutoff = Date.now() - CHAT_TTL_MS;
  chats.forEach(function (chat, key) {
    if (chat.lastSeen < cutoff) chats.delete(key);
  });
}, 60 * 60 * 1000).unref();

function getChat(from) {
  let chat = chats.get(from);
  if (!chat) {
    chat = {
      from: from,
      phone: String(from).replace(/^whatsapp:/, ''),
      history: [],
      lead: {},
      offeredSlot: null,
      booked: false,
      sheetRowRange: null,
      written: {},
      createdAt: Date.now(),
    };
    chats.set(from, chat);
  }
  chat.lastSeen = Date.now();
  return chat;
}

function transcriptOf(chat) {
  return chat.history
    .map(function (m) { return (m.role === 'agent' ? 'Agent' : 'Customer') + ': ' + m.content; })
    .join('\n');
}

/** Everything the customer has told us, as scorer input. */
function leadFrom(chat, turn) {
  const details = transcriptOf(chat);
  return {
    name: chat.lead.name || turn.name || '',
    phone: chat.phone,
    email: chat.lead.email || turn.email || '',
    serviceNeeded: chat.lead.serviceNeeded || turn.serviceNeeded || '',
    problem: chat.lead.projectSummary || turn.projectSummary || details,
    details: details,
  };
}

/**
 * Score once the conversation has enough to judge, then log the lead. Runs in
 * the background so the customer is never left waiting on it.
 */
async function scoreAndLog(chat, turn) {
  if (chat.scored || turn.budgetSignal === 'Unknown' || turn.timeline === 'Unknown') return;
  chat.scored = true;

  try {
    const lead = leadFrom(chat, turn);
    const scoring = await leadScorer.scoreLead(lead);
    chat.scoring = scoring;
    chat.lead = Object.assign({}, chat.lead, lead);

    console.log('[whatsapp] scored:', scoring.tier, scoring.score, '-', chat.phone);

    const result = await googleSheets.logLead({
      timestamp: new Date().toISOString(),
      name: lead.name,
      phone: lead.phone,
      email: lead.email,
      serviceNeeded: lead.serviceNeeded,
      score: scoring.score,
      tier: scoring.tier,
      urgency: [scoring.timeline, scoring.urgency].filter(Boolean).join(' - '),
      estJobValue: scoring.estJobValue,
      callMade: false,
      ownerAlerted: false,
      keySignals: [
        'Channel: WhatsApp',
        'Budget: ' + scoring.budgetSignal,
        'Type: ' + scoring.projectType,
        scoring.keySignals,
      ].filter(Boolean).join(' | '),
      followUpNote: scoring.followUpNote,
      problem: lead.problem,
      inspectionBooked: false,
      transcript: transcriptOf(chat),
    });

    if (result.success) chat.sheetRowRange = result.rowRange;
  } catch (err) {
    chat.scored = false; // let a later turn retry
    console.error('[whatsapp] scoreAndLog failed:', err.message);
  }
}

/**
 * Keep the sheet row current as the conversation continues. Name and email
 * often arrive after the row is written, so they are backfilled here rather
 * than being lost.
 */
async function syncSheet(chat) {
  if (!chat.sheetRowRange) return;
  try {
    await googleSheets.updateCell(chat.sheetRowRange, 'P', transcriptOf(chat));

    const backfill = [['B', chat.lead.name], ['D', chat.lead.email], ['E', chat.lead.serviceNeeded]];
    for (let i = 0; i < backfill.length; i++) {
      const column = backfill[i][0];
      const value = backfill[i][1];
      if (value && chat.written[column] !== value) {
        await googleSheets.updateCell(chat.sheetRowRange, column, value);
        chat.written[column] = value;
      }
    }

    if (chat.booked) {
      await googleSheets.markInspectionBooked(chat.sheetRowRange, true);
    }
  } catch (err) {
    console.error('[whatsapp] syncSheet failed:', err.message);
  }
}

function reply(res, text) {
  const twiml = new MessagingResponse();
  twiml.message(text);
  res.type('text/xml').send(twiml.toString());
}

router.post('/incoming', async function (req, res) {
  const from = req.body.From || '';
  const body = (req.body.Body || '').trim();
  console.log('[whatsapp] from', from, ':', body);

  if (!from) return res.sendStatus(400);

  const chat = getChat(from);
  if (body) chat.history.push({ role: 'user', content: body });

  try {
    const turn = await whatsappAgent.nextTurn(chat.history);

    // Remember anything new the customer revealed.
    ['name', 'email', 'serviceNeeded', 'projectSummary'].forEach(function (k) {
      if (turn[k]) chat.lead[k] = turn[k];
    });

    let message = turn.reply;

    // Booking: confirm an offered slot, or find one to offer.
    if (chat.booked) {
      // Already booked — never double-book on a second "yes".
      message = 'You are all set for ' + voiceRoutes.spokenSlot(chat.offeredSlot) +
        '. If you need to change it, just let me know.';
    } else if (chat.offeredSlot && turn.confirmsOffer) {
      const result = await calcom.bookAppointment(chat.offeredSlot, {
        name: chat.lead.name || 'WhatsApp enquiry',
        email: chat.lead.email,
        phone: chat.phone,
      });

      if (result.success) {
        chat.booked = true;
        message = 'Done - you are booked in for ' + voiceRoutes.spokenSlot(chat.offeredSlot) +
          '. You will get a confirmation shortly. Looking forward to it.';
      } else {
        message = 'I could not lock that in on my end, sorry. Someone from the studio will ' +
          'message you shortly to confirm.';
      }
    } else if (chat.offeredSlot) {
      // A time is already on the table and they have not accepted it. The model
      // can see it in the history, so let its reply stand rather than repeating
      // the offer on top of it.
      message = turn.reply;
    } else if (turn.readyToBook) {
      const date = voiceRoutes.parseDatePreference(turn.preferredTime);
      const slot = await voiceRoutes.findSlot(date, turn.preferredTime, 7);

      if (slot) {
        chat.offeredSlot = slot;
        // Composed here, not by the model, so the time is never duplicated or
        // invented.
        message = (chat.lead.name ? 'Thanks ' + String(chat.lead.name).split(/\s+/)[0] + '. ' : '') +
          'The closest opening is ' + voiceRoutes.spokenSlot(slot) + '. Does that work?';
      } else {
        message = 'I am not seeing anything free in the next week. Someone from the studio ' +
          'will message you with more options.';
      }
    }

    chat.history.push({ role: 'agent', content: message });
    reply(res, message);

    // Sheet work happens after the customer has their reply.
    await scoreAndLog(chat, turn);
    await syncSheet(chat);
  } catch (err) {
    console.error('[whatsapp] handler failed:', err.stack || err.message);
    reply(res, 'Sorry, something went wrong on our end. Someone from the studio will get back to you.');
  }
});

/** Twilio delivery status callback for outbound WhatsApp messages. */
router.post('/status', function (req, res) {
  console.log('[whatsapp/status]', req.body.MessageSid, req.body.MessageStatus);
  res.sendStatus(204);
});

module.exports = router;
module.exports.chats = chats;
