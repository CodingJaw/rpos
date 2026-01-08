///<reference path="../rpos.d.ts"/>

import fs = require("fs");
import { Utils }  from './utils';
import { Server } from 'http';
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
    this.installProcessFallback();

    this.serviceInstance.on("request", (request: any, methodName: string) => {
      utils.log.debug('%s received request %s', (<TypeConstructor>this.constructor).name, methodName);

      // Use the '=>' notation so 'this' refers to the class we are in
      // ONVIF allows GetSystemDateAndTime to be sent with no authenticaton header
      // So we check the header and check authentication in this function

      // utils.log.info('received soap header');
      const authDebug = !!this.config.authDebug;
      const authDisabled = !!this.config.authDisable;

      const unauthenticatedMethods = new Set([
        'GetServices',
        'GetCapabilities',
        'GetServiceCapabilities',
        'GetSystemDateAndTime',
        'GetDeviceInformation'
      ]);

      const optionalInventoryMethods = new Set([
        'GetScopes',
        'GetHostname'
      ]);

      if (authDisabled) {
        if (authDebug) {
          utils.log.info(
            'Auth debug (%s): authentication disabled; skipping checks',
            methodName
          );
        }
        return;
      }

      if (unauthenticatedMethods.has(methodName)) {
        if (authDebug) {
          utils.log.info(
            'Auth debug (%s): unauthenticated method; skipping checks',
            methodName
          );
        }
        return;
      }

      if (optionalInventoryMethods.has(methodName) && !this.config.Username) {
        if (authDebug) {
          utils.log.info(
            'Auth debug (%s): optional inventory method without credentials; skipping checks',
            methodName
          );
        }
        return;
      }

      if (this.config.Username) {
        let token: any = null;
        try {
          token = request.Header.Security.UsernameToken;
        } catch (err) {
          utils.log.info('No Username/Password (ws-security) supplied for ' + methodName);
          if (authDebug) {
            utils.log.info(
              'Auth debug (%s): SOAP header received: %j',
              methodName,
              request && request.Header
            );
          }
          throw NOT_IMPLEMENTED;
        }
        const user = token.Username;
        const password = (token.Password.$value || token.Password);
        const passwordType =
          (token.Password.attributes && token.Password.attributes.Type) || '';
        const nonce =
          (token.Nonce && (token.Nonce.$value || token.Nonce)) || '';
        const created = token.Created;

        const onvif_username = this.config.Username;
        const onvif_password = this.config.Password;

        if (authDebug) {
          utils.log.info(
            'Auth debug (%s): received token username=%s password=%s nonce=%s created=%s type=%s',
            methodName,
            user,
            password,
            nonce,
            created,
            passwordType || ''
          );
        }

        let password_ok = false;

        const expectsDigest =
          passwordType.indexOf('PasswordDigest') >= 0 || (nonce && created);
        const schemeUsed = expectsDigest ? 'PasswordDigest' : 'PasswordText';

        if (expectsDigest) {
          const crypto = require('crypto');
          const pwHash = crypto.createHash('sha1');
          const rawNonce = Buffer.from(nonce || '', 'base64');
          const combined_data = Buffer.concat([
            rawNonce,
            Buffer.from(created, 'ascii'),
            Buffer.from(onvif_password, 'ascii')
          ]);
          pwHash.update(combined_data);
          const generated_password = pwHash.digest('base64');

          if (authDebug) {
            utils.log.info(
              'Auth debug (%s): expected username=%s, configured password=%s, generated digest=%s',
              methodName,
              onvif_username,
              onvif_password,
              generated_password
            );
          }

          password_ok =
            (user === onvif_username && password === generated_password);
        } else {
          if (authDebug) {
            utils.log.info(
              'Auth debug (%s): using PasswordText comparison',
              methodName
            );
          }
          password_ok =
            (user === onvif_username && password === onvif_password);
        }

        if (authDebug) {
          utils.log.info(
            'Auth debug (%s): scheme=%s type=%s passed=%s',
            methodName,
            schemeUsed,
            passwordType || '',
            password_ok
          );
        }

        if (!password_ok) {
          utils.log.info('Invalid username/password with ' + methodName);
          throw NOT_IMPLEMENTED;
        }
      };
    });

    this.serviceInstance.log = (type: string, data: any) => {
      if (this.config.logSoapCalls)
        utils.log.debug('%s - Calltype : %s, Data : %s', (<TypeConstructor>this.constructor).name, type, data);
    };
  }

  installProcessFallback() {
    if (!this.serviceInstance || this.serviceInstance._rposProcessPatched) {
      return;
    }

    const originalProcess = this.serviceInstance._process.bind(this.serviceInstance);
    this.serviceInstance._process = (input: any, url: any, callback?: (result: string) => void) => {
      let processUrl: string = typeof url === 'string' ? url : '';
      let processCallback: ((result: string) => void) | undefined =
        typeof callback === 'function' ? callback : undefined;

      if (typeof url === 'function') {
        if (!processCallback) {
          processCallback = url;
        } else {
          processUrl = '';
        }
      }

      if (!processCallback) {
        utils.log.info('SOAP _process invoked without a callback; response will be discarded.');
        processCallback = () => { };
      }
      try {
        return originalProcess(input, processUrl, processCallback);
      } catch (err) {
        const message = err && err.message ? String(err.message) : '';
        if (err instanceof TypeError && message.indexOf('methodName') >= 0) {
          utils.log.info('SOAP request did not match a known operation; returning empty response.');
          return processCallback(this.serviceInstance._envelope('', false));
        }
        throw err;
      }
    };
    this.serviceInstance._rposProcessPatched = true;
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
}
export = SoapService;
