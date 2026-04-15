import { describe, it, expect } from "vitest";
import { SessionActor } from "../src/sessions/actor";

describe("SessionActor", () => {
  it("runs enqueued jobs serially in FIFO order", async () => {
    const actor = new SessionActor("sess_test");
    const log: string[] = [];

    const job = (tag: string, delay: number) => async () => {
      log.push(`start ${tag}`);
      await new Promise((r) => setTimeout(r, delay));
      log.push(`end ${tag}`);
      return tag;
    };

    const results = await Promise.all([
      actor.enqueue(job("a", 20)),
      actor.enqueue(job("b", 5)),
      actor.enqueue(job("c", 10)),
    ]);

    expect(results).toEqual(["a", "b", "c"]);
    expect(log).toEqual([
      "start a",
      "end a",
      "start b",
      "end b",
      "start c",
      "end c",
    ]);
  });

  it("continues the chain even when a job throws", async () => {
    const actor = new SessionActor("sess_test");
    const log: string[] = [];

    await expect(
      actor.enqueue(async () => {
        log.push("boom");
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");

    const r = await actor.enqueue(async () => {
      log.push("ok");
      return 42;
    });
    expect(r).toBe(42);
    expect(log).toEqual(["boom", "ok"]);
  });
});
