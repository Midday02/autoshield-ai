import { google } from 'googleapis';

// ─── Auth ────────────────────────────────────────────────────────────────────

function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

async function getSheets() {
  const auth = await getAuth().getClient();
  return google.sheets({ version: 'v4', auth });
}

const SHEET_ID = process.env.GOOGLE_SHEET_ID;

// ─── Warranty CRM Lookup ─────────────────────────────────────────────────────

export async function lookupPolicy(policyId) {
  try {
    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Warranties!A2:J1000', // Skip header row
    });

    const rows = res.data.values || [];
    // Columns: policy_id, customer_name, phone, vehicle, vin,
    //          coverage_start, coverage_end, plan_type, claim_status, notes

    const row = rows.find(r => r[0]?.toUpperCase() === policyId.toUpperCase());
    if (!row) return null;

    const today = new Date();
    const endDate = new Date(row[6]);

    return {
      policy_id:      row[0],
      customer_name:  row[1],
      phone:          row[2],
      vehicle:        row[3],
      vin:            row[4],
      coverage_start: row[5],
      coverage_end:   row[6],
      plan_type:      row[7],
      claim_status:   row[8] || 'None',
      notes:          row[9] || '',
      active:         endDate >= today,
    };
  } catch (err) {
    console.error('Sheets lookupPolicy error:', err.message);
    return null;
  }
}

// ─── Call Log (append row to "Call Log" sheet) ───────────────────────────────

export async function logCall(session) {
  try {
    const sheets = await getSheets();
    const row = [
      session.startTime,
      session.fromNumber,
      session.name || '',
      session.policyId || '',
      session.reason || '',
      session.routedTo || '',
      'Completed',
      '', // recording URL — filled in later
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Call Log!A:H',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [row] },
    });

    console.log(`Call logged: ${session.callSid}`);
  } catch (err) {
    console.error('Sheets logCall error:', err.message);
  }
}

// ─── Update call log row with recording URL ──────────────────────────────────

export async function updateCallLog(callSid, updates) {
  // For simplicity, this just logs — in production you'd match by callSid
  console.log(`Call ${callSid} update:`, updates);
}

// ─── Get call log for dashboard API ─────────────────────────────────────────

export async function getCallLog() {
  try {
    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Call Log!A2:H500',
    });

    const rows = res.data.values || [];
    return rows.reverse().slice(0, 100).map(r => ({
      time:       r[0],
      phone:      r[1],
      name:       r[2],
      policyId:   r[3],
      reason:     r[4],
      routedTo:   r[5],
      status:     r[6],
      recording:  r[7],
    }));
  } catch (err) {
    console.error('Sheets getCallLog error:', err.message);
    return [];
  }
}
