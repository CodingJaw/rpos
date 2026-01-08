///<reference path="../rpos.d.ts"/>

import fs = require("fs");
import url = require('url');
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
    this.patchSoapServerDispatch(this.serviceInstance);

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

  patchSoapServerDispatch(serviceInstance: any) {
    if (!serviceInstance || serviceInstance._rposPatched) {
      return;
    }

    serviceInstance._rposPatched = true;
    var originalProcess = serviceInstance._process;

    serviceInstance._process = function(input: any, URL: string, callback: any) {
      var self = this;
      var pathname = url.parse(URL).pathname.replace(/\/$/, '');
      var obj: any = null;
      try {
        obj = this.wsdl.xmlToObject(input);
      } catch (err) {
        if (typeof originalProcess === 'function') {
          return originalProcess.call(self, input, URL, callback);
        }
        throw err;
      }

      var body = obj.Body || {};
      var headers = obj.Header;
      var includeTimestamp = obj.Header && obj.Header.Security && obj.Header.Security.Timestamp;

      if (typeof self.authenticate === 'function') {
        if (!obj.Header || !obj.Header.Security) {
          throw new Error('No security header');
        }
        if (!self.authenticate(obj.Header.Security)) {
          throw new Error('Invalid username or password');
        }
      }

      if (typeof self.log === 'function') {
        self.log("info", "Attempting to bind to " + pathname);
      }

      var messageElemName = Object.keys(body)[0];
      if (messageElemName === 'attributes') {
        messageElemName = Object.keys(body)[1];
      }

      var bindingInfo = self._selectBindingForMessage(pathname, messageElemName);
      if (!bindingInfo) {
        throw new Error('Failed to bind to WSDL');
      }

      try {
        if (bindingInfo.binding.style === 'rpc') {
          var rpcMethodName = Object.keys(body)[0];

          self.emit('request', obj, rpcMethodName);
          if (headers)
            self.emit('headers', headers, rpcMethodName);

          self._executeMethod({
            serviceName: bindingInfo.serviceName,
            portName: bindingInfo.portName,
            methodName: rpcMethodName,
            outputName: rpcMethodName + 'Response',
            args: body[rpcMethodName],
            headers: headers,
            style: 'rpc'
          }, callback);
        } else {
          var documentPair = bindingInfo.binding.topElements[messageElemName];
          if (!documentPair) {
            return callback(self._envelope('', includeTimestamp));
          }

          self.emit('request', obj, documentPair.methodName);
          if (headers)
            self.emit('headers', headers, documentPair.methodName);

          self._executeMethod({
            serviceName: bindingInfo.serviceName,
            portName: bindingInfo.portName,
            methodName: documentPair.methodName,
            outputName: documentPair.outputName,
            args: body[messageElemName],
            headers: headers,
            style: 'document'
          }, callback, includeTimestamp);
        }
      }
      catch (err) {
        if (err && err.Fault !== undefined) {
          var fault = self.wsdl.objectToDocumentXML("Fault", err.Fault, "soap");
          callback(self._envelope(fault, includeTimestamp));
        } else if (typeof originalProcess === 'function') {
          return originalProcess.call(self, input, URL, callback);
        } else {
          throw err;
        }
      }
    };

    serviceInstance._selectBindingForMessage = function(pathname: string, messageElemName: string) {
      var services = this.wsdl.definitions.services;
      var fallback = null;
      var name;

      for (name in services) {
        var serviceName = name;
        var service = services[serviceName];
        var ports = service.ports;
        for (name in ports) {
          var portName = name;
          var port = ports[portName];
          var portPathname = url.parse(port.location).pathname.replace(/\/$/, '');

          if (typeof this.log === 'function') {
            this.log("info", "Trying " + portName + " from path " + portPathname);
          }

          if (portPathname !== pathname) {
            continue;
          }

          if (!fallback) {
            fallback = { binding: port.binding, serviceName: serviceName, portName: portName };
          }

          if (messageElemName && port.binding.topElements[messageElemName]) {
            return { binding: port.binding, serviceName: serviceName, portName: portName };
          }
        }
      }

      return fallback;
    };
  }
}
export = SoapService;
