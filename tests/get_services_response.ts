import assert = require('assert');
import http = require('http');
import DeviceService = require('../services/device_service');
import { ServiceRegistry } from '../lib/service_registry';

const dummyConfig: rposConfig = {
  NetworkAdapters: [],
  IpAddress: '127.0.0.1',
  ServicePort: 8080,
  Username: 'user',
  Password: 'pass',
  CameraType: 'test',
  CameraDevice: 'test',
  Codec: 'h264',
  FPS: 25,
  RTSPAddress: '127.0.0.1',
  RTSPPort: 8554,
  RTSPName: 'stream',
  RTSPServer: 0,
  MulticastEnabled: false,
  RTSPMulticastName: '',
  MulticastAddress: '',
  MulticastPort: 0,
  PTZDriver: '',
  PTZOutput: '',
  PTZSerialPort: '',
  PTZSerialPortSettings: {
    baudRate: 9600,
    dataBits: 8,
    parity: 'none',
    stopBits: 1
  },
  PTZOutputURL: '',
  PTZCameraAddress: 1,
  DeviceInformation: {
    Manufacturer: 'Test',
    Model: 'Model',
    HardwareId: 'HW',
    SerialNumber: '1234',
    FirmwareVersion: '1.0.0'
  },
  logLevel: 3,
  logSoapCalls: false
};

const mediaCapabilities = {
  'trt:Capabilities': {
    'trt:StreamingCapabilities': {
      attributes: {
        RTPMulticast: true,
        RTP_TCP: true,
        RTP_RTSP_TCP: true
      }
    },
    'trt:ProfileCapabilities': {
      attributes: {
        MaximumNumberOfProfiles: 1
      }
    }
  }
};

const mediaStub = {
  getPort: () => ({
    GetServiceCapabilities: () => mediaCapabilities
  })
};

const registry = new ServiceRegistry();
registry.register({
  Namespace: DeviceService.namespace,
  XAddr: 'http://127.0.0.1:8080/onvif/device_service'
});
registry.register({
  Namespace: 'http://www.onvif.org/ver10/deviceIO/wsdl',
  XAddr: 'http://127.0.0.1:8080/onvif/deviceio_service'
});

const deviceService = new DeviceService(dummyConfig, http.createServer(), <any>mediaStub, () => {}, registry);
const getServices = deviceService['device_service'].DeviceService.Device.GetServices;
const response = getServices({});

assert.ok(response.Service instanceof Array, 'GetServices should return a Service array');

var foundDeviceIO = false;
for (var i = 0; i < response.Service.length; i++) {
  if (response.Service[i].Namespace === 'http://www.onvif.org/ver10/deviceIO/wsdl') {
    foundDeviceIO = true;
  }
}

assert.ok(foundDeviceIO, 'DeviceIO namespace must be present in GetServices response');
