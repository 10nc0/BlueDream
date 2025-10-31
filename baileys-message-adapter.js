/**
 * Baileys Message Adapter
 * Converts Baileys message format to whatsapp-web.js-compatible format
 * so we can reuse existing message handler with minimal changes
 */

const { downloadMediaMessage } = require('@whiskeysockets/baileys');

class BaileysMessageAdapter {
    constructor(rawMessage, sock) {
        this.raw = rawMessage;
        this.sock = sock;
        
        // Extract basic message info
        this.key = rawMessage.key;
        this.messageTimestamp = rawMessage.messageTimestamp;
        this.fromMe = rawMessage.key.fromMe;
        this.remoteJid = rawMessage.key.remoteJid;
        
        // Create whatsapp-web.js compatible id object
        // whatsapp-web.js uses message.id._serialized for unique message IDs
        this.id = {
            fromMe: rawMessage.key.fromMe,
            remote: rawMessage.key.remoteJid,
            id: rawMessage.key.id,
            _serialized: `${rawMessage.key.fromMe ? 'true' : 'false'}_${rawMessage.key.remoteJid}_${rawMessage.key.id}`
        };
        
        // Extract message content - unwrap containers first
        const msgContent = this._unwrapMessage(rawMessage.message);
        this.unwrappedMessage = msgContent; // Store for later use
        this.body = this._extractText(msgContent);
        this.hasMedia = this._hasMedia(msgContent);
        this.mediaType = this._getMediaType(msgContent);
    }

    /**
     * Unwrap container message types (ephemeralMessage, viewOnceMessage, etc.)
     * Modern WhatsApp wraps messages in containers - extract the actual message
     */
    _unwrapMessage(msgContent) {
        if (!msgContent) return null;

        // Check for wrapped message types and recursively unwrap
        if (msgContent.ephemeralMessage) {
            return this._unwrapMessage(msgContent.ephemeralMessage.message);
        }
        if (msgContent.viewOnceMessage) {
            return this._unwrapMessage(msgContent.viewOnceMessage.message);
        }
        if (msgContent.viewOnceMessageV2) {
            return this._unwrapMessage(msgContent.viewOnceMessageV2.message);
        }
        if (msgContent.documentWithCaptionMessage) {
            return this._unwrapMessage(msgContent.documentWithCaptionMessage.message);
        }
        if (msgContent.editedMessage) {
            return this._unwrapMessage(msgContent.editedMessage.message);
        }

        // Not a container, return as-is
        return msgContent;
    }

    _extractText(msgContent) {
        if (!msgContent) return '';
        
        // Try different message types
        return msgContent.conversation ||
               msgContent.extendedTextMessage?.text ||
               msgContent.imageMessage?.caption ||
               msgContent.videoMessage?.caption ||
               msgContent.documentMessage?.caption ||
               '';
    }

    _hasMedia(msgContent) {
        if (!msgContent) return false;
        return !!(msgContent.imageMessage || msgContent.videoMessage || 
                  msgContent.documentMessage || msgContent.audioMessage);
    }

    _getMediaType(msgContent) {
        if (!msgContent) return null;
        
        if (msgContent.imageMessage) return 'image';
        if (msgContent.videoMessage) return 'video';
        if (msgContent.documentMessage) return 'document';
        if (msgContent.audioMessage) return 'audio';
        return null;
    }

    // Emulate whatsapp-web.js getChat()
    async getChat() {
        // Determine if it's a group
        const isGroup = this.remoteJid.endsWith('@g.us');
        
        return {
            id: { _serialized: this.remoteJid },
            isGroup,
            name: isGroup ? 'Group Chat' : null // Could be enhanced with contact name lookup
        };
    }

    // Emulate whatsapp-web.js getContact()
    async getContact() {
        // Extract phone number from JID
        const number = this.remoteJid.split('@')[0];
        
        return {
            id: { user: number },
            number,
            pushname: this.raw.pushName || number,
            
            // Get profile picture
            getProfilePicUrl: async () => {
                try {
                    const ppUrl = await this.sock.profilePictureUrl(this.remoteJid, 'image');
                    return ppUrl;
                } catch (error) {
                    return null; // No profile picture
                }
            }
        };
    }

    // Emulate whatsapp-web.js downloadMedia()
    async downloadMedia() {
        if (!this.hasMedia) return null;

        try {
            const buffer = await downloadMediaMessage(
                this.raw,
                'buffer',
                {},
                {
                    logger: { level: 'silent' },
                    reuploadRequest: this.sock.updateMediaMessage
                }
            );

            // Use unwrapped message content to get correct mimetype/filename
            const msgContent = this.unwrappedMessage;
            let mimetype = 'application/octet-stream';
            let filename = 'media';

            if (msgContent.imageMessage) {
                mimetype = msgContent.imageMessage.mimetype || 'image/jpeg';
                filename = 'image.' + (mimetype.split('/')[1] || 'jpg');
            } else if (msgContent.videoMessage) {
                mimetype = msgContent.videoMessage.mimetype || 'video/mp4';
                filename = 'video.' + (mimetype.split('/')[1] || 'mp4');
            } else if (msgContent.documentMessage) {
                mimetype = msgContent.documentMessage.mimetype || 'application/octet-stream';
                filename = msgContent.documentMessage.fileName || 'document';
            } else if (msgContent.audioMessage) {
                mimetype = msgContent.audioMessage.mimetype || 'audio/ogg';
                filename = 'audio.' + (mimetype.split('/')[1] || 'ogg');
            }

            return {
                data: buffer,
                mimetype,
                filename
            };
        } catch (error) {
            console.error('Error downloading media:', error);
            return null;
        }
    }

    // Expose timestamp in same format (seconds)
    get timestamp() {
        return this.messageTimestamp;
    }
}

module.exports = BaileysMessageAdapter;
