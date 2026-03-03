/**
 * gRPC Client for Windsurf Language Server
 * 
 * Implements HTTP/2-based gRPC communication with the local Windsurf language server.
 * Uses manual protobuf encoding (no external protobuf library needed).
 * 
 * Two code paths:
 *   - Legacy (RawGetChatMessage): for older models with enum < 280 and no modelUid
 *   - Cascade flow (StartCascade → SendUserCascadeMessage → poll): for all premium models
 */

import * as http2 from 'http2';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { ChatMessageSource } from './types.js';
import { resolveModel } from './models.js';
import { WindsurfCredentials, WindsurfError, WindsurfErrorCode, getCredentials } from './auth.js';
import { getMetadataFields } from './discovery.js';

// ============================================================================
// Bun/Node.js Runtime Detection
// ============================================================================

const IS_BUN = typeof (process as any).isBun !== 'undefined' || 
               (process.versions as any).bun !== undefined;

// ============================================================================
// Types
// ============================================================================
// Types
// ============================================================================

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
}

export interface StreamChatOptions {
  model: string;
  messages: ChatMessage[];
  onChunk?: (text: string) => void;
  onComplete?: (fullText: string) => void;
  onError?: (error: Error) => void;
  variantOverride?: string;
}

// ============================================================================
// Protobuf Encoding Helpers
// ============================================================================

/**
 * Encode a number as a varint (variable-length integer)
 */
function encodeVarint(value: number | bigint): number[] {
  const bytes: number[] = [];
  let v = BigInt(value);
  while (v > 127n) {
    bytes.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  bytes.push(Number(v));
  return bytes;
}

/**
 * Encode a string field (wire type 2: length-delimited)
 */
function encodeString(fieldNum: number, str: string): number[] {
  const strBytes = Buffer.from(str, 'utf8');
  return [...encodeVarint((fieldNum << 3) | 2), ...encodeVarint(strBytes.length), ...strBytes];
}

/**
 * Encode a nested message field (wire type 2: length-delimited)
 */
function encodeMessage(fieldNum: number, data: number[]): number[] {
  return [...encodeVarint((fieldNum << 3) | 2), ...encodeVarint(data.length), ...data];
}

/**
 * Encode a varint field (wire type 0)
 */
function encodeVarintField(fieldNum: number, value: number | bigint): number[] {
  return [...encodeVarint((fieldNum << 3) | 0), ...encodeVarint(value)];
}

// ============================================================================
// Request Building
// ============================================================================

/**
 * Generate a UUID for message and conversation IDs
 */
function generateUUID(): string {
  return crypto.randomUUID();
}

/**
 * Encode a google.protobuf.Timestamp
 * Field 1: seconds (int64)
 * Field 2: nanos (int32)
 */
function encodeTimestamp(): number[] {
  const now = Date.now();
  const seconds = Math.floor(now / 1000);
  const nanos = (now % 1000) * 1_000_000;

  const bytes: number[] = [];
  bytes.push(...encodeVarintField(1, seconds));
  if (nanos > 0) {
    bytes.push(...encodeVarintField(2, nanos));
  }
  return bytes;
}

/**
 * Encode IntentGeneric message
 * Field 1: text (string)
 */
function encodeIntentGeneric(text: string): number[] {
  return encodeString(1, text);
}

/**
 * Encode ChatMessageIntent message
 * Field 1: generic (IntentGeneric, oneof)
 * Field 12: num_tokens (int32)
 */
function encodeChatMessageIntent(text: string): number[] {
  const generic = encodeIntentGeneric(text);
  return encodeMessage(1, generic);
}

/**
 * Encode a ChatMessage for the RawGetChatMessageRequest
 * 
 * ChatMessage structure (from reverse engineering):
 * Field 1: message_id (string, required)
 * Field 2: source (enum: 1=USER, 2=SYSTEM, 3=ASSISTANT)
 * Field 3: timestamp (google.protobuf.Timestamp, required)
 * Field 4: conversation_id (string, required)
 * Field 5: For USER/SYSTEM/TOOL: intent (ChatMessageIntent)
 *          For ASSISTANT: text (string)
 */
function encodeChatMessage(content: string, source: number, conversationId: string): number[] {
  const messageId = generateUUID();
  const bytes: number[] = [];

  // Field 1: message_id (required)
  bytes.push(...encodeString(1, messageId));

  // Field 2: source
  bytes.push(...encodeVarintField(2, source));

  // Field 3: timestamp (required)
  const timestamp = encodeTimestamp();
  bytes.push(...encodeMessage(3, timestamp));

  // Field 4: conversation_id (required)
  bytes.push(...encodeString(4, conversationId));

  // Field 5: content
  if (source === ChatMessageSource.ASSISTANT) {
    // Assistant replies use plain text field
    bytes.push(...encodeString(5, content));
  } else {
    const intent = encodeChatMessageIntent(content);
    bytes.push(...encodeMessage(5, intent));
  }

  return bytes;
}

/**
 * Build the metadata message for Cascade requests
 * Uses hardcoded field numbers that work with StartCascade/SendUserCascadeMessage
 * 
 * Discovered field mapping for Cascade:
 *   api_key: 3, ide_name: 1, ide_version: 7, extension_version: 2, session_id: 10, locale: 4
 */
function encodeCascadeMetadata(apiKey: string, version: string): number[] {
  return [
    ...encodeString(3, apiKey),                    // api_key = 3
    ...encodeString(1, 'vscode'),                  // ide_name = 1
    ...encodeString(7, version),                   // ide_version = 7
    ...encodeString(2, version),                   // extension_version = 2 (use windsurf version)
    ...encodeString(10, generateUUID()),           // session_id = 10
    ...encodeString(4, 'en-US'),                   // locale = 4
  ];
}

/**
 * Build the metadata message for RawGetChatMessage requests
 * Dynamically maps fields using discovered extension.js values
 */
function encodeMetadata(apiKey: string, version: string): number[] {
  const fields = getMetadataFields();

  return [
    ...encodeString(fields.api_key, apiKey),                    // api_key
    ...encodeString(fields.ide_name, 'windsurf'),               // ide_name
    ...encodeString(fields.ide_version, version),               // ide_version
    ...encodeString(fields.extension_version, version),         // extension_version
    // Optional fields
    ...(fields.session_id ? encodeString(fields.session_id, generateUUID()) : []),
    ...(fields.locale ? encodeString(fields.locale, 'en') : []),
    // Add extension_name equivalent if needed (often mapped to 12 in older versions or same as ide_name)
    // For safety, we only encode defined discovered fields
  ];
}

/**
 * Map role string to ChatMessageSource enum value
 */
function roleToSource(role: string): number {
  switch (role) {
    case 'user':
      return ChatMessageSource.USER;
    case 'assistant':
      return ChatMessageSource.ASSISTANT;
    case 'system':
      return ChatMessageSource.SYSTEM;
    case 'tool':
      return ChatMessageSource.TOOL;
    default:
      return ChatMessageSource.USER;
  }
}

/**
 * Build the complete chat request buffer using RawGetChatMessageRequest format
 * 
 * RawGetChatMessageRequest structure:
 * Field 1: metadata (Metadata message)
 * Field 2: chat_messages (repeated ChatMessage)
 * Field 3: system_prompt_override (string) - optional
 * Field 4: chat_model (enum: Model)
 * Field 5: chat_model_name (string) - optional
 */
function buildChatRequest(
  apiKey: string,
  version: string,
  modelEnum: number,
  messages: ChatMessage[],
  modelName?: string
): Buffer {
  const metadata = encodeMetadata(apiKey, version);
  const conversationId = generateUUID();

  // Build the request with all messages
  const request: number[] = [];

  // Field 1: metadata
  request.push(...encodeMessage(1, metadata));

  // Field 2: chat_messages (repeated ChatMessage)
  // Extract system message if present and handle separately
  let systemPrompt = '';
  for (const msg of messages) {
    if (msg.role === 'system') {
      systemPrompt = msg.content;
    } else {
      // Encode each message as ChatMessage with ChatMessageIntent
      const source = roleToSource(msg.role);
      const chatMsg = encodeChatMessage(msg.content, source, conversationId);
      request.push(...encodeMessage(2, chatMsg));
    }
  }

  // Field 3: system_prompt_override (if we have a system message)
  if (systemPrompt) {
    request.push(...encodeString(3, systemPrompt));
  }

  // Field 4: model enum
  request.push(...encodeVarintField(4, modelEnum));

  // Field 5: chat_model_name (string) if provided
  if (modelName) {
    request.push(...encodeString(5, modelName));
  }

  const payload = Buffer.from(request);

  // gRPC framing: 1 byte compression flag (0) + 4 bytes length + payload
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = 0; // No compression
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, 5);

  return frame;
}

