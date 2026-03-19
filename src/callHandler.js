import pkg from 'twilio';
const { twiml: TwiML } = pkg;
import Groq from 'groq-sdk';
import { lookupPolicy, logCall, updateCallLog } from './sheets.js';
import { EXTENSIONS, GREETINGS, AFTER_HOURS_MSG } from './config.js';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const sessions = new Map();

function isAfterHours() {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Toronto' }));
  const h = et.getHours(), d = et.getDay();
  return d === 0 || d === 6 || h < 9 || h >= 17;
}

export async function handleIncomingCall(req, res) {
  const callSid = req.body.CallSid;
  const from = req.body.From || 'Unknown';
  sessions.set(callSid, {
    callSid, from,
    name: null, policyId: null, reason: null,
    messages: [], routedTo: null,
    startTime: new Date().toISOString(),
  });
  const r = new TwiML.VoiceResponse();
if (isAfterHours()) {
    const session = sessions.get(callSid);
    session.routedTo = 'After Hours';
    sessions.set(callSid, session);
    const gather = r.gather({
      input: 'speech dtmf',
      action: `/voice/afterhours?callSid=${callSid}`,
      speechTimeout: 'auto',
      timeout: 8,
      numDigits: 1,
    });
    gather.say({ voice: 'Polly.Joanna' },
      `Thank you for calling A-Protect Warranty. Our office is currently closed. 
       Business hours are Monday to Friday, 9 AM to 5 PM Eastern Time.
       Press 1 or say assistant to speak with our virtual assistant — available anytime for warranty status and claim updates.
       Press 2 or say voicemail to leave a message and we will call you back next business day.`
    );
    return res.type('text/xml').send(r.toString());
  }
  const gather = r.gather({
    input: 'speech',
    action: `/voice/speech?callSid=${callSid}`,
    speechTimeout: 'auto',
    speechModel: 'phone_call',
    enhanced: true,
    timeout: 8,
  });
  gather.say({ voice: 'Polly.Joanna' }, GREETINGS.welcome);
  res.type('text/xml').send(r.toString());
}

export async function handleAfterHours(req, res) {
  const callSid = req.query.callSid || req.body.CallSid;
  const speech = (req.body.SpeechResult || '').toLowerCase();
  const digit = req.body.Digits || '';
  const session = sessions.get(callSid) || {
    callSid, from: req.body.From,
    name: null, policyId: null, reason: null,
    messages: [], routedTo: null,
    startTime: new Date().toISOString(),
  };
  const r = new TwiML.VoiceResponse();
  if (digit === '1' || speech.includes('assistant') || speech.includes('one') || speech.includes('status') || speech.includes('claim') || speech.includes('warranty')) {
    session.routedTo = 'After Hours AI';
    sessions.set(callSid, session);
    const gather = r.gather({
      input: 'speech',
      action: `/voice/speech?callSid=${callSid}`,
      speechTimeout: 'auto',
      speechModel: 'phone_call',
      enhanced: true,
      timeout: 8,
    });
    gather.say({ voice: 'Polly.Joanna' },
      `Of course! I am your virtual assistant and available anytime. Could I get your name and what you would like help with today?`
    );
  } else {
    session.routedTo = 'Voicemail';
    session.reason = 'After hours voicemail';
    sessions.set(callSid, session);
    await logCall(session);
    r.say({ voice: 'Polly.Joanna' },
      `No problem. Please leave your name, phone number, and a brief message after the tone. We will call you back next business day.`
    );
    r.record({
      action: `/voice/recording?callSid=${callSid}`,
      maxLength: 120,
      playBeep: true,
    });
  }
  res.type('text/xml').send(r.toString());
}

