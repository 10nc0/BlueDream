'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const ThothBot = require('../bots/thoth-bot');

process.env.THOTH_TOKEN = 'isolated-thoth-test-token';

class FakeClient extends EventEmitter {
    static clients = [];
    constructor() {
        super();
        this.user = null;
        this.destroyed = false;
        FakeClient.clients.push(this);
    }
    login(token) {
        assert.equal(token, 'isolated-thoth-test-token');
        return new Promise((resolve, reject) => { this.finishLogin = resolve; this.failLogin = reject; });
    }
    async destroy() { this.destroyed = true; }
}

function initializeWithFakeClient(bot, setupTimers = () => {}) {
    const load = Module._load;
    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;
    let timeoutHandler;
    global.setTimeout = (fn, ms, ...args) => {
        if (ms === 30000) { timeoutHandler = fn; return { thothTimeout: true }; }
        return originalSetTimeout(fn, ms, ...args);
    };
    global.clearTimeout = timer => {
        if (timer?.thothTimeout) return;
        originalClearTimeout(timer);
    };
    Module._load = function(request, parent, isMain) {
        if (request === 'discord.js') return {
            Client: FakeClient,
            GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4 }
        };
        return load.call(this, request, parent, isMain);
    };
    let pending;
    let testData;
    try { pending = bot.initialize(); }
    finally {
        Module._load = load;
        global.setTimeout = originalSetTimeout;
        global.clearTimeout = originalClearTimeout;
    }
    testData = setupTimers(() => timeoutHandler);
    return { pending, timeout: () => timeoutHandler?.(), testData };
}

test('timeout destroys the failed client and a late ready event cannot poison reconnect', async () => {
    FakeClient.clients = [];
    const bot = new ThothBot();
    const { pending, timeout, testData: duplicateCall } = initializeWithFakeClient(bot, getTimeout => {
        const duplicateCall = bot.initialize();
        assert.equal(bot.client, FakeClient.clients[0]);
        assert.equal(bot.client.listenerCount('clientReady'), 1);
        assert.equal(typeof getTimeout(), 'function');
        assert.equal(bot.isReady(), false);
        assert.ok(duplicateCall instanceof Promise);
        return duplicateCall;
    });
    const failedClient = FakeClient.clients[0];
    timeout();
    await assert.rejects(pending, /login timeout/);
    await assert.rejects(duplicateCall, /login timeout/);
    assert.equal(failedClient.destroyed, true);
    assert.equal(failedClient.listenerCount('clientReady'), 0);
    failedClient.emit('clientReady');
    assert.equal(bot.client, null);
    assert.equal(bot.isReady(), false);

    const reconnect = initializeWithFakeClient(bot);
    const currentClient = FakeClient.clients[1];
    currentClient.user = { tag: 'thoth#0001' };
    currentClient.emit('clientReady');
    await reconnect.pending;
    assert.equal(bot.client, currentClient);
    assert.equal(bot.isReady(), true);
});

test('shutdown invalidates an initializing client before late readiness', async () => {
    FakeClient.clients = [];
    const bot = new ThothBot();
    const { pending } = initializeWithFakeClient(bot);
    const client = FakeClient.clients[0];
    const shutdown = bot.shutdown();
    client.user = { tag: 'thoth#0001' };
    client.emit('clientReady');
    await shutdown;
    await assert.rejects(pending, /client replaced/);
    assert.equal(client.destroyed, true);
    assert.equal(client.listenerCount('clientReady'), 0);
    assert.equal(bot.client, null);
    assert.equal(bot.isReady(), false);
});

test('login resolving does not mark Thoth ready before the clientReady event', async () => {
    FakeClient.clients = [];
    const bot = new ThothBot();
    const { pending } = initializeWithFakeClient(bot);
    const client = FakeClient.clients[0];
    let settled = false;
    pending.then(() => { settled = true; });
    client.finishLogin();
    await Promise.resolve();
    assert.equal(bot.isReady(), false);
    assert.equal(settled, false);
    client.user = { tag: 'thoth#0001' };
    client.emit('clientReady');
    await pending;
    assert.equal(bot.isReady(), true);
});

test('a login rejection cleans up listeners and the failed client', async () => {
    FakeClient.clients = [];
    const bot = new ThothBot();
    const { pending } = initializeWithFakeClient(bot);
    const client = FakeClient.clients[0];
    client.failLogin(new Error('fixture login failure'));
    await assert.rejects(pending, /fixture login failure/);
    assert.equal(client.destroyed, true);
    assert.equal(client.listenerCount('clientReady'), 0);
    assert.equal(bot.client, null);
    assert.equal(bot.isReady(), false);
});
