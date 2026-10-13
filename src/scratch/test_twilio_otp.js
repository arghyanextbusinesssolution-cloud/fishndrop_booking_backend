const http = require('http');

const data = JSON.stringify({ phone: '+15139405811' });

const options = {
  hostname: 'localhost',
  port: 5001,
  path: '/api/auth/send-otp',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data)
  }
};

const req = http.request(options, (res) => {
  console.log(`STATUS: ${res.statusCode}`);
  let body = '';
  res.on('data', (chunk) => body += chunk);
  res.on('end', () => console.log('RESPONSE:', body));
});

req.on('error', (e) => console.error(`ERROR: ${e.message}`));
req.write(data);
req.end();
