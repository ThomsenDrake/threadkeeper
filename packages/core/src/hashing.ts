import { createHash } from 'node:crypto';

export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const canonical = (value: any): string => value === null || typeof value !== 'object'
  ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
export const normalize = (value: string) => value.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
export const sourceIdentity = (clientId: string, eventId: string) => hash(canonical([clientId, eventId]));
export const sourceContent = (text: string) => hash(normalize(text));
export const memoryContent = (statement: string, project: string | null, subject: string) => hash(canonical([normalize(statement), project, subject]));
