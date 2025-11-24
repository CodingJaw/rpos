///<reference path="../rpos.d.ts" />

import fs = require('fs');
import SoapService = require('../lib/SoapService');
import { Utils } from '../lib/utils';
import { Server } from 'http';
import { RecordingConfigStore, RecordingMode } from '../lib/recordingStore';

const utils = Utils.utils;

class RecordingService extends SoapService {
  private store: RecordingConfigStore;

  constructor(config: rposConfig, server: Server, store: RecordingConfigStore) {
    super(config, server);
    this.store = store;

    this.serviceOptions = {
      path: '/onvif/recording_service',
      services: this.buildServiceDefinition(),
      xml: fs.readFileSync('./wsdl/recording_service.wsdl', 'utf8'),
      wsdlPath: 'wsdl/recording_service.wsdl',
      onReady: () => utils.log.info('recording_service started')
    };
  }

  private buildServiceDefinition() {
    const service: any = { RecordingService: { RecordingPort: {} } };
    const port = service.RecordingService.RecordingPort;

    port.GetServiceCapabilities = () => ({
      Capabilities: {
        attributes: { xmlns: 'http://www.onvif.org/ver10/recording/wsdl' },
        RecordingModes: this.store.getSupportedModes(),
        SupportsSchedules: true
      }
    });

    port.GetRecordingMode = () => ({ Mode: this.store.getMode() });

    port.SetRecordingMode = (args: any) => {
      const requested = args?.Mode ?? args?.RecordingMode ?? args;
      const mode = this.store.setMode(requested as RecordingMode);
      return { Mode: mode };
    };

    port.GetRecordingSchedule = () => ({
      Schedule: {
        Entry: this.store.getSchedule()
      }
    });

    port.SetRecordingSchedule = (args: any) => {
      const schedule = this.store.setSchedule(args?.Schedule ?? args);
      return { Schedule: { Entry: schedule } };
    };

    port.GetRecordingConfiguration = () => this.buildRecordingConfiguration();

    return service;
  }

  private buildRecordingConfiguration() {
    const response: any = {
      RecordingConfiguration: {
        Mode: this.store.getMode(),
        Schedule: {
          Entry: this.store.getSchedule()
        }
      }
    };

    return response;
  }
}

export = RecordingService;

