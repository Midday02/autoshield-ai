import pkg from 'twilio';
const { twiml: TwiML } = pkg;
import Groq from 'groq-sdk';
import { lookupPolicy, logCall, logRequest, updateCallLog } from './sheets.js';
import { EXTENSIONS } from './config.js';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const sessions = new Map();

function isAfterHours() {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Toronto' }));
  const h = et.getHours(), d = et.getDay();
  return d === 0 || d === 6 || h < 9 || h >= 17;
}

function gather(r, callSid, sayText) {
  const g = r.gather({
    input: 'speech',
    action: `/voice/speech?callSid=${callSid}`,
    speechTimeout: '2',
    speechModel: 'phone_call',
    enhanced: true,
    timeout: 10,
  });
  g.say({ voice: 'Polly.Joanna', language: 'en-US' }, sayText);
  r.redirect(`/voice/speech?callSid=${callSid}&fallback=1`);
}

export async function handleIncomingCall(req, res) {
  const callSid = req.body.CallSid;
  const from = req.body.From || 'Unknown';
  const afterHours = isAfterHours();

  sessions.set(callSid, {
    callSid, from,
    callerType: null,
    name: null,
    policyId: null,
    vehicle: null,
    reason: null,
    intent: null,
    claimDetails: {},
    dealerName: null,
    messages: [],
    routedTo: null,
    afterHours,
    stage: 'identify',
    startTime: new Date().toISOString(),
  });

  const r = new TwiML.VoiceResponse();
  const greeting = afterHours
    ? `Hi, thank you for calling A-Protect Warranty! Our office is closed right now, but I'm Alex, your virtual assistant — available anytime. Do you have a policy number or the last 6 digits of your VIN so I can pull up your account?`
    : `Hi, thank you for calling A-Protect Warranty! I'm Alex, your virtual assistant. Do you have a policy number or the last 6 digits of your VIN handy so I can pull up your account?`;

  gather(r, callSid, greeting);
  res.type('text/xml').send(r.toString());
}

export async function handleUserSpeech(req, res) {
  const callSid = req.query.callSid || req.body.CallSid;
  const speech = req.body.SpeechResult || '';
  const fallback = req.query.fallback === '1';

  let session = sessions.get(callSid);
  if (!session) {
    session = {
      callSid, from: req.body.From || 'Unknown',
      callerType: null, name: null, policyId: null,
      vehicle: null, reason: null, intent: null,
      claimDetails: {}, dealerName: null,
      messages: [], routedTo: null,
      afterHours: isAfterHours(),
      stage: 'identify',
      startTime: new Date().toISOString(),
    };
    sessions.set(callSid, session);
  }

  const r = new TwiML.VoiceResponse();

  if (!speech && fallback) {
    session.routedTo = session.routedTo || 'Voicemail';
    sessions.set(callSid, session);
    await logCall(session);
    r.say({ voice: 'Polly.Joanna' },
      `I didn't quite catch that. No worries — please leave your name and number after the beep and we'll call you back.`
    );
    r.record({ action: `/voice/recording?callSid=${callSid}`, maxLength: 120, playBeep: true });
    return res.type('text/xml').send(r.toString());
  }

  if (speech) session.messages.push({ role: 'user', content: speech });

  const policyMatch = speech.match(/[Ww]\d{6}/);
  if (policyMatch) session.policyId = policyMatch[0].toUpperCase();

  const vinMatch = speech.replace(/\s/g, '').match(/[A-HJ-NPR-Z0-9]{6}$/i);
  if (vinMatch && !session.policyId) session.vinFragment = vinMatch[0].toUpperCase();

  let policyData = null;
  if (session.policyId) {
    policyData = await lookupPolicy(session.policyId);
    if (policyData) {
      session.vehicle = policyData.vehicle;
      session.callerType = 'client';
    }
  }

  sessions.set(callSid, session);

  const ai = await getAIResponse(session, speech, policyData);

  if (ai.extracted?.name) session.name = ai.extracted.name;
  if (ai.extracted?.reason) session.reason = ai.extracted.reason;
  if (ai.extracted?.intent) session.intent = ai.extracted.intent;
  if (ai.extracted?.callerType) session.callerType = ai.extracted.callerType;
  if (ai.extracted?.dealerName) session.dealerName = ai.extracted.dealerName;
  if (ai.extracted?.claimDetails) session.claimDetails = { ...session.claimDetails, ...ai.extracted.claimDetails };
  if (ai.extracted?.stage) session.stage = ai.extracted.stage;

  session.messages.push({ role: 'assistant', content: ai.speech });
  sessions.set(callSid, session);

  if (ai.action === 'collect_more' || ai.action === 'provide_info') {
    gather(r, callSid, ai.speech);

  } else if (ai.action === 'transfer') {
    const dept = EXTENSIONS[ai.extension];
    session.routedTo = `${dept?.name || 'Unknown'} · Ext. ${ai.extension}`;
    sessions.set(callSid, session);
    await logCall(session);
    await logRequest(session, ai.summary || '');
    r.say({ voice: 'Polly.Joanna' }, ai.speech);
    const dial = r.dial({ timeout: 20, action: `/voice/recording?callSid=${callSid}` });
    dial.number(dept.phoneNumber);

  } else if (ai.action === 'voicemail') {
    session.routedTo = `Voicemail · ${ai.department || 'General'}`;
    sessions.set(callSid, session);
    await logCall(session);
    await logRequest(session, ai.summary || '');
    r.say({ voice: 'Polly.Joanna' }, ai.speech);
    r.record({ action: `/voice/recording?callSid=${callSid}`, maxLength: 120, playBeep: true });

  } else if (ai.action === 'save_request') {
    session.routedTo = 'Request Saved';
    sessions.set(callSid, session);
    await logCall(session);
    await logRequest(session, ai.summary || '');
    gather(r, callSid, ai.speech);

  } else if (ai.action === 'goodbye') {
    session.routedTo = session.routedTo || 'Self-served';
    sessions.set(callSid, session);
    await logCall(session);
    if (session.intent) await logRequest(session, ai.summary || '');
    r.say({ voice: 'Polly.Joanna' }, ai.speech);
    r.hangup();
  }

  res.type('text/xml').send(r.toString());
}

