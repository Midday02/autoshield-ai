import { twiml as TwiML } from 'twilio';
import Groq from 'groq-sdk';
import { lookupPolicy, logCall, updateCallLog } from './sheets.js';
import { EXTENSIONS, GREETINGS, AFTER_HOURS_MSG } from './config.js';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const sessions = new Map();

function isAfterHours() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/Toronto' }));
  const hour = et.getHours();
  const day = et.getDay();
  return day === 0 || day === 6 || hour < 9 || hour >= 18;
}

export async function handleIncomingCall(req, res) {
  const callSid = req.body.CallSid;
  const fromNumber = req.body.From || 'Unknown';
  sessions.set(callSid, {
    callSid, fromNumber, name: null, policyId: null,
    reason: null, messages: [], routedTo: null,
    startTime: new Date().toISOString(),
  });
  const VoiceResponse = TwiML.VoiceResponse;
  const response = new VoiceResponse();
  if (isAfterHours()) {
    response.say({ voice: 'Polly.Joanna' }, AFTER_HOURS_MSG);
    response.record({ action: '/voice/recording', maxLength: 120, playBeep: true });
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
  session.messages.push({ role: 'user', content: speechResult });
  const aiResponse = await getAIResponse(session, speechResult);
  session.messages.push({ role: 'assistant', content: aiResponse.speech });
  sessions.set(callSid, session);
  const VoiceResponse = TwiML.VoiceResponse;
  const response = new VoiceResponse();
  if (aiResponse.action === 'collect_more') {
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
    response.record({ action: `/voice/recording?callSid=${callSid}`, maxLength: 120, playBeep: true });
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

async function getAIResponse(session, latestInput) {
  const policyMatch = latestInput.match(/[Ww]\d{6}/);
  if (policyMatch) session.policyId = policyMatch[0].toUpperCase();
  let policyContext = '';
  if (session.policyId) {
    const policy = await lookupPolicy(session.policyId);
    if (policy) {
      policyContext = `POLICY FOUND IN CRM:
- Customer: ${policy.customer_name}
- Vehicle: ${policy.vehicle}
- Coverage: ${policy.coverage_start} to ${policy.coverage_end} (${policy.active ? 'ACTIVE' : 'EXPIRED'})
- Plan: ${policy.plan_type}
- Claim status: ${policy.claim_status}`;
    } else {
      policyContext = `Policy ${session.policyId} was NOT found in the CRM.`;
    }
  }
  const systemPrompt = `You are the AI phone receptionist for AutoShield Warranty, a used-car warranty company in Canada. Respond ONLY with valid JSON, no markdown, no explanation.

DEPARTMENTS:
- Sales (Ext 101): New quotes, pricing, renewals
- Claims (Ext 102): Filing claims, claim status
- Accounting (Ext 103): Billing, invoices, payments
- Management (Ext 104): Escalations, complaints
- Voicemail (Ext 199): After hours, unavailable

COLLECTED SO FAR:
- Name: ${session.name || 'not yet collected'}
- Policy: ${session.policyId || 'not yet collected'}
- Reason: ${session.reason || 'not yet collected'}
${policyContext}

HISTORY:
${session.messages.slice(-6).map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n')}

LATEST INPUT: "${latestInput}"

Reply with this exact JSON:
{"speech":"your reply under 40 words","action":"collect_more","extension":"101","extracted":{"name":null,"reason":null}}

Rules: action must be collect_more, transfer, or voicemail. Only transfer when you have name AND reason.`;

  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 200,
      messages: [{ role: 'user', content: systemPrompt }],
    });
    const raw = completion.choices[0].message.content.trim();
    const parsed = JSON.parse(raw.replace(/```json|```/g, ''));
    if (parsed.extracted?.name) session.name = parsed.extracted.name;
    if (parsed.extracted?.reason) session.reason = parsed.extracted.reason;
    return parsed;
  } catch (err) {
    console.error('Groq error:', err);
    return {
      speech: "I'm sorry, could you please repeat that?",
      action: 'collect_more',
      extension: null,
    };
  }
}
