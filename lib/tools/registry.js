'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('../logger');

const REQUIRED_FIELDS = ['name', 'description', 'execute'];
const _tools = new Map();

function loadTools() {
    if (_tools.size > 0) return _tools;

    const dir = __dirname;
    const files = fs.readdirSync(dir).filter(f =>
        f.endsWith('.js') && f !== 'registry.js'
    );

    for (const file of files) {
        try {
            const tool = require(path.join(dir, file));
            const missing = REQUIRED_FIELDS.filter(f => !tool[f]);
            if (missing.length > 0) {
                logger.warn({ file, missing }, '🔧 Tool skipped — missing required fields');
                continue;
            }
            if (typeof tool.execute !== 'function') {
                logger.warn({ file }, '🔧 Tool skipped — execute is not a function');
                continue;
            }
            _tools.set(tool.name, tool);
        } catch (err) {
            logger.error({ err, file }, '🔧 Tool failed to load');
        }
    }

    logger.info({ count: _tools.size, tools: [..._tools.keys()] }, '🔧 Tool registry loaded');
    return _tools;
}

function getTool(name) {
    if (_tools.size === 0) loadTools();
    return _tools.get(name) || null;
}

function getAllTools() {
    if (_tools.size === 0) loadTools();
    return _tools;
}

function getManifest() {
    if (_tools.size === 0) loadTools();
    const manifest = [];
    for (const [, tool] of _tools) {
        manifest.push({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters || {}
        });
    }
    return manifest;
}

module.exports = { loadTools, getTool, getAllTools, getManifest };
