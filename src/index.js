#!/usr/bin/env node

const { SMTPServer } = require('smtp-server');
const { simpleParser } = require('mailparser');
const fetch = require('node-fetch');
const { Writable } = require('stream');
const dns = require('dns').promises;
const net = require('net');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const os = require('os');

// Load package.json to get version
const packageJson = require('../package.json');

// Parse command line arguments
const args = process.argv.slice(2);
let configPath = process.env.ACTIONSMTP_CONFIG_PATH || 'config.yml';
let verboseOverride = null;

// Parse minimal CLI args
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  
  if (arg === '--help' || arg === '-h') {
    console.log(`
Usage: actionsmtp [options]

Options:
  --config       Path to YAML configuration file (default: config.yml or $ACTIONSMTP_CONFIG_PATH)
  --verbose      Enable verbose logging (overrides config file)
  --help, -h     Show this help message

Environment:
  ACTIONSMTP_CONFIG_PATH    Default path to configuration file (overridden by --config)

Example:
  actionsmtp
  actionsmtp --config /etc/actionsmtp/config.yml
  actionsmtp --verbose
  ACTIONSMTP_CONFIG_PATH=/etc/actionsmtp.yml actionsmtp
`);
    process.exit(0);
  } else if (arg === '--config' && i + 1 < args.length) {
    configPath = args[++i];
  } else if (arg === '--verbose') {
    verboseOverride = true;
  } else if (!arg.startsWith('--')) {
    // Backward compatibility: treat first non-flag argument as config path
    configPath = arg;
  }
}

// Load configuration from YAML file
let config;
try {
  // Check if config file exists, if not copy from example
  if (!fs.existsSync(configPath)) {
    const examplePath = path.join(path.dirname(configPath), 'config.example.yml');
    
    if (fs.existsSync(examplePath)) {
      console.log(`No config file found at ${configPath}, creating from example...`);
      fs.copyFileSync(examplePath, configPath);
      console.log(`Created ${configPath} from example. Please edit it with your settings.`);
      console.log('Starting with default configuration...\n');
    } else {
      throw new Error(`Configuration file not found: ${configPath} (and no example file found)`);
    }
  }
  
  const configFile = fs.readFileSync(configPath, 'utf8');
  const yamlConfig = yaml.load(configFile);
  
  // Parse webhooks configuration
  const webhooks = [];
  if (yamlConfig.webhooks) {
    for (const [domains, webhookConfig] of Object.entries(yamlConfig.webhooks)) {
      if (!webhookConfig.url) {
        console.error(`Error: URL is required for webhook domains: ${domains}`);
        process.exit(1);
      }
      
      // Split comma-separated domains and trim whitespace
      const domainList = domains.split(',').map(d => d.trim()).filter(d => d);
      
      webhooks.push({
        domains: domainList,
        url: webhookConfig.url,
        authUser: webhookConfig.auth?.user || 'actionmailbox',
        authPass: webhookConfig.auth?.pass || null
      });
    }
  }
  
  
  // Transform YAML structure to internal config format
  config = {
    webhooks: webhooks,
    port: yamlConfig.server?.port || 25,
    host: yamlConfig.server?.host || '0.0.0.0',
    hostname: yamlConfig.server?.hostname || os.hostname(),
    maxSize: yamlConfig.server?.maxSize || 25 * 1024 * 1024,
    timeout: yamlConfig.server?.timeout || 30000,
    verbose: verboseOverride !== null ? verboseOverride : (yamlConfig.logging?.verbose || false),
    spamCheck: yamlConfig.spam?.enabled !== false,
    spamHost: yamlConfig.spam?.spamassassin?.host || 'localhost',
    spamPort: yamlConfig.spam?.spamassassin?.port || 783,
    spamThreshold: yamlConfig.spam?.thresholds?.flag || 5.0,
    spamReject: yamlConfig.spam?.thresholds?.reject || 10.0,
    spamAction: 'flag',
    dnsbl: {
      enabled: yamlConfig.spam?.dnsbl?.enabled !== false,
      servers: yamlConfig.spam?.dnsbl?.servers || ['zen.spamhaus.org', 'bl.spamcop.net'],
      timeout: yamlConfig.spam?.dnsbl?.timeout || 3000,
      dnsServers: yamlConfig.spam?.dnsbl?.dns_servers || ['8.8.8.8', '8.8.4.4']
    }
  };
  
  // Validate required fields
  if (!config.webhooks.length) {
    console.error('Error: At least one webhook must be configured in the webhooks section');
    console.error('Example:');
    console.error('  webhooks:');
    console.error('    example.com:');
    console.error('      url: "http://localhost:3000/webhook"');
    process.exit(1);
  }
} catch (err) {
  if (err.code === 'ENOENT') {
    console.error(`Error: Configuration file not found: ${configPath}`);
    console.error('Create a config.yml file or specify a different path with --config');
    console.error('\nExample configuration file available at: config.example.yml');
  } else if (err.name === 'YAMLException') {
    console.error(`Error: Invalid YAML in configuration file: ${err.message}`);
  } else {
    console.error(`Error loading configuration: ${err.message}`);
  }
  process.exit(1);
}

