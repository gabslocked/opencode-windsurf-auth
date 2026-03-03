#!/usr/bin/env node
/**
 * Node.js gRPC wrapper for Bun HTTP/2 compatibility
 * 
 * Usage: node grpc-wrapper.mjs <port> <csrf> <path> <body_file>
 * body_file: path to a file containing the raw gRPC body bytes
 * Returns: base64_response on stdout, exit code 0 on success
 */

import http2 from 'http2';
import fs from 'fs';

const [,, port, csrfToken, path, bodyFile] = process.argv;

if (!port || !csrfToken || !path || !bodyFile) {
  console.error('Usage: node grpc-wrapper.mjs <port> <csrf> <path> <body_file>');
  process.exit(1);
}

const body = fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile) : Buffer.alloc(0);
// Clean up temp file immediately after reading
try { fs.unlinkSync(bodyFile); } catch { /* ignore */ }

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
    // Write raw response to stdout as binary (no base64 needed — caller reads file)
    // Strip gRPC frame header (5 bytes) if present
    if (full.length >= 5 && full[0] === 0) {
      const msgLen = full.readUInt32BE(1);
      if (full.length >= 5 + msgLen) {
        process.stdout.write(full.subarray(5, 5 + msgLen).toString('base64'));
        process.exit(0);
      }
    }
    process.stdout.write(full.toString('base64'));
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
