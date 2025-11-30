///<reference path="../rpos.d.ts" />

import fs = require("fs");
import SoapService = require('../lib/SoapService');
import { Server } from 'http';

class DeviceService extends SoapService {
  device_service: any;
  callback: any;

  constructor(config: rposConfig, server: Server, callback) {
    super(config, server);

    const createDeviceService = require('./stubs/device_service.js').DeviceService;
    this.device_service = createDeviceService(this.config, callback);
    this.callback = callback;

    this.serviceOptions = {
      path: '/onvif/device_service',
      services: this.device_service,
      xml: fs.readFileSync('./wsdl/device_service.wsdl', 'utf8'),
      wsdlPath: 'wsdl/device_service.wsdl',
      onReady: () => console.log('device_service started')
    };
  }
}
export = DeviceService;
