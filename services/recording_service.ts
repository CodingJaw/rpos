///<reference path="../rpos.d.ts" />

import fs = require('fs');
import SoapService = require('../lib/SoapService');
import { Utils } from '../lib/utils';
import { Server } from 'http';
import { RecordingStore, WeeklySchedule } from '../lib/recordingStore';

const utils = Utils.utils;

class RecordingService extends SoapService {
  recording_service: any;
  store: RecordingStore;

  constructor(config: rposConfig, server: Server, store: RecordingStore) {
    super(config, server);

    this.recording_service = require('./stubs/recording_service.js').RecordingService;
    this.store = store;

    this.serviceOptions = {
      path: '/onvif/recording_service',
      services: this.recording_service,
      xml: fs.readFileSync('./wsdl/recording_service.wsdl', 'utf8'),
      wsdlPath: 'wsdl/recording_service.wsdl',
      onReady: function () {
        utils.log.info('recording_service started');
      }
    };

    this.extendService();
  }

  extendService() {
    const port = this.recording_service.RecordingService.Recording;

    port.GetRecordingConfiguration = () => {
      return { RecordingConfiguration: this.store.getConfiguration() };
    };

    port.SetRecordingConfiguration = (args) => {
      if (args?.RecordingConfiguration?.Mode) {
        this.store.setMode(args.RecordingConfiguration.Mode);
      }
      if (args?.RecordingConfiguration?.Schedule) {
        this.store.setSchedule(<WeeklySchedule>args.RecordingConfiguration.Schedule);
      }
      return { RecordingConfiguration: this.store.getConfiguration() };
    };

    port.SetRecordingMode = (args) => {
      const mode = this.store.setMode(args?.Mode);
      return { RecordingConfiguration: this.store.getConfiguration(), Mode: mode };
    };

    port.SetRecordingSchedule = (args) => {
      const schedule = this.store.setSchedule(<WeeklySchedule>args?.Schedule);
      return { RecordingConfiguration: this.store.getConfiguration(), Schedule: schedule };
    };
  }
}

export = RecordingService;

