/// <reference types="jest" />

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

function createPasswordDigest(nonce: string, created: string) {
  const crypto = require('crypto');
  const pwHash = crypto.createHash('sha1');
  const combined = Buffer.concat([
    Buffer.from(nonce, 'base64'),
    Buffer.from(created, 'ascii'),
    Buffer.from(config.Password, 'ascii')
  ]);
  pwHash.update(combined);
  return pwHash.digest('base64');
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

  test('rejects PasswordText tokens with incorrect credentials', () => {
    const service = createService();
    const token = {
      Username: { $value: 'wrong' },
      Password: {
        $value: 'badpassword',
        attributes: {
          Type: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText'
        }
      }
    } as any;

    expect(service.validateUsernameToken(token)).toBe(false);
  });

  test('validates PasswordDigest tokens using nonce, created, and password', () => {
    const service = createService();
    const nonce = Buffer.from('nonce-value').toString('base64');
    const created = '2024-01-01T00:00:00Z';
    const digest = createPasswordDigest(nonce, created);

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

  test('rejects PasswordDigest tokens missing nonce', () => {
    const service = createService();
    const created = '2024-01-01T00:00:00Z';
    const digest = createPasswordDigest(Buffer.from('nonce-value').toString('base64'), created);

    const token = {
      Username: 'admin',
      Password: {
        $value: digest,
        attributes: {
          Type: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest'
        }
      },
      Created: created
    } as any;

    expect(service.validateUsernameToken(token)).toBe(false);
  });

  test('rejects PasswordDigest tokens missing created', () => {
    const service = createService();
    const nonce = Buffer.from('nonce-value').toString('base64');
    const digest = createPasswordDigest(nonce, '2024-01-01T00:00:00Z');

    const token = {
      Username: 'admin',
      Password: {
        $value: digest,
        attributes: {
          Type: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest'
        }
      },
      Nonce: nonce
    } as any;

    expect(service.validateUsernameToken(token)).toBe(false);
  });

  test('rejects tokens with unsupported password type', () => {
    const service = createService();
    const token = {
      Username: 'admin',
      Password: {
        $value: 'irrelevant',
        attributes: {
          Type: 'http://unsupported-password-type'
        }
      },
      Nonce: Buffer.from('nonce-value').toString('base64'),
      Created: '2024-01-01T00:00:00Z'
    } as any;

    expect(service.validateUsernameToken(token)).toBe(false);
  });

  test('rejects requests without a UsernameToken', () => {
    const service = createService();

    expect(service.validateUsernameToken(undefined as any)).toBe(false);
    expect(service.validateUsernameToken({} as any)).toBe(false);
  });
});