// ============================================================================
// Cascade Flow Request Building
// ============================================================================

/**
 * Build StartCascadeRequest
 * 
 * StartCascadeRequest:
 *   Field 1: metadata (Metadata)
 *   Field 4: source (CortexTrajectorySource enum, 0=unspecified)
 *   Field 5: trajectory_type (CortexTrajectoryType enum, 0=unspecified)
 */
function buildStartCascadeRequest(apiKey: string, version: string): Buffer {
  const metadata = encodeCascadeMetadata(apiKey, version);
  const request: number[] = [];

  // Field 1: metadata
  request.push(...encodeMessage(1, metadata));
  // Field 4: source = 0 (CORTEX_TRAJECTORY_SOURCE_UNSPECIFIED)
  // Field 5: trajectory_type = 0 (CORTEX_TRAJECTORY_TYPE_UNSPECIFIED)
  // Both are 0 so we can omit them (proto3 default)

  return grpcFrame(Buffer.from(request));
}

/**
 * Build SendUserCascadeMessageRequest
 * 
 * SendUserCascadeMessageRequest:
 *   Field 1: cascade_id (string)
 *   Field 2: items (repeated TextOrScopeItem)
 *   Field 3: metadata (Metadata)
 *   Field 5: cascade_config (CascadeConfig)
 * 
 * TextOrScopeItem:
 *   Field 1: text (string)
 * 
 * CascadeConfig:
 *   Field 1: planner_config (CascadePlannerConfig)
 *   Field 7: brain_config (BrainConfig)
 * 
 * CascadePlannerConfig:
 *   Field 2: conversational (CascadeConversationalPlannerConfig)
 *   Field 13: tool_config (CascadeToolConfig)
 *   Field 35: requested_model_uid (string) — for string-UID models
 *   Field 15: requested_model_deprecated (ModelOrAlias) — for enum models
 * 
 * CascadeConversationalPlannerConfig:
 *   Field 4: planner_mode (ConversationalPlannerMode, 1=CONVERSATIONAL)
 * 
 * CascadeToolConfig:
 *   Field 8: run_command (RunCommandToolConfig)
 * 
 * RunCommandToolConfig:
 *   Field 3: auto_command_config (AutoCommandConfig)
 * 
 * AutoCommandConfig:
 *   Field 6: auto_execution_policy (CascadeCommandsAutoExecution, 3=ALWAYS)
 * 
 * BrainConfig:
 *   Field 1: enabled (bool)
 *   Field 6: update_strategy (BrainUpdateStrategy)
 * 
 * BrainUpdateStrategy:
 *   Field 6: dynamic_update (DynamicBrainUpdateConfig, empty message)
 * 
 * ModelOrAlias:
 *   Field 1: model (Model enum)
 *   Field 3: model_uid (string)
 */
