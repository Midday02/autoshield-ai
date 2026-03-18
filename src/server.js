import express from 'express';
import pkg from 'twilio';
const { twiml: TwiML } = pkg;
import { handleIncomingCall, handleUserSpeech, handleRecording } from './callHandler.js';

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static('public'));

app.post('/voice/incoming', handleIncomingCall);
app.post('/voice/speech', handleUserSpeech);
app.post('/voice/recording', handleRecording);

app.get('/api/calls', async (req, res) => {
  const { getCallLog } = await import('./sheets.js');
  const calls = await getCallLog();
  res.json(calls);
});

app.get('/api/warranty/:policyId', async (req, res) => {
  const { lookupPolicy } = await import('./sheets.js');
  const policy = await lookupPolicy(req.params.policyId.toUpperCase());
  if (!policy) return res.status(404).json({ error: 'Policy not found' });
  res.json(policy);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AutoShield AI Receptionist running on port ${PORT}`));
