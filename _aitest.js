const { init, getPool } = require('./database/db');
const http = require('http');

async function testAIChat(question, label) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ question });
    const req = http.request({
      hostname: 'localhost',
      port: 5001,
      path: '/api/ai/chat',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ label, status: res.statusCode, ...parsed });
        } catch {
          resolve({ label, status: res.statusCode, raw: data });
        }
      });
    });
    req.on('error', (e) => resolve({ label, error: e.message }));
    req.setTimeout(60000, () => { req.destroy(); resolve({ label, error: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

async function main() {
  // Start server as child
  const { spawn } = require('child_process');
  const server = spawn('node', ['server.js'], {
    cwd: 'C:\\Rubavutoday\\backend',
    env: { ...process.env, PORT: '5001' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderr = '';
  server.stderr.on('data', d => stderr += d);

  // Wait for port
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 60000;
    const check = setInterval(async () => {
      try {
        const req = http.get('http://localhost:5001/api/health', (res) => {
          if (res.statusCode === 200) { clearInterval(check); resolve(); }
        });
        req.on('error', () => {});
        req.setTimeout(2000, () => req.destroy());
      } catch {}
      if (Date.now() > deadline) { clearInterval(check); reject(new Error('Server did not start')); }
    }, 2000);
  });

  console.log('=== SERVER STARTED ===');

  // Run tests
  const tests = [
    { q: 'Muraho! Ni ayahe makuru mashya kuri Rubavu uyu munsi?', label: 'Kinyarwanda latest news' },
    { q: 'What is the latest news on Rubavu Today?', label: 'English latest news' },
    { q: 'What are the categories on Rubavu Today?', label: 'Category question' },
    { q: 'Tell me about the article on APR FC football', label: 'Specific article' },
    { q: 'How do I bake a chocolate cake?', label: 'No matching article' },
  ];

  const results = [];
  for (const t of tests) {
    console.log(`Testing: ${t.label}...`);
    const result = await testAIChat(t.q, t.label);
    results.push(result);
    console.log(`  Status: ${result.status}`);
    if (result.answer) {
      console.log(`  Answer (first 200 chars): ${result.answer.slice(0, 200)}`);
    }
    if (result.sources) {
      console.log(`  Sources count: ${result.sources.length}`);
      result.sources.forEach(s => console.log(`    - ${s.title} | ${s.url} | ${s.date}`));
    }
    if (result.error) console.log(`  Error: ${result.error}`);
  }

  // Kill server
  server.kill('SIGTERM');

  console.log('\n=== FULL RESULTS ===');
  console.log(JSON.stringify(results, null, 2));

  // Check key not in response
  const allJSON = JSON.stringify(results);
  if (allJSON.includes('YOUR_GEMINI') || allJSON.includes('sk-proj')) {
    console.log('\n!!! SECURITY: API key leaked in response !!!');
  } else {
    console.log('\nSecurity check: PASS - no keys in response');
  }

  process.exit(0);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
