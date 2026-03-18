export const EXTENSIONS = {
  '101': { name: 'Sales',      phoneNumber: process.env.EXT_SALES       || '+15550000101' },
  '102': { name: 'Claims',     phoneNumber: process.env.EXT_CLAIMS      || '+15550000102' },
  '103': { name: 'Accounting', phoneNumber: process.env.EXT_ACCOUNTING  || '+15550000103' },
  '104': { name: 'Management', phoneNumber: process.env.EXT_MANAGEMENT  || '+15550000104' },
  '199': { name: 'Voicemail',  phoneNumber: null },
};

export const GREETINGS = {
  welcome: "Thank you for calling A-Protect Warranty. I'm your virtual assistant. Could I get your name and the reason for your call today?",
};

export const AFTER_HOURS_MSG = "Thank you for calling A-Protect Warranty. Our office is currently closed. Business hours are Monday to Friday, 9 AM to 5 PM Eastern Time. Please leave your name, phone number, and a brief message after the tone and we will get back to you next business day.";