// Domain matching helper function
function matchesDomain(emailDomain, pattern) {
  // Exact match
  if (pattern === emailDomain) {
    return true;
  }
  
  // Wildcard match for all domains
  if (pattern === '*') {
    return true;
  }
  
  // Subdomain wildcard match (*.example.com)
  if (pattern.startsWith('*.')) {
    const baseDomain = pattern.substring(2);
    return emailDomain === baseDomain || emailDomain.endsWith('.' + baseDomain);
  }
  
  return false;
}

// Find webhook configuration for a given email domain
function findWebhookForDomain(domain) {
  for (const webhook of config.webhooks) {
    for (const pattern of webhook.domains) {
      if (matchesDomain(domain, pattern)) {
        debug(`Domain ${domain} matched pattern ${pattern}`);
        return webhook;
      }
    }
  }
  return null;
}

// Logging functions
const log = (message) => {
  console.log(`[${new Date().toISOString()}] INFO: ${message}`);
};

const debug = (message) => {
  if (config.verbose) {
    console.log(`[${new Date().toISOString()}] DEBUG: ${message}`);
  }
};

const warn = (message) => {
  console.log(`[${new Date().toISOString()}] WARN: ${message}`);
};

const error = (message, err) => {
  console.error(`[${new Date().toISOString()}] ERROR: ${message}`, err || '');
};

const logEmailInfo = (session, action, details = '') => {
  const from = session.envelope?.mailFrom?.address || 'unknown';
  const to = session.envelope?.rcptTo?.map(r => r.address).join(', ') || 'unknown';
  const ip = session.remoteAddress || 'unknown';
  log(`${action} - From: ${from}, To: ${to}, IP: ${ip}${details ? ', ' + details : ''}`);
};

const logSpamCheck = (session, spamResult, dnsblResult) => {
  const from = session.envelope?.mailFrom?.address || 'unknown';
  const ip = session.remoteAddress || 'unknown';
  const spamStatus = spamResult.score >= config.spamThreshold ? 'SPAM' : 'CLEAN';
  
  log(`SPAM_CHECK - ${spamStatus} - Score: ${spamResult.score}/${config.spamThreshold}, From: ${from}, IP: ${ip}`);
  
  if (config.verbose) {
    debug(`Spam tests: ${spamResult.tests.join(', ')}`);
    if (dnsblResult.isListed) {
      debug(`DNSBL listings: ${dnsblResult.listings.join(', ')}`);
    }
  }
};

const logWebhookResult = (session, success, responseStatus, errorDetails = null) => {
  const from = session.envelope?.mailFrom?.address || 'unknown';
  const to = session.envelope?.rcptTo?.map(r => r.address).join(', ') || 'unknown';
  
  if (success) {
    log(`WEBHOOK_SUCCESS - HTTP ${responseStatus}, From: ${from}, To: ${to}`);
  } else {
    error(`WEBHOOK_FAILED - HTTP ${responseStatus || 'N/A'}, From: ${from}, To: ${to}`, errorDetails);
  }
};

// DNSBL services are now configured via config.dnsbl.servers

