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
      uri: '',
      callback: (err: any, res: any) => void {}
    };

  }

  starting() { }

  started() { }

  start() {
    this.starting();

    utils.log.info("Binding %s to http://%s:%s%s", (<TypeConstructor>this.constructor).name, utils.getIpAddress(), this.config.ServicePort, this.serviceOptions.path);
    this.serviceOptions.callback = (err: any, res: any) => {
      this._started();
    };
    this.serviceInstance = soap.listen(this.webserver, this.serviceOptions);

    this.serviceInstance.on("request", (request: any, methodName: string) => {
      utils.log.debug('%s received request %s', (<TypeConstructor>this.constructor).name, methodName);

      // Use the '=>' notation so 'this' refers to the class we are in
      // ONVIF allows GetSystemDateAndTime to be sent with no authenticaton header
      // So we check the header and check authentication in this function

      // utils.log.info('received soap header');
      if (methodName === "GetSystemDateAndTime") return;

      const authDebug = !!this.config.authDebug;
      const authDisabled = !!this.config.authDisable;

      if (authDisabled) {
        if (authDebug) {
          utils.log.info('Auth debug (%s): authentication disabled; skipping checks', methodName);
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
            utils.log.info('Auth debug (%s): SOAP header received: %j', methodName, request && request.Header);
          }
          throw NOT_IMPLEMENTED;
        }
        var user = token.Username;
        var password = (token.Password.$value || token.Password);
        var nonce = (token.Nonce.$value || token.Nonce); // handle 2 ways to map XML to the javascript data structure
        var created = token.Created;

        var onvif_username = this.config.Username;
        var onvif_password = this.config.Password;

        if (authDebug) {
          utils.log.info('Auth debug (%s): received token username=%s password=%s nonce=%s created=%s',
            methodName, user, password, nonce, created);
        }

        // digest = base64 ( sha1 ( nonce + created + onvif_password ) )
        var crypto = require('crypto');
        var pwHash = crypto.createHash('sha1');
        var rawNonce = Buffer.from(nonce || '', 'base64')
        var combined_data = Buffer.concat([rawNonce,
          Buffer.from(created, 'ascii'), Buffer.from(onvif_password, 'ascii')]);
        pwHash.update(combined_data);
        var generated_password = pwHash.digest('base64');

        if (authDebug) {
          utils.log.info('Auth debug (%s): expected username=%s, configured password=%s, generated digest=%s',
            methodName, onvif_username, onvif_password, generated_password);
        }

        var password_ok = (user === onvif_username && password === generated_password);

        if (password_ok == false) {
          utils.log.info('Invalid username/password with ' + methodName);
          throw NOT_IMPLEMENTED;
        }
      };
    });

    this.serviceInstance.on('soapError', (error: any, eid: string) => {
      utils.log.error('%s received error %s', (<TypeConstructor>this.constructor).name, eid);
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
}
export = SoapService;
