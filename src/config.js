// ─── Department Extensions ───────────────────────────────────────────────────
// Replace phoneNumber values with your real agent phone numbers

export const EXTENSIONS = {
  '101': {
    name: 'Sales',
    phoneNumber: process.env.EXT_SALES || '+15550000101',
    description: 'New quotes, pricing, renewals',
  },
  '102': {
    name: 'Claims / Service',
    phoneNumber: process.env.EXT_CLAIMS || '+15550000102',
    description: 'Filing claims, claim status',
  },
  '103': {
    name: 'Accounting',
    phoneNumber: process.env.EXT_ACCOUNTING || '+15550000103',
    description: 'Billing, invoices, payments',
  },
  '104': {
    name: 'Management',
    phoneNumber: process.env.EXT_MANAGEMENT || '+15550000104',
    description: 'Escalations, complaints, appeals',
  },
  '199': {
    name: 'Voicemail',
    phoneNumber: null, // handled via Twilio recording
    description: 'After hours / unavailable',
  },
};

// ─── Greetings & Messages ────────────────────────────────────────────────────

export const GREETINGS = {
  welcome: `Thank you for calling AutoShield Warranty. I'm your virtual assistant. 
            I can help route your call or look up your warranty status. 
            Could I get your name and the reason for your call today?`,
};

export const AFTER_HOURS_MSG = `Thank you for calling AutoShield Warranty. 
  Our office is currently closed. Business hours are Monday through Friday, 
  9 AM to 6 PM Eastern Time. 
  Please leave your name, phone number, and a brief message after the tone, 
  and we'll return your call the next business day.`;