// Check IP against DNS blacklists using configurable DNS servers
async function checkDNSBL(ip) {
  // Skip if DNSBL is disabled
  if (!config.dnsbl.enabled) {
    debug(`DNSBL checks disabled`);
    return { isListed: false, listings: [] };
  }

  // Skip private IPs
  if (ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('172.') || ip === '127.0.0.1') {
    debug(`Skipping DNSBL check for private IP: ${ip}`);
    return { isListed: false, listings: [] };
  }

  debug(`Starting DNSBL check for IP: ${ip}`);
  const reversedIP = ip.split('.').reverse().join('.');
  
  // Create custom resolver with fallback DNS servers
  const resolver = new dns.Resolver();
  
  const checks = config.dnsbl.servers.map(async (blacklist) => {
    const hostname = `${reversedIP}.${blacklist}`;
    
    // Try each DNS server until one succeeds
    for (const dnsServer of config.dnsbl.dnsServers) {
      try {
        resolver.setServers([dnsServer]);
        const result = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('DNS timeout')), config.dnsbl.timeout);
          resolver.resolve4(hostname, (err, addresses) => {
            clearTimeout(timeout);
            if (err) reject(err);
            else resolve(addresses);
          });
        });
        
        // If resolve succeeds, IP is listed
        debug(`IP ${ip} listed on ${blacklist} via DNS ${dnsServer} - result: ${result.join(', ')}`);
        return { blacklist, listed: true, result, dnsServer };
      } catch (err) {
        debug(`IP ${ip} check on ${blacklist} via DNS ${dnsServer} failed: ${err.code || err.message}`);
        // Continue to next DNS server
      }
    }
    
    // All DNS servers failed for this blacklist
    debug(`IP ${ip} not listed on ${blacklist} (all DNS servers failed or returned NXDOMAIN)`);
    return { blacklist, listed: false };
  });

  try {
    const results = await Promise.all(checks);
    const listings = results.filter(r => r.listed);
    const result = {
      isListed: listings.length > 0,
      listings: listings.map(l => l.blacklist)
    };
    
    if (result.isListed) {
      warn(`IP ${ip} found on DNSBL: ${result.listings.join(', ')}`);
    } else {
      debug(`IP ${ip} clean on all DNSBL services`);
    }
    
    return result;
  } catch (err) {
    debug(`DNSBL check failed for ${ip}: ${err.message}`);
    return { isListed: false, listings: [] };
  }
}

// Check email with SpamAssassin
async function checkSpamAssassin(rawEmail) {
  debug(`Starting SpamAssassin check (${rawEmail.length} bytes)`);
  
  return new Promise((resolve, reject) => {
    let client;
    try {
      client = net.createConnection(config.spamPort, config.spamHost);
    } catch (err) {
      warn(`SpamAssassin connection failed: ${err.message}`);
      resolve({ score: 0, threshold: config.spamThreshold, tests: [] });
      return;
    }
    const timeout = setTimeout(() => {
      client.destroy();
      warn('SpamAssassin check timed out after 10 seconds');
      resolve({ score: 0, threshold: config.spamThreshold, tests: [] });
    }, 10000);

    let response = Buffer.alloc(0);
    
    client.on('connect', () => {
      debug(`Connected to SpamAssassin at ${config.spamHost}:${config.spamPort}`);
      // SPAMC protocol
      const headers = [
        'SYMBOLS SPAMC/1.5',
        `Content-length: ${rawEmail.length}`,
        '',
        ''
      ].join('\r\n');
      
      client.write(headers);
      client.write(rawEmail);
    });

    client.on('data', (data) => {
      response = Buffer.concat([response, data]);
    });

    client.on('end', () => {
      clearTimeout(timeout);
      debug('SpamAssassin check completed');
      
      try {
        const responseStr = response.toString();
        const lines = responseStr.split('\r\n');
        
        // Parse Spam: True ; 15.5 / 5.0
        const spamLine = lines.find(l => l.startsWith('Spam:')) || '';
        const spamMatch = spamLine.match(/Spam: (True|False) ; (-?\d+\.?\d*) \/ (-?\d+\.?\d*)/);
        
        const score = spamMatch ? parseFloat(spamMatch[2]) : 0;
        const threshold = spamMatch ? parseFloat(spamMatch[3]) : config.spamThreshold;
        
        // Parse tests
        const testsLine = lines.find(l => l.includes(',')) || '';
        const tests = testsLine ? testsLine.split(',').map(t => t.trim()).filter(t => t) : [];

        debug(`SpamAssassin result: score=${score}, threshold=${threshold}, tests=${tests.length}`);
        
        resolve({
          score: score,
          threshold: threshold,
          tests: tests
        });
      } catch (err) {
        warn(`Failed to parse SpamAssassin response: ${err.message}`);
        resolve({ score: 0, threshold: config.spamThreshold, tests: [] });
      }
    });

    client.on('error', (err) => {
      clearTimeout(timeout);
      warn(`SpamAssassin error: ${err.message}`);
      // Don't reject, just return default values
      resolve({ score: 0, threshold: config.spamThreshold, tests: [] });
    });
  });
}

