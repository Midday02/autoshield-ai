import pkg from 'twilio';
const { twiml: TwiML } = pkg;

import { logCall, lookupPolicy } from './sheets.js';

function isWorkingHours() {
  const now = new Date();
  const toronto = new Date(
    now.toLocaleString("en-US", { timeZone: "America/Toronto" })
  );
  const hour = toronto.getHours();
  return hour >= 9 && hour < 18;
}

// ===== INCOMING CALL =====
export async function handleIncomingCall(req, res) {
  const twiml = new TwiML.VoiceResponse();

  if (!isWorkingHours()) {
    twiml.say("We are currently closed. Please leave a message.");
    twiml.record({ action: '/voice/recording' });
    return res.type('text/xml').send(twiml.toString());
  }

  twiml.gather({
    input: 'speech',
    action: '/voice/speech',
    speechTimeout: 'auto'
  }).say(`
    Welcome to AutoShield.
    You can say:
    warranty status,
    file a claim,
    or speak to an agent.
  `);

  res.type('text/xml').send(twiml.toString());
}

// ===== SPEECH HANDLER =====
export async function handleUserSpeech(req, res) {
  const twiml = new TwiML.VoiceResponse();
  const speech = (req.body.SpeechResult || '').toLowerCase();
  const from = req.body.From || 'unknown';

  let intent = 'unknown';

  if (speech.includes('warranty')) {
    intent = 'warranty';

    twiml.gather({
      input: 'speech',
      action: '/voice/speech'
    }).say('Please say your policy number.');

  } else if (speech.includes('claim')) {
    intent = 'claim';

    twiml.say('Please describe your issue after the beep.');
    twiml.record({ action: '/voice/recording' });

  } else if (speech.includes('agent')) {
    intent = 'agent';

    twiml.say('Connecting you to an agent.');
    twiml.dial('+1234567890'); // ← ПОМЕНЯЙ НА СВОЙ НОМЕР

  } else if (/^[a-z0-9]+$/i.test(speech.replace(/\s/g, ''))) {
    // POLICY ID
    const policyId = speech.replace(/\s/g, '').toUpperCase();
    const policy = await lookupPolicy(policyId);

    if (policy) {
      twiml.say(`Your warranty is ${policy.status}`);
      intent = 'warranty_lookup';
    } else {
      twiml.say('Policy not found.');
    }

  } else {
    twiml.say('Sorry, I did not understand. Connecting you to an agent.');
    twiml.dial('+1234567890');
  }

  await logCall({
    phone: from,
    intent,
    time: new Date().toISOString()
  });

  res.type('text/xml').send(twiml.toString());
}

// ===== VOICEMAIL =====
export async function handleRecording(req, res) {
  const twiml = new TwiML.VoiceResponse();

  await logCall({
    phone: req.body.From,
    intent: 'voicemail',
    time: new Date().toISOString()
  });

  twiml.say('Thank you. We will call you back.');
  res.type('text/xml').send(twiml.toString());
}