function buildSendCascadeMessageRequest(
  apiKey: string,
  version: string,
  cascadeId: string,
  text: string,
  modelEnum: number,
  modelUid?: string
): Buffer {
  const metadata = encodeCascadeMetadata(apiKey, version);

  // TextOrScopeItem: field 1 = text
  const textItem = encodeString(1, text);

  // ModelOrAlias for the requested model
  let requestedModelBytes: number[];
  if (modelUid) {
    // String-UID model: field 3 = model_uid
    requestedModelBytes = encodeString(3, modelUid);
  } else {
    // Enum model: field 1 = model enum value
    requestedModelBytes = encodeVarintField(1, modelEnum);
  }

  // CascadeConversationalPlannerConfig: field 4 = planner_mode = 1 (CONVERSATIONAL)
  const conversationalConfig = encodeVarintField(4, 1);

  // AutoCommandConfig: field 6 = auto_execution_policy = 3 (ALWAYS)
  const autoCommandConfig = encodeVarintField(6, 3);

  // RunCommandToolConfig: field 3 = auto_command_config
  const runCommandConfig = encodeMessage(3, autoCommandConfig);

  // CascadeToolConfig: field 8 = run_command
  const toolConfig = encodeMessage(8, runCommandConfig);

  // CascadePlannerConfig:
  //   field 2 = conversational
  //   field 13 = tool_config
  //   field 35 = requested_model_uid (string-UID) OR field 15 = requested_model_deprecated (ModelOrAlias)
  const plannerConfig: number[] = [
    ...encodeMessage(2, conversationalConfig),
    ...encodeMessage(13, toolConfig),
  ];
  if (modelUid) {
    // field 35: requested_model_uid (string)
    plannerConfig.push(...encodeString(35, modelUid));
  } else {
    // field 15: requested_model_deprecated (ModelOrAlias)
    plannerConfig.push(...encodeMessage(15, requestedModelBytes));
  }

  // DynamicBrainUpdateConfig: empty message
  const dynamicBrainUpdate: number[] = [];

  // BrainUpdateStrategy: field 6 = dynamic_update
  const brainUpdateStrategy = encodeMessage(6, dynamicBrainUpdate);

  // BrainConfig: field 1 = enabled (true=1), field 6 = update_strategy
  const brainConfig: number[] = [
    ...encodeVarintField(1, 1),
    ...encodeMessage(6, brainUpdateStrategy),
  ];

  // CascadeConfig: field 1 = planner_config, field 7 = brain_config
  const cascadeConfig: number[] = [
    ...encodeMessage(1, plannerConfig),
    ...encodeMessage(7, brainConfig),
  ];

  // Build the full request
  const request: number[] = [];

  // Field 1: cascade_id
  request.push(...encodeString(1, cascadeId));

  // Field 2: items (repeated TextOrScopeItem)
  request.push(...encodeMessage(2, textItem));

  // Field 3: metadata
  request.push(...encodeMessage(3, metadata));

  // Field 5: cascade_config
  request.push(...encodeMessage(5, cascadeConfig));

  return grpcFrame(Buffer.from(request));
}

/**
 * Build GetCascadeTrajectoryStepsRequest
 * 
 * Field 1: cascade_id (string)
 * Field 2: step_offset (uint32)
 */
function buildGetTrajectoryStepsRequest(cascadeId: string, stepOffset: number = 0): Buffer {
  const request: number[] = [];
  request.push(...encodeString(1, cascadeId));
  if (stepOffset > 0) {
    request.push(...encodeVarintField(2, stepOffset));
  }
  return grpcFrame(Buffer.from(request));
}

/**
 * Build GetCascadeTrajectoryRequest (for status polling)
 * 
 * Field 1: cascade_id (string)
 */
function buildGetTrajectoryRequest(cascadeId: string): Buffer {
  const request: number[] = [];
  request.push(...encodeString(1, cascadeId));
  return grpcFrame(Buffer.from(request));
}

/**
 * Wrap a protobuf payload in a gRPC frame
 * Format: 1 byte compression (0) + 4 bytes length + payload
 */
function grpcFrame(payload: Buffer): Buffer {
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = 0; // No compression
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, 5);
  return frame;
}

// ============================================================================
// Response Parsing (Protobuf Decoding)
// ============================================================================

/**
 * Decode a varint from a buffer starting at offset
 * @returns [value, bytesRead]
 */
function decodeVarint(buffer: Buffer, offset: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  let bytesRead = 0;

  while (offset + bytesRead < buffer.length) {
    const byte = buffer[offset + bytesRead];
    bytesRead++;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      break;
    }
    shift += 7n;
  }

  return [result, bytesRead];
}

/**
 * Parse a protobuf field from buffer
 * @returns { fieldNum, wireType, value, bytesConsumed } or null if can't parse
 */
