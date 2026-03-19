import pkg from 'twilio';
const { twiml: TwiML } = pkg;
import Groq from 'groq-sdk';
import { lookupPolicy, logCall, logRequestToSheets, updateCallLog, getPlanDetails } from './sheets.js';
import { EXTENSIONS } from './config.js';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const sessions = new Map();
const sessionsByPhone = new Map();

function isAfterHours() {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Toronto' }));
  const h = et.getHours(), d = et.getDay();
  return d === 0 || d === 6 || h < 9 || h >= 17;
}

function gather(r, callSid, sayText) {
  const g = r.gather({
    input: 'speech',
    action: `/voice/speech?callSid=${callSid}`,
    speechTimeout: '3',
    speechModel: 'phone_call',
    enhanced: true,
    timeout: 12,
  });
  g.say({ voice: 'Polly.Matthew', language: 'en-US' }, sayText);
  r.redirect(`/voice/speech?callSid=${callSid}&fallback=1`);
}

function newSession(callSid, from) {
  return {
    callSid, from,
    name: null, policyId: null, vehicle: null, planType: null,
    reason: null, intent: null, callerType: null, dealerName: null,
    claimDetails: {}, messages: [], routedTo: null,
    afterHours: isAfterHours(), stage: 'identify',
    identified: false, fallbackCount: 0,
    startTime: new Date().toISOString(),
  };
}

function getSession(callSid, from) {
  let s = sessions.get(callSid);
  if (!s && from) s = sessionsByPhone.get(from);
  if (!s) s = newSession(callSid, from);
  sessions.set(callSid, s);
  if (from) sessionsByPhone.set(from, s);
  return s;
}

export async function handleIncomingCall(req, res) {
  const callSid = req.body.CallSid;
  const from = req.body.From || 'Unknown';
  const s = newSession(callSid, from);
  sessions.set(callSid, s);
  sessionsByPhone.set(from, s);
  console.log(`[CALL] Incoming: ${callSid} from ${from}`);
  const r = new TwiML.VoiceResponse();
  const greeting = s.afterHours
    ? `Thanks for calling A-Protect Warranty. Our office is closed but I can still help you check coverage, get a claim update, or take your request. Do you have your policy number handy?`
    : `Thanks for calling A-Protect Warranty. To pull up your account, could I get your policy number? It starts with W followed by six digits.`;
  gather(r, callSid, greeting);
  res.type('text/xml').send(r.toString());
}

