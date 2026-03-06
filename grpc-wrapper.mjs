#!/usr/bin/env node
/**
 * Node.js gRPC wrapper for Bun HTTP/2 compatibility
 * 
 * Unary mode (default):
 *   Usage: node grpc-wrapper.mjs <port> <csrf> <path> <body_file>
 *   body_file: path to a file containing the raw gRPC body bytes
 *   Returns: base64_response on stdout, exit code 0 on success
 *
 * Stream mode:
 *   Usage: node grpc-wrapper.mjs <port> <csrf> <path> <body_file> --stream
 *   Each gRPC data chunk is written to stdout as:
 *     CHUNK:<base64_of_raw_chunk>\n
 *   On trailers with non-zero status:
 *     ERROR:<json>\n
 *   On completion:
 *     DONE\n
 */

import http2 from 'http2';
import fs from 'fs';

const args = process.argv.slice(2);
const streamMode = args.includes('--stream');
const [port, csrfToken, path, bodyFile] = args.filter(a => a !== '--stream');

if (!port || !csrfToken || !path || !bodyFile) {
  console.error('Usage: node grpc-wrapper.mjs <port> <csrf> <path> <body_file> [--stream]');
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
  if (streamMode) {
    process.stdout.write(`ERROR:${JSON.stringify({ error: err.message, code: err.code })}\n`);
    client.close();
    process.exit(1);
  } else {
    console.error(JSON.stringify({ error: err.message, code: err.code }));
    client.close();
    process.exit(1);
  }
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
    if (streamMode) {
      // Emit each raw chunk immediately for streaming consumers
      process.stdout.write(`CHUNK:${chunk.toString('base64')}\n`);
    } else {
      chunks.push(chunk);
    }
  });

  req.on('trailers', (trailers) => {
    grpcStatus = String(trailers['grpc-status'] ?? '0');
    grpcMessage = String(trailers['grpc-message'] ?? '');
  });

  req.on('end', () => {
    client.close();

    if (grpcStatus !== '0') {
      const errJson = JSON.stringify({
        error: `gRPC error ${grpcStatus}: ${grpcMessage || 'Unknown error'}`,
        grpcStatus,
        grpcMessage
      });
      if (streamMode) {
        process.stdout.write(`ERROR:${errJson}\n`);
        process.exit(1);
      } else {
        console.error(errJson);
        process.exit(1);
      }
    }

    if (streamMode) {
      process.stdout.write('DONE\n');
      process.exit(0);
    } else {
      const full = Buffer.concat(chunks);
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
    }
  });

  req.on('error', (err) => {
    const errJson = JSON.stringify({ error: err.message });
    if (streamMode) {
      process.stdout.write(`ERROR:${errJson}\n`);
    } else {
      console.error(errJson);
    }
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
  const errJson = JSON.stringify({ error: 'Timeout' });
  if (streamMode) {
    process.stdout.write(`ERROR:${errJson}\n`);
  } else {
    console.error(errJson);
  }
  client.close();
  process.exit(1);
}, 30000);
