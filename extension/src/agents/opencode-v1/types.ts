// OpenCode v1.18.29 types derived from docs/reference/opencode-1.18.29-openapi.json.
// These are v1 schemas; v2 endpoints are deliberately excluded.

export type APIError = { "name": "APIError"; "data": { "message": string; "statusCode"?: number; "isRetryable": boolean; "responseHeaders"?: Record<string, string>; "responseBody"?: string; "metadata"?: Record<string, string>; }; };

export type Agent = { "name": string; "description"?: string; "mode": "subagent" | "primary" | "all"; "native"?: boolean; "hidden"?: boolean; "topP"?: number; "temperature"?: number; "color"?: string; "permission": PermissionRuleset; "model"?: { "modelID": string; "providerID": string; }; "variant"?: string; "prompt"?: string; "options": Record<string, unknown>; "steps"?: number; };

export type AgentPart = { "id": string; "sessionID": string; "messageID": string; "type": "agent"; "name": string; "source"?: { "value": string; "start": number; "end": number; }; };

export type AgentPartInput = { "id"?: string; "type": "agent"; "name": string; "source"?: { "value": string; "start": number; "end": number; }; };

export type AssistantMessage = { "id": string; "sessionID": string; "role": "assistant"; "time": { "created": number; "completed"?: number; }; "error"?: (ProviderAuthError) | (UnknownError) | (MessageOutputLengthError) | (MessageAbortedError) | (StructuredOutputError) | (ContextOverflowError) | (ContentFilterError) | (APIError); "parentID": string; "modelID": string; "providerID": string; "mode": string; "agent": string; "path": { "cwd": string; "root": string; }; "summary"?: boolean; "cost": number; "tokens": { "total"?: number; "input": number; "output": number; "reasoning": number; "cache": { "read": number; "write": number; }; }; "structured"?: unknown; "variant"?: string; "finish"?: string; };

export type Command = { "name": string; "description"?: string; "agent"?: string; "model"?: string; "source"?: "command" | "mcp" | "skill"; "template": string; "subtask"?: boolean; "hints": Array<string>; };

export type CompactionPart = { "id": string; "sessionID": string; "messageID": string; "type": "compaction"; "auto": boolean; "overflow"?: boolean; "tail_start_id"?: string; };

export type ContentFilterError = { "name": "ContentFilterError"; "data": { "message": string; }; };

export type ContextOverflowError = { "name": "ContextOverflowError"; "data": { "message": string; "responseBody"?: string; }; };

export type FileContent = { "type": "text" | "binary"; "content": string; "diff"?: string; "patch"?: { "oldFileName": string; "newFileName": string; "oldHeader"?: string; "newHeader"?: string; "hunks": Array<{ "oldStart": number; "oldLines": number; "newStart": number; "newLines": number; "lines": Array<string>; }>; "index"?: string; }; "encoding"?: "base64"; "mimeType"?: string; };

export type FileNode = { "name": string; "path": string; "absolute": string; "type": "file" | "directory"; "ignored": boolean; };

export type FilePart = { "id": string; "sessionID": string; "messageID": string; "type": "file"; "mime": string; "filename"?: string; "url": string; "source"?: FilePartSource; };

export type FilePartInput = { "id"?: string; "type": "file"; "mime": string; "filename"?: string; "url": string; "source"?: FilePartSource; };

export type FilePartSource = (FileSource) | (SymbolSource) | (ResourceSource);

export type FilePartSourceText = { "value": string; "start": number; "end": number; };

export type FileSource = { "text": FilePartSourceText; "type": "file"; "path": string; };

export type JSONSchema = Record<string, unknown>;

export type Message = (UserMessage) | (AssistantMessage);

export type MessageAbortedError = { "name": "MessageAbortedError"; "data": { "message": string; }; };

export type MessageOutputLengthError = { "name": "MessageOutputLengthError"; "data": Record<string, unknown>; };

