const { GoogleGenAI } = require('@google/genai');
require('dotenv').config();

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  console.log('Key length:', apiKey?.length);
  console.log('Model:', model);

  const genai = new GoogleGenAI({ apiKey });

  try {
    const response = await genai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: 'Hello, respond with just "Hi" in Kinyarwanda.' }] }],
      config: {
        temperature: 0.3,
        maxOutputTokens: 50,
      }
    });
    console.log('RESPONSE:', JSON.stringify(response).slice(0, 500));
    console.log('TEXT:', response.text);
  } catch (e) {
    console.error('GEMINI ERROR:', e.message);
    console.error('FULL:', JSON.stringify(e, null, 2).slice(0, 1000));
  }

  process.exit(0);
}
main();