// Add spam headers to email
function addSpamHeaders(rawEmail, dnsblResult, spamResult) {
  const emailStr = rawEmail.toString();
  const headerEnd = emailStr.indexOf('\r\n\r\n');
  
  if (headerEnd === -1) {
    return rawEmail;
  }

  const headers = [
    `X-Spam-Score: ${spamResult.score}`,
    `X-Spam-Status: ${spamResult.score >= config.spamThreshold ? 'Yes' : 'No'}, score=${spamResult.score} required=${config.spamThreshold}`,
    `X-Spam-Tests: ${spamResult.tests.join(', ')}`
  ];

  if (dnsblResult.isListed) {
    headers.push(`X-Spam-DNSBL: Listed on ${dnsblResult.listings.join(', ')}`);
  }

  const newEmail = 
    emailStr.substring(0, headerEnd) + '\r\n' +
    headers.join('\r\n') + '\r\n' +
    emailStr.substring(headerEnd);

  return Buffer.from(newEmail);
}

// Forward email to a specific webhook
async function forwardToWebhook(rawEmail, webhookConfig, session, recipientInfo) {
  try {
    debug(`Starting webhook forward to ${webhookConfig.url}`);
    debug(`Email size: ${rawEmail.length} bytes`);
    
    const headers = {
      'Content-Type': 'message/rfc822',
      'User-Agent': 'actionsmtp/1.0',
      'Content-Length': rawEmail.length.toString()
    };
    
    // Add basic auth if configured
    if (webhookConfig.authPass) {
      debug(`Using basic authentication for webhook (user: ${webhookConfig.authUser})`);
      const auth = Buffer.from(`${webhookConfig.authUser}:${webhookConfig.authPass}`).toString('base64');
      headers['Authorization'] = `Basic ${auth}`;
    }
    
    const startTime = Date.now();
    const response = await fetch(webhookConfig.url, {
      method: 'POST',
      headers: headers,
      body: rawEmail,
      timeout: config.timeout
    });
    const duration = Date.now() - startTime;
    
    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      logWebhookResult(session, false, response.status, errorText);
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    debug(`Webhook completed in ${duration}ms`);
    logWebhookResult(session, true, response.status);
    return true;
  } catch (err) {
    if (err.name === 'FetchError' && err.code === 'ECONNREFUSED') {
      logWebhookResult(session, false, null, 'Connection refused - webhook server not reachable');
    } else if (err.name === 'AbortError' || err.message.includes('timeout')) {
      logWebhookResult(session, false, null, `Timeout after ${config.timeout}ms`);
    } else {
      logWebhookResult(session, false, null, err.message);
    }
    throw err;
  }
}

// Forward email to Action Mailbox webhooks based on recipient domains
async function forwardEmail(rawEmail, envelope, session) {
  try {
    // Validate envelope
    if (!envelope.mailFrom || !envelope.mailFrom.address) {
      throw new Error('Invalid sender address');
    }
    if (!envelope.rcptTo || envelope.rcptTo.length === 0) {
      throw new Error('No recipients');
    }
    
    // Group recipients by webhook
    const recipientsByWebhook = new Map();
    
    for (const recipient of envelope.rcptTo) {
      const webhook = session.webhooksByRecipient[recipient.address];
      if (!webhook) {
        warn(`No webhook found for recipient ${recipient.address}, skipping`);
        continue;
      }
      
      const webhookKey = JSON.stringify({
        url: webhook.url,
        authUser: webhook.authUser,
        authPass: webhook.authPass
      });
      
      if (!recipientsByWebhook.has(webhookKey)) {
        recipientsByWebhook.set(webhookKey, {
          webhook: webhook,
          recipients: []
        });
      }
      
      recipientsByWebhook.get(webhookKey).recipients.push(recipient.address);
    }
    
    // Forward to each unique webhook
    const forwardPromises = [];
    for (const [webhookKey, info] of recipientsByWebhook) {
      debug(`Forwarding to ${info.webhook.url} for recipients: ${info.recipients.join(', ')}`);
      forwardPromises.push(
        forwardToWebhook(rawEmail, info.webhook, session, {
          recipients: info.recipients
        })
      );
    }
    
    // Wait for all forwards to complete
    await Promise.all(forwardPromises);
    
    return true;
  } catch (err) {
    throw err;
  }
}