export type Model = { "id": string; "providerID": string; "api": { "id": string; "url": string; "npm": string; }; "name": string; "family"?: string; "capabilities": { "temperature": boolean; "reasoning": boolean; "attachment": boolean; "toolcall": boolean; "input": { "text": boolean; "audio": boolean; "image": boolean; "video": boolean; "pdf": boolean; }; "output": { "text": boolean; "audio": boolean; "image": boolean; "video": boolean; "pdf": boolean; }; "interleaved": (boolean) | ({ "field": ("reasoning" | "reasoning_content" | "reasoning_text") | (string); }); }; "cost": { "input": number; "output": number; "cache": { "read": number; "write": number; }; "tiers"?: Array<{ "input": number; "output": number; "cache": { "read": number; "write": number; }; "tier": { "type": "context"; "size": number; }; }>; "experimentalOver200K"?: { "input": number; "output": number; "cache": { "read": number; "write": number; }; }; }; "limit": { "context": number; "input"?: number; "output": number; }; "status": "alpha" | "beta" | "deprecated" | "active"; "options": Record<string, unknown>; "headers": Record<string, string>; "release_date": string; "variants"?: Record<string, Record<string, unknown>>; };

export type OutputFormat = (OutputFormatText) | (OutputFormatJsonSchema);

export type OutputFormatJsonSchema = { "type": "json_schema"; "schema": JSONSchema; "retryCount"?: number; };

export type OutputFormatText = { "type": "text"; };

export type Part = (TextPart) | (SubtaskPart) | (ReasoningPart) | (FilePart) | (ToolPart) | (StepStartPart) | (StepFinishPart) | (SnapshotPart) | (PatchPart) | (AgentPart) | (RetryPart) | (CompactionPart);

export type PatchPart = { "id": string; "sessionID": string; "messageID": string; "type": "patch"; "hash": string; "files": Array<string>; };

export type PermissionAction = "allow" | "deny" | "ask";

export type PermissionRequest = { "id": string; "sessionID": string; "permission": string; "patterns": Array<string>; "metadata": Record<string, unknown>; "always": Array<string>; "tool"?: { "messageID": string; "callID": string; }; };

export type PermissionRule = { "permission": string; "pattern": string; "action": PermissionAction; };

export type PermissionRuleset = Array<PermissionRule>;

export type Provider = { "id": string; "name": string; "source": "env" | "config" | "custom" | "api"; "env": Array<string>; "key"?: string; "options": Record<string, unknown>; "models": Record<string, Model>; };

export type ProviderAuthError = { "name": "ProviderAuthError"; "data": { "providerID": string; "message": string; }; };

export type QuestionInfo = { "question": string; "header": string; "options": Array<QuestionOption>; "multiple"?: boolean; "custom"?: boolean; };

export type QuestionOption = { "label": string; "description": string; };

export type QuestionRequest = { "id": string; "sessionID": string; "questions": Array<QuestionInfo>; "tool"?: QuestionTool; };

export type QuestionTool = { "messageID": string; "callID": string; };

export type Range = { "start": { "line": number; "character": number; }; "end": { "line": number; "character": number; }; };

export type ReasoningPart = { "id": string; "sessionID": string; "messageID": string; "type": "reasoning"; "text": string; "metadata"?: Record<string, unknown>; "time": { "start": number; "end"?: number; }; };

export type ResourceSource = { "text": FilePartSourceText; "type": "resource"; "clientName": string; "uri": string; };

export type RetryPart = { "id": string; "sessionID": string; "messageID": string; "type": "retry"; "attempt": number; "error": APIError; "time": { "created": number; }; };

export type Session = { "id": string; "slug": string; "projectID": string; "workspaceID"?: string; "directory": string; "path"?: string; "parentID"?: string; "summary"?: { "additions": number; "deletions": number; "files": number; "diffs"?: Array<SnapshotFileDiff>; }; "cost"?: number; "tokens"?: { "input": number; "output": number; "reasoning": number; "cache": { "read": number; "write": number; }; }; "share"?: { "url": string; }; "title": string; "agent"?: string; "model"?: { "id": string; "providerID": string; "variant"?: string; }; "version": string; "metadata"?: Record<string, unknown>; "time": { "created": number; "updated": number; "compacting"?: number; "archived"?: number; }; "permission"?: PermissionRuleset; "revert"?: { "messageID": string; "partID"?: string; "snapshot"?: string; "diff"?: string; }; };

export type SessionStatus = ({ "type": "idle"; }) | ({ "type": "retry"; "attempt": number; "message": string; "action"?: { "reason": string; "provider": string; "title": string; "message": string; "label": string; "link"?: string; }; "next": number; }) | ({ "type": "busy"; });

