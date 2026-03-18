import pkg from 'twilio';
const { twiml: TwiML } = pkg;

import {
  logCall,
  lookupPolicyByPhone,
  lookupPolicyByFullCheck
} from './sheets.js';

// ===== WORK HOURS =====
function isWorkingHours() {
  const now = new Date();
  const toronto = new Date(
    now.toLocaleString("en-US", { timeZone: "America/Toronto" })
  );
  const hour = toronto.getHours();
  return hour >= 9 && hour < 18;
}

// ===== INCOMING =====
export async function handleIncomingCall(req, res) {
  const twiml = new TwiML.VoiceResponse();

  twiml.gather({
    input: 'speech',
    action: '/voice/speech',
    speechTimeout: 'auto'
  }).say(`
    Welcome to AutoShield.

    You can say:
    check warranty,
    open a claim,
    billing,
    or speak to an agent.
  `);

  res.type('text/xml').send(twiml.toString());
}

// ===== INTENT DETECTION =====
export async function handleUserSpeech(req, res) {
  const twiml = new TwiML.VoiceResponse();

  const speech = (req.body.SpeechResult || '').toLowerCase();
  const from = req.body.From || '';

  // ===== TRY AUTO IDENTIFY =====
  let knownPolicy = await lookupPolicyByPhone(from);

  if (speech.includes('warranty') || speech.includes('status')) {

    if (knownPolicy) {
      return respondWithPolicy(twiml, knownPolicy, res);
    }

    twiml.gather({
      input: 'speech',
      action: '/voice/check'
    }).say(`
      Please say your policy number,
      or your phone number and last 5 digits of VIN.
    `);
  }

  else if (speech.includes('claim')) {
    twiml.say('Please describe your issue after the beep.');
    twiml.record({ action: '/voice/recording' });
  }

  else if (speech.includes('billing')) {
    routeCall(twiml, 'billing');
  }

  else if (speech.includes('agent')) {
    routeCall(twiml, 'general');
  }

  else {
    twiml.say('Let me help you.');
    twiml.redirect('/voice/incoming');
  }

  await logCall({
    phone: from,
    intent: speech,
    time: new Date().toISOString()
  });

  res.type('text/xml').send(twiml.toString());
}

// ===== POLICY RESPONSE =====
function respondWithPolicy(twiml, policy, res) {
  const today = new Date();
  const end = new Date(policy.coverage_end);

  let statusMsg = 'active';
  let extra = '';

  if (end < today) {
    statusMsg = 'expired';
  } else {
    const daysLeft = Math.floor((end - today) / (1000 * 60 * 60 * 24));
    if (daysLeft < 30) {
      extra = `Your warranty expires in ${daysLeft} days.`;
    }
  }

  twiml.say(`
    I found your policy.

    Vehicle: ${policy.vehicle}.
    Plan: ${policy.plan}.
    Your warranty is ${statusMsg}.
    ${extra}
    Claim status: ${policy.status}.
  `);

  twiml.gather({
    input: 'speech',
    action: '/voice/after'
  }).say(`
    Can I help with anything else?
    You can say open claim or speak to an agent.
  `);

  res.type('text/xml').send(twiml.toString());
}

// ===== WARRANTY CHECK (manual input) =====
export async function handleWarrantyCheck(req, res) {
  const twiml = new TwiML.VoiceResponse();

  const speech = (req.body.SpeechResult || '').toUpperCase().replace(/\s/g, '');

  let policy = await lookupPolicyByFullCheck(speech);

  if (!policy) {
    twiml.say('Policy not found.');
    twiml.redirect('/voice/incoming');
  } else {
    return respondWithPolicy(twiml, policy, res);
  }

  res.type('text/xml').send(twiml.toString());
}

// ===== AFTER ACTION =====
export async function handleAfter(req, res) {
  const twiml = new TwiML.VoiceResponse();
  const speech = (req.body.SpeechResult || '').toLowerCase();

  if (speech.includes('claim')) {
    twiml.say('Please describe your issue after the beep.');
    twiml.record({ action: '/voice/recording' });
  }

  else if (speech.includes('agent')) {
    routeCall(twiml, 'general');
  }

  else {
    twiml.say('Thank you for calling AutoShield.');
  }

  res.type('text/xml').send(twiml.toString());
}

// ===== ROUTING =====
function routeCall(twiml, type) {
  if (!isWorkingHours()) {
    twiml.say('We are currently closed. Please leave a message.');
    twiml.record({ action: '/voice/recording' });
    return;
  }

  if (type === 'billing') {
    twiml.say('Connecting billing.');
    twiml.dial('+1111111111');
  }

  else if (type === 'claims') {
    twiml.say('Connecting claims department.');
    twiml.dial('+1222222222');
  }

  else {
    twiml.say('Connecting you to an agent.');
    twiml.dial('+1333333333');
  }
}

// ===== RECORDING =====
export async function handleRecording(req, res) {
  const twiml = new TwiML.VoiceResponse();

  await logCall({
    phone: req.body.From,
    recording: req.body.RecordingUrl,
    time: new Date().toISOString()
  });

  twiml.say('Your message has been recorded. Goodbye.');

  res.type('text/xml').send(twiml.toString());
}
