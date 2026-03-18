import { google } from 'googleapis';

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const RANGE = 'Sheet1!A:J';

// === AUTH ===
async function getAuth() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  return auth;
}

// === GET ALL CALLS (для dashboard) ===
let calls = [];

export async function logCall(call) {
  calls.push(call);
}

export async function getCallLog() {
  return calls;
}

// === LOOKUP POLICY ===
export async function lookupPolicy(policyId) {
  const auth = await getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: RANGE,
  });

  const rows = res.data.values;

  if (!rows || rows.length === 0) return null;

  const headers = rows[0];

  const data = rows.slice(1).map(row => {
    let obj = {};
    headers.forEach((h, i) => {
      obj[h] = row[i];
    });
    return obj;
  });

  const policy = data.find(
    p => p.policy_id?.toUpperCase() === policyId.toUpperCase()
  );

  if (!policy) return null;

  return {
    policy_id: policy.policy_id,
    name: policy.customer_name,
    phone: policy.phone,
    vehicle: policy.vehicle,
    vin: policy.vin,
    status: policy.claim_status || 'No active claim',
    coverage: `${policy.coverage_start} to ${policy.coverage_end}`,
    plan: policy.plan_type,
  };
}
