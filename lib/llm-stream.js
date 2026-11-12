'use strict';

const { completionError } = require('./llm-completion');

// Parse only visible content. Reasoning, tool arguments and provider prose are
// never forwarded. The owner settles usage only after a complete stream.
async function consumeCompletionStream(stream, { signal, onDelta, maxBytes = 1024 * 1024 } = {}) {
    const decoder = new TextDecoder();
    let buffer = '', text = '', finishReason = null, usage = null, done = false, bytes = 0;
    const abort = () => stream.destroy(signal.reason || new Error('Stream cancelled'));
    signal?.addEventListener('abort', abort, { once: true });
    try {
        signal?.throwIfAborted();
        const event = block => {
            const data = block.split('\n').filter(line => line.startsWith('data:'))
                .map(line => line.slice(5).trimStart()).join('\n').trim();
            if (!data) return;
            if (data === '[DONE]') { done = true; return; }
            if (done) throw completionError('AI_STREAM_INVALID');
            let parsed;
            try { parsed = JSON.parse(data); } catch { throw completionError('AI_STREAM_INVALID'); }
            if (parsed.error) throw completionError('AI_STREAM_INVALID');
            if (parsed.usage) usage = parsed.usage;
            const choice = parsed.choices?.[0];
            if (choice?.finish_reason) finishReason = choice.finish_reason;
            const content = choice?.delta?.content;
            if (typeof content === 'string' && content) {
                text += content;
                onDelta?.(content);
            }
        };
        for await (const chunk of stream) {
            signal?.throwIfAborted();
            bytes += Buffer.byteLength(chunk);
            if (bytes > maxBytes) throw completionError('AI_STREAM_INVALID');
            buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n');
            let index;
            while ((index = buffer.indexOf('\n\n')) !== -1) {
                event(buffer.slice(0, index));
                buffer = buffer.slice(index + 2);
            }
            if (done) break;
        }
        buffer += decoder.decode();
        if (buffer.trim()) event(buffer);
        if (!done || !finishReason) throw completionError('AI_STREAM_INCOMPLETE');
        if (finishReason === 'length') throw completionError('AI_RESPONSE_TRUNCATED');
        if (finishReason !== 'stop' || !text.trim()) throw completionError('AI_RESPONSE_EMPTY');
        return { choices: [{ finish_reason: finishReason, message: { content: text } }], usage };
    } finally {
        signal?.removeEventListener('abort', abort);
        if (!stream.destroyed) stream.destroy();
    }
}

module.exports = { consumeCompletionStream };
