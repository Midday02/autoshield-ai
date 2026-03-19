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
    ? `Thanks for calling A-Protect Warranty. Our office is closed but I can still help — I can check your coverage, update you on a claim, or take your request for our team. Do you have your policy number?`
    : `Thanks for calling A-Protect Warranty. Could I get your policy number to pull up your account? It starts with W followed by six digits.`;
  gather(r, callSid, greeting);
  res.type('text/xml').send(r.toString());
}

export async function handleUserSpeech(req, res) {
  const callSid = req.query.callSid || req.body.CallSid;
  const from = req.body.From || 'Unknown';
  const speech = (req.body.SpeechResult || '').trim();
  const s = getSession(callSid, from);
  const r = new TwiML.VoiceResponse();

  console.log(`[SPEECH] ${callSid} | "${speech}" | stage:${s.stage} | identified:${s.identified}`);

  // Handle silence
  if (!speech) {
    s.fallbackCount = (s.fallbackCount || 0) + 1;
    sessions.set(callSid, s);
    if (s.fallbackCount >= 2) {
      s.routedTo = 'Voicemail (no response)';
      sessions.set(callSid, s);
      await safeLogCall(s);
      r.say({ voice: 'Polly.Matthew' }, `No worries. Please leave your name and number after the beep and we will call you back.`);
      r.record({ action: `/voice/recording?callSid=${callSid}`, maxLength: 120, playBeep: true });
    } else {
      gather(r, callSid, `Sorry, I did not catch that. Could you say that again?`);
    }
    return res.type('text/xml').send(r.toString());
  }

  s.fallbackCount = 0;

  // Extract policy number W######
  const policyMatch = speech.match(/[Ww]\s*\d[\s\d]{5}/);
  if (policyMatch) {
    const clean = policyMatch[0].replace(/\s/g, '').toUpperCase();
    if (clean.match(/^W\d{6}$/)) s.policyId = clean;
  }

  // Extract last 6 digits of VIN
  const vinMatch = speech.replace(/\s/g, '').match(/[A-HJ-NPR-Z0-9]{6}$/i);
  if (vinMatch && !s.policyId && !s.identified) {
    s.vinFragment = vinMatch[0].toUpperCase();
  }

  s.messages.push({ role: 'user', content: speech });

  // Look up policy
  let policyData = null;
  if (s.policyId && !s.identified) {
    policyData = await lookupPolicy(s.policyId);
    if (policyData) {
      s.identified = true;
      s.vehicle = policyData.vehicle;
      s.planType = policyData.plan_type;
      if (!s.name) s.name = policyData.customer_name;
      console.log(`[IDENTIFIED by policy] ${s.policyId} — ${policyData.customer_name}`);
    }
  } else if (s.vinFragment && !s.identified) {
    policyData = await lookupPolicyByVin(s.vinFragment);
    if (policyData) {
      s.identified = true;
      s.policyId = policyData.policy_id;
      s.vehicle = policyData.vehicle;
      s.planType = policyData.plan_type;
      if (!s.name) s.name = policyData.customer_name;
      console.log(`[IDENTIFIED by VIN] ${s.vinFragment} → ${s.policyId} — ${policyData.customer_name}`);
    }
  } else if (s.policyId && s.identified) {
    policyData = await lookupPolicy(s.policyId);
  }

  // Load plan data if we have a plan type
  let planData = null;
  if (s.planType) planData = await getPlanDetails(s.planType);

  // Load all plans for general questions
  let allPlans = [];
  const speechLower = speech.toLowerCase();
  const plansKeywords = ['what plans', 'what coverage', 'what options', 'types of warranty',
    'what warranties', 'available plans', 'recommend', 'which plan', 'best plan',
    'what do you offer', 'upgrade', 'what packages'];
  const needsAllPlans = plansKeywords.some(k => speechLower.includes(k));
  if (needsAllPlans) {
    allPlans = await getAllPlans();
    console.log(`[PLANS] Loaded ${allPlans.length} plans for general query`);
  }

  sessions.set(callSid, s);

  const ai = await getAIResponse(s, speech, policyData, planData, allPlans);

  if (ai.extracted?.name && !s.name) s.name = ai.extracted.name;
  if (ai.extracted?.reason) s.reason = ai.extracted.reason;
  if (ai.extracted?.intent) s.intent = ai.extracted.intent;
  if (ai.extracted?.callerType) s.callerType = ai.extracted.callerType;
  if (ai.extracted?.dealerName) s.dealerName = ai.extracted.dealerName;
  if (ai.extracted?.stage) s.stage = ai.extracted.stage;
  if (ai.extracted?.claimDetails) s.claimDetails = { ...s.claimDetails, ...ai.extracted.claimDetails };

  s.messages.push({ role: 'assistant', content: ai.speech });
  sessions.set(callSid, s);

  console.log(`[AI] action:${ai.action} | ext:${ai.extension} | "${ai.speech?.slice(0,80)}"`);

  if (ai.action === 'collect_more' || ai.action === 'provide_info') {
    gather(r, callSid, ai.speech);

  } else if (ai.action === 'transfer') {
    if (s.afterHours) {
      s.routedTo = 'After Hours — Request Saved';
      sessions.set(callSid, s);
      await safeLogCall(s);
      await safeLogRequest(s, ai.summary || s.reason || '');
      gather(r, callSid, `Our team is not available right now. I have saved your request and someone will follow up next business day.`);
    } else {
      const dept = EXTENSIONS[ai.extension];
      const isPlaceholder = !dept?.phoneNumber || dept.phoneNumber.includes('555');
      if (isPlaceholder) {
        s.routedTo = `${dept?.name || 'Team'} — Request Saved`;
        sessions.set(callSid, s);
        await safeLogCall(s);
        await safeLogRequest(s, ai.summary || s.reason || '');
        gather(r, callSid, `I have passed your details to the ${dept?.name || 'team'} and they will call you back shortly. Is there anything else I can help with?`);
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

async function getAIResponse(s, latestInput, policyData, planData, allPlans) {
  let policyContext = '';
  if (policyData) {
    const daysLeft = Math.floor((new Date(policyData.coverage_end) - new Date()) / (1000 * 60 * 60 * 24));
    policyContext = `
VERIFIED CUSTOMER:
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
CUSTOMER PLAN DETAILS (${planData.plan_name}) — ONLY use this, never guess:
Engine: ${planData.engine} | Transmission: ${planData.transmission} | Drivetrain: ${planData.drivetrain}
Electrical: ${planData.electrical} | AC/Heating: ${planData.ac_heating} | Turbo: ${planData.turbo_supercharger}
Fuel system: ${planData.fuel_system} | Cooling: ${planData.cooling_system} | Brakes: ${planData.brake_system}
Suspension: ${planData.suspension} | Seals/Gaskets: ${planData.seals_gaskets}
Rental car: ${planData.rental_car} | Towing: ${planData.towing} | Roadside: ${planData.roadside}
Deductible: ${planData.deductible} | Max claim: ${planData.max_claim}`;
  }

  let plansContext = '';
  if (allPlans && allPlans.length > 0) {
    plansContext = `
ALL AVAILABLE PLANS (use ONLY these — do not invent others):
${allPlans.map(p => `
${p.plan_name} ($${p.price_monthly}/mo):
- Vehicle age: up to ${p.max_vehicle_age} | Mileage: up to ${p.max_mileage}
- Engine:${p.engine} | Trans:${p.transmission} | Drive:${p.drivetrain} | Elec:${p.electrical}
- AC/Heat:${p.ac_heating} | Turbo:${p.turbo_supercharger} | Fuel:${p.fuel_system} | Cooling:${p.cooling_system}
- Brakes:${p.brake_system} | Susp:${p.suspension} | Seals:${p.seals_gaskets}
- Rental:${p.rental_car} | Towing:${p.towing} | Roadside:${p.roadside}
- Deductible:${p.deductible} | Max claim:${p.max_claim}`).join('\n')}`;
  }

  const timeContext = s.afterHours
    ? `AFTER HOURS — office closed. Cannot transfer. Save requests or offer voicemail.`
    : `BUSINESS HOURS — can transfer to agents.`;

  const history = s.messages.slice(-10).map(m =>
    `${m.role === 'user' ? 'CALLER' : 'ALEX'}: ${m.content}`
  ).join('\n');

  const prompt = `You are Alex, a knowledgeable virtual assistant for A-Protect Warranty (Canada).

${timeContext}

SESSION:
- Name: ${s.name || 'unknown'}
- Policy: ${s.policyId || 'none'}
- Vehicle: ${s.vehicle || 'unknown'}
- Plan: ${s.planType || 'unknown'}
- Intent: ${s.intent || 'unknown'}
- Stage: ${s.stage}
- Identified: ${s.identified}
${policyContext}
${planContext}
${plansContext}

CONVERSATION:
${history}

CALLER: "${latestInput}"

STRICT RULES:
1. NEVER say "I located", "I found your policy", "I have your account" more than once
2. NEVER say "let me check", "one moment", "let me look that up" — ALL data is already in your prompt, answer immediately
3. NEVER greet caller by name after the first turn
4. NEVER repeat coverage info already stated in this conversation
5. Keep responses SHORT — 2 sentences max
6. When caller says "no", "that's all", "thanks", "goodbye" → action=goodbye immediately
7. NEVER invent plan names — only use plans from ALL AVAILABLE PLANS
8. After hours → never transfer
9. stage must ALWAYS move forward — never go back to "greet" or "identify" once past them
10. If you already confirmed the policy, vehicle and plan — go straight to answering questions, do NOT re-confirm

GOODBYE TRIGGERS — action=goodbye immediately:
"no", "nope", "that's all", "that's it", "thanks", "thank you", "goodbye", "bye", "all good", "perfect", "got it"

FLOW:
- identify: Get policy # or last 6 VIN digits. If new client/dealer → get name + what they need
- greet: Found policy → confirm vehicle + plan in ONE sentence, ask how you can help. Only once.
- intent: Understand what they need
- claim_collect: What happened, when, mileage, at shop, warning lights
- resolve: Summarize, offer next step

DEPARTMENTS: Sales 101 | Claims 102 | Accounting 103 | Management 104

Reply ONLY with JSON, no markdown:
{
  "speech": "2-3 sentences max, natural, no name after first turn",
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
      max_tokens: 350,
      temperature: 0.25,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = completion.choices[0].message.content.trim().replace(/```json|```/g, '').trim();
    console.log(`[GROQ] ${raw.slice(0, 200)}`);
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[GROQ ERROR] ${err.message}`);
    return {
      speech: `Sorry, could you say that again?`,
      action: 'collect_more',
      extension: null, department: null, summary: null,
      extracted: { name: null, reason: null, intent: null, callerType: null, dealerName: null, stage: null, claimDetails: null },
    };
  }
}
