import assert = require('assert');
import http = require('http');
import SoapService = require('../lib/SoapService');

class WsdlHarness extends SoapService {
  constructor(config: rposConfig) {
    super(config, http.createServer());
    this.serviceOptions.path = '/onvif/device_service';
  }

  public rewrite(xml: string) {
    return (this as any).injectServiceAddresses(xml);
  }
}

const config: rposConfig = {
  NetworkAdapters: [],
  IpAddress: '127.0.0.1',
  ServicePort: 9090,
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

const wsdl = '<soap:address location="http://10.0.0.1/onvif/device_service" />';
const rewritten = new WsdlHarness(config).rewrite(wsdl);

assert.notStrictEqual(
  rewritten.indexOf('http://127.0.0.1:9090/onvif/device_service'),
  -1,
  'soap:address locations must include the configured port'
);
