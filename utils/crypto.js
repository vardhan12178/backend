// utils/crypto.js - Shared 2FA encryption/decryption utilities
import crypto from 'crypto';

const ENC_KEY = Buffer.from(process.env.AES_KEY || '', 'utf8');
export const HAS_VALID_KEY = ENC_KEY.length === 32;

if (!HAS_VALID_KEY && process.env.NODE_ENV !== 'test') {
    console.warn('[WARN] AES_KEY must be 32 bytes for 2FA encryption');
}

/**
 * Encrypt a string using AES-256-CBC
 * @param {string} text - Plain text to encrypt
 * @returns {string} Encrypted string in format "iv:encrypted"
 */
export function encrypt(text) {
    if (!HAS_VALID_KEY) throw new Error('AES key invalid');
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', ENC_KEY, iv);
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
}

/**
 * Decrypt a string encrypted with AES-256-CBC
 * @param {string} encryptedText - Encrypted string in format "iv:encrypted"
 * @returns {string|null} Decrypted plain text or null if invalid
 */
export function decrypt(encryptedText) {
    if (!HAS_VALID_KEY) throw new Error('AES key invalid');
    if (!encryptedText || typeof encryptedText !== 'string') return null;
    const parts = encryptedText.split(':');
    if (parts.length !== 2) return null;
    const [ivHex, dataHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const encrypted = Buffer.from(dataHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', ENC_KEY, iv);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
}
