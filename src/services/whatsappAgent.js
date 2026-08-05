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

/*
 * What to find out once the customer has picked a topic. Each list ends on
 * budget and timeline, which are what the scorer needs.
 */
const TOPIC_GUIDES = {
  UX: [
    'What they are designing - something new, or improving what they have',
    'Whether it is a web app, mobile app, or website',
    'Whether they have existing designs or a design system, or are starting from scratch',
    'Their rough budget range and when they want to start',
  ],
  Automation: [
    'What process they want to automate',
    'Which tools it touches - spreadsheets, CRM, email, something else',
    'Roughly how often it runs, and who does it manually today',
    'Their rough budget range and when they want to start',
  ],
  Agents: [
    'What the agent would do - customer support, sales follow-up, internal Q&A',
    'Where it should live - their website, WhatsApp, phone, or an internal tool',
    'What systems it would need access to',
    'Their rough budget range and when they want to start',
  ],
};

function topicSection(topic) {
  const guide = TOPIC_GUIDES[topic];
  if (!guide) return '';
  return `\nThey have chosen the ${topic} topic. Work through these, one question per message,
in this order, skipping anything they have already told you:
${guide.map(function (g, i) { return (i + 1) + '. ' + g; }).join('\n')}\n`;
}

function systemPrompt(topic) {
  return `You are ${config.business.whatsappAgentName}, the scheduling assistant for ${config.business.name},
a design consultancy doing UX design, automation / AI agent builds, and general design work. You are
chatting with an inbound enquiry over WhatsApp.

If they ask who you are, say you are ${config.business.whatsappAgentName}, the scheduling assistant for
${config.business.name}. Do not claim to be human, and do not claim to be one of the designers.
Introduce yourself by name in your first message.

Your job, in this order:
1. Find out what they want built or designed.
2. Find out their budget and when they want to start.
3. Get their name AND their email. The email is required to book - if they hesitate, explain
   you need it to send the calendar invite. Do not set readyToBook until you have it.
4. Once you know the project, budget and timeline, offer to book a short call.
${topicSection(topic)}

Style: warm, brief, human. One or two sentences per message, and at most one question at a time.
This is WhatsApp, not email - no greetings like "Dear", no bullet lists, no signatures. Never
invent availability, prices, or promises about what the studio will deliver. If they ask something
you do not know, say you will check with the team.

Return ONLY a JSON object, no prose and no markdown fences:
{
  "reply": "<what to send them next>",
  "name": "<their name if known, else empty string>",
  "email": "<their email if given, else empty string>",
  "serviceNeeded": "<UX / Automation / General / mixed, or empty string>",
  "projectSummary": "<one line describing what they want, or empty string>",
  "budgetSignal": "High" | "Mid" | "Low" | "Unknown",
  "timeline": "Immediate" | "TimeX" | "Unknown",
  "readyToBook": <true once you know the project, budget and timeline AND they want a call>,
  "preferredTime": "<what they said about timing for the call, e.g. 'tomorrow at 11', else empty>",
  "confirmsOffer": <true only when replying yes to a specific time you already offered>
}

When readyToBook is true, keep "reply" to a short lead-in like "Great - let me find a time." The
system appends the actual slot, so do NOT state a day or time yourself.`;
}

const REPLY_TOOL = {
  name: 'send_reply',
  description: 'Send the next WhatsApp message and record what the conversation has revealed.',
  input_schema: {
    type: 'object',
    properties: {
      reply: { type: 'string', description: 'The message to send. One or two sentences.' },
      name: { type: 'string', description: "Customer's name if known, else empty string" },
      email: { type: 'string', description: 'Their email if given, else empty string' },
      serviceNeeded: { type: 'string', description: 'UX / Automation / General / mixed, or empty' },
      projectSummary: { type: 'string', description: 'One line on what they want, or empty' },
      budgetSignal: { type: 'string', enum: ['High', 'Mid', 'Low', 'Unknown'] },
      timeline: { type: 'string', enum: ['Immediate', 'TimeX', 'Unknown'] },
      readyToBook: { type: 'boolean', description: 'True once project, budget and timeline are known AND they want a call' },
      preferredTime: { type: 'string', description: "What they said about timing, e.g. 'tomorrow at 11', else empty" },
      confirmsOffer: { type: 'boolean', description: 'True only when saying yes to a time already offered' },
    },
    required: ['reply', 'budgetSignal', 'timeline', 'readyToBook', 'confirmsOffer'],
  },
};

function extractJson(text) {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('No JSON object in model response');
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

/**
 * Produce the next WhatsApp reply plus whatever the conversation has revealed.
 * @param {Array<{role:string, content:string}>} history full conversation so far
 */
async function nextTurn(history, topic) {
  try {
    const messages = history.map(function (m) {
      return { role: m.role === 'agent' ? 'assistant' : 'user', content: m.content };
    });

    // The history is full of plain-text assistant turns, so asking for JSON in
    // the prompt alone makes the model answer in prose. Forcing a tool call
    // guarantees the shape.
    const response = await getClient().messages.create({
      model: config.anthropic.model,
      max_tokens: 1024,
      system: systemPrompt(topic),
      messages: messages,
      tools: [REPLY_TOOL],
      tool_choice: { type: 'tool', name: REPLY_TOOL.name },
    });

    const toolUse = (response.content || []).find(function (b) { return b.type === 'tool_use'; });
    if (!toolUse) throw new Error('Model did not return the reply tool');
    const parsed = toolUse.input || {};
    return {
      reply: parsed.reply || 'Sorry, could you say that again?',
      name: parsed.name || '',
      email: parsed.email || '',
      serviceNeeded: parsed.serviceNeeded || '',
      projectSummary: parsed.projectSummary || '',
      budgetSignal: parsed.budgetSignal || 'Unknown',
      timeline: parsed.timeline || 'Unknown',
      readyToBook: parsed.readyToBook === true,
      preferredTime: parsed.preferredTime || '',
      confirmsOffer: parsed.confirmsOffer === true,
      failed: false,
    };
  } catch (err) {
    console.error('[whatsappAgent] turn failed:', err.message);
    return {
      reply: 'Sorry, I had a technical hiccup there. Could you send that again?',
      name: '', email: '', serviceNeeded: '', projectSummary: '',
      budgetSignal: 'Unknown', timeline: 'Unknown',
      readyToBook: false, preferredTime: '', confirmsOffer: false,
      failed: true,
    };
  }
}

module.exports = { nextTurn: nextTurn, TOPIC_GUIDES: TOPIC_GUIDES };
