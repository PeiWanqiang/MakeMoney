import assert from "node:assert/strict";
import test from "node:test";
import { BusyError, ConcurrencyGate } from "../worker/concurrency.ts";

/** A task that finishes only when the returned `release` is called. */
function blocking() {
  let release = () => {};
  const started = { value: false };
  const task = () => {
    started.value = true;
    return new Promise((resolve) => { release = resolve; });
  };
  return { task, started, release: () => release() };
}

test("runs up to the active limit at once and queues the rest", async () => {
  const gate = new ConcurrencyGate(2, 4, 1);
  const first = blocking();
  const second = blocking();
  const third = blocking();
  const running = [gate.run(first.task), gate.run(second.task), gate.run(third.task)];

  await Promise.resolve();
  assert.equal(first.started.value, true);
  assert.equal(second.started.value, true);
  assert.equal(third.started.value, false, "the third task must wait for a slot");
  assert.deepEqual(gate.load, { active: 2, waiting: 1 });

  first.release();
  await running[0];
  await Promise.resolve();
  assert.equal(third.started.value, true, "finishing one task must admit the queued one");

  second.release();
  third.release();
  await Promise.all(running);
  assert.deepEqual(gate.load, { active: 0, waiting: 0 });
});

test("rejects immediately once the queue is full instead of growing it", async () => {
  const gate = new ConcurrencyGate(1, 2, 7);
  const held = blocking();
  const running = [gate.run(held.task), gate.run(() => "queued-1"), gate.run(() => "queued-2")];
  await Promise.resolve();
  assert.deepEqual(gate.load, { active: 1, waiting: 2 });

  await assert.rejects(() => gate.run(() => "rejected"), (error) => {
    assert.ok(error instanceof BusyError);
    // The retry hint is what the 429 puts in `Retry-After`, so it has to survive.
    assert.equal(error.retryAfterSeconds, 7);
    return true;
  });

  held.release();
  assert.deepEqual(await Promise.all(running), [undefined, "queued-1", "queued-2"]);
  assert.deepEqual(gate.load, { active: 0, waiting: 0 });
});

test("a failing task frees its slot", async () => {
  const gate = new ConcurrencyGate(1, 1, 1);
  await assert.rejects(() => gate.run(() => { throw new Error("boom"); }), /boom/);
  assert.deepEqual(gate.load, { active: 0, waiting: 0 });
  assert.equal(await gate.run(() => "after"), "after");
});

test("a queued task still runs when the one ahead of it fails", async () => {
  const gate = new ConcurrencyGate(1, 2, 1);
  const held = blocking();
  const first = gate.run(async () => { await held.task(); throw new Error("boom"); });
  const second = gate.run(() => "second");
  await Promise.resolve();
  held.release();
  await assert.rejects(() => first, /boom/);
  assert.equal(await second, "second");
  assert.deepEqual(gate.load, { active: 0, waiting: 0 });
});
