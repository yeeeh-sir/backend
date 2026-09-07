const http = require('http');
const { spawn } = require('child_process');

function request(port, path, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request({ hostname: 'localhost', port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, ...JSON.parse(d) }); } catch { resolve({ status: res.statusCode, raw: d }); } });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.setTimeout(90000, () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.write(data);
    req.end();
  });
}

async function main() {
  const server = spawn('node', ['server.js'], {
    cwd: 'C:\\Rubavutoday\\backend',
    env: { ...process.env, PORT: '5001' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  server.stderr.on('data', d => { stderr += d; });

  await new Promise((resolve, reject) => {
    const d = Date.now() + 60000;
    const i = setInterval(() => {
      const r = http.get('http://localhost:5001/api/health', (res) => { if (res.statusCode === 200) { clearInterval(i); resolve(); } });
      r.on('error', () => {});
      r.setTimeout(2000, () => r.destroy());
      if (Date.now() > d) { clearInterval(i); reject(new Error('timeout')); }
    }, 2000);
  });
  console.log('SERVER READY');

  const result = await request(5001, '/api/ai/chat', { question: 'Muraho' });
  console.log('RESULT:', JSON.stringify(result, null, 2));
  console.log('STDERR:', stderr.slice(-1000));

  server.kill('SIGTERM');
  process.exit(0);
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