function parseProtobufField(buffer: Buffer, offset: number): {
  fieldNum: number;
  wireType: number;
  value: Buffer | bigint;
  bytesConsumed: number
} | null {
  if (offset >= buffer.length) return null;

  const [tag, tagBytes] = decodeVarint(buffer, offset);
  const fieldNum = Number(tag >> 3n);
  const wireType = Number(tag & 0x7n);

  let bytesConsumed = tagBytes;
  let value: Buffer | bigint;

  switch (wireType) {
    case 0: // Varint
      const [varintValue, varintBytes] = decodeVarint(buffer, offset + bytesConsumed);
      value = varintValue;
      bytesConsumed += varintBytes;
      break;

    case 2: // Length-delimited (string, bytes, embedded message)
      const [length, lengthBytes] = decodeVarint(buffer, offset + bytesConsumed);
      bytesConsumed += lengthBytes;
      const len = Number(length);
      if (offset + bytesConsumed + len > buffer.length) {
        // Not enough data
        return null;
      }
      value = buffer.subarray(offset + bytesConsumed, offset + bytesConsumed + len);
      bytesConsumed += len;
      break;

    case 1: // 64-bit (fixed64, sfixed64, double)
      if (offset + bytesConsumed + 8 > buffer.length) return null;
      value = buffer.subarray(offset + bytesConsumed, offset + bytesConsumed + 8);
      bytesConsumed += 8;
      break;

    case 5: // 32-bit (fixed32, sfixed32, float)
      if (offset + bytesConsumed + 4 > buffer.length) return null;
      value = buffer.subarray(offset + bytesConsumed, offset + bytesConsumed + 4);
      bytesConsumed += 4;
      break;

    default:
      // Unknown wire type, can't parse
      return null;
  }

  return { fieldNum, wireType, value, bytesConsumed };
}

/**
 * Extract text from RawChatMessage protobuf
 * 
 * RawChatMessage structure:
 * Field 1: message_id (string)
 * Field 2: source (enum)
 * Field 3: timestamp (message)
 * Field 4: conversation_id (string)
 * Field 5: text (string) ← What we want
 * Field 6: in_progress (bool)
 * Field 7: is_error (bool)
 */
function extractTextFromRawChatMessage(buffer: Buffer): string {
  let offset = 0;

  while (offset < buffer.length) {
    const field = parseProtobufField(buffer, offset);
    if (!field) break;

    offset += field.bytesConsumed;

    // Field 5 is the text content
    if (field.fieldNum === 5 && field.wireType === 2 && Buffer.isBuffer(field.value)) {
      return field.value.toString('utf8');
    }
  }

  return '';
}

/**
 * Extract text from RawGetChatMessageResponse protobuf
 * 
 * RawGetChatMessageResponse structure:
 * Field 1: delta_message (RawChatMessage)
 */
function extractTextFromResponse(buffer: Buffer): string {
  let offset = 0;

  while (offset < buffer.length) {
    const field = parseProtobufField(buffer, offset);
    if (!field) break;

    offset += field.bytesConsumed;

    // Field 1 is delta_message (RawChatMessage)
    if (field.fieldNum === 1 && field.wireType === 2 && Buffer.isBuffer(field.value)) {
      const text = extractTextFromRawChatMessage(field.value);
      if (text) return text;
    }
  }

  return '';
}

/**
 * Extract readable text from a gRPC response chunk
 * 
 * The response is gRPC-framed: 1 byte compression + 4 bytes length + protobuf payload
 * We parse the protobuf to extract the text field from RawChatMessage.
 */
function extractTextFromChunk(chunk: Buffer): string {
  // gRPC frame: 1 byte compression flag + 4 bytes message length + message
  // Multiple messages may be concatenated in a single chunk

  const results: string[] = [];
  let offset = 0;

  while (offset + 5 <= chunk.length) {
    const compressed = chunk[offset];
    const messageLength = chunk.readUInt32BE(offset + 1);

    if (compressed !== 0) {
      // Compressed data not supported, skip
      offset += 5 + messageLength;
      continue;
    }

    if (offset + 5 + messageLength > chunk.length) {
      // Not enough data for the full message, try as raw protobuf
      break;
    }

    const messageData = chunk.subarray(offset + 5, offset + 5 + messageLength);
    const text = extractTextFromResponse(messageData);

    if (text) {
      results.push(text);
    }

    offset += 5 + messageLength;
  }

  // If we extracted text from proper protobuf parsing, return it
  if (results.length > 0) {
    return results.join('');
  }

  // Fallback: try parsing the entire chunk as protobuf (in case framing was already stripped)
  const fallbackText = extractTextFromResponse(chunk);
  if (fallbackText) {
    return fallbackText;
  }

  // Last resort: heuristic extraction for edge cases
  return '';
}

// ============================================================================
// Cascade Response Parsing
// ============================================================================

/**
 * Parse StartCascadeResponse to extract cascade_id
 * 
 * StartCascadeResponse:
 *   Field 1: cascade_id (string)
 */
function parseStartCascadeResponse(buffer: Buffer): string {
  let offset = 0;
  while (offset < buffer.length) {
    const field = parseProtobufField(buffer, offset);
    if (!field) break;
    offset += field.bytesConsumed;
    if (field.fieldNum === 1 && field.wireType === 2 && Buffer.isBuffer(field.value)) {
      return field.value.toString('utf8');
    }
  }
  return '';
}

/**
 * Parse GetCascadeTrajectoryResponse to extract status
 * 
 * GetCascadeTrajectoryResponse:
 *   Field 1: trajectory (CortexTrajectory)
 *   Field 2: status (CascadeRunStatus enum)
 *     CASCADE_RUN_STATUS_IDLE = 1
 *     CASCADE_RUN_STATUS_RUNNING = 2
 */
