'use strict';

const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const leadScorer = require('../services/leadScorer');
const twilioCall = require('../services/twilioCall');
const googleSheets = require('../services/googleSheets');
const voiceRoutes = require('./voice');

const router = express.Router();

/** Pull the scalar value out of a single Typeform answer object. */
function answerValue(answer) {
  switch (answer.type) {
    case 'text':
    case 'email':
    case 'phone_number':
    case 'url':
    case 'short_text':
    case 'long_text':
      return answer[answer.type] || answer.text || '';
    case 'choice':
      return (answer.choice && (answer.choice.label || answer.choice.other)) || '';
    case 'choices':
      return ((answer.choices && answer.choices.labels) || []).join(', ');
    case 'number':
      return String(answer.number);
    case 'boolean':
      return answer.boolean ? 'Yes' : 'No';
    case 'date':
      return answer.date || '';
    default:
      return answer[answer.type] != null && typeof answer[answer.type] !== 'object'
        ? String(answer[answer.type])
        : '';
  }
}

/** Identifiers Typeform may attach to an answer, lowercased. */
function answerKeys(answer) {
  const field = answer.field || {};
  return [field.ref, field.id, field.title]
    .filter(Boolean)
    .map(function (k) { return String(k).toLowerCase(); });
}

function matches(keys, patterns) {
  return keys.some(function (key) {
    return patterns.some(function (p) { return key.indexOf(p) !== -1; });
  });
}

/**
 * Extract the five lead fields from a Typeform webhook body.
 * Matches on field ref, id, or title so the form can be edited without code
 * changes, and falls back to answer type for phone/email.
 */
function parseTypeform(body) {
  const formResponse = (body && body.form_response) || {};
  const answers = formResponse.answers || [];
  const definitionFields = (formResponse.definition && formResponse.definition.fields) || [];

  // Typeform puts the question title in `definition`, not in `answers`, so
  // merge the title back onto each answer before matching.
  const titleById = {};
  definitionFields.forEach(function (f) {
    if (f.id) titleById[f.id] = f.title;
    if (f.ref) titleById[f.ref] = f.title;
  });

  const lead = { name: '', phone: '', email: '', serviceNeeded: '', problem: '' };

  answers.forEach(function (answer) {
    const field = answer.field || {};
    const withTitle = Object.assign({}, answer, {
      field: Object.assign({}, field, { title: field.title || titleById[field.id] || titleById[field.ref] || '' }),
    });
    const keys = answerKeys(withTitle);
    const value = answerValue(answer);
    if (!value) return;

    if (!lead.name && matches(keys, ['name', 'full_name', 'your name'])) {
      lead.name = value;
    } else if (!lead.phone && (answer.type === 'phone_number' || matches(keys, ['phone', 'mobile', 'cell', 'number']))) {
      lead.phone = value;
    } else if (!lead.email && (answer.type === 'email' || matches(keys, ['email', 'e-mail']))) {
      lead.email = value;
    } else if (!lead.serviceNeeded && matches(keys, ['service', 'inspection type', 'what type', 'need'])) {
      lead.serviceNeeded = value;
    } else if (!lead.problem && matches(keys, ['problem', 'issue', 'describe', 'details', 'concern', 'message', 'tell us'])) {
      lead.problem = value;
    }
  });

  // Allow a flat JSON body too (useful for testing and for other form tools).
  ['name', 'phone', 'email', 'serviceNeeded', 'problem'].forEach(function (key) {
    if (!lead[key] && body && typeof body[key] === 'string') {
      lead[key] = body[key];
    }
  });

  lead.phone = String(lead.phone || '').trim();
  lead.email = String(lead.email || '').trim();

  return lead;
}

/**
 * Verify the `Typeform-Signature` header: "sha256=" + base64 HMAC-SHA256 of the
 * raw request body, keyed with TYPEFORM_SECRET.
 * No secret configured means the check is skipped (useful for local testing).
 */
function verifyTypeformSignature(req) {
  if (!config.typeform.secret) {
    return { valid: true, skipped: true };
  }

  const header = req.get('Typeform-Signature');
  if (!header || !req.rawBody) {
    return { valid: false, reason: 'missing signature header or raw body' };
  }

  const expected =
    'sha256=' +
    crypto.createHmac('sha256', config.typeform.secret).update(req.rawBody).digest('base64');

  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { valid: false, reason: 'signature mismatch' };
  }
  return { valid: true };
}

router.post('/typeform', async function (req, res) {
  const signature = verifyTypeformSignature(req);
  if (!signature.valid) {
    console.warn('[webhook] rejected submission:', signature.reason);
    return res.status(401).json({ error: 'Invalid signature' });
  }
  if (signature.skipped) {
    console.warn('[webhook] TYPEFORM_SECRET not set — signature check skipped');
  }

  // Acknowledge immediately — Typeform retries on slow responses, and scoring
  // plus dialing takes several seconds.
  res.status(200).json({ received: true });

  try {
    const lead = parseTypeform(req.body);
    console.log('[webhook] lead received:', JSON.stringify(lead));

    const scoring = await leadScorer.scoreLead(lead);
    console.log('[webhook] scored:', scoring.tier, scoring.score, scoring.urgency);

    const shouldCall = (scoring.tier === 'Hot' || scoring.tier === 'Warm') && Boolean(lead.phone);

    let callResult = { success: false };
    if (shouldCall) {
      callResult = await twilioCall.placeOutboundCall(lead);
    } else {
      console.log('[webhook] no call placed (tier=' + scoring.tier + ', phone=' + (lead.phone ? 'yes' : 'no') + ')');
    }

    let ownerAlerted = false;
    if (scoring.tier === 'Hot') {
      const alert = await twilioCall.alertOwner(lead, scoring);
      ownerAlerted = alert.success;
    }

    const logResult = await googleSheets.logLead({
      timestamp: new Date().toISOString(),
      name: lead.name,
      phone: lead.phone,
      email: lead.email,
      serviceNeeded: lead.serviceNeeded,
      score: scoring.score,
      tier: scoring.tier,
      urgency: [scoring.timeline, scoring.urgency].filter(Boolean).join(' - '),
      estJobValue: scoring.estJobValue,
      callMade: callResult.success,
      ownerAlerted: ownerAlerted,
      // Budget and project type ride in Key Signals so the sheet keeps its
      // agreed 15 columns.
      keySignals: [
        'Budget: ' + scoring.budgetSignal,
        'Type: ' + scoring.projectType,
        scoring.keySignals,
      ].filter(Boolean).join(' | '),
      followUpNote: scoring.followUpNote,
      problem: lead.problem,
      inspectionBooked: false,
    });

    // Hand the lead (and its sheet row) to the voice flow so the call can
    // greet by name and flip "Inspection Booked" when it books.
    if (callResult.success && callResult.sid) {
      voiceRoutes.registerLead(callResult.sid, lead, {
        scoring: scoring,
        sheetRowRange: logResult.rowRange,
      });
    }
  } catch (err) {
    console.error('[webhook] processing failed:', err.stack || err.message);
  }
});

module.exports = router;
module.exports.parseTypeform = parseTypeform;
