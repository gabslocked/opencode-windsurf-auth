/**
 * Windsurf Credential Discovery Module
 * 
 * Automatically discovers credentials from the running Windsurf language server:
 * - CSRF token from process arguments
 * - Port from process arguments (extension_server_port + 2)
 * - API key from VSCode state database (~/Library/Application Support/Windsurf/User/globalStorage/state.vscdb)
 * - Version from process arguments
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ============================================================================
// Types
// ============================================================================

export interface WindsurfCredentials {
  /** CSRF token for authenticating with local language server */
  csrfToken: string;
  /** Port where the language server is listening */
  port: number;
  /** Codeium API key */
  apiKey: string;
  /** Windsurf version string */
  version: string;
}

export enum WindsurfErrorCode {
  NOT_RUNNING = 'NOT_RUNNING',
  CSRF_MISSING = 'CSRF_MISSING',
  API_KEY_MISSING = 'API_KEY_MISSING',
  CONNECTION_FAILED = 'CONNECTION_FAILED',
  AUTH_FAILED = 'AUTH_FAILED',
  STREAM_ERROR = 'STREAM_ERROR',
}

export class WindsurfError extends Error {
  code: WindsurfErrorCode;
  details?: unknown;

  constructor(message: string, code: WindsurfErrorCode, details?: unknown) {
    super(message);
    this.name = 'WindsurfError';
    this.code = code;
    this.details = details;
  }
}

// ============================================================================
// Config Paths
// ============================================================================

// Paths for API key discovery
const VSCODE_STATE_PATHS = {
  darwin: path.join(os.homedir(), 'Library/Application Support/Windsurf/User/globalStorage/state.vscdb'),
  linux: path.join(os.homedir(), '.config/Windsurf/User/globalStorage/state.vscdb'),
  win32: path.join(os.homedir(), 'AppData/Roaming/Windsurf/User/globalStorage/state.vscdb'),
} as const;

// Legacy config path (fallback)
const LEGACY_CONFIG_PATH = path.join(os.homedir(), '.codeium', 'config.json');

// Platform-specific process names
const LANGUAGE_SERVER_PATTERNS = {
  darwin: 'language_server_macos',
  linux: 'language_server_linux_x64',
  win32: 'language_server_windows',
} as const;

// ============================================================================
// Process Discovery
// ============================================================================

/**
 * Get the language server process pattern for the current platform
 */
function getLanguageServerPattern(): string {
  const platform = process.platform as keyof typeof LANGUAGE_SERVER_PATTERNS;
  return LANGUAGE_SERVER_PATTERNS[platform] || 'language_server';
}

/**
 * Get process listing for language server
 */
function getLanguageServerProcess(): string | null {
  const pattern = getLanguageServerPattern();
  
  try {
    if (process.platform === 'win32') {
      // Windows: use WMIC
      const output = execSync(
        `wmic process where "name like '%${pattern}%'" get CommandLine /format:list`,
        { encoding: 'utf8', timeout: 5000 }
      );
      return output;
    } else {
      // Unix-like: use ps
      const output = execSync(
        `ps aux | grep ${pattern}`,
        { encoding: 'utf8', timeout: 5000 }
      );
      return output;
    }
  } catch {
    return null;
  }
}

/**
 * Extract CSRF token from running Windsurf language server process
 */
export function getCSRFToken(): string {
  const processInfo = getLanguageServerProcess();
  
  if (!processInfo) {
    throw new WindsurfError(
      'Windsurf language server not found. Is Windsurf running?',
      WindsurfErrorCode.NOT_RUNNING
    );
  }
  
  const match = processInfo.match(/--csrf_token\s+([a-f0-9-]+)/);
  if (match?.[1]) {
    return match[1];
  }
  
  throw new WindsurfError(
    'CSRF token not found in Windsurf process. Is Windsurf running?',
    WindsurfErrorCode.CSRF_MISSING
  );
}

/**
 * Get the language server gRPC port dynamically using lsof
 * The port offset from extension_server_port varies (--random_port flag), so we use lsof
 */
