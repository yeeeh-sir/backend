const { GoogleGenAI } = require('@google/genai');
require('dotenv').config();
(async () => {
  const g = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  try {
    const res = await g.models.list({});
    const str = JSON.stringify(res);
    const matches = [...str.matchAll(/"name"\s*:\s*"(models\/[^"]+)"/g)];
    matches.forEach(m => console.log(m[1]));
  } catch (e) {
    console.log('ERROR:', e.message);
  }
})();