function parseTrajectoryStatus(buffer: Buffer): number {
  let offset = 0;
  while (offset < buffer.length) {
    const field = parseProtobufField(buffer, offset);
    if (!field) break;
    offset += field.bytesConsumed;
    if (field.fieldNum === 2 && field.wireType === 0 && typeof field.value === 'bigint') {
      return Number(field.value);
    }
  }
  return 0; // UNSPECIFIED
}

/**
 * Parse GetCascadeTrajectoryStepsResponse to extract planner response text
 * 
 * GetCascadeTrajectoryStepsResponse:
 *   Field 1: steps (repeated CortexTrajectoryStep)
 * 
 * CortexTrajectoryStep:
 *   Field 1: type (CortexStepType enum)
 *     CORTEX_STEP_TYPE_PLANNER_RESPONSE = 15
 *   Field 4: status (CortexStepStatus enum)
 *     CORTEX_STEP_STATUS_DONE = 3
 *     CORTEX_STEP_STATUS_GENERATING = 8
 *   Field 20: planner_response (CortexStepPlannerResponse)
 * 
 * CortexStepPlannerResponse:
 *   Field 1: response (string) ← the text
 *   Field 3: thinking (string)
 */
interface ParsedStep {
  type: number;
  status: number;
  text: string;
  thinking: string;
}

function parsePlannerResponseStep(stepBuffer: Buffer): ParsedStep {
  let offset = 0;
  let type = 0;
  let status = 0;
  let text = '';
  let thinking = '';

  while (offset < stepBuffer.length) {
    const field = parseProtobufField(stepBuffer, offset);
    if (!field) break;
    offset += field.bytesConsumed;

    if (field.fieldNum === 1 && field.wireType === 0 && typeof field.value === 'bigint') {
      type = Number(field.value);
    } else if (field.fieldNum === 4 && field.wireType === 0 && typeof field.value === 'bigint') {
      status = Number(field.value);
    } else if (field.fieldNum === 20 && field.wireType === 2 && Buffer.isBuffer(field.value)) {
      // Parse CortexStepPlannerResponse
      let innerOffset = 0;
      const inner = field.value;
      while (innerOffset < inner.length) {
        const innerField = parseProtobufField(inner, innerOffset);
        if (!innerField) break;
        innerOffset += innerField.bytesConsumed;
        if (innerField.fieldNum === 1 && innerField.wireType === 2 && Buffer.isBuffer(innerField.value)) {
          text = innerField.value.toString('utf8');
        } else if (innerField.fieldNum === 3 && innerField.wireType === 2 && Buffer.isBuffer(innerField.value)) {
          thinking = innerField.value.toString('utf8');
        }
      }
    }
  }

  return { type, status, text, thinking };
}

function parseTrajectoryStepsResponse(buffer: Buffer): ParsedStep[] {
  const steps: ParsedStep[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    const field = parseProtobufField(buffer, offset);
    if (!field) break;
    offset += field.bytesConsumed;

    // Field 1: steps (repeated CortexTrajectoryStep)
    if (field.fieldNum === 1 && field.wireType === 2 && Buffer.isBuffer(field.value)) {
      const step = parsePlannerResponseStep(field.value);
      steps.push(step);
    }
  }

  return steps;
}

// ============================================================================
// gRPC HTTP/2 Helpers with Auto-Retry
// ============================================================================

/**
 * Make a unary gRPC call and return the response body as a Buffer
 * Auto-retries with fresh credentials on connection failure (Windsurf restart)
 * Uses Node.js wrapper when running under Bun for HTTP/2 compatibility
 */
function grpcUnaryCall(
  port: number,
  csrfToken: string,
  grpcPath: string,
  body: Buffer,
  retryCount: number = 0
): Promise<Buffer> {
  // Use Node.js wrapper on Bun to avoid HTTP/2 bugs
  if (IS_BUN) {
    return grpcUnaryCallNode(port, csrfToken, grpcPath, body, retryCount);
  }
  
  // Use native http2 on Node.js
  return new Promise((resolve, reject) => {
    const client = http2.connect(`http://localhost:${port}`);
    const chunks: Buffer[] = [];

    client.on('error', async (err) => {
      client.close();
      // Retry with fresh credentials on connection failure (Windsurf may have restarted)
      if (retryCount === 0 && (err as any).code === 'ECONNREFUSED') {
        try {
          console.log('[grpc-client] Connection refused, retrying with fresh credentials...');
          const freshCreds = getCredentials();
          const result = await grpcUnaryCall(freshCreds.port, freshCreds.csrfToken, grpcPath, body, retryCount + 1);
          resolve(result);
          return;
        } catch (retryErr) {
          reject(retryErr);
          return;
        }
      }
      reject(new WindsurfError(
        `Connection failed: ${err.message}`,
        WindsurfErrorCode.CONNECTION_FAILED,
        err
      ));
    });

    const req = client.request({
      ':method': 'POST',
      ':path': grpcPath,
      'content-type': 'application/grpc',
      'te': 'trailers',
      'x-codeium-csrf-token': csrfToken,
    });

    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    let grpcStatus = '0';
    let grpcMessage = '';

    req.on('trailers', (trailers) => {
      grpcStatus = String(trailers['grpc-status'] ?? '0');
      grpcMessage = String(trailers['grpc-message'] ?? '');
    });

    req.on('end', () => {
      client.close();
      if (grpcStatus !== '0') {
        reject(new WindsurfError(
          `gRPC error ${grpcStatus}: ${grpcMessage ? decodeURIComponent(grpcMessage) : 'Unknown error'}`,
          WindsurfErrorCode.STREAM_ERROR
        ));
        return;
      }
      const full = Buffer.concat(chunks);
      // Strip gRPC frame header (5 bytes) if present
      if (full.length >= 5 && full[0] === 0) {
        const msgLen = full.readUInt32BE(1);
        if (full.length >= 5 + msgLen) {
          resolve(full.subarray(5, 5 + msgLen));
          return;
        }
      }
      resolve(full);
    });

    req.on('error', (err) => {
      client.close();
      reject(new WindsurfError(
        `Request failed: ${err.message}`,
        WindsurfErrorCode.STREAM_ERROR,
        err
      ));
    });

    req.write(body);
    req.end();
  });
}

