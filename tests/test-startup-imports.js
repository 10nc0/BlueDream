'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function load(filename, env, overrides) {
    const localRequire = createRequire(filename);
    const box = {
        module: { exports: {} }, process: { env },
        require: name => Object.hasOwn(overrides, name) ? overrides[name] : localRequire(name)
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), box, { filename });
    return box.module.exports;
}

async function main() {
    const logger = { debug() {}, info() {}, warn() {}, error() {} };
    for (const [name, token] of [
        ['hermes', 'HERMES_TOKEN'], ['thoth', 'THOTH_TOKEN'],
        ['idris', 'IDRIS_AI_LOG_TOKEN'], ['horus', 'HORUS_AI_LOG_TOKEN']
    ]) {
        const env = {};
        let constructed = 0;
        const filename = require.resolve(`../bots/${name}-bot`);
        // Getter proves the SDK is unused until a configured connection starts.
        const overrides = { '../lib/logger': logger };
        Object.defineProperty(overrides, 'discord.js', { get() {
            constructed++;
            return {
                GatewayIntentBits: {},
                Client: class { constructor() { throw new Error('fixture: no network'); } }
            };
        } });
        const Bot = load(filename, env, overrides);
        const bot = new Bot();
        assert.equal(constructed, 0);
        await bot.initialize();
        assert.equal(constructed, 0, `${name}: absent token must not load Discord`);
        env[token] = 'fixture-only';
        await assert.rejects(() => bot.initialize(), /fixture: no network/);
        assert.equal(constructed, 1);
        assert.equal(bot.client, null);
        assert.equal(bot.ready, false);
    }

    const env = {};
    let sdkLoads = 0;
    const overrides = {};
    Object.defineProperty(overrides, 'twilio', { get() {
        sdkLoads++;
        return require('twilio');
    } });
    const { TwilioChannel } = load(require.resolve('../lib/channels/twilio'), env, overrides);
    const channel = new TwilioChannel({ logger });
    const headers = { Host: 'fixture.example' };
    const req = {
        protocol: 'https', originalUrl: '/webhook', body: { Body: 'fixture', From: 'fixture' },
        get: name => headers[name]
    };
    assert.equal(sdkLoads, 0);
    assert.equal(channel.validateSignature(req).status, 503);
    env.TWILIO_AUTH_TOKEN = 'fixture-only';
    assert.equal(channel.validateSignature(req).status, 401);
    assert.equal(sdkLoads, 0);
    headers['X-Twilio-Signature'] = require('twilio').getExpectedTwilioSignature(
        env.TWILIO_AUTH_TOKEN, 'https://fixture.example/webhook', req.body);
    assert.equal(channel.validateSignature(req).valid, true);
    assert.equal(sdkLoads, 1);
    req.body.Body = 'tampered';
    assert.equal(channel.validateSignature(req).status, 401);
    assert.equal(sdkLoads, 2);

    const exaOverrides = { '../logger': logger };
    Object.defineProperty(exaOverrides, 'exa-js', { get() {
        throw new Error('Unconfigured Exa loaded its SDK');
    } });
    const exa = load(require.resolve('../lib/tools/exa'), {}, exaOverrides);
    assert.equal(await exa.execute('fixture'), null);
    console.log('Optional imports: unconfigured bots/Exa skip SDKs; configured bot failures stay unavailable; lazy Twilio still rejects unsigned/tampered requests.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
