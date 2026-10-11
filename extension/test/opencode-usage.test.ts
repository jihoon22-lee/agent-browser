import { describe, expect, it } from "vitest";
import { computeUsage, availableModels } from "../src/agents/opencode-v1/usage";
import type { AssistantMessage, MessageRecord, Model, Part, ProviderCatalog, StepFinishPart, UserMessage } from "../src/agents/opencode-v1/types";
const tokens = (input: number, output = 2) => ({ input, output, reasoning: 3, cache: { read: 4, write: 5 } });
const user = (id: string, time: number): MessageRecord => ({ info: { id, sessionID: "ses_1", role: "user", time: { created: time }, agent: "build", model: { providerID: "test", modelID: "model" } } satisfies UserMessage, parts: [] });
const assistant = (id: string, parentID: string, time: number, parts: Part[] = []): MessageRecord => ({ info: { id, parentID, sessionID: "ses_1", role: "assistant", time: { created: time, completed: time + 1 }, agent: "build", mode: "build", modelID: "model", providerID: "test", path: { cwd: "/fixture", root: "/fixture" }, cost: 0.9, tokens: tokens(900) } satisfies AssistantMessage, parts });
const step = (id: string, messageID: string, input: number, cost = 0.1): StepFinishPart => ({ id, messageID, sessionID: "ses_1", type: "step-finish", reason: "tool-calls", tokens: tokens(input), cost });
const model = { id: "model", providerID: "test", limit: { context: 1000, output: 100 } } as Model;

describe("v1 usage accounting", () => {
  it("sums unique step calls without adding the assistant's last-step mirror", () => {
    const first = assistant("msg_a", "msg_u", 2, [step("prt_1", "msg_a", 10), step("prt_2", "msg_a", 20), step("prt_2", "msg_a", 20)]);
    const result = computeUsage([user("msg_u", 1), first, first], model, "ses_1");
    expect(result.latest?.input).toBe(20);
    expect(result.request?.input).toBe(30);
    expect(result.session?.input).toBe(30);
    expect(result.sessionCost).toBeCloseTo(0.2);
    expect(result.latest?.total).toBe(34);
    expect(result.context).toMatchObject({ tokens: 34, limit: 1000, estimated: true });
  });
  it("groups calls by user parent and ignores other sessions", () => {
    const old = assistant("msg_a", "msg_u", 2, [step("prt_1", "msg_a", 10)]);
    const current = assistant("msg_b", "msg_v", 4, [step("prt_2", "msg_b", 20)]);
    const foreign = assistant("msg_foreign", "msg_v", 5); foreign.info.sessionID = "ses_other";
    const result = computeUsage([user("msg_u", 1), old, user("msg_v", 3), current, foreign], model, "ses_1");
    expect(result.request?.input).toBe(20);
    expect(result.session?.input).toBe(30);
    expect(result.context.tokens).not.toBe(result.session?.total);
  });
  it("uses the selected model's context limit and does not invent missing usage", () => {
    const empty = computeUsage([user("msg_u", 1)], model);
    expect(empty.latest).toBeNull(); expect(empty.session).toBeNull(); expect(empty.context.tokens).toBeNull();
    const result = computeUsage([user("msg_u", 1), assistant("msg_a", "msg_u", 2)], { ...model, id: "changed", limit: { context: 2000, output: 100 } });
    expect(result.context).toMatchObject({ limit: 2000, modelChanged: true, tokens: 914 });
  });
  it("does not display pre-compaction input as the compacted context", () => {
    const compact = user("msg_c", 3);
    compact.parts = [{ id: "prt_compact", messageID: "msg_c", sessionID: "ses_1", type: "compaction", auto: false }];
    const summary = assistant("msg_summary", "msg_c", 4); (summary.info as AssistantMessage).summary = true;
    const result = computeUsage([user("msg_u", 1), assistant("msg_a", "msg_u", 2), compact, summary], model);
    expect(result.compaction).toBe("completed"); expect(result.context.tokens).toBeNull();
    const fresh = assistant("msg_b", "msg_v", 6, [step("prt_fresh", "msg_b", 10)]);
    expect(computeUsage([compact, summary, user("msg_v", 5), fresh], model).context.tokens).toBe(24);
  });
  it("shows only connected non-deprecated server models, with no external catalogue fallback", () => {
    const catalog = { all: [
      { id: "test", models: { model: { ...model, status: "active" }, old: { ...model, id: "old", status: "deprecated" } } },
      { id: "not-connected", models: { hidden: { ...model, id: "hidden" } } },
    ], connected: ["test"], default: {} } as unknown as ProviderCatalog;
    expect(availableModels(catalog).map(m => m.id)).toEqual(["model"]);
    expect(availableModels({ ...catalog, connected: [] })).toEqual([]);
  });
});
