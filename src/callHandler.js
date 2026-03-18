import { twiml as TwiML } from 'twilio';
import Anthropic from '@anthropic-ai/sdk';
import { lookupPolicy, logCall, updateCallLog } from './sheets.js';
import { EXTENSIONS, GREETINGS, AFTER_HOURS_MSG } from './config.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// In-memory session store (replace with Redis for production)
const sessions = new Map();

// ─── Utility ────────────────────────────────────────────────────────────────

function isAfterHours() {
  const now = new Date();
  // ET timezone — adjust offset as needed
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/Toronto' }));
  const hour = et.getHours();
  const day = et.getDay(); // 0=Sun, 6=Sat
  return day === 0 || day === 6 || hour < 9 || hour >= 18;
}

function buildTwiMLGather(say, action, hints = '') {
  const VoiceResponse = TwiML.VoiceResponse;
  const response = new VoiceResponse();
  const gather = response.gather({
    input: 'speech',
    action,
    speechTimeout: 'auto',
    speechModel: 'phone_call',
    enhanced: true,
    hints,
    timeout: 8,
  });
  gather.say({ voice: 'Polly.Joanna', language: 'en-US' }, say);
  // Fallback if no speech detected
  response.redirect('/voice/speech?callSid=${callSid}&fallback=1');
  return response.toString();
}

// ─── Handlers ───────────────────────────────────────────────────────────────

export async function handleIncomingCall(req, res) {
  const callSid = req.body.CallSid;
  const fromNumber = req.body.From || 'Unknown';

  // Initialize session
  sessions.set(callSid, {
    callSid,
    fromNumber,
    name: null,
    policyId: null,
    reason: null,
    messages: [],
    routedTo: null,
    startTime: new Date().toISOString(),
  });

  const VoiceResponse = TwiML.VoiceResponse;
  const response = new VoiceResponse();

  if (isAfterHours()) {
    response.say({ voice: 'Polly.Joanna' }, AFTER_HOURS_MSG);
    response.record({
      action: '/voice/recording',
      maxLength: 120,
      playBeep: true,
      recordingStatusCallback: '/voice/recording',
    });
    res.type('text/xml').send(response.toString());
    return;
  }

  const gather = response.gather({
    input: 'speech',
    action: `/voice/speech?callSid=${callSid}`,
    speechTimeout: 'auto',
    speechModel: 'phone_call',
    enhanced: true,
    timeout: 8,
  });
  gather.say({ voice: 'Polly.Joanna', language: 'en-US' }, GREETINGS.welcome);

  res.type('text/xml').send(response.toString());
}

export async function handleUserSpeech(req, res) {
  const callSid = req.query.callSid || req.body.CallSid;
  const speechResult = req.body.SpeechResult || '';
  const session = sessions.get(callSid) || { callSid, messages: [], fromNumber: req.body.From };

  // Add user message to history
  session.messages.push({ role: 'user', content: speechResult });

  // Ask Claude to parse intent and drive conversation
  const aiResponse = await getAIResponse(session, speechResult);

  session.messages.push({ role: 'assistant', content: aiResponse.speech });
  sessions.set(callSid, session);

  const VoiceResponse = TwiML.VoiceResponse;
  const response = new VoiceResponse();

  if (aiResponse.action === 'collect_more') {
    // Keep gathering — need more info
    const gather = response.gather({
      input: 'speech',
      action: `/voice/speech?callSid=${callSid}`,
      speechTimeout: 'auto',
      speechModel: 'phone_call',
      enhanced: true,
      timeout: 8,
    });
    gather.say({ voice: 'Polly.Joanna', language: 'en-US' }, aiResponse.speech);

  } else if (aiResponse.action === 'transfer') {
    // Route to correct extension
    const ext = aiResponse.extension;
    const dept = EXTENSIONS[ext];

    session.routedTo = `${dept?.name || 'Unknown'} · Ext. ${ext}`;
    sessions.set(callSid, session);
    await logCall(session);

    response.say({ voice: 'Polly.Joanna' }, aiResponse.speech);
    const dial = response.dial({ timeout: 20, action: `/voice/recording?callSid=${callSid}` });
    dial.number(dept.phoneNumber);

  } else if (aiResponse.action === 'voicemail') {
    session.routedTo = 'Voicemail';
    sessions.set(callSid, session);
    await logCall(session);

    response.say({ voice: 'Polly.Joanna' }, aiResponse.speech);
    response.record({
      action: `/voice/recording?callSid=${callSid}`,
      maxLength: 120,
      playBeep: true,
    });
  }

  res.type('text/xml').send(response.toString());
}

