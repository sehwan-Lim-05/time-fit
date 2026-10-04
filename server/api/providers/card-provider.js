import { mockServerCardProvider } from './mock-card-provider.js';
import { hyphenCardProvider } from './hyphen-card-provider.js';
export function cardProvider(name, connection = null) { if (name === 'mock') return mockServerCardProvider; if (name === 'hyphen') return hyphenCardProvider(connection); throw new Error('provider_not_available'); }
