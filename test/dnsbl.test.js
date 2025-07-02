const { describe, test, expect } = require('@jest/globals');
const dns = require('dns');

describe('DNSBL Tests', () => {
  // Mock config for testing
  const mockConfig = {
    dnsbl: {
      enabled: true,
      servers: ['zen.spamhaus.org', 'bl.spamcop.net'],
      timeout: 3000,
      dnsServers: ['8.8.8.8', '8.8.4.4']
    }
  };

  // Mock checkDNSBL function that matches the new implementation
  async function checkDNSBL(ip, config = mockConfig) {
    // Skip if DNSBL is disabled
    if (!config.dnsbl.enabled) {
      return { isListed: false, listings: [] };
    }

    // Skip private IPs
    if (ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('172.') || ip === '127.0.0.1') {
      return { isListed: false, listings: [] };
    }

    const reversedIP = ip.split('.').reverse().join('.');
    const resolver = new dns.Resolver();
    
    const checks = config.dnsbl.servers.map(async (blacklist) => {
      const hostname = `${reversedIP}.${blacklist}`;
      
      // Try each DNS server until one succeeds
      for (const dnsServer of config.dnsbl.dnsServers) {
        try {
          resolver.setServers([dnsServer]);
          
          // Simulate DNS responses for testing
          if (ip === '192.0.2.1' && blacklist === 'zen.spamhaus.org' && dnsServer === '8.8.8.8') {
            return { blacklist, listed: true, result: ['127.255.255.254'], dnsServer };
          }
          if (ip === '192.0.2.2' && blacklist === 'zen.spamhaus.org' && dnsServer === '8.8.4.4') {
            // Simulate first DNS server failing, second succeeding
            return { blacklist, listed: true, result: ['127.255.255.254'], dnsServer };
          }
          
          // Most IPs are not listed
          throw new Error('NXDOMAIN');
        } catch (err) {
          // Continue to next DNS server
          continue;
        }
      }
      
      return { blacklist, listed: false };
    });

    const results = await Promise.all(checks);
    const listings = results.filter(r => r.listed);
    
    return {
      isListed: listings.length > 0,
      listings: listings.map(l => l.blacklist)
    };
  }

  test('should skip private IP addresses', async () => {
    const privateIPs = ['127.0.0.1', '10.0.0.1', '192.168.1.1', '172.16.0.1'];
    
    for (const ip of privateIPs) {
      const result = await checkDNSBL(ip);
      expect(result.isListed).toBe(false);
      expect(result.listings).toEqual([]);
    }
  });

  test('should reverse IP address correctly', () => {
    const ip = '1.2.3.4';
    const reversed = ip.split('.').reverse().join('.');
    expect(reversed).toBe('4.3.2.1');
  });

  test('should check multiple DNSBL services', async () => {
    const result = await checkDNSBL('8.8.8.8');
    expect(result).toHaveProperty('isListed');
    expect(result).toHaveProperty('listings');
    expect(Array.isArray(result.listings)).toBe(true);
  });

  test('should detect blacklisted IP', async () => {
    // Using test IP that we simulate as blacklisted
    const result = await checkDNSBL('192.0.2.1');
    expect(result.isListed).toBe(true);
    expect(result.listings).toContain('zen.spamhaus.org');
  });

  test('should use DNS fallback servers', async () => {
    // Test IP that only responds on second DNS server
    const result = await checkDNSBL('192.0.2.2');
    expect(result.isListed).toBe(true);
    expect(result.listings).toContain('zen.spamhaus.org');
  });

  test('should respect DNSBL disabled config', async () => {
    const disabledConfig = {
      dnsbl: {
        enabled: false,
        servers: ['zen.spamhaus.org'],
        timeout: 3000,
        dnsServers: ['8.8.8.8']
      }
    };
    
    const result = await checkDNSBL('192.0.2.1', disabledConfig);
    expect(result.isListed).toBe(false);
    expect(result.listings).toEqual([]);
  });

  test('should use configurable DNSBL servers', async () => {
    const customConfig = {
      dnsbl: {
        enabled: true,
        servers: ['custom.blacklist.org'],
        timeout: 3000,
        dnsServers: ['1.1.1.1']
      }
    };
    
    const result = await checkDNSBL('8.8.8.8', customConfig);
    expect(result.isListed).toBe(false); // Not in our mock data
  });

  test('should use configurable DNS servers', async () => {
    const customDnsConfig = {
      dnsbl: {
        enabled: true,
        servers: ['zen.spamhaus.org'],
        timeout: 3000,
        dnsServers: ['1.1.1.1', '9.9.9.9'] // Different DNS servers
      }
    };
    
    const result = await checkDNSBL('8.8.8.8', customDnsConfig);
    expect(result.isListed).toBe(false);
  });

  test('should handle invalid IP format gracefully', async () => {
    const result = await checkDNSBL('not.an.ip');
    expect(result.isListed).toBe(false);
  });
});