export async function handleRecording(req, res) {
  const callSid = req.query.callSid || req.body.CallSid;
  const recordingUrl = req.body.RecordingUrl;
  const session = sessions.get(callSid);

  if (session && recordingUrl) {
    await updateCallLog(callSid, { recordingUrl, status: 'VM Left' });
  }

  const VoiceResponse = TwiML.VoiceResponse;
  const response = new VoiceResponse();
  response.say({ voice: 'Polly.Joanna' }, 'Thank you. We will get back to you shortly. Goodbye!');
  response.hangup();
  res.type('text/xml').send(response.toString());
}

// ─── Claude AI Conversation Logic ────────────────────────────────────────────

async function getAIResponse(session, latestInput) {
  // Extract policy number if present in latest input
  const policyMatch = latestInput.match(/[Ww]\d{6}/);
  if (policyMatch) {
    session.policyId = policyMatch[0].toUpperCase();
  }

  // Look up policy if we have one
  let policyContext = '';
  if (session.policyId) {
    const policy = await lookupPolicy(session.policyId);
    if (policy) {
      policyContext = `
POLICY FOUND IN CRM:
- Customer: ${policy.customer_name}
- Vehicle: ${policy.vehicle}
- Coverage: ${policy.coverage_start} to ${policy.coverage_end} (${policy.active ? 'ACTIVE' : 'EXPIRED'})
- Plan: ${policy.plan_type}
- Claim status: ${policy.claim_status}
`;
    } else {
      policyContext = `Policy ${session.policyId} was NOT found in the CRM.`;
    }
  }

  const systemPrompt = `You are the AI phone receptionist for AutoShield Warranty, a used-car warranty company in Canada.

Your job is to:
1. Warmly greet the caller and collect: their full name, phone number (confirm from caller ID or ask), reason for call, and policy number (format: W followed by 6 digits, e.g. W482031) if relevant.
2. Detect their intent and route them to the correct department.
3. Respond ONLY with valid JSON.

DEPARTMENTS & EXTENSIONS:
- Sales (Ext 101): New warranty quotes, pricing, coverage questions, renewals
- Claims/Service (Ext 102): Filing claims, claim status inquiries, service requests
- Accounting (Ext 103): Billing disputes, invoices, payment issues  
- Management (Ext 104): Escalations, complaints, rejection appeals
- Voicemail (Ext 199): When agent unavailable, caller requests voicemail

COLLECTED SO FAR:
- Name: ${session.name || 'not yet collected'}
- Policy #: ${session.policyId || 'not yet collected'}
- Reason: ${session.reason || 'not yet collected'}
${policyContext}

CONVERSATION HISTORY:
${session.messages.slice(-6).map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n')}

LATEST CALLER INPUT: "${latestInput}"

Respond with JSON only:
{
  "speech": "what you say to the caller (warm, professional, concise — under 40 words)",
  "action": "collect_more" | "transfer" | "voicemail",
  "extension": "101" | "102" | "103" | "104" | "199",
  "extracted": {
    "name": "caller name if detected, else null",
    "reason": "reason for call if clear, else null"
  },
  "confidence": 0.0-1.0
}

Rules:
- Only set action="transfer" or "voicemail" once you have name AND reason (policy # optional for Sales).
- If policy found in CRM, you may briefly confirm their details to the caller before routing.
- Keep speech under 40 words. Be warm but efficient.
- Never make up policy information.`;

  try {
    const completion = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      messages: [{ role: 'user', content: systemPrompt }],
    });

    const raw = completion.content[0].text.trim();
    const parsed = JSON.parse(raw.replace(/```json|```/g, ''));

    // Update session with extracted info
    if (parsed.extracted?.name) session.name = parsed.extracted.name;
    if (parsed.extracted?.reason) session.reason = parsed.extracted.reason;

    return parsed;
  } catch (err) {
    console.error('Claude API error:', err);
    return {
      speech: "I'm sorry, I had a little trouble understanding. Could you please repeat that?",
      action: 'collect_more',
      extension: null,
    };
  }
}
