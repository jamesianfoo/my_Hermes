'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');

let client = null;
function getClient() {
  if (!client) {
    client = new Anthropic({ apiKey: config.anthropic.apiKey });
  }
  return client;
}

const SYSTEM_PROMPT = `You qualify inbound leads for a residential home inspection business.

Score each lead 1-10 on how likely it is to become a paid inspection soon, and how valuable it is.

Consider:
- Urgency signals (under contract, closing date, inspection contingency deadline, active leak/damage)
- Service type (full buyer's inspection and new-construction phase inspections are higher value than a single radon or sewer scope add-on)
- Completeness of contact info
- Specificity of the described problem (specific = real intent, vague = tire kicker)

Return ONLY a JSON object, no prose and no markdown fences, with exactly these keys:
{
  "score": <integer 1-10>,
  "tier": "Hot" | "Warm" | "Cold",
  "urgency": "<short phrase, e.g. 'Closing in 5 days'>",
  "estJobValue": <integer US dollars>,
  "keySignals": "<comma separated short signals>",
  "followUpNote": "<one or two sentences the owner can act on>"
}

Tier must be derived from score: 8-10 = Hot, 5-7 = Warm, 1-4 = Cold.`;

function tierFromScore(score) {
  if (score >= 8) return 'Hot';
  if (score >= 5) return 'Warm';
  return 'Cold';
}

function clampScore(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 1;
  return Math.min(10, Math.max(1, n));
}

function extractJson(text) {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('No JSON object found in model response');
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

function fallbackScore(lead, reason) {
  // Never drop a lead just because scoring failed — treat it as Warm so a
  // human (or the outbound call) still touches it.
  return {
    score: 5,
    tier: 'Warm',
    urgency: 'Unknown - scoring unavailable',
    estJobValue: 400,
    keySignals: 'Automatic scoring failed',
    followUpNote: `Scoring failed (${reason}). Review this lead manually.`,
    raw: null,
  };
}

/**
 * Score a lead with Claude.
 * @param {{name?:string, phone?:string, email?:string, serviceNeeded?:string, problem?:string}} lead
 */
async function scoreLead(lead) {
  const userMessage = [
    `Name: ${lead.name || '(not provided)'}`,
    `Phone: ${lead.phone || '(not provided)'}`,
    `Email: ${lead.email || '(not provided)'}`,
    `Service needed: ${lead.serviceNeeded || '(not provided)'}`,
    `Problem / details: ${lead.problem || '(not provided)'}`,
  ].join('\n');

  let parsed;
  try {
    const response = await getClient().messages.create({
      model: config.anthropic.model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });

    const text = (response.content || [])
      .filter(function (block) { return block.type === 'text'; })
      .map(function (block) { return block.text; })
      .join('\n');

    parsed = extractJson(text);
  } catch (err) {
    console.error('[leadScorer] scoring failed:', err.message);
    return fallbackScore(lead, err.message);
  }

  const score = clampScore(parsed.score);

  return {
    score: score,
    // Tier is always recomputed from the score so the two can never disagree.
    tier: tierFromScore(score),
    urgency: parsed.urgency || 'Unspecified',
    estJobValue: Number.isFinite(Number(parsed.estJobValue)) ? Math.round(Number(parsed.estJobValue)) : 0,
    keySignals: Array.isArray(parsed.keySignals) ? parsed.keySignals.join(', ') : (parsed.keySignals || ''),
    followUpNote: parsed.followUpNote || '',
    raw: parsed,
  };
}

module.exports = { scoreLead: scoreLead, tierFromScore: tierFromScore };