export function getPort(): number {
  const processInfo = getLanguageServerProcess();
  
  if (!processInfo) {
    throw new WindsurfError(
      'Windsurf language server not found. Is Windsurf running?',
      WindsurfErrorCode.NOT_RUNNING
    );
  }
  
  // Extract PID from ps output (second column)
  const pidMatch = processInfo.match(/^\s*\S+\s+(\d+)/);
  const pid = pidMatch ? pidMatch[1] : null;
  
  // Get extension_server_port as a reference point
  const portMatch = processInfo.match(/--extension_server_port\s+(\d+)/);
  const extPort = portMatch ? parseInt(portMatch[1], 10) : null;
  
  // Use lsof to find actual listening ports for this specific PID
  if (process.platform === 'darwin' && pid) {
    try {
      const lsof = execSync(
        `lsof -a -p ${pid} -i -P -n 2>/dev/null | grep LISTEN`,
        { encoding: 'utf8', timeout: 15000 }
      );
      
      // lsof output: COMMAND PID USER FD TYPE ... NAME (e.g., "3u  IPv4 ... TCP 127.0.0.1:42863 (LISTEN)")
      // Parse fd (column 4, e.g., "3u") and port together, sort by fd ascending (lower fd = gRPC server)
      const portFdPairsMac: { port: number; fd: number }[] = [];
      for (const line of lsof.split('\n')) {
        const portMatch = line.match(/:([\d]+)\s+\(LISTEN\)/);
        const cols = line.trim().split(/\s+/);
        const fdNum = cols[3]?.match(/^(\d+)/);
        if (portMatch && fdNum) {
          portFdPairsMac.push({ port: parseInt(portMatch[1], 10), fd: parseInt(fdNum[1], 10) });
        }
      }
      if (portFdPairsMac.length > 0) {
        portFdPairsMac.sort((a, b) => a.fd - b.fd);
        const ports = portFdPairsMac.map(p => p.port);
        if (extPort) {
          const candidatePorts = ports.filter(p => p > extPort);
          if (candidatePorts.length > 0) {
            return candidatePorts[0];
          }
        }
        return ports[0];
      }
    } catch {
      // Fall through to offset-based approach
    }
  } else if (process.platform !== 'win32' && pid) {
    // Try lsof first (may not be installed on all Linux distros)
    try {
      const lsof = execSync(
        `lsof -p ${pid} -i -P -n 2>/dev/null | grep LISTEN`,
        { encoding: 'utf8', timeout: 15000 }
      );
      
      // lsof output: COMMAND PID USER FD TYPE ... NAME (e.g., "3u  IPv4 ... TCP 127.0.0.1:42863 (LISTEN)")
      // Parse fd and port together, sort by fd ascending (lower fd = gRPC server opened first)
      const portFdPairsLsof: { port: number; fd: number }[] = [];
      for (const line of lsof.split('\n')) {
        const portMatch = line.match(/:([\d]+)\s+\(LISTEN\)/);
        const cols = line.trim().split(/\s+/);
        const fdNum = cols[3]?.match(/^(\d+)/);
        if (portMatch && fdNum) {
          portFdPairsLsof.push({ port: parseInt(portMatch[1], 10), fd: parseInt(fdNum[1], 10) });
        }
      }
      if (portFdPairsLsof.length > 0) {
        portFdPairsLsof.sort((a, b) => a.fd - b.fd);
        const ports = portFdPairsLsof.map(p => p.port);
        if (extPort) {
          const candidatePorts = ports.filter(p => p > extPort);
          if (candidatePorts.length > 0) {
            return candidatePorts[0];
          }
        }
        return ports[0];
      }
    } catch {
      // lsof not available, fall through to ss
    }

    // Fallback: use ss (socket statistics) — always available on Linux
    try {
      const ss = execSync(
        `ss -tlnp 2>/dev/null | grep "pid=${pid}"`,
        { encoding: 'utf8', timeout: 15000 }
      );
      
      // ss output format: LISTEN 0 4096 127.0.0.1:PORT 0.0.0.0:*  users:(("proc",pid=X,fd=Y))
      // CRITICAL: ss output order is NOT guaranteed to be fd order.
      // We must parse fd explicitly and sort ascending — lower fd = socket opened first = main gRPC server.
      // Without this, ss may return the uvicorn web server port before the actual gRPC port.
      const portFdPairs: { port: number; fd: number }[] = [];
      for (const line of ss.split('\n')) {
        const portMatch = line.match(/(?:127\.0\.0\.1|\[::\]|\*):([0-9]+)/);
        const fdMatch = line.match(/\bfd=([0-9]+)/);
        if (portMatch && fdMatch) {
          const port = parseInt(portMatch[1], 10);
          const fd = parseInt(fdMatch[1], 10);
          if (port > 0) portFdPairs.push({ port, fd });
        }
      }
      if (portFdPairs.length > 0) {
        // Sort by fd ascending: lower fd = opened earlier = main gRPC server port
        portFdPairs.sort((a, b) => a.fd - b.fd);
        const ports = portFdPairs.map(p => p.port);
        if (extPort) {
          const candidatePorts = ports.filter(p => p > extPort);
          if (candidatePorts.length > 0) {
            return candidatePorts[0];
          }
        }
        return ports[0];
      }
    } catch {
      // Fall through to offset-based approach
    }
  }
  
  // Fallback: try common offsets (+3, +2, +4)
  if (extPort) {
    return extPort + 3;
  }
  
  throw new WindsurfError(
    'Windsurf language server port not found. Is Windsurf running?',
    WindsurfErrorCode.NOT_RUNNING
  );
}

