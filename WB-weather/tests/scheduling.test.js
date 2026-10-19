/* Tests for WB-weather's page-safe refresh scheduling.
 * Run: node --test WB-weather/tests/scheduling.test.js
 */
"use strict";
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const INTERVAL = 30 * 60 * 1000;

function setup() {
  let now = 1000000, nextId = 0, requests = 0, renders = 0, definition;
  const tasks = new Map(), logs = [];
  vm.runInNewContext(readFileSync(path.join(__dirname, "..", "WB-weather.js"), "utf8"), {
    config: { units: "metric", language: "sv" },
    Module: { register(name, obj) {
      assert.equal(name, "WB-weather");
      definition = obj;
    } },
    Log: {
      info: x => logs.push(["info", x]),
      debug: x => logs.push(["debug", x]),
      error: x => logs.push(["error", x])
    },
    Date: { now: () => now },
    setTimeout(fn, delay) {
      const id = ++nextId;
      tasks.set(id, { at: now + delay, fn });
      return id;
    },
    clearTimeout(id) { tasks.delete(id); }
  }, { filename: "WB-weather.js" });

  const provider = {
    name: "openweathermap",
    usesNodeHelper: false,
    updateInterval: INTERVAL,
    error: null,
    weather: { temp: 18 },
    fetchWeather() { requests++; },
    resolveWithTemporaryError(message) {
      this.error = { isTemporary: true, retryDelay: 10 * 60 * 1000, message };
      weather.updateAvailable();
    }
  };
  const weather = {
    ...definition,
    name: "WB-weather",
    config: { initialLoadDelay: 1000 },
    provider,
    updateDom() { renders++; }
  };
  function advance(ms) {
    const until = now + ms;
    for (let i = 0; i < 1000; i++) {
      const due = [...tasks].filter(([, t]) => t.at <= until)
        .sort((a, b) => a[1].at - b[1].at);
      if (!due.length) { now = until; return; }
      const [id, task] = due[0];
      tasks.delete(id);
      now = task.at;
      task.fn();
    }
    throw Error("Timer loop did not settle");
  }
  return {
    weather, provider, advance, logs,
    get requests() { return requests; },
    get renders() { return renders; },
    get timers() { return tasks.size; }
  };
}

test("default refresh interval is 30 minutes", () => {
  const h = setup();
  assert.equal(h.weather.defaults.updateInterval, INTERVAL);
});

test("page rotation does not re-fetch weather before its deadline", () => {
  const h = setup();
  h.weather.scheduleUpdate(1000);
  h.advance(1000);
  assert.equal(h.requests, 1);
  h.weather.updateAvailable();
  for (let i = 0; i < 50; i++) {
    h.weather.suspend();
    h.advance(10000);
    h.weather.resume();
    h.advance(5000);
  }
  assert.equal(h.requests, 1);
  assert.equal(h.weather.weather.temp, 18);
  h.advance(INTERVAL - 50 * 15000 - 1);
  assert.equal(h.requests, 1);
  h.advance(1);
  assert.equal(h.requests, 2);
});

test("page resume does not duplicate an in-flight request", () => {
  const h = setup();
  h.weather.scheduleUpdate(0);
  h.advance(0);
  h.weather.suspend();
  h.weather.resume();
  h.advance(5000);
  assert.equal(h.requests, 1);
  h.weather.updateAvailable();
  h.advance(5000);
  assert.equal(h.requests, 1);
  assert.equal(h.renders, 1);
});

test("hidden response preserves deadline until next visible page", () => {
  const h = setup();
  h.weather.scheduleUpdate(0);
  h.advance(0);
  h.weather.suspend();
  h.weather.updateAvailable();
  assert.equal(h.timers, 0);
  h.advance(INTERVAL + 1000);
  assert.equal(h.requests, 1);
  h.weather.resume();
  h.advance(0);
  assert.equal(h.requests, 2);
});

test("temporary errors respect the configured minimum interval", () => {
  const h = setup();
  h.weather.scheduleUpdate(0);
  h.advance(0);
  h.provider.error = { isTemporary: true, retryDelay: 10 * 60 * 1000 };
  h.weather.updateAvailable();
  h.advance(10 * 60 * 1000);
  assert.equal(h.requests, 1);
  h.advance(20 * 60 * 1000);
  assert.equal(h.requests, 2);
});

test("critical errors remain stopped after page changes", () => {
  const h = setup();
  h.weather.scheduleUpdate(0);
  h.advance(0);
  h.provider.error = { isTemporary: false };
  h.weather.updateAvailable();
  h.weather.suspend();
  h.weather.resume();
  h.advance(INTERVAL * 2);
  assert.equal(h.requests, 1);
  assert.equal(h.timers, 0);
});

test("INFO log is only written for real fetch attempts", () => {
  const h = setup();
  h.weather.scheduleUpdate(0);
  h.advance(0);
  h.weather.updateAvailable();
  h.weather.suspend();
  h.advance(5000);
  h.weather.resume();
  h.advance(5000);
  const fetchLogs = h.logs.filter(([level, msg]) => level === "info" && msg.includes("fetching weather"));
  assert.equal(fetchLogs.length, 1);
});

test("OpenWeatherMap endpoint is One Call 3.0", () => {
  const file = readFileSync(path.join(__dirname, "..", "providers", "WB-openweathermap.js"), "utf8");
  assert.ok(file.includes("https://api.openweathermap.org/data/3.0/onecall"));
  assert.ok(!file.includes("https://api.openweathermap.org/data/2.5/onecall"));
});
