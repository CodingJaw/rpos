///<reference path="../rpos.d.ts" />

import fs = require("fs");
import util = require("util");
import os = require('os');
import SoapService = require('../lib/SoapService');
import { Utils }  from '../lib/utils';
import { Server } from 'http';
import { IOState } from '../lib/io_state';
import ip = require('ip');
var utils = Utils.utils;
const NAMESPACE = "http://www.onvif.org/ver10/deviceIO/wsdl";
const PATH = '/onvif/deviceio_service';

class DeviceIOService extends SoapService {
  device_service: any;
  callback: any;
  ioState: IOState;
  private inputIdleStates: string[];

  constructor(config: rposConfig, server: Server, callback: any, ioState: IOState) {
    super(config, server);

    this.device_service = require('./stubs/deviceio_service.js').DeviceIOService;
    this.callback = callback;
    this.ioState = ioState;
    this.inputIdleStates = Array.from({ length: this.ioState.digitalInputs.length }, () => 'open');

    this.serviceOptions = {
      path: PATH,
      services: this.device_service,
      xml: this.loadWsdlWithAddress('./wsdl/onvif/services/deviceio_service.wsdl'),
      uri: 'wsdl/onvif/services/deviceio_service.wsdl',
      callback: () => console.log('deviceio_service started')
    };

    this.extendService();
  }

  static get namespace() {
    return NAMESPACE;
  }

  static get path() {
    return PATH;
  }

  extendService() {
    var port = this.device_service.DeviceIOService.DeviceIOPort;

    port.GetServiceCapabilities = () => ({
      Capabilities: {
        attributes: {
          VideoSources: 1,
          VideoOutputs: 0,
          AudioSources: 1,
          AudioOutputs: 1,
          RelayOutputs: this.ioState.digitalOutputs.length,
          DigitalInputs: this.ioState.digitalInputs.length,
          SerialPorts: 1,
          DigitalInputOptions: true
        }
      }
    });

    port.GetDigitalInputs = () => ({
      DigitalInputs: this.ioState.digitalInputs.map((_state, index) => ({
        attributes: {
          token: `Input${index}`
        },
        IdleState: this.inputIdleStates[index] || 'open'
      }))
    });

    const relayOutputs = () => this.ioState.digitalOutputs.map((_state, index) => ({
      attributes: {
        token: `Relay${index}`
      },
      Properties: {
        Mode: 'Bistable',
        DelayTime: 'PT0S',
        IdleState: 'open'
      }
    }));

    port.GetDigitalOutputs = () => ({
      RelayOutputs: relayOutputs()
    });

    if (!port.GetRelayOutputs) {
      port.GetRelayOutputs = () => ({
        RelayOutputs: relayOutputs()
      });
    } else {
      port.GetRelayOutputs = () => ({
        RelayOutputs: relayOutputs()
      });
    }

    port.SetRelayOutputState = (args: any) => {
      const token: string = args?.RelayOutputToken;
      const index = this.parseRelayIndex(token);
      const active = args?.LogicalState === 'active';
      this.ioState.setOutput(index, active);
      return {};
    };

    port.SetDigitalInputConfigurations = (args: any) => {
      const inputs = Array.isArray(args?.DigitalInputs)
        ? args.DigitalInputs
        : args?.DigitalInputs
          ? [args.DigitalInputs]
          : [];

      inputs.forEach((inputConfig: any) => {
        const token = inputConfig?.attributes?.token || inputConfig?.['attributes']?.['token'];
        const index = this.parseInputIndex(token);
        const idle = inputConfig?.IdleState;
        if (typeof idle === 'string' && idle.length > 0) {
          this.inputIdleStates[index] = idle;
        }
      });

      return {};
    };

    port.GetDigitalInputConfigurationOptions = () => ({
      DigitalInputOptions: {
        IdleState: ['open', 'closed']
      }
    });

    this.registerDebugApi();
  }

  private parseRelayIndex(token: string): number {
    if (typeof token !== 'string') {
      throw new Error('Invalid relay output token');
    }
    const match = token.match(/Relay(\d+)/i);
    if (!match) {
      throw new Error(`Unknown relay output token ${token}`);
    }
    const index = parseInt(match[1], 10);
    if (isNaN(index) || index < 0 || index >= this.ioState.digitalOutputs.length) {
      throw new RangeError(`Relay output index out of range: ${token}`);
    }
    return index;
  }

  private parseInputIndex(token: string): number {
    if (typeof token !== 'string') {
      throw new Error('Invalid digital input token');
    }
    const match = token.match(/Input(\d+)/i);
    if (!match) {
      throw new Error(`Unknown digital input token ${token}`);
    }
    const index = parseInt(match[1], 10);
    if (isNaN(index) || index < 0 || index >= this.ioState.digitalInputs.length) {
      throw new RangeError(`Digital input index out of range: ${token}`);
    }
    return index;
  }

  private getExpressApp(): any | undefined {
    const listeners = this.webserver?.listeners?.('request');
    if (listeners && listeners.length > 0) {
      const app = listeners[0];
      if (app && typeof (app as any).get === 'function' && typeof (app as any).post === 'function') {
        return app;
      }
    }
    return undefined;
  }

  private registerDebugApi() {
    const app = this.getExpressApp();
    if (!app) return;

    app.get('/api/io/inputs', (_req: any, res: any) => {
      res.json({ inputs: this.ioState.digitalInputs });
    });

    app.get('/api/io/outputs', (_req: any, res: any) => {
      res.json({ outputs: this.ioState.digitalOutputs });
    });

    app.post('/api/io/input/:id/:state', (req: any, res: any) => {
      const index = this.parseInputIndex(`Input${req.params.id}`);
      const value = this.parseBoolean(req.params.state);
      this.ioState.setInput(index, value);
      res.json({ index, value });
    });

    app.post('/api/io/output/:id/:state', (req: any, res: any) => {
      const index = this.parseRelayIndex(`Relay${req.params.id}`);
      const value = this.parseBoolean(req.params.state);
      this.ioState.setOutput(index, value);
      res.json({ index, value });
    });
  }

  private parseBoolean(value: any): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.toLowerCase();
      return normalized === '1' || normalized === 'true' || normalized === 'on' || normalized === 'active';
    }
    return !!value;
  }
}
export = DeviceIOService;

