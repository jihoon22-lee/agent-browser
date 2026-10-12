/** Test-only synthetic API surface; production contracts live in the v1 adapter. */
type FixturePart = { type: string; id?: string; sessionID?: string; messageID?: string; text?: string; filename?: string; url?: string; [key: string]: unknown };
type FixtureMessage = { info: { id: string; sessionID: string; role: string; time: { created: number; completed?: number }; [key: string]: unknown }; parts: FixturePart[] };
type FixtureSession = { id: string; title: string; revert?: { messageID: string }; [key: string]: unknown };
type FixtureBody = { parts: FixturePart[]; variant?: string; model?: unknown; [key: string]: unknown };
export function startOpenCodeFixture(options?: { responseDelayMs?: number }): Promise<{
  origin: string; username: string; password: string; directory: string;
  state: {
    sessions: FixtureSession[];
    requests: { method: string; path: string; query: Record<string, string>; body: FixtureBody }[];
    messages: Map<string, FixtureMessage[]>;
    statuses: Record<string, { type: string }>;
    replies: { id: string; body: unknown }[];
    modelsCalled: number;
  };
  session(body?: { title?: string; parentID?: string }): FixtureSession;
  emit(type: string, properties: Record<string, unknown>): unknown;
  saveMessage(record: FixtureMessage): void;
  addQuestion(sessionID: string): { id: string };
  addPermission(sessionID: string): { id: string };
  disconnectEvents(): void;
  close(): Promise<void>;
}>;
