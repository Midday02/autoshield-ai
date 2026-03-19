import pkg from 'twilio';
const { twiml: TwiML } = pkg;
import Groq from 'groq-sdk';
import { lookupPolicy, logCall, updateCallLog } from './sheets.js';
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
    name: null, policyId: null, reason: null,
    messages: [], routedTo: null,
    afterHours,
    startTime: new Date().toISOString(),
  });
 
  const r = new TwiML.VoiceResponse();
  const greeting = afterHours
    ? `Hi, thanks for calling A-Protect Warranty! Our office is closed right now, but I'm your virtual assistant and I'm here to help anytime. I can check your warranty status, update you on a claim, or take down your info. What can I do for you?`
    : `Hi, thanks for calling A-Protect Warranty! I'm your virtual assistant. I can help you check your warranty, connect you with our team, or answer any questions. What can I help you with today?`;
 
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
      name: null, policyId: null, reason: null,
      messages: [], routedTo: null,
      afterHours: isAfterHours(),
      startTime: new Date().toISOString(),
    };
    sessions.set(callSid, session);
  }
 
  const r = new TwiML.VoiceResponse();
 
  if (!speech && fallback) {
    session.routedTo = 'Voicemail';
    sessions.set(callSid, session);
    await logCall(session);
    r.say({ voice: 'Polly.Joanna' },
      `I didn't catch that. No worries — please leave your name and number after the beep and we'll call you back.`
    );
    r.record({ action: `/voice/recording?callSid=${callSid}`, maxLength: 120, playBeep: true });
    return res.type('text/xml').send(r.toString());
  }
 
  if (speech) session.messages.push({ role: 'user', content: speech });
 
  const policyMatch = speech.match(/[Ww]\d{6}/);
  if (policyMatch) session.policyId = policyMatch[0].toUpperCase();
 
  let policyData = null;
  if (session.policyId) policyData = await lookupPolicy(session.policyId);
 
  sessions.set(callSid, session);
 
  const ai = await getAIResponse(session, speech, policyData);
 
  if (ai.extracted?.name) session.name = ai.extracted.name;
  if (ai.extracted?.reason) session.reason = ai.extracted.reason;
  session.messages.push({ role: 'assistant', content: ai.speech });
  sessions.set(callSid, session);
 
  if (ai.action === 'collect_more' || ai.action === 'provide_info') {
    gather(r, callSid, ai.speech);
 
  } else if (ai.action === 'transfer') {
    if (session.afterHours) {
      session.routedTo = 'After Hours Voicemail';
      sessions.set(callSid, session);
      await logCall(session);
      r.say({ voice: 'Polly.Joanna' },
        `Our team isn't available right now but I've noted everything. Please leave a quick message after the beep and someone will call you back first thing tomorrow.`
      );
      r.record({ action: `/voice/recording?callSid=${callSid}`, maxLength: 120, playBeep: true });
    } else {
      const dept = EXTENSIONS[ai.extension];
      session.routedTo = `${dept?.name || 'Unknown'} · Ext. ${ai.extension}`;
      sessions.set(callSid, session);
      await logCall(session);
      r.say({ voice: 'Polly.Joanna' }, ai.speech);
      const dial = r.dial({ timeout: 20, action: `/voice/recording?callSid=${callSid}` });
      dial.number(dept.phoneNumber);
    }
 
  } else if (ai.action === 'voicemail') {
    session.routedTo = 'Voicemail';
    sessions.set(callSid, session);
    await logCall(session);
    r.say({ voice: 'Polly.Joanna' }, ai.speech);
    r.record({ action: `/voice/recording?callSid=${callSid}`, maxLength: 120, playBeep: true });
 
  } else if (ai.action === 'goodbye') {
    session.routedTo = session.routedTo || 'Self-served';
    sessions.set(callSid, session);
    await logCall(session);
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
  r.say({ voice: 'Polly.Joanna' }, `Got it, thanks! We'll be in touch soon. Have a great day!`);
  r.hangup();
  res.type('text/xml').send(r.toString());
}
 
async function getAIResponse(session, latestInput, policyData) {
  const afterHours = session.afterHours;
 
  let policyContext = '';
  if (policyData) {
    const daysLeft = Math.floor((new Date(policyData.coverage_end) - new Date()) / (1000 * 60 * 60 * 24));
    policyContext = `
POLICY DATA — use this to answer the caller directly:
- Policy: ${policyData.policy_id}
- Customer: ${policyData.customer_name}
- Vehicle: ${policyData.vehicle}
- Plan: ${policyData.plan_type}
- Coverage: ${policyData.coverage_start} to ${policyData.coverage_end} — ${policyData.active ? `ACTIVE, ${daysLeft} days left` : 'EXPIRED'}
- Claim status: ${policyData.claim_status}
${policyData.notes ? `- Notes: ${policyData.notes}` : ''}`;
  } else if (session.policyId) {
    policyContext = `Policy ${session.policyId} was NOT found in our system.`;
  }
 
  const timeContext = afterHours
    ? `AFTER HOURS — office is closed. Do NOT use action=transfer. Provide info directly or offer voicemail.`
    : `BUSINESS HOURS — office is open. Can transfer to agents when ready.`;
 
  const prompt = `You are Alex, a friendly virtual assistant for A-Protect Warranty (Canadian used-car warranty company).
 
${timeContext}
 
PERSONALITY: Warm and conversational — like a real helpful person, not a robot. Short responses, max 2-3 sentences. Use contractions. Never say "Certainly" or "I understand".
 
WHAT YOU CAN DO:
- Check warranty status and coverage using policy data below
- Explain claim status in plain English
- Connect to agents (business hours): Sales 101, Claims 102, Accounting 103, Management 104
- Take voicemail when needed
 
COLLECTED:
- Name: ${session.name || 'not yet'}
- Policy: ${session.policyId || 'not yet'}
- Reason: ${session.reason || 'not yet'}
${policyContext}
 
CONVERSATION:
${session.messages.slice(-8).map(m => `${m.role === 'user' ? 'CALLER' : 'ALEX'}: ${m.content}`).join('\n')}
 
CALLER: "${latestInput}"
 
Reply ONLY with JSON, no markdown:
{"speech":"Alex reply — warm, natural, under 40 words","action":"collect_more","extension":null,"extracted":{"name":null,"reason":null}}
 
ACTIONS: collect_more | provide_info | transfer | voicemail | goodbye
- provide_info: when you have policy data to share, read it out then ask if they need more help
- transfer: only business hours + have name + reason
- after hours: never transfer, use provide_info or voicemail
- goodbye: caller is satisfied and done`;
 
  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 250,
      temperature: 0.4,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = completion.choices[0].message.content.trim().replace(/```json|```/g, '').trim();
    return JSON.parse(raw);
  } catch (err) {
    console.error('Groq error:', err.message);
    return {
      speech: "Sorry about that, I missed what you said. Could you say that again?",
      action: 'collect_more',
      extension: null,
      extracted: { name: null, reason: null },
    };
  }
}
 