export type SnapshotFileDiff = { "file"?: string; "patch"?: string; "additions": number; "deletions": number; "status"?: "added" | "deleted" | "modified"; };

export type SnapshotPart = { "id": string; "sessionID": string; "messageID": string; "type": "snapshot"; "snapshot": string; };

export type StepFinishPart = { "id": string; "sessionID": string; "messageID": string; "type": "step-finish"; "reason": string; "snapshot"?: string; "cost": number; "tokens": { "total"?: number; "input": number; "output": number; "reasoning": number; "cache": { "read": number; "write": number; }; }; };

export type StepStartPart = { "id": string; "sessionID": string; "messageID": string; "type": "step-start"; "snapshot"?: string; };

export type StructuredOutputError = { "name": "StructuredOutputError"; "data": { "message": string; "retries": number; }; };

export type SubtaskPart = { "id": string; "sessionID": string; "messageID": string; "type": "subtask"; "prompt": string; "description": string; "agent": string; "model"?: { "providerID": string; "modelID": string; }; "command"?: string; };

export type SubtaskPartInput = { "id"?: string; "type": "subtask"; "prompt": string; "description": string; "agent": string; "model"?: { "providerID": string; "modelID": string; }; "command"?: string; };

export type SymbolSource = { "text": FilePartSourceText; "type": "symbol"; "path": string; "range": Range; "name": string; "kind": number; };

export type TextPart = { "id": string; "sessionID": string; "messageID": string; "type": "text"; "text": string; "synthetic"?: boolean; "ignored"?: boolean; "time"?: { "start": number; "end"?: number; }; "metadata"?: Record<string, unknown>; };

export type TextPartInput = { "id"?: string; "type": "text"; "text": string; "synthetic"?: boolean; "ignored"?: boolean; "time"?: { "start": number; "end"?: number; }; "metadata"?: Record<string, unknown>; };

export type Todo = { "content": string; "status": string; "priority": string; };

export type ToolPart = { "id": string; "sessionID": string; "messageID": string; "type": "tool"; "callID": string; "tool": string; "state": ToolState; "metadata"?: Record<string, unknown>; };

export type ToolState = (ToolStatePending) | (ToolStateRunning) | (ToolStateCompleted) | (ToolStateError);

export type ToolStateCompleted = { "status": "completed"; "input": Record<string, unknown>; "output": string; "title": string; "metadata": Record<string, unknown>; "time": { "start": number; "end": number; "compacted"?: number; }; "attachments"?: Array<FilePart>; };

export type ToolStateError = { "status": "error"; "input": Record<string, unknown>; "error": string; "metadata"?: Record<string, unknown>; "time": { "start": number; "end": number; }; };

export type ToolStatePending = { "status": "pending"; "input": Record<string, unknown>; "raw": string; };

export type ToolStateRunning = { "status": "running"; "input": Record<string, unknown>; "title"?: string; "metadata"?: Record<string, unknown>; "time": { "start": number; }; };

export type UnknownError = { "name": "UnknownError"; "data": { "message": string; "ref"?: string; }; };

export type UserMessage = { "id": string; "sessionID": string; "role": "user"; "time": { "created": number; }; "format"?: OutputFormat; "summary"?: { "title"?: string; "body"?: string; "diffs": Array<SnapshotFileDiff>; }; "agent": string; "model": { "providerID": string; "modelID": string; "variant"?: string; }; "system"?: string; "tools"?: Record<string, boolean>; };

export type MessageRecord = { info: Message; parts: Part[] };
export type OpenCodeEvent = { id?: string; type: string; properties: Record<string, unknown> };
export type SessionInfo = Session;
export type ModelInfo = Model;
export type ProviderInfo = Provider;
export type ProviderCatalog = { all: Provider[]; connected: string[]; default: Record<string, string> };
export type SkillInfo = { name: string; description?: string; location: string; content: string };
export type RuntimeInfo = { profileId: string; state: "ready" | "stopped" | "error" | "starting"; baseUrl?: string; directory: string; username?: string; password?: string; version?: string; owned: boolean; attachCommand?: string; error?: string };
export type ProfileSummary = { id: string; name: string; kind: "windows" | "wsl" | "external"; executable?: string; distribution?: string; user?: string; directory: string; port?: number; baseUrl?: string; username?: string; hasPassword?: boolean; envKeys?: string[] };
