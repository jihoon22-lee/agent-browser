import { ProtocolError, type Req } from "../protocol/envelope";

// Placeholder body so the skeleton builds; Task 11 replaces it with the real command handlers.
export async function handleBridgeRequest(req: Req): Promise<unknown> {
  throw new ProtocolError("INTERNAL", `${req.method} not implemented`);
}
