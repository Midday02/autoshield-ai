import { google } from 'googleapis';

// ===== CONFIG =====
const SHEET_ID = '15kvlkxcR9pRxRI3LC_vv4LhpVbB4G23XVEFVAL1rfNs';
const RANGE = 'Warranties!A1:Z1000';

// ===== AUTH =====
async function getAuth() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  return await auth.getClient();
}

// ===== GET ALL DATA =====
async function getAllPolicies() {
  const auth = await getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: RANGE,
  });

  const rows = res.data.values;
  const headers = rows[0];

  return rows.slice(1).map(row => {
    let obj = {};
    headers.forEach((h, i) => obj[h] = row[i]);
    return obj;
  });
}

// ===== LOOKUP BY PHONE =====
export async function lookupPolicyByPhone(phone) {
  const data = await getAllPolicies();
  return data.find(p => p.phone === phone);
}

// ===== LOOKUP BY POLICY OR VIN =====
export async function lookupPolicyByFullCheck(input) {
  const data = await getAllPolicies();

  return data.find(p =>
    p.policy_id === input ||
    p.vin?.endsWith(input)
  );
}

// ===== LOG CALL =====
export async function logCall(entry) {
  try {
    const auth = await getAuth();
    const sheets = google.sheets({ version: 'v4', auth });

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Logs!A1',
      valueInputOption: 'RAW',
      requestBody: {
        values: [[
          new Date().toISOString(),
          entry.phone || '',
          entry.intent || '',
          entry.recording || ''
        ]]
      }
    });
  } catch (e) {
    console.log('Log error:', e.message);
  }
}