export async function handleRecording(req, res) {
  const callSid = req.query.callSid || req.body.CallSid;
  const recordingUrl = req.body.RecordingUrl;
  const session = sessions.get(callSid);
  if (session && recordingUrl) {
    await updateCallLog(callSid, { recordingUrl, status: 'VM Left' });
  }
  const r = new TwiML.VoiceResponse();
  r.say({ voice: 'Polly.Joanna' }, `Got it, thank you! We'll be in touch soon. Have a great day!`);
  r.hangup();
  res.type('text/xml').send(r.toString());
}
async function getAIResponse(session, latestInput, policyData) {
  const afterHours = session.afterHours;

  let policyContext = '';
  if (policyData) {
    const daysLeft = Math.floor((new Date(policyData.coverage_end) - new Date()) / (1000 * 60 * 60 * 24));
    policyContext = `
CUSTOMER IDENTIFIED:
- Policy: ${policyData.policy_id}
- Name: ${policyData.customer_name}
- Vehicle: ${policyData.vehicle}
- VIN: ${policyData.vin}
- Plan: ${policyData.plan_type}
- Coverage: ${policyData.coverage_start} to ${policyData.coverage_end} — ${policyData.active ? `ACTIVE, ${daysLeft} days remaining` : 'EXPIRED'}
- Claim status: ${policyData.claim_status}
- Notes: ${policyData.notes || 'none'}`;
  } else if (session.policyId) {
    policyContext = `Policy ${session.policyId} NOT found in system.`;
  }

  const claimContext = Object.keys(session.claimDetails).length > 0
    ? `\nCLAIM INFO COLLECTED SO FAR: ${JSON.stringify(session.claimDetails)}`
    : '';

  const timeContext = afterHours
    ? `AFTER HOURS — office closed. Cannot transfer to agents. Options: save request as text file for team, or direct to specific voicemail.`
    : `BUSINESS HOURS — can transfer to agents.`;

  const prompt = `You are Alex, a professional and warm virtual assistant for A-Protect Warranty (Canadian used-car warranty company).

${timeContext}

CURRENT SESSION:
- Stage: ${session.stage || 'identify'}
- Caller type: ${session.callerType || 'unknown'}
- Name: ${session.name || 'unknown'}
- Policy: ${session.policyId || 'none'}
- Vehicle: ${session.vehicle || 'unknown'}
- Intent: ${session.intent || 'unknown'}
- Dealer name: ${session.dealerName || 'n/a'}
${policyContext}
${claimContext}

CONVERSATION:
${session.messages.slice(-10).map(m => `${m.role === 'user' ? 'CALLER' : 'ALEX'}: ${m.content}`).join('\n')}

CALLER JUST SAID: "${latestInput}"

FLOW LOGIC:
Stage "identify": Ask for policy number OR last 6 VIN digits + name. If they say they're a dealer or new customer — skip policy lookup.
Stage "greet": Policy found — greet by name, confirm vehicle and plan, say coverage status naturally, ask how you can help.
Stage "intent": Understand what they need. Categories: Claim (open/status), Coverage Question, Billing, New Policy, Dealer Inquiry, Escalation, Other.
Stage "claim_collect": Collect claim info — what happened, when did it start, current mileage, is vehicle at shop yet, any warning lights.
Stage "new_policy": Collect vehicle info — year/make/model, mileage, how long owned. Then explain we'll have Sales follow up.
Stage "dealer": Collect dealership name, contact name, which department they need.
Stage "resolve": You have enough info — summarize, ask if they want agent (transfer), request logged (save_request), or voicemail. After hours: save_request or voicemail only.
Stage "done": Wrap up warmly.

DEPARTMENTS: Sales 101 | Claims 102 | Accounting 103 | Management 104

PERSONALITY: Warm, conversational, natural. Short sentences. Use contractions. Never robotic. Max 2-3 sentences per response. After providing info ALWAYS ask a follow-up — never just stop talking.

IMPORTANT RULES:
- After identifying customer → ALWAYS greet by name and confirm their vehicle before asking intent
- Never say "I understand" or "Certainly" 
- After hours → NEVER transfer, offer save_request or voicemail instead
- When claim info is complete → offer to log it as a request for the Claims team
- New policy inquiry → collect vehicle details, log as Sales request
- If caller says goodbye/thanks/all good → use action goodbye
- Always end with a question unless saying goodbye

Reply ONLY with this JSON (no markdown, no other text):
{
  "speech": "Alex reply — natural, warm, max 40 words",
  "action": "collect_more",
  "extension": null,
  "department": null,
  "summary": null,
  "extracted": {
    "name": null,
    "reason": null,
    "intent": null,
    "callerType": null,
    "dealerName": null,
    "stage": null,
    "claimDetails": null
  }
}

ACTION VALUES:
- collect_more: still gathering info or continuing conversation
- provide_info: giving warranty/claim info, then asking follow-up
- transfer: connecting to agent (business hours only, need name + reason)
- voicemail: directing to specific department voicemail
- save_request: logging structured request to Sheets, confirming to caller
- goodbye: caller is done, wrap up warmly

CLAIM DETAILS to collect (claimDetails object):
- issue: what went wrong
- when_started: how long ago
- mileage: current km
- at_shop: yes/no
- warning_lights: any dashboard lights
- symptoms: sounds, smells, behaviour`;

  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 300,
      temperature: 0.35,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = completion.choices[0].message.content.trim().replace(/```json|```/g, '').trim();
    return JSON.parse(raw);
  } catch (err) {
    console.error('Groq error:', err.message);
    return {
      speech: "Sorry about that, could you say that again?",
      action: 'collect_more',
      extension: null,
      department: null,
      summary: null,
      extracted: { name: null, reason: null, intent: null, callerType: null, dealerName: null, stage: null, claimDetails: null },
    };
  }
}
async function logRequest(session, summary) {
  try {
    const { logRequestToSheets } = await import('./sheets.js');
    await logRequestToSheets({
      timestamp: new Date().toISOString(),
      type: session.intent || 'Other',
      callerType: session.callerType || 'Unknown',
      name: session.name || '',
      phone: session.from || '',
      policyId: session.policyId || '',
      vehicle: session.vehicle || '',
      department: session.routedTo?.split('·')[0]?.trim() || '',
      summary: summary || session.reason || '',
      details: JSON.stringify(session.claimDetails || {}),
      status: 'New',
      assignedTo: '',
      followUp: '',
      resolvedAt: '',
    });
  } catch (e) {
    console.error('logRequest error:', e.message);
  }
}
