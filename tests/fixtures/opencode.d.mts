/** Test-only synthetic API surface; production contracts live in the v1 adapter. */
type FixturePart = { type: string; id?: string; sessionID?: string; messageID?: string; text?: string; filename?: string; url?: string; [key: string]: unknown };
type FixtureMessage = { info: { id: string; sessionID: string; role: string; time: { created: number }; [key: string]: unknown }; parts: FixturePart[] };
type FixtureSession = { id: string; title: string; revert?: { messageID: string }; [key: string]: unknown };
type FixtureBody = { parts: FixturePart[]; variant?: string; model?: unknown; [key: string]: unknown };
export function startOpenCodeFixture(): Promise<{
  origin: string; username: string; password: string; directory: string;
  state: {
    sessions: FixtureSession[];
    requests: { path: string; body: FixtureBody }[];
    replies: { id: string; body: unknown }[];
    modelsCalled: number;
  };
  session(body?: { title?: string }): FixtureSession;
  saveMessage(record: FixtureMessage): void;
  addQuestion(sessionID: string): { id: string };
  addPermission(sessionID: string): { id: string };
  disconnectEvents(): void;
  close(): Promise<void>;
}>;
