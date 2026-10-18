import test from "node:test";
import assert from "node:assert/strict";
import {createTabSession} from "../../web/js/tab-session.js";

class FakeChannel {
  constructor(bus) {
    this.bus = bus;
    this.listeners = new Set();
    bus.add(this);
  }
  addEventListener(_name, listener) { this.listeners.add(listener); }
  removeEventListener(_name, listener) { this.listeners.delete(listener); }
  postMessage(data) {
    for (const channel of this.bus) {
      if (channel === this) continue;
      for (const listener of channel.listeners) queueMicrotask(() => listener({data: structuredClone(data)}));
    }
  }
  close() { this.bus.delete(this); }
}

test("an unlocked tab answers a correlated session request", async () => {
  const bus = new Set();
  const unlocked = createTabSession({channel: new FakeChannel(bus), requestID: () => "request-1"});
  const newcomer = createTabSession({channel: new FakeChannel(bus), requestID: () => "request-1", timeoutMs: 50});
  const session = {key: {algorithm: "AES-GCM"}, csrfToken: "csrf"};
  unlocked.offer(session);

  assert.deepEqual(await newcomer.request(), session);
  unlocked.close();
  newcomer.close();
});

test("request returns null when no unlocked tab answers", async () => {
  const bus = new Set();
  const requester = createTabSession({channel: new FakeChannel(bus), timeoutMs: 1});
  assert.equal(await requester.request(), null);
  requester.close();
});

test("closing an unlocked tab stops sharing its session", async () => {
  const bus = new Set();
  const unlocked = createTabSession({channel: new FakeChannel(bus)});
  const requester = createTabSession({channel: new FakeChannel(bus), timeoutMs: 1});
  unlocked.offer({key: {}, csrfToken: "csrf"});
  unlocked.close();
  assert.equal(await requester.request(), null);
  requester.close();
});

test("new session material is announced to already unlocked peers", async () => {
  const bus = new Set();
  const first = createTabSession({channel: new FakeChannel(bus)});
  const second = createTabSession({channel: new FakeChannel(bus)});
  const updates = [];
  second.subscribe(session => updates.push(session.csrfToken));

  first.offer({key: {}, csrfToken: "rotated"});
  await new Promise(resolve => queueMicrotask(resolve));

  assert.deepEqual(updates, ["rotated"]);
  first.close();
  second.close();
});
