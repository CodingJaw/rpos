import assert = require('assert');
import SoapService = require('../lib/SoapService');

const config: any = {
  Username: 'admin',
  Password: 'password'
};

const service = new SoapService(config, <any>{});
const crypto = require('crypto');

function runPasswordTextTest() {
  const token = {
    Username: { $value: 'admin' },
    Password: {
      $value: 'password',
      attributes: {
        Type: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText'
      }
    }
  };

  assert.strictEqual(service.validateUsernameToken(token), true, 'PasswordText tokens should validate with plain password');
}

function runPasswordTextArrayWrappedTest() {
  const token = {
    Username: [{ $value: 'admin' }],
    Password: [{
      $value: 'password',
      attributes: {
        Type: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText'
      }
    }]
  };

  assert.strictEqual(service.validateUsernameToken(token), true, 'Array-wrapped PasswordText token should validate');
}

function runPasswordDigestTest() {
  const nonce = Buffer.from('nonce-value').toString('base64');
  const created = '2024-01-01T00:00:00Z';
  const pwHash = crypto.createHash('sha1');
  const combined = Buffer.concat([
    Buffer.from(nonce, 'base64'),
    Buffer.from(created, 'ascii'),
    Buffer.from(config.Password, 'ascii')
  ]);
  pwHash.update(combined);
  const digest = pwHash.digest('base64');

  const token = {
    Username: 'admin',
    Password: {
      $value: digest,
      attributes: {
        Type: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest'
      }
    },
    Nonce: nonce,
    Created: created
  };

  assert.strictEqual(service.validateUsernameToken(token), true, 'PasswordDigest tokens should validate with digest');
}

function runRecentAuthReuseTest() {
  const reuseService = new SoapService(config, <any>{});
  reuseService.recentAuthWindowMs = 2000;

  const nonce = Buffer.from('reuse-nonce').toString('base64');
  const created = '2024-01-01T00:00:00Z';
  const pwHash = crypto.createHash('sha1');
  const combined = Buffer.concat([
    Buffer.from(nonce, 'base64'),
    Buffer.from(created, 'ascii'),
    Buffer.from(config.Password, 'ascii')
  ]);
  pwHash.update(combined);
  const digest = pwHash.digest('base64');

  const token = {
    Username: 'admin',
    Password: {
      $value: digest,
      attributes: {
        Type: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest'
      }
    },
    Nonce: nonce,
    Created: created
  };

  assert.strictEqual(reuseService.validateUsernameToken(token), true, 'Digest token should validate and set recent auth');
  assert.strictEqual(reuseService.hasRecentAuth(), true, 'Successful validation should mark recent auth window');

  reuseService.lastValidAuthAt = Date.now() - reuseService.recentAuthWindowMs - 50;
  assert.strictEqual(reuseService.hasRecentAuth(), false, 'Auth window should expire after configured duration');
}

function runHeaderExtractionTests() {
  const extract = (request: any) => (<any>service).extractUsernameToken(request).token;

  const nestedToken = { Username: 'admin' };
  const envelopeToken = { Username: 'admin' };
  const securityOnlyToken = { Username: 'admin' };
  const arrayWrapped = { Username: 'admin' };

  assert.strictEqual(
    extract({ Header: { Security: { UsernameToken: nestedToken } } }),
    nestedToken,
    'Should extract UsernameToken from Header.Security'
  );

  assert.strictEqual(
    extract({ Envelope: { Header: { Security: { UsernameToken: envelopeToken } } } }),
    envelopeToken,
    'Should extract UsernameToken from Envelope.Header.Security'
  );

  assert.strictEqual(
    extract({ Security: { UsernameToken: securityOnlyToken } }),
    securityOnlyToken,
    'Should extract UsernameToken when Security is at the root'
  );

  assert.strictEqual(
    extract({ Header: [{ Security: [{ UsernameToken: [arrayWrapped] }] }] }),
    arrayWrapped,
    'Should extract UsernameToken when elements are array-wrapped'
  );

  assert.strictEqual(
    extract({}),
    undefined,
    'Should return undefined when no token is present'
  );
}

runPasswordTextTest();
runPasswordTextArrayWrappedTest();
runPasswordDigestTest();
runHeaderExtractionTests();
runRecentAuthReuseTest();

console.log('SoapService token validation tests passed');