// Create custom writable stream to collect email data
class EmailCollector extends Writable {
  constructor(options) {
    super(options);
    this.chunks = [];
  }
  
  _write(chunk, encoding, callback) {
    this.chunks.push(chunk);
    callback();
  }
  
  getRawEmail() {
    return Buffer.concat(this.chunks);
  }
}

// Create SMTP server
const server = new SMTPServer({
  name: config.hostname,
  banner: 'ActionSMTP',
  size: config.maxSize,
  hideSize: false,
  useXForward: true,
  logger: config.verbose,
  secure: false,
  authOptional: true,
  disabledCommands: ['AUTH'], // We don't require SMTP auth
  
  onConnect(session, callback) {
    log(`CONNECT - IP: ${session.remoteAddress}`);
    
    // Check DNSBL if spam checking is enabled
    if (config.spamCheck) {
      checkDNSBL(session.remoteAddress)
        .then(result => {
          if (result.isListed) {
            warn(`REJECT_CONNECT - IP: ${session.remoteAddress}, DNSBL: ${result.listings.join(', ')}`);
            callback(new Error('550 IP address blacklisted'));
          } else {
            session.dnsblResult = result;
            debug(`Connection accepted from ${session.remoteAddress}`);
            callback();
          }
        })
        .catch(err => {
          warn(`DNSBL check error for ${session.remoteAddress}: ${err.message}`);
          callback(); // Allow on error
        });
    } else {
      debug(`Connection accepted from ${session.remoteAddress} (DNSBL disabled)`);
      callback();
    }
  },
  
  onMailFrom(address, session, callback) {
    debug(`MAIL FROM: ${address.address} (IP: ${session.remoteAddress})`);
    callback();
  },
  
  onRcptTo(address, session, callback) {
    debug(`RCPT TO: ${address.address} (IP: ${session.remoteAddress})`);
    
    // Extract domain from email address
    const emailParts = address.address.split('@');
    if (emailParts.length !== 2) {
      logEmailInfo(session, 'RCPT_REJECTED', `Invalid email format: ${address.address}`);
      callback(new Error('550 Invalid recipient address'));
      return;
    }
    
    const domain = emailParts[1].toLowerCase();
    
    // Check if domain is allowed (has a matching webhook)
    const webhook = findWebhookForDomain(domain);
    if (!webhook) {
      logEmailInfo(session, 'RCPT_REJECTED', `Domain not allowed: ${domain}`);
      callback(new Error(`550 Domain ${domain} not accepted here`));
      return;
    }
    
    // Store the webhook info for later use
    if (!session.webhooksByRecipient) {
      session.webhooksByRecipient = {};
    }
    session.webhooksByRecipient[address.address] = webhook;
    
    debug(`Domain ${domain} accepted, will route to: ${webhook.url}`);
    callback();
  },
  
  onData(stream, session, callback) {
    const collector = new EmailCollector();
    let streamEnded = false;
    
    logEmailInfo(session, 'EMAIL_START', `Starting data transfer`);
    
    // Handle stream errors
    stream.on('error', (err) => {
      error(`Stream error for ${session.remoteAddress}`, err);
      if (!streamEnded) {
        streamEnded = true;
        logEmailInfo(session, 'EMAIL_FAILED', 'Stream error');
        callback(new Error('451 Stream error'));
      }
    });
    
    stream.pipe(collector);
    
    stream.on('end', async () => {
      if (streamEnded) return;
      streamEnded = true;
      try {
        let rawEmail = collector.getRawEmail();
        
        // Validate email has content
        if (!rawEmail || rawEmail.length === 0) {
          logEmailInfo(session, 'EMAIL_REJECTED', 'Empty message');
          callback(new Error('550 Empty message'));
          return;
        }
        
        // Check for basic email structure
        const emailStr = rawEmail.toString();
        if (!emailStr.includes('\r\n\r\n')) {
          logEmailInfo(session, 'EMAIL_REJECTED', 'Malformed message');
          callback(new Error('550 Malformed message: missing headers'));
          return;
        }
        
        logEmailInfo(session, 'EMAIL_RECEIVED', `Size: ${rawEmail.length} bytes`);
        
        let spamResult = { score: 0, tests: [] };
        
        // Run SpamAssassin check if enabled
        if (config.spamCheck) {
          try {
            spamResult = await checkSpamAssassin(rawEmail);
            
            // DNSBL-listed IPs are rejected at connection time, so this code is unreachable
            
            logSpamCheck(session, spamResult, session.dnsblResult || { isListed: false, listings: [] });
            
            // Reject if score exceeds reject threshold
            if (spamResult.score >= config.spamReject) {
              logEmailInfo(session, 'EMAIL_REJECTED', `Spam score: ${spamResult.score}/${config.spamReject}`);
              callback(new Error('550 Message rejected as spam'));
              return;
            }
            
            // Add spam headers
            rawEmail = addSpamHeaders(rawEmail, session.dnsblResult || { isListed: false, listings: [] }, spamResult);
            
          } catch (err) {
            warn(`SpamAssassin check failed for email from ${session.envelope?.mailFrom?.address || 'unknown'}, allowing through: ${err.message}`);
          }
        } else {
          debug('Spam checking disabled, skipping spam filters');
        }
        
        // Forward to Action Mailbox
        await forwardEmail(rawEmail, session.envelope, session);
        
        logEmailInfo(session, 'EMAIL_ACCEPTED', 'Successfully processed and forwarded');
        callback(); // Accept message
      } catch (err) {
        error('Failed to process email', err);
        logEmailInfo(session, 'EMAIL_FAILED', err.message);
        
        // Return more specific error messages
        if (err.message.includes('timeout')) {
          callback(new Error('451 Temporary failure, please retry'));
        } else if (err.message.includes('HTTP')) {
          callback(new Error('451 Webhook temporarily unavailable'));
        } else {
          callback(new Error('550 Failed to process message'));
        }
      }
    });
  }
});

