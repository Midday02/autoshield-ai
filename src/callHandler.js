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
  session.mes