/**
 * Read API key from VSCode state database (windsurfAuthStatus)
 * 
 * The API key is stored in the SQLite database at:
 * ~/Library/Application Support/Windsurf/User/globalStorage/state.vscdb
 * 
 * It's stored in the 'windsurfAuthStatus' key as JSON containing apiKey.
 */
export function getApiKey(): string {
  const platform = process.platform as keyof typeof VSCODE_STATE_PATHS;
  const statePath = VSCODE_STATE_PATHS[platform];
  
  if (!statePath) {
    throw new WindsurfError(
      `Unsupported platform: ${process.platform}`,
      WindsurfErrorCode.API_KEY_MISSING
    );
  }
  
  // Try to get API key from VSCode state database
  if (fs.existsSync(statePath)) {
    try {
      const result = execSync(
        `sqlite3 "${statePath}" "SELECT value FROM ItemTable WHERE key = 'windsurfAuthStatus';"`,
        { encoding: 'utf8', timeout: 5000 }
      ).trim();
      
      if (result) {
        const parsed = JSON.parse(result);
        if (parsed.apiKey) {
          return parsed.apiKey;
        }
      }
    } catch (error) {
      // Fall through to legacy config
    }
  }
  
  // Try legacy config file
  if (fs.existsSync(LEGACY_CONFIG_PATH)) {
    try {
      const config = fs.readFileSync(LEGACY_CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(config);
      if (parsed.apiKey) {
        return parsed.apiKey;
      }
    } catch {
      // Fall through
    }
  }
  
  throw new WindsurfError(
    'API key not found. Please login to Windsurf first.',
    WindsurfErrorCode.API_KEY_MISSING
  );
}

/**
 * Get Windsurf version from process arguments
 */
export function getWindsurfVersion(): string {
  const processInfo = getLanguageServerProcess();
  
  if (processInfo) {
    const match = processInfo.match(/--windsurf_version\s+([^\s]+)/);
    if (match) {
      // Extract just the version number (before + if present)
      const version = match[1].split('+')[0];
      return version;
    }
  }
  
  // Default fallback version
  return '1.13.104';
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Get all credentials needed to communicate with Windsurf
 */
export function getCredentials(): WindsurfCredentials {
  return {
    csrfToken: getCSRFToken(),
    port: getPort(),
    apiKey: getApiKey(),
    version: getWindsurfVersion(),
  };
}

/**
 * Check if Windsurf is running and accessible
 */
export function isWindsurfRunning(): boolean {
  try {
    getCSRFToken();
    getPort();
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if Windsurf is installed (app exists)
 */
export function isWindsurfInstalled(): boolean {
  if (process.platform === 'darwin') {
    return fs.existsSync('/Applications/Windsurf.app');
  } else if (process.platform === 'linux') {
    return (
      fs.existsSync('/usr/share/windsurf') ||
      fs.existsSync(path.join(os.homedir(), '.local/share/windsurf'))
    );
  } else if (process.platform === 'win32') {
    return (
      fs.existsSync('C:\\Program Files\\Windsurf') ||
      fs.existsSync(path.join(os.homedir(), 'AppData\\Local\\Programs\\Windsurf'))
    );
  }
  return false;
}

/**
 * Validate credentials structure
 */
export function validateCredentials(credentials: Partial<WindsurfCredentials>): credentials is WindsurfCredentials {
  return (
    typeof credentials.csrfToken === 'string' &&
    credentials.csrfToken.length > 0 &&
    typeof credentials.port === 'number' &&
    credentials.port > 0 &&
    typeof credentials.apiKey === 'string' &&
    credentials.apiKey.length > 0 &&
    typeof credentials.version === 'string'
  );
}
