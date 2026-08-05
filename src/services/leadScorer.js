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

const SYSTEM_PROMPT = `You qualify inbound leads for a design consultancy that does UX design,
automation / AI agent builds, and general design work.

Score each lead 1-10 on how likely it is to become paid work soon, and how valuable it is.
Judge it on three dimensions:

1. BUDGET SIGNAL - High / Mid / Low
   High: names a real budget, mentions funding, an existing agency or contractor spend, a
         company with obvious scale, or a business-critical project.
   Mid:  a real company with a real project but no budget stated.
   Low:  student, personal project, "just exploring", asking for free or spec work, or
         anything suggesting no money behind it.
   When nothing indicates budget either way, use Mid rather than guessing Low.

2. PROJECT TYPE - UX / Automation / General
   Automation: AI agents, workflow automation, integrations, internal tooling. Highest value,
               usually the largest and most technical engagements.
   UX:         product design, app or web UX, design systems, research. High value.
   General:    branding, marketing collateral, one-off graphics, small edits. Lowest value.
   Pick the dominant one if the lead mentions several.

3. TIMELINE - Immediate / TimeX
   Immediate: starting now, a deadline, a launch date, "as soon as possible", actively
              blocked on this work.
   TimeX:     later, next quarter, "planning ahead", exploratory, or no timeline given.

How the three combine into the score:
- High budget + Immediate is the strongest combination regardless of project type.
- Automation and UX outrank General at the same budget and timeline.
- Low budget caps the score at 4 (Cold) even when the timeline is Immediate.
- TimeX with High budget is still worth a call - it lands mid-to-high Warm.
- Vague, generic, or obviously templated enquiries score low no matter what they claim.

Return ONLY a JSON object, no prose and no markdown fences, with exactly these keys:
{
  "score": <integer 1-10>,
  "tier": "Hot" | "Warm" | "Cold",
  "budgetSignal": "High" | "Mid" | "Low",
  "projectType": "UX" | "Automation" | "General",
  "timeline": "Immediate" | "TimeX",
  "urgency": "<short phrase, e.g. 'Launching in 3 weeks'>",
  "estJobValue": <integer US dollars for the likely engagement>,
  "keySignals": "<comma separated short signals>",
  "followUpNote": "<one or two sentences the owner can act on>"
}

Tier must be derived from score: 8-10 = Hot, 5-7 = Warm, 1-4 = Cold.`;

function tierFromScore(score) {
  if (score >= 8) return 'Hot';
  if (score >= 5) return 'Warm';
  return 'Cold';
}

/** Coerce a model-supplied enum to one of the allowed values, case-insensitively. */
function oneOf(value, allowed, fallback) {
  const wanted = String(value || '').trim().toLowerCase();
  const hit = allowed.find(function (a) { return a.toLowerCase() === wanted; });
  return hit || fallback;
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
    budgetSignal: 'Mid',
    projectType: 'General',
    timeline: 'TimeX',
    urgency: 'Unknown - scoring unavailable',
    estJobValue: 0,
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
  const parts = [
    `Name: ${lead.name || '(not provided)'}`,
    `Phone: ${lead.phone || '(not provided)'}`,
    `Email: ${lead.email || '(not provided)'}`,
    `Service needed: ${lead.serviceNeeded || '(not provided)'}`,
    `Problem / details: ${lead.problem || '(not provided)'}`,
  ];

  // The full form transcript. Budget and timeline questions usually live here
  // rather than in the five named fields, so this is what the three dimensions
  // are actually judged on.
  if (lead.details) {
    parts.push('', 'Full form submission, every question and answer:', lead.details);
  }

  const userMessage = parts.join('\n');

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

  let score = clampScore(parsed.score);

  const budgetSignal = oneOf(parsed.budgetSignal, ['High', 'Mid', 'Low'], 'Mid');
  const projectType = oneOf(parsed.projectType, ['UX', 'Automation', 'General'], 'General');
  const timeline = oneOf(parsed.timeline, ['Immediate', 'TimeX'], 'TimeX');

  // Enforce the Low-budget cap in code rather than trusting the model to
  // remember it: a Low-budget lead must never be called.
  if (budgetSignal === 'Low' && score > 4) {
    score = 4;
  }

  return {
    score: score,
    // Tier is always recomputed from the score so the two can never disagree.
    tier: tierFromScore(score),
    budgetSignal: budgetSignal,
    projectType: projectType,
    timeline: timeline,
    urgency: parsed.urgency || 'Unspecified',
    estJobValue: Number.isFinite(Number(parsed.estJobValue)) ? Math.round(Number(parsed.estJobValue)) : 0,
    keySignals: Array.isArray(parsed.keySignals) ? parsed.keySignals.join(', ') : (parsed.keySignals || ''),
    followUpNote: parsed.followUpNote || '',
    raw: parsed,
  };
}

module.exports = { scoreLead: scoreLead, tierFromScore: tierFromScore };
