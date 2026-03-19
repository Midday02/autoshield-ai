import { google } from 'googleapis';

const SHEET_ID = process.env.GOOGLE_SHEET_ID;

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

// ── Lookup warranty policy ─────────────────────────────────────────────────
export async function lookupPolicy(policyId) {
  try {
    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Warranties!A2:J1000',
    });
    const rows = res.data.values || [];
    const row = rows.find(r => r[0]?.toUpperCase() === policyId.toUpperCase());
    if (!row) return null;
    const today = new Date();
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
      active:         new Date(row[6]) >= today,
    };
  } catch (e) {
    console.error('lookupPolicy error:', e.message);
    return null;
  }
}

// ── Log new call ───────────────────────────────────────────────────────────
export async function logCall(session) {
  try {
    const sheets = await getSheets();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Call Log!A:H',
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[
          session.startTime,
          session.from,
          session.name || '',
          session.policyId || '',
          session.reason || '',
          session.routedTo || '',
          'Completed',
          '',
        ]],
      },
    });
  } catch (e) {
    console.error('logCall error:', e.message);
  }
}

// ── Update call log row ────────────────────────────────────────────────────
export async function updateCallLog(callSid, updates) {
  console.log(`updateCallLog ${callSid}:`, updates);
}

// ── Get call log for dashboard ─────────────────────────────────────────────
export async function getCallLog() {
  try {
    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Call Log!A2:H500',
    });
    const rows = res.data.values || [];
    return rows.reverse().slice(0, 100).map(r => ({
      timestamp:  r[0] || '',
      phone:      r[1] || '',
      name:       r[2] || '',
      policy_id:  r[3] || '',
      reason:     r[4] || '',
      routed_to:  r[5] || '',
      status:     r[6] || '',
      recording:  r[7] || '',
    }));
  } catch (e) {
    console.error('getCallLog error:', e.message);
    return [];
  }
}

export async function getPlanDetails(planName) {
  try {
    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Plans!A2:Y20',
    });
    const rows = res.data.values || [];
    const row = rows.find(r => r[0]?.toLowerCase() === planName?.toLowerCase());
    if (!row) return null;
    return {
      plan_name:         row[0],
      tier:              row[1],
      engine:            row[6]  === 'Yes' ? 'Covered' : 'Not covered',
      transmission:      row[7]  === 'Yes' ? 'Covered' : 'Not covered',
      drivetrain:        row[8]  === 'Yes' ? 'Covered' : 'Not covered',
      electrical:        row[9]  === 'Yes' ? 'Covered' : 'Not covered',
      ac_heating:        row[10] === 'Yes' ? 'Covered' : 'Not covered',
      turbo_supercharger:row[11] === 'Yes' ? 'Covered' : 'Not covered',
      fuel_system:       row[12] === 'Yes' ? 'Covered' : 'Not covered',
      cooling_system:    row[13] === 'Yes' ? 'Covered' : 'Not covered',
      brake_system:      row[14] === 'Yes' ? 'Covered' : 'Not covered',
      suspension:        row[15] === 'Yes' ? 'Covered' : 'Not covered',
      seals_gaskets:     row[16] === 'Yes' ? 'Covered' : 'Not covered',
      rental_car:        row[17] === 'Yes' ? 'Covered' : 'Not covered',
      towing:            row[18] === 'Yes' ? 'Covered' : 'Not covered',
      roadside:          row[19] === 'Yes' ? 'Covered' : 'Not covered',
      deductible:        row[21] || '',
      max_claim:         row[23] || '',
    };
  } catch (e) {
    console.error('getPlanDetails error:', e.message);
    return null;
  }
}