export async function handleUserSpeech(req, res) {
  const callSid = req.query.callSid || req.body.CallSid;
  const speech = req.body.SpeechResult || '';
  const session = sessions.get(callSid) || {
    callSid, from: req.body.From,
    name: null, policyId: null, reason: null,
    messages: [], routedTo: null,
    startTime: new Date().toISOString(),
  };
  session.messages.push({ role: 'user', content: speech });
  const ai = await getAIResponse(session, speech);
  session.messages.push({ role: 'assistant', content: ai.speech });
  sessions.set(callSid, session);
  const r = new TwiML.VoiceResponse();
  if (ai.action === 'collect_more') {
    const gather = r.gather({
      input: 'speech',
      action: `/voice/speech?callSid=${callSid}`,
      speechTimeout: 'auto',
      speechModel: 'phone_call',
      enhanced: true,
      timeout: 8,
    });
    gather.say({ voice: 'Polly.Joanna' }, ai.speech);
  } else if (ai.action === 'transfer') {
    const dept = EXTENSIONS[ai.extension];
    session.routedTo = `${dept?.name || 'Unknown'} · Ext. ${ai.extension}`;
    sessions.set(callSid, session);
    await logCall(session);
    r.say({ voice: 'Polly.Joanna' }, ai.speech);
    const dial = r.dial({ timeout: 20, action: `/voice/recording?callSid=${callSid}` });
    dial.number(dept.phoneNumber);
  } else if (ai.action === 'voicemail') {
    session.routedTo = 'Voicemail';
    sessions.set(callSid, session);
    await logCall(session);
    r.say({ voice: 'Polly.Joanna' }, ai.speech);
    r.record({ action: `/voice/recording?callSid=${callSid}`, maxLength: 120, playBeep: true });
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
  r.say({ voice: 'Polly.Joanna' }, 'Thank you for calling A-Protect Warranty. Goodbye!');
  r.hangup();
  res.type('text/xml').send(r.toString());
}

async function getAIResponse(session, latestInput) {
  const policyMatch = latestInput.match(/[Ww]\d{6}/);
  if (policyMatch) session.policyId = policyMatch[0].toUpperCase();
  let policyContext = '';
  if (session.policyId) {
    const policy = await lookupPolicy(session.policyId);
    if (policy) {
      policyContext = `POLICY FOUND:
- Customer: ${policy.customer_name}
- Vehicle: ${policy.vehicle}
- Coverage: ${policy.coverage_start} to ${policy.coverage_end} (${policy.active ? 'ACTIVE' : 'EXPIRED'})
- Plan: ${policy.plan_type}
- Claim: ${policy.claim_status}`;
    } else {
      policyContext = `Policy ${session.policyId} NOT found in CRM.`;
    }
  }
  const prompt = `You are the AI phone receptionist for A-Protect Warranty, a used-car warranty company in Canada.
Collect caller name and reason, then route to correct department.
You are available 24/7 — even after hours you can check warranty status and claim updates.
Respond ONLY with valid JSON, no markdown, no explanation.

DEPARTMENTS:
- Sales Ext 101: new quotes, pricing, renewals
- Claims Ext 102: claim status, filing, service
- Accounting Ext 103: billing, invoices, payments
- Management Ext 104: escalations, complaints, appeals
- Voicemail Ext 199: caller requests voicemail

COLLECTED:
- Name: ${session.name || 'unknown'}
- Policy: ${session.policyId || 'none'}
- Reason: ${session.reason || 'unknown'}
${policyContext}

HISTORY:
${session.messages.slice(-6).map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n')}

LATEST: "${latestInput}"

Reply ONLY with this JSON:
{"speech":"under 35 words, warm","action":"collect_more","extension":"102","extracted":{"name":null,"reason":null}}

Rules:
- action = collect_more until you have BOTH name AND reason
- action = transfer when you have name + reason and know the department
- action = voicemail only if caller explicitly requests it
- If after hours and caller wants warranty/claim info — provide it directly in speech before asking if they need anything else
- Never transfer to agents after hours — use voicemail instead`;

  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 200,
      temperature: 0.3,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = completion.choices[0].message.content.trim().replace(/```json|```/g, '');
    const parsed = JSON.parse(raw);
    if (parsed.extracted?.name) session.name = parsed.extracted.name;
    if (parsed.extracted?.reason) session.reason = parsed.extracted.reason;
    return parsed;
  } catch (err) {
    console.error('Groq error:', err.message);
    return {
      speech: "I'm sorry, could you please repeat that?",
      action: 'collect_more',
      extension: null,
    };
  }
}