/**
 * Make a unary gRPC call using Node.js wrapper (for Bun HTTP/2 compatibility)
 */
function grpcUnaryCallNode(
  port: number,
  csrfToken: string,
  path: string,
  body: Buffer,
  retryCount: number = 0
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const wrapperPath = getNodeWrapperPath();
    const base64Body = body.length > 0 ? body.toString('base64') : '';
    
    const args = [
      wrapperPath,
      String(port),
      csrfToken,
      path,
      base64Body
    ].filter(Boolean);
    
    const child = spawn('node', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    });
    
    let stdout = '';
    let stderr = '';
    
    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });
    
    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });
    
    child.on('close', async (code) => {
      // Retry on connection failure
      if (code !== 0 && retryCount === 0 && stderr.includes('ECONNREFUSED')) {
        try {
          console.log('[grpc-client] Connection refused, retrying with fresh credentials...');
          const freshCreds = getCredentials();
          const result = await grpcUnaryCallNode(freshCreds.port, freshCreds.csrfToken, path, body, retryCount + 1);
          resolve(result);
          return;
        } catch (retryErr) {
          reject(retryErr);
          return;
        }
      }
      
      if (code !== 0) {
        let errorData;
        try {
          errorData = JSON.parse(stderr);
        } catch {
          errorData = { error: stderr || 'Unknown error' };
        }
        reject(new WindsurfError(
          `Connection failed: ${errorData.error || 'Unknown error'}`,
          WindsurfErrorCode.CONNECTION_FAILED
        ));
        return;
      }
      
      // Decode base64 response
      try {
        const response = Buffer.from(stdout.trim(), 'base64');
        resolve(response);
      } catch (err) {
        reject(new WindsurfError(
          `Failed to decode response: ${err}`,
          WindsurfErrorCode.STREAM_ERROR
        ));
      }
    });
    
    child.on('error', (err) => {
      reject(new WindsurfError(
        `Failed to spawn Node.js: ${err.message}. Is Node.js installed?`,
        WindsurfErrorCode.CONNECTION_FAILED
      ));
    });
  });
}

/**
 * Get path to the Node.js gRPC wrapper script for Bun HTTP/2 compatibility
 */
function getNodeWrapperPath(): string {
  // When running from dist/, the wrapper is in the project root
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);
  // Go up from dist/src/plugin/ to project root
  return path.resolve(currentDir, '..', '..', '..', 'grpc-wrapper.mjs');
}

// ============================================================================
// Cascade Flow Implementation
// ============================================================================

const GRPC_PATH_START_CASCADE = '/exa.language_server_pb.LanguageServerService/StartCascade';
const GRPC_PATH_SEND_CASCADE_MSG = '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage';
const GRPC_PATH_GET_TRAJECTORY = '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectory';
const GRPC_PATH_GET_TRAJECTORY_STEPS = '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectorySteps';

/**
 * Start a new Cascade session and return the cascade_id
 */
async function startCascade(credentials: WindsurfCredentials): Promise<string> {
  const { csrfToken, port, apiKey, version } = credentials;
  const body = buildStartCascadeRequest(apiKey, version);
  const response = await grpcUnaryCall(port, csrfToken, GRPC_PATH_START_CASCADE, body);
  const cascadeId = parseStartCascadeResponse(response);
  if (!cascadeId) {
    throw new WindsurfError('StartCascade returned empty cascade_id', WindsurfErrorCode.STREAM_ERROR);
  }
  return cascadeId;
}

/**
 * Send a user message to an existing Cascade session
 */
async function sendCascadeMessage(
  credentials: WindsurfCredentials,
  cascadeId: string,
  text: string,
  modelEnum: number,
  modelUid?: string
): Promise<void> {
  const { csrfToken, port, apiKey, version } = credentials;
  const body = buildSendCascadeMessageRequest(apiKey, version, cascadeId, text, modelEnum, modelUid);
  await grpcUnaryCall(port, csrfToken, GRPC_PATH_SEND_CASCADE_MSG, body);
}

/**
 * Get the current run status of a Cascade session
 * Returns: 0=UNSPECIFIED, 1=IDLE, 2=RUNNING, 3=CANCELING, 4=BUSY
 */
async function getCascadeStatus(credentials: WindsurfCredentials, cascadeId: string): Promise<number> {
  const { csrfToken, port } = credentials;
  const body = buildGetTrajectoryRequest(cascadeId);
  const response = await grpcUnaryCall(port, csrfToken, GRPC_PATH_GET_TRAJECTORY, body);
  return parseTrajectoryStatus(response);
}

/**
 * Get trajectory steps for a Cascade session
 */
