///<reference path="../rpos.d.ts"/>

import fs = require("fs");
import { Utils }  from './utils';
import { Server } from 'http';
import crypto = require('crypto');
var soap = <any>require('soap');
var utils = Utils.utils;

var NOT_IMPLEMENTED = {
  Fault: {
    attributes: { // Add namespace here. Really wanted to put it in Envelope but this should be valid
      'xmlns:ter' : 'http://www.onvif.org/ver10/error',
    },
    Code: {
      Value: "soap:Sender",
      Subcode: {
        Value: "ter:NotAuthorized",  
      },
    },
    Reason: {
      Text: {
        attributes: {
          'xml:lang': 'en',
        },
        $value: 'Sender not Authorized',
      }
    }
  }
};


class SoapService {
  webserver: Server;
  config: rposConfig;
  serviceInstance: any;
  serviceOptions: SoapServiceOptions;
  startedCallbacks: (() => void)[];
  isStarted: boolean;

  constructor(config: rposConfig, server: Server) {
    this.webserver = server;
    this.config = config;
    this.serviceInstance = null;
    this.startedCallbacks = [];
    this.isStarted = false;

    this.serviceOptions = {
      path: '',
      services: null,
      xml: null,
      wsdlPath: '',
      onReady: () => { }
    };

  }

  starting() { }

  started() { }

  start() {
    this.starting();

    utils.log.info("Binding %s to http://%s:%s%s", (<TypeConstructor>this.constructor).name, utils.getIpAddress(), this.config.ServicePort, this.serviceOptions.path);
    var onReady = this.serviceOptions.onReady;
    this.serviceOptions.onReady = () => {
      this._started();
      onReady();
    };
    this.serviceInstance = soap.listen(this.webserver, this.serviceOptions);

    this.serviceInstance.on("request", (request: any, methodName: string) => {
      utils.log.debug('%s received request %s', (<TypeConstructor>this.constructor).name, methodName);

      // Use the '=>' notation so 'this' refers to the class we are in
      // ONVIF allows GetSystemDateAndTime to be sent with no authenticaton header
      // So we check the header and check authentication in this function

      // utils.log.info('received soap header');
      if (methodName === "GetSystemDateAndTime") return;

      if (this.config.Username) {
        const token = request?.Header?.Security?.UsernameToken;
        if (!token) {
          utils.log.info('No Username/Password (ws-security) supplied for ' + methodName);
          throw NOT_IMPLEMENTED;
        }

        if (!this.validateUsernameToken(token)) {
          utils.log.info('Invalid username/password with ' + methodName);
          throw NOT_IMPLEMENTED;
        }
      }
    });

    this.serviceInstance.log = (type: string, data: any) => {
      if (this.config.logSoapCalls)
        utils.log.debug('%s - Calltype : %s, Data : %s', (<TypeConstructor>this.constructor).name, type, data);
    };
  }

  onStarted(callback: () => {}) {
    if (this.isStarted)
      callback();
    else
      this.startedCallbacks.push(callback);
  }

  _started() {
    this.isStarted = true;
    for (var callback of this.startedCallbacks)
      callback();
    this.startedCallbacks = [];
    this.started();
  }

  validateUsernameToken(token: any): boolean {
    const maskValue = (value: string) => {
      if (!value) return '';
      if (value.length <= 4) return '****';
      return `${value.slice(0, 2)}***${value.slice(-2)}`;
    };

    const username = token?.Username?.$value ?? token?.Username ?? '';
    const passwordElement = token?.Password;
    const password = passwordElement?.$value ?? passwordElement ?? '';
    const passwordType = passwordElement?.attributes?.Type ?? passwordElement?.Type ?? '';
    const nonce = token?.Nonce?.$value ?? token?.Nonce ?? '';
    const created = token?.Created?.$value ?? token?.Created ?? '';

    const onvif_username = this.config.Username;
    const onvif_password = this.config.Password;

    utils.log.info('[AuthDebug] Parsed UsernameToken', {
      username,
      passwordType: passwordType || 'PasswordDigest',
      nonce,
      created,
    });

    if (!username || !password || !onvif_username) {
      utils.log.info('[AuthDebug] Missing credential fields', {
        hasUsername: !!username,
        hasPassword: !!password,
        hasConfiguredUsername: !!onvif_username,
        hasNonce: !!nonce,
        hasCreated: !!created,
      });
      return false;
    }

    const isPasswordText = typeof passwordType === 'string' && passwordType.indexOf('PasswordText') !== -1;

    if (isPasswordText) {
      const isMatch = username === onvif_username && password === onvif_password;
      utils.log.info('[AuthDebug] PasswordText comparison', {
        providedUsername: username,
        expectedUsername: onvif_username,
        providedPassword: maskValue(password),
        expectedPassword: maskValue(onvif_password),
        result: isMatch,
      });
      return isMatch;
    }

    const rawNonce = Buffer.from(nonce || '', 'base64');
    const combined_data = Buffer.concat([
      rawNonce,
      Buffer.from(created || '', 'ascii'),
      Buffer.from(onvif_password || '', 'ascii')
    ]);

    const pwHash = crypto.createHash('sha1');
    pwHash.update(combined_data);
    const generated_password = pwHash.digest('base64');

    const isDigestMatch = username === onvif_username && password === generated_password;
    utils.log.info('[AuthDebug] PasswordDigest comparison', {
      providedUsername: username,
      expectedUsername: onvif_username,
      providedPasswordDigest: maskValue(password),
      generatedPasswordDigest: maskValue(generated_password),
      rawNonce: nonce,
      created,
      result: isDigestMatch,
    });

    return isDigestMatch;
  }
}
export = SoapService;
