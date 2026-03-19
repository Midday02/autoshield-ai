import pkg from 'twilio';
const { twiml: TwiML } = pkg;
import Groq from 'groq-sdk';
import { lookupPolicy, lookupPolicyByVin, logCall, logRequestToSheets, updateCallLog, getPlanDetails, getAllPlans } from './sheets.js';
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

// Convert spoken numbers to digits: "W four eight two zero three one" -> "W482031"
function normalizeSpeech(text) {
  const numWords = {
    zero:'0',one:'1',two:'2',three:'3',four:'4',
    five:'5',six:'6',seven:'7',eight:'8',nine:'9',oh:'0',nought:'0'
  };
  let s = text
    .replace(/\bdouble\s+you\b/gi, 'W')
    .replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|oh|nought)\b/gi,
      m => numWords[m.toLowerCase()] || m);
  s = s.replace(/[Ww][\s0-9]{6,}/g, m => m.replace(/\s/g, ''));
  return s;
}

function newSession(callSid, from) {
  return {
    callSid, from,
    name: null, policyId: null, vehicle: null, planType: null,
    reason: null, intent: null, callerType: null, dealerName: null,
    claimDetails: {}, messages: [], routedTo: null,
    afterHours: isAfterHours(), stage: 'identify',
    identified: false, fallbackCount: 0, logged: false,
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
    ? `Thanks for calling A-Protect Warranty. Our office is closed but I can still help — check coverage, claim updates, or take your request. Do you have your policy number?`
    : `Thanks for calling A-Protect Warranty. Could I get your policy number to pull up your account? It starts with W followed by six digits.`;
  gather(r, callSid, greeting);
  res.type('text/xml').send(r.toString());
}

export async function handleUserSpeech(req, res) {
  const callSid = req.query.callSid || req.body.CallSid;
  const from = req.body.From || 'Unknown';
  const rawSpeech = (req.body.SpeechResult || '').trim();
  const speech = normalizeSpeech(rawSpeech);
  const s = getSession(callSid, from);
  const r = new TwiML.VoiceResponse();

  console.log(`[SPEECH] raw:"${rawSpeech}" | normalized:"${speech}" | stage:${s.stage}`);

  if (!speech) {
    s.fallbackCount = (s.fallbackCount || 0) + 1;
    sessions.set(callSid, s);
    if (s.fallbackCount >= 2) {
      s.routedTo = 'Voicemail (no response)';
      sessions.set(callSid, s);
      await safeLogCall(s);
      await safeLogRequest(s, 'No response from caller');
      r.say({ voice: 'Polly.Matthew' }, `No worries. Leave your name and number after the beep and we will call you back.`);
      r.record({ action: `/voice/recording?callSid=${callSid}`, maxLength: 120, playBeep: true });
    } else {
      gather(r, callSid, `Sorry, I did not catch that. Could you say that again?`);
    }
    return res.type('text/xml').send(r.toString());
  }

  s.fallbackCount = 0;

  // Extract policy number W######
  const policyMatch = speech.match(/[Ww]\d{6}/);
  if (policyMatch) {
    s.policyId = policyMatch[0].toUpperCase();
    console.log(`[POLICY EXTRACTED] ${s.policyId}`);
  }

  // Extract last 6 VIN digits
  const vinMatch = speech.replace(/\s/g, '').match(/[A-HJ-NPR-Z0-9]{6}$/i);
  if (vinMatch && !s.policyId && !s.identified) s.vinFragment = vinMatch[0].toUpperCase();

  // Store original speech in history
  s.messages.push({ role: 'user', content: rawSpeech });

  // Policy lookup
  let policyData = null;
  if (s.policyId && !s.identified) {
    policyData = await lookupPolicy(s.policyId);
    if (policyData) {
      s.identified = true;
      s.vehicle = policyData.vehicle;
      s.planType = policyData.plan_type;
      if (!s.name) s.name = policyData.customer_name;
      s.stage = 'greet';
      console.log(`[IDENTIFIED] ${s.policyId} — ${policyData.customer_name}`);
    } else {
      console.log(`[NOT FOUND] ${s.policyId}`);
    }
  } else if (s.vinFragment && !s.identified) {
    policyData = await lookupPolicyByVin(s.vinFragment);
    if (policyData) {
      s.identified = true;
      s.policyId = policyData.policy_id;
      s.vehicle = policyData.vehicle;
      s.planType = policyData.plan_type;
      if (!s.name) s.name = policyData.customer_name;
      s.stage = 'greet';
      console.log(`[IDENTIFIED by VIN] ${s.policyId} — ${policyData.customer_name}`);
    }
  } else if (s.policyId && s.identified) {
    policyData = await lookupPolicy(s.policyId);
  }

  let planData = null;
  if (s.planType) planData = await getPlanDetails(s.planType);

  let allPlans = [];
  const sl = speech.toLowerCase();
  const plansKw = ['what plans','what coverage','what options','types of warranty',
    'available plans','recommend','which plan','best plan','what do you offer','upgrade'];
  if (plansKw.some(k => sl.includes(k))) {
    allPlans = await getAllPlans();
    console.log(`[PLANS] Loaded ${allPlans.length} plans`);
  }

  sessions.set(callSid, s);

  const ai = await getAIResponse(s, rawSpeech, policyData, planData, allPlans);

  if (ai.extracted?.name && !s.name) s.name = ai.extracted.name;
  if (ai.extracted?.reason) s.reason = ai.extracted.reason;
  if (ai.extracted?.intent) s.intent = ai.extracted.intent;
  if (ai.extracted?.callerType) s.callerType = ai.extracted.callerType;
  if (ai.extracted?.dealerName) s.dealerName = ai.extracted.dealerName;
  if (ai.extracted?.stage) s.stage = ai.extracted.stage;
  if (ai.extracted?.claimDetails) s.claimDetails = { ...s.claimDetails, ...ai.extracted.claimDetails };

  s.messages.push({ role: 'assistant', content: ai.speech });
  sessions.set(callSid, s);

  console.log(`[AI] action:${ai.action} | stage:${s.stage} | "${ai.speech?.slice(0,80)}"`);

  if (ai.action === 'collect_more' || ai.action === 'provide_info') {
    gather(r, callSid, ai.speech);

  } else if (ai.action === 'confirm') {
    s.stage = 'confirm';
    sessions.set(callSid, s);
    gather(r, callSid, ai.speech);

  } else if (ai.action === 'transfer') {
    if (s.afterHours) {
      s.routedTo = 'After Hours — Request Saved';
      sessions.set(callSid, s);
      await safeLogCall(s);
      await safeLogRequest(s, ai.summary || s.reason || '');
      r.say({ voice: 'Polly.Matthew' }, `I have saved your request and someone will follow up next business day. Have a great day!`);
      r.hangup();
    } else {
      const dept = EXTENSIONS[ai.extension];
      const isPlaceholder = !dept?.phoneNumber || dept.phoneNumber.includes('555');
      if (isPlaceholder) {
        s.routedTo = `${dept?.name || 'Team'} — Request Saved`;
        sessions.set(callSid, s);
        await safeLogCall(s);
        await safeLogRequest(s, ai.summary || s.reason || '');
        r.say({ voice: 'Polly.Matthew' }, `I have logged your request for the ${dept?.name || 'team'} and they will call you back. Have a great day!`);
        r.hangup();
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
    r.say({ voice: 'Polly.Matthew' }, ai.speech);
    r.hangup();

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
    if (s.intent || s.reason || s.policyId) {
      await safeLogRequest(s, ai.summary || s.reason || s.intent || 'Call completed');
    }
    r.say({ voice: 'Polly.Matthew' }, ai.speech);
    r.hangup();

  } else {
    gather(r, callSid, ai.speech || `Could you say that again?`);
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

export async function handleCallStatus(req, res) {
  const callSid = req.body.CallSid;
  const status = req.body.CallStatus;
  const from = req.body.From || req.body.Called;
  console.log(`[STATUS] ${callSid} — ${status}`);
  if (status === 'completed' || status === 'no-answer' || status === 'busy') {
    const s = sessions.get(callSid) || (from ? sessionsByPhone.get(from) : null);
    if (s && !s.logged && (s.policyId || s.name || s.reason || s.intent)) {
      if (!s.routedTo) s.routedTo = 'Call ended';
      await safeLogCall(s);
      await safeLogRequest(s, s.reason || s.intent || 'Call ended without resolution');
      console.log(`[AUTO-LOG] ${s.name} / ${s.policyId}`);
    }
  }
  res.sendStatus(200);
}

async function safeLogCall(s) {
  if (s.logged) return;
  try {
    await logCall(s);
    s.logged = true;
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

async function getAIResponse(s, latestInput, policyData, planData, allPlans) {
  let policyContext = '';
  if (policyData) {
    const daysLeft = Math.floor((new Date(policyData.coverage_end) - new Date()) / (1000 * 60 * 60 * 24));
    policyContext = `
VERIFIED CUSTOMER (confirmed — do NOT re-confirm or re-greet):
- Policy: ${policyData.policy_id}
- Name: ${policyData.customer_name}
- Vehicle: ${policyData.vehicle}
- VIN: ${policyData.vin}
- Plan: ${policyData.plan_type}
- Coverage: ${policyData.coverage_start} to ${policyData.coverage_end} — ${policyData.active ? `ACTIVE, ${daysLeft} days remaining` : 'EXPIRED'}
- Claim status: ${policyData.claim_status}
- Notes: ${policyData.notes || 'none'}`;
  } else if (s.policyId) {
    policyContext = `\nPolicy ${s.policyId} NOT found in system.`;
  }

  let planContext = '';
  if (planData) {
    planContext = `
CUSTOMER PLAN (${planData.plan_name}) — answer immediately from this data, never say "let me check":
Engine:${planData.engine} | Trans:${planData.transmission} | Drivetrain:${planData.drivetrain} | Electrical:${planData.electrical}
AC/Heat:${planData.ac_heating} | Turbo:${planData.turbo_supercharger} | Fuel:${planData.fuel_system} | Cooling:${planData.cooling_system}
Brakes:${planData.brake_system} | Suspension:${planData.suspension} | Seals/Gaskets:${planData.seals_gaskets}
Rental:${planData.rental_car} | Towing:${planData.towing} | Roadside:${planData.roadside}
Deductible:${planData.deductible} | Max claim:${planData.max_claim}`;
  }

  let plansContext = '';
  if (allPlans && allPlans.length > 0) {
    plansContext = `
ALL AVAILABLE PLANS — only these exist, never invent others:
${allPlans.map(p => `${p.plan_name} ($${p.price_monthly}/mo | age:${p.max_vehicle_age} | km:${p.max_mileage} | engine:${p.engine} | AC:${p.ac_heating} | seals:${p.seals_gaskets} | deduct:${p.deductible} | max:${p.max_claim})`).join('\n')}`;
  }

  const timeContext = s.afterHours
    ? `AFTER HOURS — cannot transfer. Provide info, save requests, or voicemail only.`
    : `BUSINESS HOURS — can transfer to agents.`;

  const history = s.messages.slice(-10).map(m =>
    `${m.role === 'user' ? 'CALLER' : 'ALEX'}: ${m.content}`
  ).join('\n');

  const claimCollected = Object.keys(s.claimDetails || {}).length;

  const prompt = `You are Alex, virtual assistant for A-Protect Warranty (Canada). Warm, professional, concise.

${timeContext}

SESSION:
- Name: ${s.name || 'unknown'}
- Policy: ${s.policyId || 'none'}
- Vehicle: ${s.vehicle || 'unknown'}
- Plan: ${s.planType || 'unknown'}
- Intent: ${s.intent || 'unknown'}
- Stage: ${s.stage}
- Identified: ${s.identified}
- Claim details collected: ${claimCollected} fields
${policyContext}
${planContext}
${plansContext}

CONVERSATION:
${history}

CALLER: "${latestInput}"

STRICT RULES:
1. NEVER say "I located", "I found your policy" — customer is already verified, just answer their question
2. NEVER say "let me check", "one moment", "let me look that up" — ALL data is in your prompt, answer immediately
3. NEVER greet caller by name after the first turn (only say name once at greet stage)
4. NEVER repeat info already stated in this conversation
5. Keep responses concise — 3-4 sentences. For coverage or plan questions use up to 6 sentences.
6. action=goodbye when caller says: no, nope, that's all, thanks, thank you, goodbye, bye, all good, perfect, got it, done, that's it
7. NEVER invent plan names — only plans from ALL AVAILABLE PLANS
8. After hours: never use action=transfer
9. Stage never goes backwards
10. Answer coverage questions IMMEDIATELY from plan data

CLAIM COLLECTION FLOW:
- When intent=Claim and stage=claim_collect: collect these fields one at a time:
  issue (what happened), when_started, mileage, at_shop (yes/no), symptoms
- When all 5 fields collected → stage=confirm
- At confirm stage: summarize collected info in 2-3 sentences, ask "Does that sound right?"
- After caller confirms → say "I can log this request for the Claims team and they will follow up, or I can connect you now if you prefer. Which would you like?" Use action=confirm
- After caller chooses → execute (save_request or transfer) + say ONE goodbye sentence. Never ask more questions.
- NEVER repeat the summary more than once

GOODBYE TRIGGERS — action=goodbye immediately:
"no", "nope", "that's all", "that's it", "thanks", "thank you", "goodbye", "bye", "all good", "perfect", "got it", "done"

DEPARTMENTS: Sales 101 | Claims 102 | Accounting 103 | Management 104

Reply ONLY with JSON, no markdown:
{"speech":"response text","action":"collect_more","extension":null,"department":null,"summary":null,"extracted":{"name":null,"reason":null,"intent":null,"callerType":null,"dealerName":null,"stage":null,"claimDetails":null}}

ACTIONS: collect_more | provide_info | confirm | transfer | voicemail | save_request | goodbye`;

  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 350,
      temperature: 0.2,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = completion.choices[0].message.content.trim().replace(/```json|```/g, '').trim();
    console.log(`[GROQ] ${raw.slice(0, 200)}`);
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[GROQ ERROR] ${err.message}`);
    return {
      speech: `Could you say that again?`,
      action: 'collect_more',
      extension: null, department: null, summary: null,
      extracted: { name: null, reason: null, intent: null, callerType: null, dealerName: null, stage: null, claimDetails: null },
    };
  }
}
