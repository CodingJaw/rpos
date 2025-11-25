import SoapService = require('../lib/SoapService');
import { Utils } from '../lib/utils';

const config: any = {
  Username: 'admin',
  Password: 'password'
};

// Jest requires a logger, ensure utils is initialized to avoid undefined log usage in SoapService
const utils = Utils.utils;
utils.log.level = Utils.logLevel.Warn;

function createService() {
  return new SoapService(config, <any>{});
}

describe('SoapService.validateUsernameToken', () => {
  test('validates PasswordText tokens with plain password', () => {
    const service = createService();
    const token = {
      Username: { $value: 'admin' },
      Password: {
        $value: 'password',
        attributes: {
          Type: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText'
        }
      }
    } as any;

    expect(service.validateUsernameToken(token)).toBe(true);
  });

  test('validates PasswordDigest tokens using nonce, created, and password', () => {
    const service = createService();
    const nonce = Buffer.from('nonce-value').toString('base64');
    const created = '2024-01-01T00:00:00Z';
    const crypto = require('crypto');
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
    } as any;

    expect(service.validateUsernameToken(token)).toBe(true);
  });
});
