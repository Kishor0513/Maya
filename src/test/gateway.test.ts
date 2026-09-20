import { describe, it, expect } from 'vitest';
import { gatewayHeaders, resolveChatBase } from '../services/gateway';

describe('gateway helpers', () => {
  it('resolves an empty endpoint to the baked base, or relative /api', () => {
    // No VITE_API_URL in the test env → relative, as in local dev.
    expect(resolveChatBase('')).toBe('/api');
    expect(resolveChatBase('   ')).toBe('/api');
  });

  it('keeps explicit endpoints, trimming trailing slashes', () => {
    expect(resolveChatBase('/api/')).toBe('/api');
    expect(resolveChatBase('https://gw.example.com/api/')).toBe(
      'https://gw.example.com/api',
    );
  });

  it('sends no auth header unless a build-time token is configured', () => {
    const h = gatewayHeaders({ 'Content-Type': 'application/json' });
    expect(h['Content-Type']).toBe('application/json');
    expect('x-gateway-token' in h).toBe(false);
  });
});