export async function handleUserSpeech(req, res) {
  const callSid = req.query.callSid || req.body.CallSid;
  const from = req.body.From || 'Unknown';
  const speech = (req.body.SpeechResult || '').trim();
  const s = getSession(callSid, from);
  const r = new TwiML.VoiceResponse();

  console.log(`[SPEECH] ${callSid} | speech:"${speech}" | stage:${s.stage} | identified:${s.identified}`);

  if (!speech) {
    s.fallbackCount = (s.fallbackCount || 0) + 1;
    sessions.set(callSid, s);
    if (s.fallbackCount >= 2) {
      s.routedTo = 'Voicemail (no response)';
      sessions.set(callSid, s);
      await safeLogCall(s);
      r.say({ voice: 'Polly.Matthew' }, `No worries. Leave your name and number after the beep and we will call you back.`);
      r.record({ action: `/voice/recording?callSid=${callSid}`, maxLength: 120, playBeep: true });
    } else {
      gather(r, callSid, `Sorry, I did not catch that. Could you say that again?`);
    }
    return res.type('text/xml').send(r.toString());
  }

  s.fallbackCount = 0;

  const policyMatch = speech.match(/[Ww]\s*\d[\s\d]{5}/);
  if (policyMatch) {
    const clean = policyMatch[0].replace(/\s/g, '').toUpperCase();
    if (clean.match(/^W\d{6}$/)) s.policyId = clean;
  }

  s.messages.push({ role: 'user', content: speech });

  let policyData = null;
  if (s.policyId) {
    policyData = await lookupPolicy(s.policyId);
    if (policyData && !s.identified) {
      s.identified = true;
      s.vehicle = policyData.vehicle;
      s.planType = policyData.plan_type;
      if (!s.name) s.name = policyData.customer_name;
      console.log(`[IDENTIFIED] ${s.policyId} — ${policyData.customer_name} — ${policyData.plan_type}`);
    }
  }

  let planData = null;
  if (s.planType) {
    planData = await getPlanDetails(s.planType);
  }

  sessions.set(callSid, s);

  const ai = await getAIResponse(s, speech, policyData, planData);

  if (ai.extracted?.name && !s.name) s.name = ai.extracted.name;
  if (ai.extracted?.reason) s.reason = ai.extracted.reason;
  if (ai.extracted?.intent) s.intent = ai.extracted.intent;
  if (ai.extracted?.callerType) s.callerType = ai.extracted.callerType;
  if (ai.extracted?.dealerName) s.dealerName = ai.extracted.dealerName;
  if (ai.extracted?.stage) s.stage = ai.extracted.stage;
  if (ai.extracted?.claimDetails) s.claimDetails = { ...s.claimDetails, ...ai.extracted.claimDetails };

  s.messages.push({ role: 'assistant', content: ai.speech });
  sessions.set(callSid, s);

  console.log(`[AI] action:${ai.action} | ext:${ai.extension} | speech:"${ai.speech?.slice(0,80)}"`);

  if (ai.action === 'collect_more' || ai.action === 'provide_info') {
    gather(r, callSid, ai.speech);

  } else if (ai.action === 'transfer') {
    if (s.afterHours) {
      s.routedTo = 'After Hours — Request Saved';
      sessions.set(callSid, s);
      await safeLogCall(s);
      await safeLogRequest(s, ai.summary || s.reason || '');
      r.say({ voice: 'Polly.Matthew' }, `Our team is not in right now. I have saved your request and someone will follow up next business day. Anything else I can help with?`);
      gather(r, callSid, `Is there anything else I can help you with?`);
    } else {
      const dept = EXTENSIONS[ai.extension];
      const isPlaceholder = !dept?.phoneNumber || dept.phoneNumber.includes('555');
      if (isPlaceholder) {
        s.routedTo = `${dept?.name || 'Team'} — Request Saved`;
        sessions.set(callSid, s);
        await safeLogCall(s);
        await safeLogRequest(s, ai.summary || s.reason || '');
        gather(r, callSid, `I have passed your details to the ${dept?.name || 'team'} and they will call you back. Is there anything else I can help with?`);
      } else {
        s.routedTo = `${dept.name} · Ext. ${ai.extension}`;
        sessions.set(callSid, s);
        await safeLogCall(s);
        await safeLogRequest(s, ai.summary || s.reason || '');
        r.say({ voice: 'Polly.Matthew' }, ai.speech);
        const dial = r.dial({ timeout: 20, action: `/voice/recording?callSid=${callSid}` });
        dial.number(dept.phoneNumber);
      }
    }

  } else if (ai.action === 'save_request') {
    s.routedTo = s.routedTo || 'Request Saved';
    sessions.set(callSid, s);
    await safeLogCall(s);
    await safeLogRequest(s, ai.summary || s.reason || '');
    gather(r, callSid, ai.speech);

  } else if (ai.action === 'voicemail') {
    s.routedTo = `Voicemail · ${ai.department || 'General'}`;
    sessions.set(callSid, s);
    await safeLogCall(s);
    await safeLogRequest(s, ai.summary || s.reason || '');
    r.say({ voice: 'Polly.Matthew' }, ai.speech);
    r.record({ action: `/voice/recording?callSid=${callSid}`, maxLength: 120, playBeep: true });

  } else if (ai.action === 'goodbye') {
    s.routedTo = s.routedTo || 'Self-served';
    sessions.set(callSid, s);
    await safeLogCall(s);
    if (s.intent || s.reason) await safeLogRequest(s, ai.summary || s.reason || '');
    r.say({ voice: 'Polly.Matthew' }, ai.speech);
    r.hangup();

  } else {
    gather(r, callSid, ai.speech || `Sorry, could you repeat that?`);
  }

  res.type('text/xml').send(r.toString());
}

export async function handleRecording(req, res) {
  const callSid = req.query.callSid || req.body.CallSid;
  const recordingUrl = req.body.RecordingUrl;
  const s = sessions.get(callSid);
  if (s && recordingUrl) {
    await updateCallLog(callSid, { recordingUrl, status: 'VM Left' });
    console.log(`[RECORDING] ${callSid}`);
  }
  const r = new TwiML.VoiceResponse();
  r.say({ voice: 'Polly.Matthew' }, `Got it. We will be in touch soon. Have a great day!`);
  r.hangup();
  res.type('text/xml').send(r.toString());
}

async function safeLogCall(s) {
  try {
    await logCall(s);
    console.log(`[LOGGED] Call: ${s.callSid} → ${s.routedTo}`);
  } catch (e) {
    console.error(`[ERROR] logCall: ${e.message}`);
  }
}

async function safeLogRequest(s, summary) {
  try {
    await logRequestToSheets({
      timestamp: new Date().toISOString(),
      type: s.intent || 'Other',
      callerType: s.callerType || 'Unknown',
      name: s.name || '',
      phone: s.from || '',
      policyId: s.policyId || '',
      vehicle: s.vehicle || '',
      vin: '',
      department: (s.routedTo || '').split('·')[0].trim(),
      summary,
      details: JSON.stringify(s.claimDetails || {}),
      status: 'New',
      assignedTo: '',
      followUp: '',
      resolvedAt: '',
    });
    console.log(`[LOGGED] Request: ${s.intent} for ${s.name}`);
  } catch (e) {
    console.error(`[ERROR] logRequest: ${e.message}`);
  }
}

