import { ProtocolError } from "../protocol/errors";

// Placeholder so the content entry point compiles; Task 10 replaces it with the real actions.
export async function runAction(method: string, _params: Record<string, unknown>): Promise<unknown> {
  throw new ProtocolError("INTERNAL", `${method} not implemented`);
}