async function getTrajectorySteps(
  credentials: WindsurfCredentials,
  cascadeId: string,
  stepOffset: number = 0
): Promise<ParsedStep[]> {
  const { csrfToken, port } = credentials;
  const body = buildGetTrajectoryStepsRequest(cascadeId, stepOffset);
  const response = await grpcUnaryCall(port, csrfToken, GRPC_PATH_GET_TRAJECTORY_STEPS, body);
  return parseTrajectoryStepsResponse(response);
}

/**
 * Stream chat via the Cascade flow (for premium models)
 * 
 * Flow:
 * 1. StartCascade → get cascade_id
 * 2. SendUserCascadeMessage (with model config)
 * 3. Poll GetCascadeTrajectorySteps for PLANNER_RESPONSE steps
 * 4. Yield text as it arrives (streaming from GENERATING steps)
 * 5. Stop when CASCADE_RUN_STATUS_IDLE
 */
async function* streamChatCascade(
  credentials: WindsurfCredentials,
  options: Pick<StreamChatOptions, 'model' | 'messages'>,
  modelEnum: number,
  modelUid?: string
): AsyncGenerator<string, void, unknown> {
  // Build the user message text (combine system + user messages)
  const systemMsg = options.messages.find(m => m.role === 'system');
  const userMessages = options.messages.filter(m => m.role !== 'system' && m.role !== 'assistant');
  const lastUserMsg = userMessages[userMessages.length - 1];

  let text = lastUserMsg?.content ?? '';
  if (systemMsg && text) {
    text = `${systemMsg.content}\n\n${text}`;
  } else if (systemMsg) {
    text = systemMsg.content;
  }

  // Step 1: Start cascade
  const cascadeId = await startCascade(credentials);

  // Step 2: Send message
  await sendCascadeMessage(credentials, cascadeId, text, modelEnum, modelUid);

  // Step 3: Poll for response
  const pollIntervalMs = 300;
  const maxWaitMs = 120_000;
  const startTime = Date.now();

  let lastYieldedText = '';
  let idleCount = 0;

  while (Date.now() - startTime < maxWaitMs) {
    await new Promise(r => setTimeout(r, pollIntervalMs));

    // Get current steps
    const steps = await getTrajectorySteps(credentials, cascadeId, 0);

    // Find planner response steps
    for (const step of steps) {
      if (step.type === 15 && step.text) {
        // Yield any new text (streaming delta)
        if (step.text.length > lastYieldedText.length) {
          const delta = step.text.slice(lastYieldedText.length);
          lastYieldedText = step.text;
          yield delta;
        }
      }
    }

    // Check if cascade is done
    const status = await getCascadeStatus(credentials, cascadeId);
    if (status === 1) {
      idleCount++;
      // Wait for one more poll to ensure we got all text
      if (idleCount >= 2) {
        // Final check for any remaining text
        const finalSteps = await getTrajectorySteps(credentials, cascadeId, 0);
        for (const step of finalSteps) {
          if (step.type === 15 && step.text) {
            if (step.text.length > lastYieldedText.length) {
              const delta = step.text.slice(lastYieldedText.length);
              lastYieldedText = step.text;
              yield delta;
            }
          }
        }
        break;
      }
    } else {
      idleCount = 0;
    }
  }
}

// ============================================================================
// Model Routing
// ============================================================================

/**
 * Determine if a model should use the Cascade flow
 * 
 /**
 * Determines whether to use the Cascade flow for a given model.
 * Only use Cascade when we have an explicit string UID — models without UIDs
 * go through the legacy RawGetChatMessage endpoint.
 */
function shouldUseCascade(_modelEnum: number, modelUid?: string): boolean {
  return !!modelUid;
}

// ============================================================================
// Streaming API
// ============================================================================

/**
 * Stream chat completion using Promise-based API
 * 
 * @param credentials - Windsurf credentials (csrf, port, apiKey, version)
 * @param options - Chat options including model, messages, and callbacks
 * @returns Promise that resolves to the full response text
 */
export function streamChat(
  credentials: WindsurfCredentials,
  options: StreamChatOptions
): Promise<string> {
  const { csrfToken: _csrfToken, port: _port, apiKey, version } = credentials;
  const resolved = resolveModel(options.model);
  const modelEnum = resolved.enumValue;
  const modelUid = resolved.modelUid;
  const modelName = modelUid ?? (resolved.variant ? `${resolved.modelId}:${resolved.variant}` : resolved.modelId);

  if (shouldUseCascade(modelEnum, modelUid)) {
    // Use Cascade flow for premium models
    return new Promise(async (resolve, reject) => {
      const chunks: string[] = [];
      try {
        const gen = streamChatCascade(credentials, options, modelEnum, modelUid);
        for await (const chunk of gen) {
          chunks.push(chunk);
          options.onChunk?.(chunk);
        }
        const fullText = chunks.join('');
        options.onComplete?.(fullText);
        resolve(fullText);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        options.onError?.(error);
        reject(error);
      }
    });
  }

  // Legacy RawGetChatMessage flow
  const body = buildChatRequest(apiKey, version, modelEnum, options.messages, modelName);

  return new Promise((resolve, reject) => {
    let retryAttempted = false;
    
    function connectWithCredentials(creds: WindsurfCredentials) {
      const client = http2.connect(`http://localhost:${creds.port}`);
      const chunks: string[] = [];

      client.on('error', async (err) => {
        client.close();
        // Retry with fresh credentials on connection failure (Windsurf may have restarted)
        if (!retryAttempted && (err as any).code === 'ECONNREFUSED') {
          retryAttempted = true;
          console.log('[grpc-client] Legacy connection refused, retrying with fresh credentials...');
          try {
            const freshCreds = getCredentials();
            connectWithCredentials(freshCreds);
            return;
          } catch (retryErr) {
            options.onError?.(retryErr as Error);
            reject(retryErr);
            return;
          }
        }
        options.onError?.(err);
        reject(new WindsurfError(
          `Connection failed: ${err.message}`,
          WindsurfErrorCode.CONNECTION_FAILED,
          err
        ));
      });

      client.on('connect', () => {
        const req = client.request({
          ':method': 'POST',
          ':path': '/exa.language_server_pb.LanguageServerService/RawGetChatMessage',
          'content-type': 'application/grpc',
          'te': 'trailers',
          'x-codeium-csrf-token': creds.csrfToken,
        });

        req.on('data', (chunk: Buffer) => {
          const text = extractTextFromChunk(chunk);
          if (text) {
            chunks.push(text);
            options.onChunk?.(text);
          }
        });

        req.on('trailers', (trailers) => {
          const status = trailers['grpc-status'];
          if (status !== '0') {
            const message = trailers['grpc-message'];
            const err = new WindsurfError(
              `gRPC error ${status}: ${message ? decodeURIComponent(message as string) : 'Unknown error'}`,
              WindsurfErrorCode.STREAM_ERROR
            );
            options.onError?.(err);
            reject(err);
          }
        });

        req.on('end', () => {
          client.close();
          const fullText = chunks.join('');
          options.onComplete?.(fullText);
          resolve(fullText);
        });

        req.on('error', (err) => {
          client.close();
          options.onError?.(err);
          reject(new WindsurfError(
            `Request failed: ${err.message}`,
            WindsurfErrorCode.STREAM_ERROR,
            err
          ));
        });

        req.write(body);
        req.end();
      });
    }
    
    connectWithCredentials(credentials);
  });
}

