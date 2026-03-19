import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { handleIncomingCall, handleUserSpeech, handleRecording, handleAfterHours } from './callHandler.js';
import { lookupPolicy, getCallLog } from './sheets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/voice/incoming', handleIncomingCall);
app.post('/voice/speech',   handleUserSpeech);
app.post('/voice/recording', handleRecording);
app.post('/voice/afterhours', handleAfterHours);

app.get('/api/calls', async (req, res) => {
  try { res.json(await getCallLog()); }
  catch { res.json([]); }
});

app.get('/api/warranty/:id', async (req, res) => {
  try {
    const policy = await lookupPolicy(req.params.id.toUpperCase());
    if (!policy) return res.status(404).json({ error: 'Not found' });
    res.json(policy);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stats', async (req, res) => {
  try {
    const calls = await getCallLog();
    const today = new Date().toISOString().slice(0, 10);
    const todayCalls = calls.filter(c => c.timestamp?.startsWith(today));
    const routed = todayCalls.filter(c => c.routed_to && c.routed_to !== 'Voicemail');
    res.json({
      total: todayCalls.length,
      routed: routed.length,
      voicemail: todayCalls.length - routed.length,
      accuracy: todayCalls.length ? Math.round((routed.length / todayCalls.length) * 100) : 0,
    });
  } catch { res.json({ total: 0, routed: 0, voicemail: 0, accuracy: 0 }); }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AutoShield AI running on port ${PORT}`));
