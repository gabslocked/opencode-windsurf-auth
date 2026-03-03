#!/usr/bin/env node
/**
 * Node.js gRPC wrapper for Bun HTTP/2 compatibility
 * 
 * Usage: node grpc-wrapper.js <port> <csrf> <path> <base64_body>
 * Returns: base64_response on stdout, exit code 0 on success
 */

const http2 = require('http2');

const [,, port, csrfToken, path, base64Body] = process.argv;

if (!port || !csrfToken || !path) {
  console.error('Usage: node grpc-wrapper.js <port> <csrf> <path> [base64_body]');
  process.exit(1);
}

const body = base64Body ? Buffer.from(base64Body, 'base64') : Buffer.alloc(0);

const client = http2.connect(`http://localhost:${port}`);
const chunks = [];
let grpcStatus = '0';
let grpcMessage = '';

client.on('error', (err) => {
  console.error(JSON.stringify({ error: err.message, code: err.code }));
  client.close();
  process.exit(1);
});

client.on('connect', () => {
  const req = client.request({
    ':method': 'POST',
    ':path': path,
    'content-type': 'application/grpc',
    'te': 'trailers',
    'x-codeium-csrf-token': csrfToken,
  });

  req.on('data', (chunk) => {
    chunks.push(chunk);
  });

  req.on('trailers', (trailers) => {
    grpcStatus = String(trailers['grpc-status'] ?? '0');
    grpcMessage = String(trailers['grpc-message'] ?? '');
  });

  req.on('end', () => {
    client.close();
    
    if (grpcStatus !== '0') {
      console.error(JSON.stringify({ 
        error: `gRPC error ${grpcStatus}: ${grpcMessage || 'Unknown error'}`,
        grpcStatus,
        grpcMessage 
      }));
      process.exit(1);
    }
    
    const full = Buffer.concat(chunks);
    // Strip gRPC frame header if present
    if (full.length >= 5 && full[0] === 0) {
      const msgLen = full.readUInt32BE(1);
      if (full.length >= 5 + msgLen) {
        console.log(full.subarray(5, 5 + msgLen).toString('base64'));
        process.exit(0);
      }
    }
    console.log(full.toString('base64'));
    process.exit(0);
  });

  req.on('error', (err) => {
    console.error(JSON.stringify({ error: err.message }));
    client.close();
    process.exit(1);
  });

  if (body.length > 0) {
    req.write(body);
  }
  req.end();
});

// Timeout
setTimeout(() => {
  console.error(JSON.stringify({ error: 'Timeout' }));
  client.close();
  process.exit(1);
}, 30000);
