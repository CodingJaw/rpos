///<reference path="../rpos.d.ts"/>

import fs = require("fs");
import { Utils }  from './utils';
import { Server } from 'http';
import url = require('url');
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
  private static subscriptionBindingPatched = false;

  constructor(config: rposConfig, server: Server) {
    this.webserver = server;
    this.config = config;
    this.serviceInstance = null;
    this.startedCallbacks = [];
    this.isStarted = false;

    this.ensureSubscriptionBindingPatch();

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

  private ensureSubscriptionBindingPatch() {
    if (SoapService.subscriptionBindingPatched) return;
    SoapService.subscriptionBindingPatched = true;

    if (!soap || !soap.Server || typeof soap.Server.prototype._process !== 'function') {
      return;
    }

    const originalProcess = soap.Server.prototype._process;
    soap.Server.prototype._process = function() {
      const args = Array.prototype.slice.call(arguments);
      const reqOrUrl = args[1];
      const inputXml = args[0];

      let parsedUrl: url.UrlWithParsedQuery | null = null;
      try {
        const urlValue = typeof reqOrUrl === 'string' ? reqOrUrl : reqOrUrl?.url;
        if (typeof urlValue === 'string') {
          parsedUrl = url.parse(urlValue, true);
        }
      } catch (err) {
        parsedUrl = null;
      }

      let actionHint: string | null = null;
      try {
        const parsed = typeof inputXml === 'string' && this.wsdl?.xmlToObject ? this.wsdl.xmlToObject(inputXml) : null;
        const actionRaw = parsed?.Header?.Action || parsed?.Header?.['wsa:Action'] || parsed?.Header?.wsa__Action;
        const action = typeof actionRaw === 'string' ? actionRaw : actionRaw?.$value || actionRaw?._; 

        if (typeof action === 'string') {
          if (action.indexOf('SubscriptionManager') !== -1 || action.indexOf('/Renew') !== -1 || action.indexOf('/Unsubscribe') !== -1) {
            actionHint = 'SubscriptionManager';
          } else if (action.indexOf('PullPointSubscription') !== -1 || action.indexOf('/PullMessages') !== -1) {
            actionHint = 'PullPointSubscription';
          }
        }
      } catch (err) {
        actionHint = null;
      }

      const hasSubscriptionQuery = parsedUrl?.query && parsedUrl.query.subscription !== undefined;

      let restorePorts: { service: any; ports: any }[] = [];
      if (hasSubscriptionQuery && this.wsdl && this.wsdl.definitions && this.wsdl.definitions.services) {
        for (const serviceName of Object.keys(this.wsdl.definitions.services)) {
          const service = this.wsdl.definitions.services[serviceName];
          const ports = service?.ports;
          if (!ports || !ports.PullPointSubscription) continue;

          const originalPorts = service.ports;
          const prioritized = [] as string[];
          if (actionHint) prioritized.push(actionHint);
          prioritized.push('PullPointSubscription', 'SubscriptionManager');

          const seen: Record<string, boolean> = {};
          const reordered: any = {};

          for (const key of prioritized) {
            if (ports[key] && !seen[key]) {
              reordered[key] = ports[key];
              seen[key] = true;
            }
          }
          for (const key of Object.keys(ports)) {
            if (!seen[key]) {
              reordered[key] = ports[key];
              seen[key] = true;
            }
          }

          restorePorts.push({ service, ports: originalPorts });
          service.ports = reordered;
        }
      }

      try {
        return originalProcess.apply(this, args);
      } finally {
        for (const entry of restorePorts) {
          entry.service.ports = entry.ports;
        }
      }
    };
  }

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
        var passwordType = (token.Password.attributes && token.Password.attributes.Type) || '';
        var nonce = (token.Nonce && (token.Nonce.$value || token.Nonce)) || '';
        var created = token.Created;

        var onvif_username = this.config.Username;
        var onvif_password = this.config.Password;

        if (authDebug) {
          utils.log.info('Auth debug (%s): received token username=%s password=%s nonce=%s created=%s type=%s',
            methodName, user, password, nonce, created, passwordType || '');
        }

        var password_ok = false;

        // If password type is PasswordText (or nonce/created are missing) fall back to plain comparison
        var expectsDigest = passwordType.indexOf('PasswordDigest') >= 0 || (nonce && created);
        var schemeUsed = expectsDigest ? 'PasswordDigest' : 'PasswordText';

        if (expectsDigest) {
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

          password_ok = (user === onvif_username && password === generated_password);
        } else {
          if (authDebug) {
            utils.log.info('Auth debug (%s): using PasswordText comparison', methodName);
          }
          password_ok = (user === onvif_username && password === onvif_password);
        }

        if (authDebug) {
          utils.log.info('Auth debug (%s): scheme=%s type=%s passed=%s', methodName, schemeUsed, passwordType || '', password_ok);
        }

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
