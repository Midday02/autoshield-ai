import express from 'express';
import bodyParser from 'body-parser';

import {
  handleIncomingCall,
  handleUserSpeech,
  handleRecording,
  handleWarrantyCheck,
  handleAfter
} from './callHandler.js';

const app = express();

app.use(bodyParser.urlencoded({ extended: false }));

// ===== ROUTES =====
app.post('/voice/incoming', handleIncomingCall);
app.post('/voice/speech', handleUserSpeech);
app.post('/voice/recording', handleRecording);
app.post('/voice/check', handleWarrantyCheck);
app.post('/voice/after', handleAfter);

// ===== TEST ROUTE =====
app.get('/', (req, res) => {
  res.send('Server is running');
});

// ===== START =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