// Error handling
server.on('error', (err) => {
  error('SMTP Server error', err);
});

// Start server
server.listen(config.port, config.host, () => {
  log('=== ActionSMTP Server Starting ===');
  log(`Version: ${packageJson.version}`);
  log(`Listening on: ${config.host}:${config.port}`);
  log(`Server hostname: ${config.hostname}`);
  log(`Max message size: ${Math.round(config.maxSize / 1024 / 1024)}MB`);
  log(`Timeout: ${config.timeout}ms`);
  log(`Verbose logging: ${config.verbose ? 'enabled' : 'disabled'}`);
  
  // Log webhook configurations
  log(`Configured webhooks:`);
  for (const webhook of config.webhooks) {
    const domains = webhook.domains.join(', ');
    const auth = webhook.authPass ? ` (auth: ${webhook.authUser})` : ' (no auth)';
    log(`  ${domains} -> ${webhook.url}${auth}`);
  }
  
  if (config.spamCheck) {
    log(`Spam filtering: enabled`);
    log(`  SpamAssassin: ${config.spamHost}:${config.spamPort}`);
    log(`  DNSBL services: ${config.dnsbl.servers.join(', ')}`);
    log(`  Spam threshold: ${config.spamThreshold} (flag), ${config.spamReject} (reject)`);
  } else {
    log('Spam filtering: disabled');
  }
  
  log('=== Server Ready - Waiting for connections ===');
});

// Graceful shutdown
const shutdown = () => {
  log('Shutting down...');
  server.close(() => {
    log('Server closed');
    process.exit(0);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Handle uncaught errors
process.on('uncaughtException', (err) => {
  error('Uncaught exception', err);
  shutdown();
});

process.on('unhandledRejection', (reason, promise) => {
  error('Unhandled rejection', reason);
});