/**
 * Stream chat completion using async generator
 * 
 * Yields text chunks as they arrive, for use with SSE streaming.
 * 
 * @param credentials - Windsurf credentials
 * @param options - Chat options (model and messages)
 * @yields Text chunks as they arrive
 */
export async function* streamChatGenerator(
  credentials: WindsurfCredentials,
  options: Pick<StreamChatOptions, 'model' | 'messages'>
): AsyncGenerator<string, void, unknown> {
  const { csrfToken: _csrfToken, port: _port, apiKey, version } = credentials;
  const resolved = resolveModel(options.model);
  const modelEnum = resolved.enumValue;
  const modelUid = resolved.modelUid;
  const modelName = modelUid ?? (resolved.variant ? `${resolved.modelId}:${resolved.variant}` : resolved.modelId);

  if (shouldUseCascade(modelEnum, modelUid)) {
    // Use Cascade flow for premium models
    yield* streamChatCascade(credentials, options, modelEnum, modelUid);
    return;
  }

  // Legacy RawGetChatMessage flow
  const body = buildChatRequest(apiKey, version, modelEnum, options.messages, modelName);

  let retryAttempted = false;

  async function* connectAndStream(creds: WindsurfCredentials): AsyncGenerator<string, void, unknown> {
    const client = http2.connect(`http://localhost:${creds.port}`);

    const chunkQueue: string[] = [];
    let done = false;
    let error: Error | null = null;
    let resolveWait: (() => void) | null = null;
    let connectionError: Error | null = null;

    client.on('error', (err) => {
      // Check if this is a connection error we should retry
      if (!retryAttempted && (err as any).code === 'ECONNREFUSED') {
        connectionError = err;
        done = true;
        resolveWait?.();
        return;
      }
      error = new WindsurfError(
        `Connection failed: ${err.message}`,
        WindsurfErrorCode.CONNECTION_FAILED,
        err
      );
      done = true;
      resolveWait?.();
    });

    const req = client.request({
      ':method': 'POST',
      ':path': '/exa.language_server_pb.LanguageServerService/RawGetChatMessage',
      'content-type': 'application/grpc',
      'te': 'trailers',
      'x-codeium-csrf-token': creds.csrfToken,
    });

    req.on('data', (chunk: Buffer) => {
      const text = extractTextFromChunk(chunk);
      if (text) {
        chunkQueue.push(text);
        resolveWait?.();
      }
    });

    req.on('trailers', (trailers) => {
      const status = trailers['grpc-status'];
      if (status !== '0') {
        const message = trailers['grpc-message'];
        error = new WindsurfError(
          `gRPC error ${status}: ${message ? decodeURIComponent(message as string) : 'Unknown error'}`,
          WindsurfErrorCode.STREAM_ERROR
        );
      }
    });

    req.on('end', () => {
      done = true;
      client.close();
      resolveWait?.();
    });

    req.on('error', (err) => {
      error = new WindsurfError(
        `Request failed: ${err.message}`,
        WindsurfErrorCode.STREAM_ERROR,
        err
      );
      done = true;
      client.close();
      resolveWait?.();
    });

    req.write(body);
    req.end();

    // Yield chunks as they arrive
    while (!done || chunkQueue.length > 0) {
      if (chunkQueue.length > 0) {
        yield chunkQueue.shift()!;
      } else if (!done) {
        await new Promise<void>((resolve) => {
          resolveWait = resolve;
        });
        resolveWait = null;
      }
    }

    // Check if we had a retryable connection error
    if (connectionError && !retryAttempted) {
      retryAttempted = true;
      console.log('[grpc-client] Generator connection refused, retrying with fresh credentials...');
      const freshCreds = getCredentials();
      yield* connectAndStream(freshCreds);
      return;
    }

    if (error) {
      throw error;
    }
  }

  yield* connectAndStream(credentials);
}
