import { google } from 'googleapis';

const SHEET_ID = process.env.GOOGLE_SHEET_ID;

let sheetsClientPromise = null;

async function getSheets() {
  if (!sheetsClientPromise) {
    sheetsClientPromise = (async () => {
      const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
      const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      const client = await auth.getClient();
      return google.sheets({ version: 'v4', auth: client });
    })().catch(e => { sheetsClientPromise = null; throw e; });
  }
  return sheetsClientPromise;
}

function parseRow(row) {
  return {
    plan_name:          row[0]  || '',
    price_monthly:      row[2]  || '',
    price_annual:       row[3]  || '',
    max_vehicle_age:    row[4]  || '',
    max_mileage:        row[5]  || '',
    engine:             row[6]  === 'Yes' ? 'Covered' : 'Not covered',
    transmission:       row[7]  === 'Yes' ? 'Covered' : 'Not covered',
    drivetrain:         row[8]  === 'Yes' ? 'Covered' : 'Not covered',
    electrical:         row[9]  === 'Yes' ? 'Covered' : 'Not covered',
    ac_heating:         row[10] === 'Yes' ? 'Covered' : 'Not covered',
    turbo_supercharger: row[11] === 'Yes' ? 'Covered' : 'Not covered',
    fuel_system:        row[12] === 'Yes' ? 'Covered' : 'Not covered',
    cooling_system:     row[13] === 'Yes' ? 'Covered' : 'Not covered',
    brake_system:       row[14] === 'Yes' ? 'Covered' : 'Not covered',
    suspension:         row[15] === 'Yes' ? 'Covered' : 'Not covered',
    seals_gaskets:      row[16] === 'Yes' ? 'Covered' : 'Not covered',
    rental_car:         row[17] === 'Yes' ? 'Covered' : 'Not covered',
    towing:             row[18] === 'Yes' ? 'Covered' : 'Not covered',
    roadside:           row[19] === 'Yes' ? 'Covered' : 'Not covered',
    trip_interruption:  row[20] === 'Yes' ? 'Covered' : 'Not covered',
    deductible:         row[21] || '',
    labor_rate:         row[22] || '',
    max_claim:          row[23] || '',
    notes:              row[24] || '',
  };
}

export async function getAllPlans() {
  try {
    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Plans!A2:Y20',
    });
    const rows = res.data.values || [];
    return rows.filter(r => r[0]).map(parseRow);
  } catch (e) {
    console.error('getAllPlans error:', e.message);
    return [];
  }
}

export async function getPlanDetails(planName) {
  try {
    const plans = await getAllPlans();
    return plans.find(p => p.plan_name.toLowerCase() === planName?.toLowerCase()) || null;
  } catch (e) {
    console.error('getPlanDetails error:', e.message);
    return null;
  }
}

function mapWarrantyRow(row) {
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
    active:         new Date(row[6]) >= new Date(),
  };
}

async function getWarrantyRows() {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Warranties!A2:J1000',
  });
  return res.data.values || [];
}

export async function getAllPolicies() {
  try {
    const rows = await getWarrantyRows();
    return rows.filter(r => r[0]).map(mapWarrantyRow);
  } catch (e) {
    console.error('getAllPolicies error:', e.message);
    return [];
  }
}

export async function updatePolicyInfo(policyId, updates) {
  try {
    const sheets = await getSheets();
    const rows = await getWarrantyRows();
    const rowIndex = rows.findIndex(r => r[0]?.toUpperCase() === policyId.toUpperCase());
    if (rowIndex === -1) return false;
    const sheetRow = rowIndex + 2; // +1 for header row, +1 for 1-based sheet rows
    const data = [];
    if (updates.customer_name !== undefined) data.push({ range: `Warranties!B${sheetRow}`, values: [[updates.customer_name]] });
    if (updates.phone !== undefined) data.push({ range: `Warranties!C${sheetRow}`, values: [[updates.phone]] });
    if (updates.notes !== undefined) data.push({ range: `Warranties!J${sheetRow}`, values: [[updates.notes]] });
    if (!data.length) return true;
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      resource: { valueInputOption: 'USER_ENTERED', data },
    });
    return true;
  } catch (e) {
    console.error('updatePolicyInfo error:', e.message);
    return false;
  }
}

export async function lookupPolicy(policyId) {
  try {
    const rows = await getWarrantyRows();
    const row = rows.find(r => r[0]?.toUpperCase() === policyId.toUpperCase());
    return row ? mapWarrantyRow(row) : null;
  } catch (e) {
    console.error('lookupPolicy error:', e.message);
    return null;
  }
}

export async function lookupPolicyByVin(vinFragment) {
  try {
    const rows = await getWarrantyRows();
    const clean = vinFragment.replace(/\s/g, '').toUpperCase();
    const row = rows.find(r => r[4]?.toUpperCase().endsWith(clean));
    return row ? mapWarrantyRow(row) : null;
  } catch (e) {
    console.error('lookupPolicyByVin error:', e.message);
    return null;
  }
}

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
          session.reason || session.intent || '',
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

export async function logRequestToSheets(entry) {
  try {
    const sheets = await getSheets();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Requests!A:O',
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[
          entry.timestamp,
          entry.type,
          entry.callerType,
          entry.name,
          entry.phone,
          entry.policyId,
          entry.vehicle,
          entry.vin || '',
          entry.department,
          entry.summary,
          entry.details,
          entry.status,
          entry.assignedTo,
          entry.followUp,
          entry.resolvedAt,
        ]],
      },
    });
  } catch (e) {
    console.error('logRequestToSheets error:', e.message);
  }
}

export async function logSecurityEvent(entry) {
  try {
    const sheets = await getSheets();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Security!A:D',
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[entry.timestamp, entry.phone, entry.policyId, entry.reason]],
      },
    });
    console.log(`[SECURITY LOG] ${entry.phone} — ${entry.reason}`);
  } catch (e) {
    console.error('logSecurityEvent error:', e.message);
  }
}

export async function updateCallLog(callSid, updates) {
  console.log(`updateCallLog ${callSid}:`, updates);
}

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

export async function getRequests() {
  try {
    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Requests!A2:O500',
    });
    const rows = res.data.values || [];
    return rows.reverse().slice(0, 200).map(r => ({
      timestamp:  r[0] || '',
      type:       r[1] || '',
      callerType: r[2] || '',
      name:       r[3] || '',
      phone:      r[4] || '',
      policyId:   r[5] || '',
      vehicle:    r[6] || '',
      vin:        r[7] || '',
      department: r[8] || '',
      summary:    r[9] || '',
      details:    r[10] || '',
      status:     r[11] || '',
      assignedTo: r[12] || '',
      followUp:   r[13] || '',
      resolvedAt: r[14] || '',
    }));
  } catch (e) {
    console.error('getRequests error:', e.message);
    return [];
  }
}

export async function updateRequestStatus(rowIndex, status) {
  try {
    const sheets = await getSheets();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Requests!L${rowIndex + 2}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[status]] },
    });
    return true;
  } catch (e) {
    console.error('updateRequestStatus error:', e.message);
    return false;
  }
}
