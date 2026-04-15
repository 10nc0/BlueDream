'use strict';

const { EventEmitter } = require('events');
const logger = require('./logger');

class NyanBus extends EventEmitter {
    constructor() {
        super();
        this.setMaxListeners(50);
    }

    emit(event, data) {
        const count = this.listenerCount(event);
        if (count > 0) {
            logger.debug({ event, listeners: count }, '🔌 NyanBus: emit %s', event);
        }
        return super.emit(event, data);
    }

    on(event, handler) {
        logger.debug({ event }, '🔌 NyanBus: listener registered — %s', event);
        return super.on(event, handler);
    }

    listEvents() {
        return this.eventNames().map(name => ({
            event: name,
            listeners: this.listenerCount(name)
        }));
    }
}

const nyanBus = new NyanBus();

module.exports = nyanBus;