async function getAIResponse(s, latestInput, policyData, planData) {
  let policyContext = '';
  if (policyData) {
    const daysLeft = Math.floor((new Date(policyData.coverage_end) - new Date()) / (1000 * 60 * 60 * 24));
    policyContext = `
CUSTOMER ACCOUNT (already verified — use this to answer questions):
- Policy: ${policyData.policy_id}
- Name: ${policyData.customer_name}
- Vehicle: ${policyData.vehicle}
- VIN: ${policyData.vin}
- Plan: ${policyData.plan_type}
- Coverage: ${policyData.coverage_start} to ${policyData.coverage_end} — ${policyData.active ? `ACTIVE, ${daysLeft} days left` : 'EXPIRED'}
- Claim status: ${policyData.claim_status}
- Notes: ${policyData.notes || 'none'}`;
  } else if (s.policyId) {
    policyContext = `\nPolicy ${s.policyId} NOT found in system.`;
  }

  let planContext = '';
  if (planData) {
    planContext = `
PLAN COVERAGE (ONLY use this — do NOT make up coverage info):
- Plan name: ${planData.plan_name}
- Engine: ${planData.engine}
- Transmission: ${planData.transmission}
- Drivetrain: ${planData.drivetrain}
- Electrical: ${planData.electrical}
- AC/Heating: ${planData.ac_heating}
- Turbo/Supercharger: ${planData.turbo_supercharger}
- Fuel system: ${planData.fuel_system}
- Cooling system: ${planData.cooling_system}
- Brake system: ${planData.brake_system}
- Suspension: ${planData.suspension}
- Seals/Gaskets: ${planData.seals_gaskets}
- Rental car: ${planData.rental_car}
- Towing: ${planData.towing}
- Roadside: ${planData.roadside}
- Deductible: ${planData.deductible}
- Max claim: ${planData.max_claim}`;
  }

  const timeContext = s.afterHours
    ? `AFTER HOURS — office closed. Do NOT transfer to agents. Save requests or offer voicemail.`
    : `BUSINESS HOURS — can transfer to agents when ready.`;

  const history = s.messages.slice(-8).map(m =>
    `${m.role === 'user' ? 'CALLER' : 'ALEX'}: ${m.content}`
  ).join('\n');

  const prompt = `You are Alex, a knowledgeable and friendly virtual assistant for A-Protect Warranty (Canadian used-car warranty company).

${timeContext}

SESSION STATE:
- Caller name: ${s.name || 'unknown — do not ask again if already provided'}
- Policy: ${s.policyId || 'not yet provided'}
- Vehicle: ${s.vehicle || 'unknown'}
- Plan: ${s.planType || 'unknown'}
- Intent: ${s.intent || 'unknown'}
- Stage: ${s.stage}
- Identified: ${s.identified}
${policyContext}
${planContext}

CONVERSATION SO FAR:
${history}

CALLER JUST SAID: "${latestInput}"

STRICT RULES:
1. NEVER greet with the caller's name more than once — only greet at the very start
2. NEVER say "Hello James" or "Hi James" mid-conversation — just talk naturally
3. NEVER make up coverage info — ONLY use the PLAN COVERAGE section above
4. If asked about something not in the plan, say it is NOT covered
5. Do NOT re-ask for info already collected (name, policy number)
6. Keep responses SHORT — 1-3 sentences max
7. After providing info, always ask "Is there anything else I can help you with?"
8. After hours: never transfer, save request or offer voicemail

FLOW:
- Stage "identify": Get policy number. If no policy (new client or dealer) — ask their name and what they need.
- Stage "greet": Policy found — confirm vehicle and plan in ONE sentence, ask how you can help. Do not repeat this.
- Stage "intent": Understand what they need.
- Stage "claim_collect": Collect — what happened, when, mileage, at shop, symptoms.
- Stage "resolve": Summarize, offer next step (transfer / save request / voicemail).

DEPARTMENTS: Sales 101 | Claims 102 | Accounting 103 | Management 104

Reply ONLY with this JSON (no markdown):
{
  "speech": "natural response, max 3 sentences, no name greeting after first turn",
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

ACTIONS: collect_more | provide_info | transfer | voicemail | save_request | goodbye`;

  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 300,
      temperature: 0.3,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = completion.choices[0].message.content.trim().replace(/```json|```/g, '').trim();
    console.log(`[GROQ RAW] ${raw.slice(0, 200)}`);
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[GROQ ERROR] ${err.message}`);
    return {
      speech: `Sorry, could you say that again?`,
      action: 'collect_more',
      extension: null,
      department: null,
      summary: null,
      extracted: { name: null, reason: null, intent: null, callerType: null, dealerName: null, stage: null, claimDetails: null },
    };
  }
}
